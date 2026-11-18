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
import { assertFirestoreAllowed } from "./maintenance";
import { recordDocRead, recordQueryRead } from "./readMeter";
import { demoStoreSync, type DemoStoreModule } from "./demoLoader";
import * as dual from "./dual/dualDb";
import { isDualMode } from "./dual/bootstrap";
import {
  collection as fsCollection,
  deleteDoc as fsDeleteDoc,
  doc as fsDoc,
  getDoc as fsGetDoc,
  getDocs as fsGetDocs,
  getCountFromServer as fsGetCountFromServer,
  getDocFromServer as fsGetDocFromServer,
  getDocsFromServer as fsGetDocsFromServer,
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

/** 展示模式實作改為延遲載入（見 demoLoader.ts）；呼叫端寫法不變，取用時才解析模組。 */
const demo: DemoStoreModule = new Proxy({} as DemoStoreModule, {
  get: (_target, key) => demoStoreSync()[key as keyof DemoStoreModule],
});
const demoOn = (): boolean => isDemoMode();
/** 雙寫模式（Supabase 主／Firebase 備）；展示模式優先，且需 VITE_DB_MODE=dual 並已初始化。 */
const dualOn = (): boolean => !isDemoMode() && isDualMode();

/* eslint-disable @typescript-eslint/no-explicit-any */

export function collection(db: any, ...path: string[]): any {
  if (dualOn()) return dual.collection(...path);
  return demoOn()
    ? demo.collection(path.join("/"))
    : (fsCollection as (...a: any[]) => any)(db, ...path);
}

export function doc(first: any, ...segments: string[]): any {
  if (dualOn()) return dual.docOf(first, ...segments);
  return demoOn() ? demo.docOf(first, ...segments) : fsDoc(first, ...segments);
}

export async function getDoc(ref: any): Promise<DocumentSnapshot> {
  if (demoOn()) return Promise.resolve(demo.getDoc(ref) as unknown as DocumentSnapshot);
  if (dualOn()) return dual.getDoc(ref) as unknown as Promise<DocumentSnapshot>; // 讀 Supabase，不耗 Firestore 額度
  // v1.41.0 流量控管：維護開啟且非管理員時阻擋（登入 profile 與狀態文件讀取豁免）
  await assertFirestoreAllowed({ path: ref?.path, kind: "read" });
  const snap = (await fsGetDoc(ref)) as unknown as DocumentSnapshot;
  recordDocRead(snap);
  return snap;
}

/** 直接向伺服器讀單一文件（送出後讀回確認用；不走本機快取）。 */
export async function getDocFromServer(ref: any): Promise<DocumentSnapshot> {
  if (demoOn()) return Promise.resolve(demo.getDoc(ref) as unknown as DocumentSnapshot);
  if (dualOn()) return dual.getDoc(ref) as unknown as Promise<DocumentSnapshot>;
  await assertFirestoreAllowed({ path: ref?.path, kind: "read" });
  const snap = (await fsGetDocFromServer(ref)) as unknown as DocumentSnapshot;
  recordDocRead(snap);
  return snap;
}

/** 伺服器端計數（約每 1000 筆計 1 次讀取，遠低於逐筆讀取）；展示模式以筆數代替。 */
export async function getCount(q: any): Promise<number> {
  if (demoOn()) return (demo.getDocs(q) as unknown as QuerySnapshot).docs.length;
  if (dualOn()) return dual.getCount(q);
  await assertFirestoreAllowed({ kind: "read" });
  const snap = await fsGetCountFromServer(q);
  return snap.data().count;
}

export async function getDocs(ref: any): Promise<QuerySnapshot> {
  if (demoOn()) return Promise.resolve(demo.getDocs(ref) as unknown as QuerySnapshot);
  if (dualOn()) return dual.getDocs(ref) as unknown as Promise<QuerySnapshot>;
  // v1.41.0 流量控管：維護開啟且非管理員時阻擋
  await assertFirestoreAllowed({ kind: "read" });
  const snap = (await fsGetDocs(ref)) as unknown as QuerySnapshot;
  recordQueryRead(snap);
  return snap;
}

/** 需要完整清單時繞過可能不完整的本機 IndexedDB 查詢快取。 */
export async function getDocsFromServer(ref: any): Promise<QuerySnapshot> {
  if (demoOn()) return Promise.resolve(demo.getDocs(ref) as unknown as QuerySnapshot);
  if (dualOn()) return dual.getDocs(ref) as unknown as Promise<QuerySnapshot>;
  // v1.41.0 流量控管：維護開啟且非管理員時阻擋
  await assertFirestoreAllowed({ kind: "read" });
  const snap = (await fsGetDocsFromServer(ref)) as unknown as QuerySnapshot;
  recordQueryRead(snap);
  return snap;
}

export async function setDoc(ref: any, data: any, options?: any): Promise<void> {
  if (demoOn()) return Promise.resolve(demo.setDoc(ref, data, options));
  if (dualOn()) {
    await assertFirestoreAllowed({ kind: "write" }); // 備庫仍是 Firestore，寫入額度照樣受控
    return dual.setDoc(ref, data, options).then(() => invalidateRefAfterWrite(ref));
  }
  // v1.41.0 流量控管：維護開啟且非管理員時阻擋寫入
  await assertFirestoreAllowed({ kind: "write" });
  return fsSetDoc(ref, data, options).then(() => {
    invalidateRefAfterWrite(ref);
  });
}

export async function updateDoc(ref: any, data: any): Promise<void> {
  if (demoOn()) return Promise.resolve(demo.updateDoc(ref, data));
  if (dualOn()) {
    await assertFirestoreAllowed({ kind: "write" });
    return dual.updateDoc(ref, data).then(() => invalidateRefAfterWrite(ref));
  }
  // v1.41.0 流量控管：維護開啟且非管理員時阻擋寫入
  await assertFirestoreAllowed({ kind: "write" });
  return fsUpdateDoc(ref, data).then(() => {
    invalidateRefAfterWrite(ref);
  });
}

export async function deleteDoc(ref: any): Promise<void> {
  if (demoOn()) return Promise.resolve(demo.deleteDoc(ref));
  if (dualOn()) {
    await assertFirestoreAllowed({ kind: "write" });
    return dual.deleteDoc(ref).then(() => invalidateRefAfterWrite(ref));
  }
  // v1.41.0 流量控管：維護開啟且非管理員時阻擋寫入
  await assertFirestoreAllowed({ kind: "write" });
  return fsDeleteDoc(ref).then(() => {
    invalidateRefAfterWrite(ref);
  });
}

export function query(ref: any, ...constraints: any[]): any {
  if (dualOn()) return dual.query(ref, ...constraints);
  return demoOn() ? demo.query(ref, ...constraints) : fsQuery(ref, ...constraints);
}

export function where(field: string, op: string, value: any): any {
  if (dualOn()) return dual.where(field, op, value);
  return demoOn()
    ? demo.where(field, op, value)
    : (fsWhere as (...a: any[]) => any)(field, op, value);
}

export function orderBy(field: string, dir?: "asc" | "desc"): any {
  if (dualOn()) return dual.orderBy(field, dir ?? "asc");
  return demoOn() ? demo.orderBy(field, dir ?? "asc") : fsOrderBy(field, dir as any);
}

export function limit(n: number): any {
  if (dualOn()) return dual.limit(n);
  return demoOn() ? demo.limit(n) : fsLimit(n);
}

/** v1.28 階段 6（B6）：游標分頁用。真實模式走 Firestore startAfter（文件 snapshot）；展示模式走 demoStore（以文件 id 定位游標）。 */
export function startAfter(snapshot: any): any {
  if (dualOn()) return dual.startAfter(snapshot);
  return demoOn() ? demo.startAfter(snapshot) : fsStartAfter(snapshot);
}

export function serverTimestamp(): any {
  if (dualOn()) return dual.serverTimestamp();
  return demoOn() ? demo.serverTimestamp() : fsServerTimestamp();
}

/** v1.28 階段 2：48h 警示查詢用（submittedAt >= 指定毫秒時間戳） */
export function timestampFromMs(ms: number): any {
  if (dualOn()) return dual.timestampFromMs(ms);
  return demoOn()
    ? demo.timestampFromMs(ms)
    : fsTimestamp.fromMillis(ms);
}

export function writeBatch(db: any): any {
  if (demoOn()) return demo.writeBatch();
  if (dualOn()) {
    const b = dual.writeBatch();
    const touchedPaths: string[] = [];
    const wrappedDual: any = {
      set(ref: any, data: any, options?: any): any { touchedPaths.push(ref?.path); b.set(ref, data, options); return wrappedDual; },
      update(ref: any, data: any): any { touchedPaths.push(ref?.path); b.update(ref, data); return wrappedDual; },
      delete(ref: any): any { touchedPaths.push(ref?.path); b.delete(ref); return wrappedDual; },
      commit(): Promise<void> {
        return (async () => {
          await assertFirestoreAllowed({ kind: "write" });
          await b.commit();
          for (const path of touchedPaths) if (typeof path === "string") invalidateRefForDocPath(path);
        })();
      },
    };
    return wrappedDual;
  }
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
      return (async () => {
        // v1.41.0 流量控管：維護開啟且非管理員時阻擋整批寫入
        await assertFirestoreAllowed({ kind: "write" });
        await batch.commit();
        for (const path of touched) invalidateRefForDocPath(path);
      })();
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
