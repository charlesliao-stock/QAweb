/**
 * 查詢描述與「用戶端」執行器。
 * Supabase 端只下推 ==／in／array-contains，其餘（範圍、!=、排序、游標、limit）
 * 一律用本檔在取回的列上執行，語意與 demoStore 相同。
 * Supabase 讀取不計 Firestore 額度，故以正確性優先。
 */
import type { Json } from "./codec";

export type WhereOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "array-contains" | "in";

export interface WhereC {
  field: string;
  op: WhereOp | string;
  value: Json;
}
export interface OrderC {
  field: string;
  dir: "asc" | "desc";
}
export interface Query {
  wheres: WhereC[];
  orderBys: OrderC[];
  limitN?: number;
  startAfterId?: string;
}

export interface Row {
  id: string;
  ts: number;
  data: Json;
}

export function getField(data: Json, field: string): Json | undefined {
  let cur: Json | undefined = data;
  for (const part of field.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object" || Array.isArray(cur)) {
      return undefined;
    }
    cur = (cur as { [k: string]: Json })[part];
  }
  return cur;
}

function comparable(v: Json | undefined): number | string {
  if (v === undefined || v === null) return "";
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (!Array.isArray(v) && typeof (v as { __t?: unknown }).__t === "number") {
    return (v as { __t: number }).__t;
  }
  return JSON.stringify(v);
}

function same(a: Json | undefined, b: Json | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function testWhere(data: Json, w: WhereC): boolean {
  const v = getField(data, w.field);
  switch (w.op) {
    case "==":
      return same(v, w.value);
    case "!=":
      return !same(v, w.value);
    case "<":
      return comparable(v) < comparable(w.value);
    case "<=":
      return comparable(v) <= comparable(w.value);
    case ">":
      return comparable(v) > comparable(w.value);
    case ">=":
      return comparable(v) >= comparable(w.value);
    case "array-contains":
      return Array.isArray(v) && v.some((x) => same(x, w.value));
    case "in":
      return Array.isArray(w.value) && w.value.some((x) => same(x, v));
    default:
      return true;
  }
}

/** 套用 where／orderBy／startAfter／limit。 */
export function runQuery(rows: Row[], q: Query): Row[] {
  let out = rows.filter((r) => q.wheres.every((w) => testWhere(r.data, w)));
  // Firestore 預設依文件 id 排序；游標分頁需要穩定順序
  out = [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const o of [...q.orderBys].reverse()) {
    const dir = o.dir === "desc" ? -1 : 1;
    out = [...out].sort((a, b) => {
      const va = comparable(getField(a.data, o.field));
      const vb = comparable(getField(b.data, o.field));
      return va < vb ? -dir : va > vb ? dir : 0;
    });
  }
  if (q.startAfterId) {
    const at = out.findIndex((r) => r.id === q.startAfterId);
    if (at >= 0) out = out.slice(at + 1);
  }
  if (q.limitN !== undefined) out = out.slice(0, q.limitN);
  return out;
}
