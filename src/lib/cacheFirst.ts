/**
 * Firestore 持久快取 cache-first 讀法（v1.28 階段 7，提案 B3）。
 *
 * 前置：firebase.ts 的 getFirebaseDb() 已啟用 persistentLocalCache
 *（IndexedDB，多分頁共用；Safari 私密模式等不可用時退回預設行為）。
 * 只開快取開關不改讀法是省不到錢的（getDocs() 預設先問伺服器，一定計費），
 * 故參考資料改走本模組：先讀快取、命中免計費、未命中回伺服器。
 *
 * 範圍（收斂）：只走 refCache 漏斗的參考資料——指標／群組／單位／
 * 角色／職稱集合＋systemParams/config（變化慢）。users 全集合查詢改走
 * getDocsFromServer：Firestore 本機 query cache 可能只包含先前讀過的文件，
 * 不能保證是完整人員名單。reviewRecords／
 * reviewTasks 保持伺服器優先（變化快、正確性優先），不擴大範圍。
 * 呼叫端不需逐處改寫：遷移方式是把 refCache fetcher 內的 getDocs／getDoc
 * 換成本模組的 getDocsCacheFirst／getDocCacheFirst。
 *
 * 失效與新鮮度（誠實說明）：
 * - 自己寫入：SDK 本地寫入會同步更新持久快取內對應文件；寫入成功後
 *   refCache 記憶體快取也失效（db.ts 統一出口），兩套失效不打架。
 * - 他人寫入：持久快取不會自動知道。畫面照舊顯示「資料時間」；
 *   按「重新整理」會呼叫 forceServerRefetch()，其後 30 秒強制走伺服器，
 *   讓重新整理真的拿到最新資料。
 * - 跨分頁／跨天重訪：持久快取命中時直接回上次的參考資料（變化慢的
 *   集合可接受），不計費；要最新請按重新整理。
 * - 空集合：快取永遠是空，每次新工作階段仍付一次伺服器讀取，與改前一致。
 *
 * 展示模式隔離：demo 走 lib/db.ts 記憶體實作、零 Firestore 成本；
 * 本模組在 demo 模式下直接透傳 db.ts 的 getDocs／getDoc，絕不呼叫
 * Firestore SDK（demo 的 query 物件不是真正的 SDK Query，傳進 SDK 會錯）。
 * 快取不可用時（例如持久快取未啟用）一律退回預設伺服器讀取，不拋錯。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  getDocFromCache as fsGetDocFromCache,
  getDocFromServer as fsGetDocFromServer,
  getDocsFromCache as fsGetDocsFromCache,
  getDocsFromServer as fsGetDocsFromServer,
  type DocumentSnapshot,
  type QuerySnapshot,
} from "firebase/firestore";
import { getDoc as dbGetDoc, getDocs as dbGetDocs } from "./db";
import { isDemoMode } from "./demoMode";

export interface CacheFirstApi {
  isDemoMode: () => boolean;
  getDocs: (q: any) => Promise<QuerySnapshot>;
  getDoc: (ref: any) => Promise<DocumentSnapshot>;
  getDocsFromCache: (q: any) => Promise<QuerySnapshot>;
  getDocsFromServer: (q: any) => Promise<QuerySnapshot>;
  getDocFromCache: (ref: any) => Promise<DocumentSnapshot>;
  getDocFromServer: (ref: any) => Promise<DocumentSnapshot>;
}

const defaultApi: CacheFirstApi = {
  isDemoMode,
  getDocs: (q: any) => dbGetDocs(q),
  getDoc: (ref: any) => dbGetDoc(ref),
  getDocsFromCache: (q: any) => fsGetDocsFromCache(q),
  getDocsFromServer: (q: any) => fsGetDocsFromServer(q),
  getDocFromCache: (ref: any) => fsGetDocFromCache(ref),
  getDocFromServer: (ref: any) => fsGetDocFromServer(ref),
};

let api: CacheFirstApi = defaultApi;

/** 測試接縫：注入假 API；測試結束用 resetCacheFirstApi() 還原。 */
export function setCacheFirstApi(next: CacheFirstApi): void {
  api = next;
}

export function resetCacheFirstApi(): void {
  api = defaultApi;
}

/** 手動「重新整理」後強制走伺服器的窗口（毫秒 epoch）。 */
let serverOnlyUntil = 0;

/**
 * 手動重新整理時呼叫：其後 `seconds` 秒內參考資料強制走伺服器，
 * 讓重新整理真的拿到最新資料（否則會命中可能過期的持久快取）。
 */
export function forceServerRefetch(seconds = 30): void {
  serverOnlyUntil = Date.now() + seconds * 1000;
}

export function isServerOnlyNow(): boolean {
  return Date.now() < serverOnlyUntil;
}

/** 測試用：清除強制走伺服器窗口。 */
export function clearServerOnly(): void {
  serverOnlyUntil = 0;
}

/**
 * 集合查詢：先讀快取（命中免計費），未命中回伺服器；
 * 快取不可用時退回預設伺服器讀取。demo 模式直接走記憶體實作。
 */
export async function getDocsCacheFirst(q: any): Promise<QuerySnapshot> {
  if (api.isDemoMode()) return api.getDocs(q);
  if (isServerOnlyNow()) return api.getDocsFromServer(q);
  try {
    const cached = await api.getDocsFromCache(q);
    if (!cached.empty) return cached;
    return await api.getDocsFromServer(q);
  } catch {
    return api.getDocs(q);
  }
}

/**
 * 單一文件查詢：先讀快取（命中免計費），未命中回伺服器；
 * 快取不可用時退回預設伺服器讀取。demo 模式直接走記憶體實作。
 */
export async function getDocCacheFirst(ref: any): Promise<DocumentSnapshot> {
  if (api.isDemoMode()) return api.getDoc(ref);
  if (isServerOnlyNow()) return api.getDocFromServer(ref);
  try {
    const cached = await api.getDocFromCache(ref);
    if (cached.exists()) return cached;
    return await api.getDocFromServer(ref);
  } catch {
    return api.getDoc(ref);
  }
}
