import { belowClass } from "../../../lib/analysisRates";
import type { CapaCase } from "../../capa/model";

export function fmtRate(rate: number | null): string {
  return rate == null ? "—" : `${rate.toFixed(1)}%`;
}

/** 低於閾值時回傳 " below"（紅字樣式），否則空字串；閾值未設定（<=0）不標示 */
export function isBelow(rate: number | null | undefined, threshold: number | undefined): string {
  return belowClass(rate, threshold);
}

/** CAPA 案件的來源月份（periodKeys 最後一筆，YYYY-MM）是否落在該欄的月份內 */
export function capaInColumn(item: CapaCase, months: { year: number; month: number }[]): boolean {
  const last = item.periodKeys[item.periodKeys.length - 1];
  const m = /^(\d{4})-(\d{1,2})$/.exec(last ?? "");
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return months.some((x) => x.year === y && x.month === mo);
}
