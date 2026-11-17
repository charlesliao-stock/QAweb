/**
 * 雙寫＋故障轉移核心（Supabase 主、Firebase 備）。
 * - 寫入：先寫主庫；成功後把同一批操作排入「備庫複寫佇列」，背景補送。
 * - 主庫逾時／連續失敗 → 斷路器開啟，寫入改走備庫，並排入「主庫回補佇列」。
 * - 讀取：主庫優先；主庫失敗，或該筆還欠主庫回補時，讀備庫（回傳 stale）。
 * - 佇列可持久化（localStorage），同一文件只保留最新操作，重送冪等。
 */
import type { Json } from "./codec";
import { DataError, type DocAdapter, type Op } from "./supabaseDocs";
import type { Query, Row } from "./query";

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export class MemoryStorage implements StorageLike {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
}

export class CircuitBreaker {
  failures = 0;
  openedAt = 0;
  state: "closed" | "open" | "half-open" = "closed";
  constructor(
    private threshold: number,
    private cooldownMs: number,
    private now: () => number,
  ) {}
  allow(): boolean {
    if (this.state === "closed") return true;
    if (this.now() - this.openedAt >= this.cooldownMs) {
      this.state = "half-open";
      return true;
    }
    return false;
  }
  success(): void {
    this.failures = 0;
    this.state = "closed";
  }
  failure(): void {
    this.failures += 1;
    if (this.state === "half-open" || this.failures >= this.threshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }
}

interface QItem {
  target: string;
  op: Op;
  attempts: number;
  nextAt: number;
}

export type DualEvent =
  | { type: "failover-write"; ops: number }
  | { type: "error"; db: string; error: string; breaker: string }
  | { type: "dead-letter"; target: string; col: string; id: string };

export interface DualOptions {
  primary: DocAdapter;
  secondary: DocAdapter;
  storage?: StorageLike;
  now?: () => number;
  timeoutMs?: number;
  queueKey?: string;
  maxAttempts?: number;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  chunk?: number;
  onEvent?: (e: DualEvent) => void;
}

export interface DualHealth {
  /** primary＝主庫正常；failover＝主庫斷路中，目前由備庫服務 */
  mode: "primary" | "failover";
  primary: { name: string; breaker: "closed" | "open" | "half-open" };
  secondary: { name: string; breaker: "closed" | "open" | "half-open" };
  /** 還沒補回主庫的筆數（故障轉移期間寫到備庫的資料） */
  pendingToPrimary: number;
  /** 還沒複寫到備庫的筆數 */
  pendingToSecondary: number;
  /** 重送失敗、被放棄的筆數（本次開啟頁面以來），需要人工對帳 */
  deadLetters: number;
}

export interface ReadResult<T> {
  source: string;
  stale: boolean;
  value: T;
}

const keyOf = (target: string, col: string, id: string): string => `${target}|${col}|${id}`;

export class DualStore {
  readonly p: DocAdapter;
  readonly s: DocAdapter;
  private storage: StorageLike;
  private now: () => number;
  private timeoutMs: number;
  private queueKey: string;
  private maxAttempts: number;
  private chunk: number;
  private onEvent: (e: DualEvent) => void;
  private breakers: Record<string, CircuitBreaker>;
  private inflight: Promise<{ done: number; left: number }> | undefined;
  private lastTs = 0;
  private deadLetters = 0;

  constructor(o: DualOptions) {
    this.p = o.primary;
    this.s = o.secondary;
    this.storage = o.storage ?? new MemoryStorage();
    this.now = o.now ?? Date.now;
    this.timeoutMs = o.timeoutMs ?? 8000;
    this.queueKey = o.queueKey ?? "dualstore:queue:v1";
    this.maxAttempts = o.maxAttempts ?? 8;
    this.chunk = o.chunk ?? 200;
    this.onEvent = o.onEvent ?? (() => {});
    const th = o.breakerThreshold ?? 3;
    const cd = o.breakerCooldownMs ?? 30000;
    this.breakers = {
      [this.p.name]: new CircuitBreaker(th, cd, this.now),
      [this.s.name]: new CircuitBreaker(th, cd, this.now),
    };
  }

  /** 單調遞增的寫入時鐘（毫秒）；同毫秒內多次寫入也保證嚴格遞增。 */
  tick(): number {
    this.lastTs = Math.max(this.now(), this.lastTs + 1);
    return this.lastTs;
  }

  /** 目前模式：primary＝正常；failover＝主庫斷路中。 */
  mode(): "primary" | "failover" {
    return this.breakers[this.p.name]!.state === "closed" ? "primary" : "failover";
  }

  /** 給管理頁／橫幅顯示的健康狀態（不發出任何網路請求）。 */
  health(): DualHealth {
    const b = (name: string): "closed" | "open" | "half-open" => this.breakers[name]!.state;
    return {
      mode: this.mode(),
      primary: { name: this.p.name, breaker: b(this.p.name) },
      secondary: { name: this.s.name, breaker: b(this.s.name) },
      pendingToPrimary: this.pending(this.p.name).length,
      pendingToSecondary: this.pending(this.s.name).length,
      deadLetters: this.deadLetters,
    };
  }

