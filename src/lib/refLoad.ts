/**
 * 參考集合的「唯一」讀取入口（取代各頁各寫一份 fetcher）。
 *
 * 過去各頁各自傳 fetcher 給 refCache，同一個快取鍵卻帶著不同的 limit／讀法
 * （例如 users 有的 limit(1000)、有的不設限），先載入的頁面決定快取內容，
 * 人數超過上限時其他頁會悄悄拿到被截斷的名單。現在每個集合只有一支 fetcher：
 * - users：走伺服器（本機 query cache 不保證完整人員名單），不設 limit；
 * - 其餘參考集合：cache-first（變化慢，命中免計費）。
 * 同分頁記憶體快取、進行中請求去重、寫入後自動失效，皆由 refCache／db.ts 負責。
 */
import { collection, getDocsFromServer } from "./db";
import { getDocsCacheFirst } from "./cacheFirst";
import { getFirebaseDb } from "./firebase";
import { getCachedRefCollection, type RefCollectionName } from "./refCache";

export function loadRefCollection(name: RefCollectionName) {
  return getCachedRefCollection(name, () => {
    const db = getFirebaseDb();
    return name === "users"
      ? getDocsFromServer(collection(db, name))
      : getDocsCacheFirst(collection(db, name));
  });
}
