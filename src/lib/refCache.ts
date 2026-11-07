/**
 * 參考資料記憶體快取（v1.28 階段 4，提案 B2）。
 *
 * 範圍：六個參考集合 indicators／groups／units／users／roles／titles
 * ＋ systemParams/config 單一文件。不要快取 reviewTasks／reviewRecords
 *（那是階段 3 按年份快取的範圍）。
 *
 * 存放位置：模組級 Map（記憶體），與階段 3 的 resultsCache.ts 同一層、
 * 同一模式。分頁關閉、重新整理、登出都會消失，無殘留；每分頁第一次
 * 進頁仍要全付，重新整理／新分頁重付。
 *
 * 參考資料本身不分權限範圍（權限過濾在前端），所以快取鍵只有集合名，
 * 不像 resultsCache 需要含權限範圍。但 users 含人員資料：人員異動後
 * 必須失效，否則會看到舊的人員名單——失效走 lib/db.ts 統一出口，
 * 任何寫入成功後依 ref path 自動失效對應集合（見 db.ts），呼叫端
 * 不必逐處補失效。
 *
 * 並行去重：同時發出的同一集合讀取共用同一個 Promise（in-flight 去重），
 * 取代 GroupsPage v1.27.2 的 usersInflight；進行中的去重＋命中後的
 * 跨頁共用，兩層都在這裡。
 *
 * 展示模式：demo 走 lib/db.ts 記憶體實作、讀取本身已是零 Firestore
 * 成本，本模組在 demo 模式下直接透傳 fetcher、不讀不寫快取，
 * 快取邏輯不污染 demo 路徑。
 *
 * 本模組是純邏輯，不直接碰 Firestore（fetcher 由呼叫端傳入），
 * 方便單元測試。
 */
import { isDemoMode } from "./demoMode";

export type RefCollectionName =
  | "indicators"
  | "groups"
  | "units"
  | "users"
  | "roles"
  | "titles"
  | "uiThemes";

export const REF_COLLECTIONS: readonly RefCollectionName[] = [
  "indicators",
  "groups",
  "units",
  "users",
  "roles",
  "titles",
  "uiThemes",
] as const;

/** systemParams/config 單一文件的快取鍵 */
export const SYSTEM_CONFIG_KEY = "systemParams/config";

function isRefCollection(name: string): name is RefCollectionName {
  return (REF_COLLECTIONS as readonly string[]).includes(name);
}

interface CacheEntry {
  value: unknown;
  /** 該集合資料的抓取時間（毫秒 epoch），畫面顯示「資料時間」用 */
  fetchedAt: number;
}

/** 模組級記憶體快取：分頁關閉即消失 */
const cache = new Map<string, CacheEntry>();
/** 進行中的讀取：同一鍵共用一個 Promise，只發一次查詢 */
const inflight = new Map<string, Promise<unknown>>();

function cacheKey(name: string): string {
  return name;
}

/**
 * 取參考集合（或單一文件）：命中直接回傳；未命中發一次查詢，
 * 同時發出的重複呼叫共用同一個 Promise。demo 模式不快取、直接查。
 */
export function getCachedRef<T>(
  key: string,
  fetcher: () => Promise<T>,
): Promise<T> {
  if (isDemoMode()) return fetcher();
  const hit = cache.get(cacheKey(key));
  if (hit) return Promise.resolve(hit.value as T);
  const pending = inflight.get(cacheKey(key));
  if (pending) return pending as Promise<T>;
  const p = fetcher()
    .then((value) => {
      cache.set(cacheKey(key), { value, fetchedAt: Date.now() });
      return value;
    })
    .finally(() => {
      inflight.delete(cacheKey(key));
    });
  inflight.set(cacheKey(key), p);
  return p;
}

/** 參考集合的語意包裝：鍵即集合名 */
export function getCachedRefCollection<T>(
  name: RefCollectionName,
  fetcher: () => Promise<T>,
): Promise<T> {
  return getCachedRef(name, fetcher);
}

/** 失效一個參考集合（寫入成功後呼叫；db.ts 統一出口會自動做） */
export function invalidateRefCollection(name: RefCollectionName): void {
  cache.delete(cacheKey(name));
}

/** 失效 systemParams/config */
export function invalidateRefConfig(): void {
  cache.delete(cacheKey(SYSTEM_CONFIG_KEY));
}

/**
 * 依 Firestore 文件路徑失效對應快取（供 lib/db.ts 寫入出口用）。
 * 路徑形如 `users/EMP001` → 失效 users；`systemParams/config` → 失效
 * config；子集合路徑如 `indicators/xx/versions/v1.0` → 失效首段集合
 * indicators（過度失效，安全方向：版本寫入本來就連帶更新指標文件）。
 * 非參考集合路徑 → 不做任何事。
 */
export function invalidateRefForDocPath(path: string): void {
  if (typeof path !== "string" || path.length === 0) return;
  if (path === SYSTEM_CONFIG_KEY) {
    invalidateRefConfig();
    return;
  }
  const first = path.split("/")[0];
  if (isRefCollection(first)) invalidateRefCollection(first);
}

/** 該鍵最近一次抓取時間；未快取為 null */
export function getRefCacheFetchedAt(key: string): number | null {
  return cache.get(cacheKey(key))?.fetchedAt ?? null;
}

/** 測試／登出用：清空全部參考快取（含進行中去重） */
export function clearRefCache(): void {
  cache.clear();
  inflight.clear();
}