  // ---------- 佇列 ----------
  private load(): QItem[] {
    try {
      return JSON.parse(this.storage.getItem(this.queueKey) ?? "[]") as QItem[];
    } catch {
      return [];
    }
  }
  private save(q: QItem[]): void {
    this.storage.setItem(this.queueKey, JSON.stringify(q));
  }
  private enqueue(target: string, ops: Op[]): void {
    const q = this.load();
    for (const op of ops) {
      const i = q.findIndex((x) => keyOf(x.target, x.op.col, x.op.id) === keyOf(target, op.col, op.id));
      const item: QItem = { target, op, attempts: 0, nextAt: 0 };
      if (i < 0) q.push(item);
      else if (q[i]!.op.ts <= op.ts) q[i] = item;
    }
    this.save(q);
  }
  pending(target?: string): QItem[] {
    return this.load().filter((x) => !target || x.target === target);
  }
  private owes(target: string, col: string, id?: string): boolean {
    return this.load().some((x) => x.target === target && x.op.col === col && (id === undefined || x.op.id === id));
  }

  private adapter(name: string): DocAdapter {
    return name === this.p.name ? this.p : this.s;
  }

  private async call<T>(a: DocAdapter, fn: () => Promise<T>): Promise<T> {
    const br = this.breakers[a.name]!;
    if (!br.allow()) throw new Error(`${a.name} circuit open`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([
        fn(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error(`${a.name} timeout ${this.timeoutMs}ms`)), this.timeoutMs);
        }),
      ]);
      br.success();
      return r;
    } catch (e) {
      if (e instanceof DataError) throw e; // 規則拒絕不是故障：不計入斷路器
      br.failure();
      this.onEvent({ type: "error", db: a.name, error: (e as Error).message, breaker: br.state });
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---------- 寫入 ----------
  /** 一批操作（對應一次 setDoc／batch.commit）。回傳實際落地的庫。 */
  async commit(ops: Op[]): Promise<{ mode: "primary" | "failover" }> {
    if (ops.length === 0) return { mode: this.mode() };
    let mode: "primary" | "failover" = "primary";
    try {
      await this.call(this.p, () => this.p.apply(ops));
      this.enqueue(this.s.name, ops);
    } catch (pe) {
      if (pe instanceof DataError) throw pe; // 規則／資料錯誤：直接回報，不轉移到備庫
      try {
        await this.call(this.s, () => this.s.apply(ops));
        this.enqueue(this.p.name, ops);
        mode = "failover";
        this.onEvent({ type: "failover-write", ops: ops.length });
      } catch (se) {
        throw new Error(`寫入失敗（主庫：${(pe as Error).message}；備庫：${(se as Error).message}）`);
      }
    }
    void this.drain().catch(() => {});
    return { mode };
  }

  /** 把佇列補送到對應資料庫；斷路中的目標略過，不阻塞呼叫端。進行中的一輪會先等它結束再跑新的一輪。 */
  async drain(): Promise<{ done: number; left: number }> {
    while (this.inflight) await this.inflight.catch(() => {});
    this.inflight = this.runDrain();
    try {
      return await this.inflight;
    } finally {
      this.inflight = undefined;
    }
  }

  private async runDrain(): Promise<{ done: number; left: number }> {
    let done = 0;
    {
      const snapshot = this.load();
      const kept: QItem[] = [];
      for (const target of [this.p.name, this.s.name]) {
        const mine = snapshot.filter((x) => x.target === target);
        const ready = mine.filter((x) => x.nextAt <= this.now());
        kept.push(...mine.filter((x) => x.nextAt > this.now()));
        const a = this.adapter(target);
        for (let i = 0; i < ready.length; i += this.chunk) {
          const part = ready.slice(i, i + this.chunk);
          if (!this.breakers[a.name]!.allow()) {
            kept.push(...part);
            continue;
          }
          try {
            await this.call(a, () => a.apply(part.map((x) => x.op)));
            done += part.length;
          } catch (err) {
            for (const it of part) {
              it.attempts += err instanceof DataError ? this.maxAttempts : 1; // 規則拒絕：重送無意義，直接進死信
              if (it.attempts >= this.maxAttempts) {
                this.deadLetters += 1;
                this.onEvent({ type: "dead-letter", target, col: it.op.col, id: it.op.id });
              } else {
                it.nextAt = this.now() + Math.min(60000, 1000 * 2 ** it.attempts);
                kept.push(it);
              }
            }
          }
        }
      }
      // 送的過程中新排入的操作要保留；同一文件以較新的為準
      const merged = new Map<string, QItem>();
      const fresh = this.load().filter(
        (x) => !snapshot.some((o) => keyOf(o.target, o.op.col, o.op.id) === keyOf(x.target, x.op.col, x.op.id) && o.op.ts === x.op.ts),
      );
      for (const x of [...kept, ...fresh]) {
        const k = keyOf(x.target, x.op.col, x.op.id);
        const cur = merged.get(k);
        if (!cur || cur.op.ts <= x.op.ts) merged.set(k, x);
      }
      this.save([...merged.values()]);
      return { done, left: merged.size };
    }
  }

  // ---------- 讀取 ----------
  async get(col: string, id: string): Promise<ReadResult<Row | null>> {
    if (!this.owes(this.p.name, col, id)) {
      try {
        return { source: this.p.name, stale: false, value: await this.call(this.p, () => this.p.get(col, id)) };
      } catch (e) {
        if (e instanceof DataError) throw e;
        /* 轉移到備庫 */
      }
    }
    return { source: this.s.name, stale: true, value: await this.call(this.s, () => this.s.get(col, id)) };
  }

  async list(col: string, q: Query): Promise<ReadResult<Row[]>> {
    if (!this.owes(this.p.name, col)) {
      try {
        return { source: this.p.name, stale: false, value: await this.call(this.p, () => this.p.list(col, q)) };
      } catch (e) {
        if (e instanceof DataError) throw e;
        /* 轉移到備庫 */
      }
    }
    return { source: this.s.name, stale: true, value: await this.call(this.s, () => this.s.list(col, q)) };
  }
}

export type { Json };
