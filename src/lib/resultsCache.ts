/**
 * 結果分析按年份快取（v1.28 階段 3，第一階段：記憶體內）。
 *
 * 快取鍵必須含權限範圍，格式 `{collection}:{year}:{scopeKind}:{scopeId}`，
 * 例如 `reviewRecords:2026:admin`、`reviewRecords:2026:reviewer:empNo123`、
 * `reviewRecords:2026:staff:UNIT01`。不可只用年份當鍵：紀錄是先全量拉回、
 * 再依權限在前端過濾，管理員查過的年份快取被審查員直接拿去用就是越權。
 *
 * 存放位置：模組級 Map（記憶體），分頁關閉即消失、零殘留。
 * 失效：自己寫入後失效對應年份（呼叫端在寫入後呼叫 invalidate）；
 * 別人寫的看不到，直到手動「重新整理」（失效＋重查）或分頁重開。
 * 本模組是純邏輯，不碰 Firestore，方便單元測試。
 */

export type ResultsCacheScope =
  | { kind: "admin" }
  | { kind: "reviewer"; staffId: string }
  | { kind: "staff"; unitCode: string };

export type ResultsCacheCollection = "reviewRecords" | "reviewTasks";

/** 權限範圍鍵：admin／reviewer:<staffId>／staff:<unitCode> */
export function resultsScopeKey(scope: ResultsCacheScope): string {
  if (scope.kind === "admin") return "admin";
  if (scope.kind === "reviewer") return `reviewer:${scope.staffId}`;
  return `staff:${scope.unitCode}`;
}

/** 快取鍵：`{collection}:{year}:{scopeKind}:{scopeId}` */
export function resultsCacheKey(
  collection: ResultsCacheCollection,
  year: number,
  scope: ResultsCacheScope,
): string {
  return `${collection}:${year}:${resultsScopeKey(scope)}`;
}

interface CacheEntry<T> {
  year: number;
  docs: T[];
  /** 該年份資料的抓取時間（毫秒 epoch），畫面顯示「資料時間」用 */
  fetchedAt: number;
}

/** 模組級記憶體快取：分頁關閉即消失 */
const cache = new Map<string, CacheEntry<unknown>>();

export function setCachedYear<T>(
  collection: ResultsCacheCollection,
  year: number,
  scope: ResultsCacheScope,
  docs: T[],
): void {
  cache.set(resultsCacheKey(collection, year, scope), {
    year,
    docs,
    fetchedAt: Date.now(),
  });
}

export interface CachedYears<T> {
  /** 已命中的年份 → 文件（不保證順序，呼叫端用 mergeYearDocs 合併） */
  hits: Map<number, T[]>;
  /** 未命中的年份（需發查詢），依傳入順序 */
  missing: number[];
  /** 命中年份中最新的抓取時間；無命中為 null */
  fetchedAt: number | null;
}

export function getCachedYears<T>(
  collection: ResultsCacheCollection,
  years: number[],
  scope: ResultsCacheScope,
): CachedYears<T> {
  const hits = new Map<number, T[]>();
  const missing: number[] = [];
  let fetchedAt: number | null = null;
  for (const y of years) {
    const entry = cache.get(
      resultsCacheKey(collection, y, scope),
    ) as CacheEntry<T> | undefined;
    if (entry) {
      hits.set(y, entry.docs);
      fetchedAt =
        fetchedAt == null ? entry.fetchedAt : Math.max(fetchedAt, entry.fetchedAt);
    } else {
      missing.push(y);
    }
  }
  return { hits, missing, fetchedAt };
}

/** 年份由小到大合併快取命中與新查回的文件 */
export function mergeYearDocs<T>(
  hits: Map<number, T[]>,
  fresh: Map<number, T[]>,
): T[] {
  const years = [...new Set([...hits.keys(), ...fresh.keys()])].sort(
    (a, b) => a - b,
  );
  const out: T[] = [];
  for (const y of years) {
    const h = hits.get(y);
    if (h) out.push(...h);
    const f = fresh.get(y);
    if (f) out.push(...f);
  }
  return out;
}

export function invalidateCachedYear(
  collection: ResultsCacheCollection,
  year: number,
  scope: ResultsCacheScope,
): void {
  cache.delete(resultsCacheKey(collection, year, scope));
}

export function invalidateCachedYears(
  collection: ResultsCacheCollection,
  years: number[],
  scope: ResultsCacheScope,
): void {
  for (const y of years) invalidateCachedYear(collection, y, scope);
}

/** 測試／登出用：清空全部快取 */
export function clearResultsCache(): void {
  cache.clear();
}
