/**
 * 展示模式用記憶體 Firestore 子集實作。
 * 只實作各頁實際用到的操作：get/getDocs/set/update/delete、
 * query(where ==, orderBy, limit)、writeBatch、serverTimestamp。
 */
import { getDemoData } from "./demoData";

export interface DemoCollectionRef {
  __demo: "collection";
  path: string;
}
export interface DemoDocRef {
  __demo: "doc";
  collPath: string;
  id: string;
}
interface DemoWhere {
  __demoQ: "where";
  field: string;
  op: string;
  value: unknown;
}
interface DemoOrderBy {
  __demoQ: "orderBy";
  field: string;
  dir: "asc" | "desc";
}
interface DemoLimit {
  __demoQ: "limit";
  n: number;
}
export interface DemoQuery {
  __demo: "query";
  collPath: string;
  wheres: DemoWhere[];
  orderBys: DemoOrderBy[];
  limitN?: number;
}

/** 模擬 Firestore Timestamp：支援 toDate() 與數值比較 */
export class DemoTimestamp {
  constructor(readonly ms: number) {}
  toDate(): Date {
    return new Date(this.ms);
  }
  toMillis(): number {
    return this.ms;
  }
  valueOf(): number {
    return this.ms;
  }
}

const store = new Map<string, Map<string, unknown>>();
let seeded = false;

function coll(path: string): Map<string, unknown> {
  let m = store.get(path);
  if (!m) {
    m = new Map();
    store.set(path, m);
  }
  return m;
}

export function ensureSeeded(): void {
  if (seeded) return;
  seeded = true;
  for (const [path, docs] of Object.entries(getDemoData())) {
    const m = coll(path);
    for (const [id, data] of Object.entries(docs)) {
      m.set(id, structuredClone(data));
    }
  }
}

