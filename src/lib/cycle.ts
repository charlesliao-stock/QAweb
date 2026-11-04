/**
 * 排程週期純函式（v1.16.0 新增）。
 *
 * 排程分三類別：年度（曆年 1–12 月）／學年度（8 月制）／臨時。
 * 本檔零依賴、不碰 DOM、不碰 Firestore，可在 jsdom／node 直接單元測試。
 */

/** 排程類別：年度（曆年）／學年度（8 月制）／臨時 */
export type CycleCategory = "year" | "academic" | "temp";

export const CYCLE_CATEGORIES: CycleCategory[] = ["year", "academic", "temp"];

/** 類別中文標籤：年度／學年度／臨時 */
export function categoryLabel(c: string): string {
  if (c === "year") return "年度";
  if (c === "academic") return "學年度";
  if (c === "temp") return "臨時";
  return c;
}

/** 民國年＝西元年 − 1911 */
export function rocYear(year: number): number {
  return year - 1911;
}

/**
 * 8 月制學年度（民國年）：8 月起算新學年度。
 * 2026-11 → 115，2027-03 → 115，2027-08 → 116。
 */
export function academicYearOf(d: Date): number {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  return m >= 8 ? rocYear(y) : rocYear(y) - 1;
}

/**
 * 曆年月 → 週期鍵。
 * 年度：直接用西元年字串；學年度：month≥8 → year−1911，否則 year−1912。
 */
export function toCycleKey(
  year: number,
  month: number,
  cycle: "year" | "academic",
): string {
  if (cycle === "academic") {
    return String(month >= 8 ? year - 1911 : year - 1912);
  }
  return String(year);
}

/** 目前的週期鍵（now 預設現在；可注入方便測試） */
export function currentCycleKey(
  cycle: "year" | "academic",
  now: Date = new Date(),
): string {
  return toCycleKey(now.getFullYear(), now.getMonth() + 1, cycle);
}

/**
 * 週期內的月份順序。
 * 年度 → [1..12]；學年度 → [8,9,10,11,12,1,2,3,4,5,6,7]；臨時 → [1..12]
 *（period 參數保留供未來週期擴充，目前不影響結果）。
 */
export function cycleMonths(category: CycleCategory, _period: string): number[] {
  if (category === "academic") {
    return [8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7];
  }
  return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
}

/**
 * 週期月份 → 曆年。
 * 學年度 period "115"：8–12 月 → 2026，1–7 月 → 2027；
 * 年度 period "2026" → 2026；
 * 臨時：period 為建立時間戳字串，取其年份（解析失敗退回今年）。
 */
export function monthToCalendarYear(
  category: CycleCategory,
  period: string,
  month: number,
): number {
  if (category === "academic") {
    const p = parseInt(period, 10);
    const roc = Number.isFinite(p) ? p : academicYearOf(new Date());
    return month >= 8 ? roc + 1911 : roc + 1912;
  }
  if (category === "temp") {
    const t = Number(period);
    const d = Number.isFinite(t) && t > 0 ? new Date(t) : new Date();
    return d.getFullYear();
  }
  const y = parseInt(period, 10);
  return Number.isFinite(y) ? y : new Date().getFullYear();
}

/** 週期顯示標籤：「2026年度」／「115學年度」／「臨時」 */
export function periodLabel(category: CycleCategory, period: string): string {
  if (category === "temp") return "臨時";
  if (category === "academic") return `${period}學年度`;
  return `${period}年度`;
}
