/**
 * CAPA 連續未達標偵測（v1.88.18，純函式，不碰 Firestore，可 node 測試）。
 *
 * 一個排程區間（span）算一次審查，不按月算；不論區間或單月，
 * 連續 need 次未達標就觸發。無資料的期不列入；中間有一次達標即中斷連續。
 * 加審月份歸併原區間、不另算一期（呼叫端傳入的 spans 不應把加審月切出）。
 *
 * periods 依月排序（buildRowSpans 的 partition，一個月只屬一個 span）；
 * selectedMonths 為選定格的月份，其最後一個月決定截止位置（取包含該月的 span
 * 之前的所有 span）。選定期本身須有資料且為最新一期才觸發。
 */
import { pad2 } from "./ym";
import type { CalendarMonth } from "./analysisPeriod";

/** 一次審查：一個排程區間或一個單月。 */
export interface CapaReviewPeriod {
  label: string;
  months: CalendarMonth[];
}

export interface CapaTriggerPoint {
  label: string;
  rate: number;
  /** 該期內最後一筆有資料月份（YYYY-MM），案件 periodKeys 用 */
  ym: string;
}

export interface CapaTrigger {
  need: number;
  series: CapaTriggerPoint[];
}

export function detectCapaTrigger(
  periods: CapaReviewPeriod[],
  rateOf: (months: CalendarMonth[]) => { rate: number | null; total: number },
  hasData: (month: CalendarMonth) => boolean,
  selectedMonths: CalendarMonth[],
  need: number,
  threshold: number,
): CapaTrigger | null {
  if (need < 1 || threshold <= 0 || periods.length === 0 || selectedMonths.length === 0) return null;
  const lastSel = selectedMonths[selectedMonths.length - 1];
  const selKey = lastSel.year * 100 + lastSel.month;
  // 截止位置：包含選定最後一個月的 span；找不到（選定月不在 spans 內，如全期間欄超出可見範圍）則取全部。
  let endIdx = periods.findIndex((p) =>
    p.months.some((m) => m.year * 100 + m.month === selKey),
  );
  if (endIdx < 0) endIdx = periods.length - 1;
  const series: CapaTriggerPoint[] = [];
  for (let i = 0; i <= endIdx; i++) {
    const p = periods[i];
    const pr = rateOf(p.months);
    if (pr.rate == null || pr.total === 0) continue;
    const withData =
      [...p.months]
        .sort((a, b) => b.year * 100 + b.month - (a.year * 100 + a.month))
        .find((m) => hasData(m)) ?? p.months[p.months.length - 1];
    series.push({
      label: p.label,
      rate: pr.rate,
      ym: `${withData.year}-${pad2(withData.month)}`,
    });
  }
  if (series.length < need) return null;
  const last = series.slice(-need);
  if (!last.every((x) => x.rate < threshold)) return null;
  // 選定期須為最新一期：最後一筆有資料期的 ym 須落在選定的 span 內。
  // （選單月下探時，選定月所屬的整個區間即為選定期。）
  const lastYm = series[series.length - 1].ym;
  const endSpan = periods[endIdx];
  const selectedHasData = endSpan.months.some(
    (m) => `${m.year}-${pad2(m.month)}` === lastYm,
  );
  if (!selectedHasData) return null;
  return { need, series: last };
}
