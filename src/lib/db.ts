/**
 * Firestore 操作統一出口。
 * 真實模式：直接轉呼叫 firebase/firestore；
 * 展示模式（demo 登入）：走 demoStore 記憶體實作，不碰真實資料庫。
 *
 * 各頁只需把 `from "firebase/firestore"` 改為 `from "../lib/db"`（lib 內為 "./db"），
 * 其餘呼叫寫法不變（第一個 db 參數在展示模式下會被忽略）。
 *
 * 型別刻意放寬為 any：同一份呼叫碼要同時相容真實 SDK 與記憶體實作。
 */
import { isDemoMode } from "./demoMode";
import { invalidateRefForDocPath } from "./refCache";
import * as demo from "./demoStore";
import {
  collection as fsCollection,
  deleteDoc as fsDeleteDoc,
  doc as fsDoc,
  getDoc as fsGetDoc,
  getDocs as fsGetDocs,
  limit as fsLimit,
  orderBy as fsOrderBy,
  query as fsQuery,
  serverTimestamp as fsServerTimestamp,
  setDoc as fsSetDoc,
  startAfter as fsStartAfter,
  Timestamp as fsTimestamp,
  updateDoc as fsUpdateDoc,
  where as fsWhere,
  writeBatch as fsWriteBatch,
  type DocumentSnapshot,
  type QuerySnapshot,
} from "firebase/firestore";

export type { Firestore, WriteBatch } from "firebase/firestore";

const demoOn = (): boolean => isDemoMode();

/* eslint-disable @typescript-eslint/no-explicit-any */

export function collection(db: any, ...path: string[]): any {
  return demoOn()
    ? demo.collection(path.join("/"))
    : (fsCollection as (...a: any[]) => any)(db, ...path);
}

export function doc(first: any, ...segments: string[]): any {
  return demoOn() ? demo.docOf(first, ...segments) : fsDoc(first, ...segments);
}

export function getDoc(ref: any): Promise<DocumentSnapshot> {
  return demoOn()
    ? Promise.resolve(demo.getDoc(ref) as unknown as DocumentSnapshot)
    : fsGetDoc(ref);
}

export function getDocs(ref: any): Promise<QuerySnapshot> {
  return demoOn()
    ? Promise.resolve(demo.getDocs(ref) as unknown as QuerySnapshot)
    : fsGetDocs(ref);
}

export function setDoc(ref: any, data: any, options?: any): Promise<void> {
  if (demoOn()) return Promise.resolve(demo.setDoc(ref, data, options));
  return fsSetDoc(ref, data, options).then(() => {
    invalidateRefAfterWrite(ref);
  });
}

export function updateDoc(ref: any, data: any): Promise<void> {
  if (demoOn()) return Promise.resolve(demo.updateDoc(ref, data));
  return fsUpdateDoc(ref, data).then(() => {
    invalidateRefAfterWrite(ref);
  });
}

export function deleteDoc(ref: any): Promise<void> {
  if (demoOn()) return Promise.resolve(demo.deleteDoc(ref));
  return fsDeleteDoc(ref).then(() => {
    invalidateRefAfterWrite(ref);
  });
}

export function query(ref: any, ...constraints: any[]): any {
  return demoOn() ? demo.query(ref, ...constraints) : fsQuery(ref, ...constraints);
}

export function where(field: string, op: string, value: any): any {
  return demoOn()
    ? demo.where(field, op, value)
    : (fsWhere as (...a: any[]) => any)(field, op, value);
}

export function orderBy(field: string, dir?: "asc" | "desc"): any {
  return demoOn() ? demo.orderBy(field, dir ?? "asc") : fsOrderBy(field, dir as any);
}

export function limit(n: number): any {
  return demoOn() ? demo.limit(n) : fsLimit(n);
}

/** v1.28 階段 6（B6）：游標分頁用。真實模式走 Firestore startAfter（文件 snapshot）；展示模式走 demoStore（以文件 id 定位游標）。 */
export function startAfter(snapshot: any): any {
  return demoOn() ? demo.startAfter(snapshot) : fsStartAfter(snapshot);
}

export function serverTimestamp(): any {
  return demoOn() ? demo.serverTimestamp() : fsServerTimestamp();
}

/** v1.28 階段 2：48h 警示查詢用（submittedAt >= 指定毫秒時間戳） */
export function timestampFromMs(ms: number): any {
  return demoOn()
    ? demo.timestampFromMs(ms)
    : fsTimestamp.fromMillis(ms);
}

export function writeBatch(db: any): any {
  if (demoOn()) return demo.writeBatch();
  const batch = fsWriteBatch(db);
  // v1.28 階段 4：batch 的 set／update／delete 只是暫存操作，commit 成功
  // 後才失效觸及的參考集合。呼叫端只用 set／update／delete／commit，
  // 包裝物件保留相同方法與鏈式回傳（回傳自身）。
  const touched: string[] = [];
  const record = (ref: any): void => {
    try {
      if (ref && typeof ref.path === "string") touched.push(ref.path);
    } catch {
      /* 路徑讀不到就不失效，寧可多讀一次也不出錯 */
    }
  };
  const wrapped: any = {
    set(ref: any, data: any, options?: any): any {
      record(ref);
      batch.set(ref, data, options);
      return wrapped;
    },
    update(ref: any, data: any): any {
      record(ref);
      batch.update(ref, data);
      return wrapped;
    },
    delete(ref: any): any {
      record(ref);
      batch.delete(ref);
      return wrapped;
    },
    commit(): Promise<void> {
      return batch.commit().then(() => {
        for (const path of touched) invalidateRefForDocPath(path);
      });
    },
  };
  return wrapped;
}

/**
 * v1.28 階段 4：單筆寫入成功後，依 ref path 失效對應參考集合快取
 *（只在真實模式；demo 模式不走快取）。寫入失敗不失效（.then 才執行）。
 * 失效本身絕不能讓寫入報錯，故包 try/catch。
 */
function invalidateRefAfterWrite(ref: any): void {
  try {
    if (ref && typeof ref.path === "string") invalidateRefForDocPath(ref.path);
  } catch {
    /* 忽略 */
  }
}