function genId(): string {
  return `demo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function collection(path: string): DemoCollectionRef {
  return { __demo: "collection", path };
}

/** 對應 firestore doc() 多載：doc(db, ...segments)／doc(collRef)／doc(collRef, id) */
export function docOf(first: unknown, ...segments: string[]): DemoDocRef {
  const r = first as Partial<DemoCollectionRef> | null;
  if (r && r.__demo === "collection" && typeof r.path === "string") {
    return { __demo: "doc", collPath: r.path, id: segments[0] ?? genId() };
  }
  // 第一個參數為 db（展示模式忽略）
  const id = segments[segments.length - 1] ?? genId();
  const collPath = segments.slice(0, -1).join("/");
  return { __demo: "doc", collPath, id };
}

export function where(field: string, op: string, value: unknown): DemoWhere {
  return { __demoQ: "where", field, op, value };
}

export function orderBy(field: string, dir: "asc" | "desc" = "asc"): DemoOrderBy {
  return { __demoQ: "orderBy", field, dir };
}

export function limit(n: number): DemoLimit {
  return { __demoQ: "limit", n };
}

export function query(
  ref: DemoCollectionRef,
  ...constraints: Array<DemoWhere | DemoOrderBy | DemoLimit | unknown>
): DemoQuery {
  const q: DemoQuery = { __demo: "query", collPath: ref.path, wheres: [], orderBys: [] };
  for (const c of constraints) {
    const cc = c as { __demoQ?: string; field?: string; op?: string; value?: unknown; dir?: "asc" | "desc"; n?: number } | null;
    if (!cc || typeof cc.__demoQ !== "string") continue;
    if (cc.__demoQ === "where" && cc.field !== undefined && cc.op !== undefined) {
      q.wheres.push({ __demoQ: "where", field: cc.field, op: cc.op, value: cc.value });
    } else if (cc.__demoQ === "orderBy" && cc.field !== undefined) {
      q.orderBys.push({ __demoQ: "orderBy", field: cc.field, dir: cc.dir ?? "asc" });
    } else if (cc.__demoQ === "limit" && cc.n !== undefined) {
      q.limitN = cc.n;
    }
  }
  return q;
}

function getField(data: unknown, field: string): unknown {
  let cur: unknown = data;
  for (const part of field.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function toComparable(v: unknown): number | string {
  if (v instanceof DemoTimestamp) return v.ms;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

function testWhere(data: unknown, w: DemoWhere): boolean {
  const v = getField(data, w.field);
  const t = w.value;
  switch (w.op) {
    case "==":
      return v === t;
    case "!=":
      return v !== t;
    case "<":
      return toComparable(v) < toComparable(t);
    case "<=":
      return toComparable(v) <= toComparable(t);
    case ">":
      return toComparable(v) > toComparable(t);
    case ">=":
      return toComparable(v) >= toComparable(t);
    case "array-contains":
      return Array.isArray(v) && v.includes(t);
    case "in":
      return Array.isArray(t) && t.includes(v);
    default:
      return true;
  }
}

export interface DemoDocSnap {
  id: string;
  exists: () => boolean;
  data: () => unknown;
  ref: DemoDocRef;
}

function makeDocSnap(collPath: string, id: string, data: unknown): DemoDocSnap {
  return {
    id,
    exists: () => data !== undefined,
    data: () => data,
    ref: { __demo: "doc", collPath, id },
  };
}

export interface DemoQuerySnap {
  docs: DemoDocSnap[];
  empty: boolean;
  size: number;
  forEach: (cb: (d: DemoDocSnap) => void) => void;
}

export function getDocs(ref: DemoCollectionRef | DemoQuery): DemoQuerySnap {
  ensureSeeded();
  const collPath = ref.__demo === "query" ? ref.collPath : ref.path;
  let entries = [...coll(collPath).entries()];
  if (ref.__demo === "query") {
    for (const w of ref.wheres) {
      entries = entries.filter(([, d]) => testWhere(d, w));
    }
    for (const o of [...ref.orderBys].reverse()) {
      const dir = o.dir === "desc" ? -1 : 1;
      entries.sort((a, b) => {
        const va = toComparable(getField(a[1], o.field));
        const vb = toComparable(getField(b[1], o.field));
        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return 0;
      });
    }
    if (ref.limitN !== undefined) entries = entries.slice(0, ref.limitN);
  }
  const docs = entries.map(([id, data]) => makeDocSnap(collPath, id, data));
  return {
    docs,
    empty: docs.length === 0,
    size: docs.length,
    forEach: (cb) => docs.forEach(cb),
  };
}

export function getDoc(ref: DemoDocRef): DemoDocSnap {
  ensureSeeded();
  return makeDocSnap(ref.collPath, ref.id, coll(ref.collPath).get(ref.id));
}

export function setDoc(
  ref: DemoDocRef,
  data: Record<string, unknown>,
  options?: { merge?: boolean },
): void {
  ensureSeeded();
  const m = coll(ref.collPath);
  if (options?.merge && m.has(ref.id)) {
    const prev = m.get(ref.id) as Record<string, unknown>;
    m.set(ref.id, { ...prev, ...data });
  } else {
    m.set(ref.id, { ...data });
  }
}

export function updateDoc(ref: DemoDocRef, data: Record<string, unknown>): void {
  ensureSeeded();
  const m = coll(ref.collPath);
  const prev = (m.get(ref.id) as Record<string, unknown>) ?? {};
  m.set(ref.id, { ...prev, ...data });
}

export function deleteDoc(ref: DemoDocRef): void {
  ensureSeeded();
  coll(ref.collPath).delete(ref.id);
}

export function serverTimestamp(): DemoTimestamp {
  return new DemoTimestamp(Date.now());
}

export interface DemoWriteBatch {
  set: (ref: DemoDocRef, data: Record<string, unknown>) => DemoWriteBatch;
  update: (ref: DemoDocRef, data: Record<string, unknown>) => DemoWriteBatch;
  delete: (ref: DemoDocRef) => DemoWriteBatch;
  commit: () => Promise<void>;
}

export function writeBatch(): DemoWriteBatch {
  const ops: Array<() => void> = [];
  const batch: DemoWriteBatch = {
    set: (ref, data) => {
      ops.push(() => setDoc(ref, data));
      return batch;
    },
    update: (ref, data) => {
      ops.push(() => updateDoc(ref, data));
      return batch;
    },
    delete: (ref) => {
      ops.push(() => deleteDoc(ref));
      return batch;
    },
    commit: async () => {
      ensureSeeded();
      ops.forEach((op) => op());
    },
  };
  return batch;
}
