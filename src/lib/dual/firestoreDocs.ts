/**
 * Firebase（Firestore）備援轉接器。
 * - 文件以「原生欄位」存放（和現有程式、firestore.rules 一致），不加任何中繼欄位，
 *   所以萬一切到備庫，舊版畫面與規則照常可用。
 * - Timestamp 寫入時由 {__t} 還原為真正的 Firestore Timestamp。
 * - 複寫採無條件覆蓋（不為了比較時間而多讀一次，省 Spark 讀取額度）；
 *   佇列已保證每份文件只送最新一筆。
 * SDK 以參數注入（方便測試，也避免本檔綁定打包方式）。
 */
import { encode, type Json } from "./codec";
import type { DocAdapter, Op } from "./supabaseDocs";
import type { Query, Row } from "./query";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface FirestoreSdk {
  db: any;
  collection: (...a: any[]) => any;
  doc: (...a: any[]) => any;
  getDoc: (ref: any) => Promise<any>;
  getDocs: (q: any) => Promise<any>;
  query: (...a: any[]) => any;
  where: (...a: any[]) => any;
  orderBy: (...a: any[]) => any;
  limit: (n: number) => any;
  startAfter: (snap: any) => any;
  writeBatch: (db: any) => any;
  Timestamp: { fromMillis: (ms: number) => any };
}

function toFs(v: Json, sdk: FirestoreSdk): unknown {
  if (Array.isArray(v)) return v.map((x) => toFs(x, sdk));
  if (v !== null && typeof v === "object") {
    const o = v as { [k: string]: Json };
    if (Object.keys(o).length === 1 && typeof o.__t === "number") return sdk.Timestamp.fromMillis(o.__t);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = toFs(x, sdk);
    return out;
  }
  return v;
}

const rowOf = (id: string, data: unknown): Row => ({ id, ts: 0, data: encode(data, 0) });

export function firestoreDocs(sdk: FirestoreSdk): DocAdapter {
  const collRef = (col: string): any => sdk.collection(sdk.db, ...col.split("/"));
  const docRef = (col: string, id: string): any => sdk.doc(sdk.db, ...col.split("/"), id);

  return {
    name: "firebase",

    async get(col, id) {
      const s = await sdk.getDoc(docRef(col, id));
      return s.exists() ? rowOf(id, s.data()) : null;
    },

    async list(col, q: Query) {
      const cs: any[] = [];
      for (const w of q.wheres) cs.push(sdk.where(w.field, w.op, toFs(w.value, sdk)));
      for (const o of q.orderBys) cs.push(sdk.orderBy(o.field, o.dir));
      if (q.startAfterId) {
        const cursor = await sdk.getDoc(docRef(col, q.startAfterId));
        if (cursor.exists()) cs.push(sdk.startAfter(cursor));
      }
      if (q.limitN !== undefined) cs.push(sdk.limit(q.limitN));
      const snap = await sdk.getDocs(sdk.query(collRef(col), ...cs));
      return snap.docs.map((d: any) => rowOf(d.id, d.data()));
    },

    async apply(ops: Op[]) {
      // Firestore 單一 batch 上限 500；呼叫端（DualStore.drain）每次最多送 200
      const b = sdk.writeBatch(sdk.db);
      for (const op of ops) {
        const ref = docRef(op.col, op.id);
        if (op.kind === "del") b.delete(ref);
        else b.set(ref, toFs(op.data ?? null, sdk));
      }
      await b.commit();
    },
  };
}
