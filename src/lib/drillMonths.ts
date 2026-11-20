/**
 * 指標分析卡片下探（全期間欄）的月份展開共用純函式。
 *
 * 背景：指標分析上方 4 張統計卡片點選下探時，傳入全期間欄
 * （key "__all__"，months＝全部已查月份）；下探 L1 不再把整個期間彙總
 * 成一欄，改為逐月欄（列＝單位／人次模式為受審人員，欄＝月份），
 * 與組別分析矩陣同一呈現、只含該支指標。
 */
import type { RowSpan } from "./analysisSpans";
import type { AnalysisRecord } from "./analysisRates";

export type DrillMonth = { year: number; month: number };

export function drillMonthKey(m: DrillMonth): string {
  return `${m.year}-${m.month}`;
}

/**
 * 「未審月份不顯示」（span 層級，與組別／單位矩陣 visibleColumns 同規則）：
 * 某月可見 ⇔ 有排程 span 含它、且該 span 內有審查資料（原始紀錄或封存摘要）。
 * spans 為空（無排程區間可對照，例如純匯入指標）時退回逐月判定：
 * 該月本身有資料才顯示。
 */
export function visibleDrillMonths(
  months: DrillMonth[],
  spans: RowSpan[],
  hasData: (months: DrillMonth[]) => boolean,
): DrillMonth[] {
  if (spans.length === 0) return months.filter((m) => hasData([m]));
  const visibleKeys = new Set<string>();
  for (const span of spans) {
    if (!hasData(span.months)) continue;
    for (const m of span.months) visibleKeys.add(drillMonthKey(m));
  }
  return months.filter((m) => visibleKeys.has(drillMonthKey(m)));
}

/** 人次模式列：期間內受審人員（去重、按職編排序）。 */
export function drillPersonRows(
  records: AnalysisRecord[],
): { empNo: string; name: string; unitId: string }[] {
  const map = new Map<string, { empNo: string; name: string; unitId: string }>();
  for (const r of records) {
    if (!map.has(r.personEmpNo)) {
      map.set(r.personEmpNo, {
        empNo: r.personEmpNo,
        name: r.personName,
        unitId: r.unitId,
      });
    }
  }
  return [...map.values()].sort((a, b) => a.empNo.localeCompare(b.empNo, "zh-Hant"));
}
