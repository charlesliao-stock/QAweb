/**
 * 結果分析矩陣索引化（v1.28 階段 7，提案 A3）。
 *
 * 舊寫法：cellValue() 每格都對全部 scopedRecords 做 filter（矩陣每格一次、
 * 曲線圖逐欄又重算一次），複雜度 O(指標×欄×R)。新寫法：資料進來時預建
 * 一次索引 Map<指標, Map<曆年月, 紀錄[]>>，cellValue 改查表，複雜度
 * O(R＋指標×欄)。
 *
 * 純前端重構，不動查詢與資料結構。等價性：矩陣格／曲線／明細用的聚合
 *（passRateOf／unitPassRate／optionDetailRows）皆為計數，與紀錄順序無關；
 * personOptionRows 會再依職編、年月排序。recordsForIndex 對 months 去重，
 * 與 recordsInMonths（以 Set 過濾）語義一致。
 */
import { monthKey, type AnalysisRecord } from "./analysisRates";

/** 指標 → 曆年月鍵（year*100+month）→ 該月紀錄（保留原始順序） */
export type RecordIndex = Map<string, Map<number, AnalysisRecord[]>>;

/** 進資料時預建一次索引（O(R)）。 */
export function buildRecordIndex(records: AnalysisRecord[]): RecordIndex {
  const index: RecordIndex = new Map();
  for (const r of records) {
    let byMonth = index.get(r.indicatorId);
    if (!byMonth) {
      byMonth = new Map();
      index.set(r.indicatorId, byMonth);
    }
    const key = monthKey(r.year, r.month);
    const bucket = byMonth.get(key);
    if (bucket) bucket.push(r);
    else byMonth.set(key, [r]);
  }
  return index;
}

/**
 * v1.40.2「未審月份不顯示」：某期間欄內的審查總數（指定指標集合＋可再限單位）。
 * 欄位為季／半年／年時，months 涵蓋該區間全部月份，有一筆就算有審查。
 */
export function columnRecordCount(
  index: RecordIndex,
  indicatorIds: string[],
  months: { year: number; month: number }[],
  unitId?: string,
): number {
  let total = 0;
  for (const indicatorId of indicatorIds) {
    total += recordsForIndex(index, indicatorId, months, unitId).length;
  }
  return total;
}

/**
 * 取某指標落在指定曆年月集合內的紀錄（可再限單位）。
 * 與舊寫法 `recordsInMonths(scopedRecords.filter(指標[, 單位]), months)`
 * 同一批紀錄；月份去重後依 months 順序串接。
 * v1.51.0：unitId 為 "" 時限縮為不限單位（unitId === ""）的紀錄；
 * 只有 undefined 才是不限單位（全部）。
 */
export function recordsForIndex(
  index: RecordIndex,
  indicatorId: string,
  months: { year: number; month: number }[],
  unitId?: string,
): AnalysisRecord[] {
  const byMonth = index.get(indicatorId);
  if (!byMonth) return [];
  const seen = new Set<number>();
  const out: AnalysisRecord[] = [];
  for (const m of months) {
    const key = monthKey(m.year, m.month);
    if (seen.has(key)) continue;
    seen.add(key);
    const bucket = byMonth.get(key);
    if (!bucket) continue;
    if (unitId !== undefined) {
      for (const r of bucket) if (r.unitId === unitId) out.push(r);
    } else {
      out.push(...bucket);
    }
  }
  return out;
}
