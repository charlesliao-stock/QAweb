/**
 * Supabase（PostgREST）文件轉接器：不依賴 supabase-js，只用 fetch，
 * 對應 public.docs 表（col／id／data／ts）與 public.apply_ops RPC。
 */
import type { Json } from "./codec";
import { runQuery, type Query, type Row, type WhereC } from "./query";

/**
 * 「資料／規則」層級的拒絕（不是資料庫掛了）：業務規則拒絕（SQLSTATE QA403）、
 * 唯一鍵衝突、格式錯誤。呼叫端要把它當一般錯誤丟給使用者，
 * 不能因此轉移到備庫、也不能算進斷路器的失敗次數。
 * 401／403／5xx／逾時／斷線則視為主庫「不可用」（含登入或設定問題），會轉移到備庫。
 */
export class DataError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "DataError";
  }
}

export interface Op {
  col: string;
  id: string;
  kind: "set" | "del";
  ts: number;
  data?: Json;
}

export interface DocAdapter {
  name: string;
  get(col: string, id: string): Promise<Row | null>;
  list(col: string, q: Query): Promise<Row[]>;
  /** 一組操作以單一交易套用（Supabase）／單一 batch（Firebase）。 */
  apply(ops: Op[]): Promise<void>;
}

export interface SupabaseOptions {
  /** 基底網址，例如 https://xxxx.supabase.co（不含 /rest/v1） */
  url: string;
  /** publishable（anon）金鑰 */
  apiKey: string;
  /** 回傳登入者的 JWT；未登入回 null（此時以 apiKey 當 Bearer，只會得到 anon 權限） */
  getToken?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  pageSize?: number;
}

export interface SupabaseAdapter extends DocAdapter {
  /** 呼叫 public schema 的 RPC 函式（例如 db_status）。 */
  rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T>;
}

export function supabaseDocs(opt: SupabaseOptions): SupabaseAdapter {
  const base = `${opt.url.replace(/\/+$/, "").replace(/\/rest\/v1$/, "")}/rest/v1`;
  const f = opt.fetchImpl ?? fetch;
  const pageSize = opt.pageSize ?? 1000;

  async function headers(extra?: Record<string, string>): Promise<Record<string, string>> {
    const token = (await opt.getToken?.()) ?? opt.apiKey;
    return { apikey: opt.apiKey, Authorization: `Bearer ${token}`, ...extra };
  }

  async function check(res: Response, what: string): Promise<void> {
    if (res.ok) return;
    let msg = "";
    let code = "";
    try {
      msg = (await res.text()).slice(0, 300);
      code = String((JSON.parse(msg) as { code?: unknown }).code ?? "");
    } catch {
      /* 非 JSON 內容 */
    }
    const dataLevel =
      code.startsWith("QA") || code.startsWith("23") ||
      res.status === 400 || res.status === 409 || res.status === 422;
    if (dataLevel) throw new DataError(`supabase ${what} ${res.status} ${msg}`, res.status, code);
    throw new Error(`supabase ${what} ${res.status} ${msg}`);
  }

  /** 把可下推的條件組成 PostgREST 篩選；其餘留給 runQuery。 */
  function pushdown(wheres: WhereC[]): string[] {
    const params: string[] = [];
    const contain: Record<string, Json> = {};
    let inUsed = false;
    for (const w of wheres) {
      if (w.field.includes(".")) continue; // 巢狀欄位交給用戶端
      if (w.op === "==") contain[w.field] = w.value;
      else if (w.op === "array-contains") contain[w.field] = [w.value];
      else if (w.op === "in" && Array.isArray(w.value) && w.value.length > 0 && !inUsed) {
        inUsed = true;
        const alts = w.value.map((v) => `data.cs.${JSON.stringify({ [w.field]: v })}`);
        params.push(`or=(${alts.join(",")})`);
      }
    }
    if (Object.keys(contain).length > 0) params.unshift(`data=cs.${JSON.stringify(contain)}`);
    return params;
  }

  return {
    name: "supabase",

    async get(col, id) {
      const url = `${base}/docs?col=eq.${encodeURIComponent(col)}&id=eq.${encodeURIComponent(id)}&select=id,ts,data&limit=1`;
      const res = await f(url, { headers: await headers() });
      await check(res, "get");
      const rows = (await res.json()) as Row[];
      return rows[0] ?? null;
    },

    async list(col, q) {
      const rows: Row[] = [];
      const filters = pushdown(q.wheres);
      for (let offset = 0; ; offset += pageSize) {
        const qs = [
          `col=eq.${encodeURIComponent(col)}`,
          "select=id,ts,data",
          "order=id.asc",
          `limit=${pageSize}`,
          `offset=${offset}`,
          ...filters.map((p) => {
            const i = p.indexOf("=");
            return `${p.slice(0, i)}=${encodeURIComponent(p.slice(i + 1))}`;
          }),
        ].join("&");
        const res = await f(`${base}/docs?${qs}`, { headers: await headers() });
        await check(res, "list");
        const page = (await res.json()) as Row[];
        rows.push(...page);
        if (page.length < pageSize) break;
      }
      return runQuery(rows, q);
    },

    async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
      const res = await f(`${base}/rpc/${encodeURIComponent(fn)}`, {
        method: "POST",
        headers: await headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(args),
      });
      await check(res, `rpc ${fn}`);
      return (await res.json()) as T;
    },

    async apply(ops) {
      if (ops.length === 0) return;
      const res = await f(`${base}/rpc/apply_ops`, {
        method: "POST",
        headers: await headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ p_ops: ops }),
      });
      await check(res, "apply_ops");
    },
  };
}
