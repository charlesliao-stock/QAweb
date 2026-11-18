/**
 * 排程查閱整頁式（v1.88.6）：審查區間推導（純函式，不碰 Firestore，可 node 測試）。
 *
 * 一個審查區間＝一個審查起始月＋有效區間月數連續展開；
 * 臨時排程（加審／自審）區間長度為 1（單月）。
 * 區間標籤格式依使用者定案：1 個月如「2026/10」，3 個月如「2026/10-2026/12」。
 */

import { monthToCalendarYear } from "./cycle";
import {
  parseScheduleMonths,
  resolveIntervalMonths,
  type ReviewFrequency,
  type ReviewInterval,
  type ScheduleCategory,
} from "./scheduling";
import { fmtYm, formatDateSlash, normalizeReviewMonths, pad2 } from "./ym";

/** 一個審查區間（起始月＋連續月數展開後的曆年月集合） */
export interface ScheduleReviewInterval {
  /** 區間 id（起始年月，如 "2026-10"） */
  id: string;
  startYear: number;
  startMonth: number;
  endYear: number;
  endMonth: number;
  /** 顯示標籤（1 個月如 "2026/10"，3 個月如 "2026/10-2026/12"） */
  label: string;
  /** 區間內全部曆年月（依曆年月排序） */
  months: { year: number; month: number }[];
}

/** 區間標籤：起訖同月只顯示該月，否則「起–訖」（v1.88.15：月不補零） */
export function reviewIntervalLabel(
  startYear: number,
  startMonth: number,
  endYear: number,
  endMonth: number,
): string {
  const s = fmtYm(startYear, startMonth);
  if (startYear === endYear && startMonth === endMonth) return s;
  return `${s}-${fmtYm(endYear, endMonth)}`;
}

function addCalMonths(
  y: number,
  m: number,
  n: number,
): { year: number; month: number } {
  const total = y * 12 + (m - 1) + n;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

/**
 * 由排程推導審查區間清單（依起始曆年月排序）。
 * 區間長度＝有效區間月數（已存值優先，無則由頻次推導，皆無→1）；
 * 臨時排程一律為 1 個月。
 */
export function buildReviewIntervals(sched: {
  category: ScheduleCategory;
  period: string;
  months: number[];
  frequency: ReviewFrequency | null;
  intervalMonths: ReviewInterval | null;
  /** v1.88.19：臨時排程明確曆年月（有值時 temp 每個曆月各為一區） */
  calendarMonths?: string[];
}): ScheduleReviewInterval[] {
  // v1.88.19：臨時排程有明確曆年月時，每個曆月各為一個 1 個月區間
  //（13 個月可能跨曆年，months＋period 年無法表達）。
  if (sched.category === "temp") {
    const explicit = normalizeReviewMonths(sched.calendarMonths);
    if (explicit.length > 0) {
      const out: ScheduleReviewInterval[] = [];
      for (const ym of explicit) {
        const m = ym.match(/^(\d{4})\/(\d{2})$/);
        if (!m) continue;
        const y = Number(m[1]);
        const mo = Number(m[2]);
        out.push({
          id: `${y}-${pad2(mo)}`,
          startYear: y,
          startMonth: mo,
          endYear: y,
          endMonth: mo,
          label: reviewIntervalLabel(y, mo, y, mo),
          months: [{ year: y, month: mo }],
        });
      }
      out.sort((a, b) => a.startYear - b.startYear || a.startMonth - b.startMonth);
      return out;
    }
  }
  const starts = parseScheduleMonths(sched.months);
  const len =
    sched.category === "temp"
      ? 1
      : (resolveIntervalMonths(sched.frequency, sched.intervalMonths) ?? 1);
  const out: ScheduleReviewInterval[] = [];
  for (const m of starts) {
    const y = monthToCalendarYear(sched.category, sched.period, m);
    const months: { year: number; month: number }[] = [];
    for (let i = 0; i < len; i++) months.push(addCalMonths(y, m, i));
    const last = months[months.length - 1];
    out.push({
      id: `${y}-${pad2(m)}`,
      startYear: y,
      startMonth: m,
      endYear: last.year,
      endMonth: last.month,
      label: reviewIntervalLabel(y, m, last.year, last.month),
      months,
    });
  }
  out.sort((a, b) => a.startYear - b.startYear || a.startMonth - b.startMonth);
  return out;
}

/** 某曆年月是否落在區間內 */
export function intervalContains(
  iv: ScheduleReviewInterval,
  year: number,
  month: number,
): boolean {
  return iv.months.some((ym) => ym.year === year && ym.month === month);
}

/**
 * 區間截止日標題：區間內任務截止日皆相同→該日；不一致→「最早–最晚」；
 * 無任務截止日→「—」。日期統一顯示為 YYYY/M/D（v1.88.7；v1.88.15 起不補零）。
 */
export function intervalDeadlineLabel(deadlines: string[]): string {
  const uniq = [...new Set(deadlines.filter(Boolean))].sort();
  if (uniq.length === 0) return "—";
  if (uniq.length === 1) return formatDateSlash(uniq[0]);
  return `${formatDateSlash(uniq[0])}–${formatDateSlash(uniq[uniq.length - 1])}`;
}
