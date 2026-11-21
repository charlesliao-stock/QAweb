/**
 * 結果分析每列合併格（v1.88.17，純函式，不碰 Firestore，可 node 測試）。
 *
 * v1.88.13 的月模式欄位是「全頁可見指標排程區間的聯集」，季審合併欄與
 * 月審單月欄並存、同一月份重複計算，且一支指標的區間會污染其他列。
 * v1.88.17 改為：表頭固定一月一格；資料格按「每支指標自己的排程區間」
 * colspan 合併（每列各自合併，互不干擾）。
 *
 * - 區間來自每支排程自己的起始月份及審查區間（intervalMonths；
 *   buildReviewIntervals 已處理，未存 intervalMonths 的舊排程才由頻次推導）。
 * - 加審月份不併入合併格：該月從區間中切出、獨立成一格（temp: true），
 *   區間其餘月份仍照常合併。
 * - 同一指標多支排程區間重疊時分列呈現（見 groupSchedulesForRows）。
 */

import {
  intervalRangeLabel,
  type AnalysisPeriodColumn,
  type CalendarMonth,
} from "./analysisPeriod";
import {
  buildReviewIntervals,
  type ScheduleReviewInterval,
} from "./scheduleIntervals";
import type {
  ReviewFrequency,
  ReviewInterval,
  ScheduleCategory,
} from "./scheduling";
import { fmtYm } from "./ym";

/** 一列的一格：月份集合＋標籤（AnalysisPeriodColumn 形狀，可直接當欄位傳給 cellValue 等）。 */
export interface RowSpan extends AnalysisPeriodColumn {
  /** "interval"＝排程區間合併格（>1 月）；"single"＝單月格 */
  kind: "interval" | "single";
  /** 加審單月格：該月有加審紀錄，不參與區間合併 */
  temp?: boolean;
}

const monthKeyOf = (m: CalendarMonth): string => `${m.year}-${m.month}`;

/** 單月格（無排程區間覆蓋時）。 */
export function singleMonthSpan(m: CalendarMonth): RowSpan {
  return {
    key: monthKeyOf(m),
    label: fmtYm(m.year, m.month),
    months: [m],
    kind: "single",
  };
}

/** 區間裁切到所選月份範圍（只留範圍內的月份；空區間丟棄）。 */
export function clipIntervalsToMonths(
  intervals: ScheduleReviewInterval[],
  months: CalendarMonth[],
): ScheduleReviewInterval[] {
  const wanted = new Set(months.map(monthKeyOf));
  const out: ScheduleReviewInterval[] = [];
  for (const iv of intervals) {
    const kept = iv.months.filter((m) => wanted.has(monthKeyOf(m)));
    if (kept.length === 0) continue;
    out.push({ ...iv, months: kept });
  }
  return out;
}

/**
 * 由月份清單＋該列的排程區間＋加審月份，建出該列的 spans。
 * 保證：spans 依月排序、月份恰好覆蓋 months 一次（partition，無重疊、無缺漏）。
 * - 同一區間內連續月份合併成一格（label 為起訖格式，如 2026/9–2026/11）；
 * - 加審月份獨立成一格（temp: true），切斷所在區間；
 * - 未被區間覆蓋的月份各為一格；
 * - 同月被多個區間覆蓋時，以起始月較早者優先（同一指標多支排程重疊時，
 *   呼叫端應先以 groupSchedulesForRows 分列；此處僅為防禦性 fallback）。
 */
export function buildRowSpans(
  months: CalendarMonth[],
  intervals: ScheduleReviewInterval[],
  tempMonthKeys: ReadonlySet<string>,
): RowSpan[] {
  const monthSet = new Set(months.map(monthKeyOf));
  const sorted = [...intervals].sort(
    (a, b) => a.startYear - b.startYear || a.startMonth - b.startMonth,
  );
  const cover = new Map<string, string>();
  for (const iv of sorted) {
    for (const m of iv.months) {
      const k = monthKeyOf(m);
      if (monthSet.has(k) && !cover.has(k)) cover.set(k, iv.id);
    }
  }
  const spans: RowSpan[] = [];
  let i = 0;
  while (i < months.length) {
    const m = months[i];
    const k = monthKeyOf(m);
    if (tempMonthKeys.has(k)) {
      spans.push({
        key: k,
        label: fmtYm(m.year, m.month),
        months: [m],
        kind: "single",
        temp: true,
      });
      i += 1;
      continue;
    }
    const ivId = cover.get(k);
    if (!ivId) {
      spans.push(singleMonthSpan(m));
      i += 1;
      continue;
    }
    const run: CalendarMonth[] = [m];
    let j = i + 1;
    while (j < months.length) {
      const nm = months[j];
      const nk = monthKeyOf(nm);
      if (tempMonthKeys.has(nk) || cover.get(nk) !== ivId) break;
      run.push(nm);
      j += 1;
    }
    spans.push({
      key: k,
      label: intervalRangeLabel(run),
      months: run,
      kind: run.length > 1 ? "interval" : "single",
    });
    i = j;
  }
  return spans;
}

/** 一支排程及其（已裁切到查詢範圍的）區間。 */
export interface ScheduleSpanInput {
  /** 排程文件 id（scheduleDocId），組內唯一即可 */
  key: string;
  /** 顯示標籤（「2026年度」／「115學年度」），分列時接在指標名稱後 */
  periodLabel: string;
  intervals: ScheduleReviewInterval[];
}

/** 一列的排程分組：組內排程區間互不重疊，可合併成一列的 spans。 */
export interface ScheduleSpanGroup {
  /** 組內第一支排程的 key（列 id 用） */
  key: string;
  periodLabels: string[];
  intervals: ScheduleReviewInterval[];
}

/**
 * 同一指標多支排程分組（v1.88.17 Q2）：區間重疊的排程分到不同列，
 * 不重疊的排程併在同一列。基本上不會重疊（各排程起始月間距＝區間長度），
 * 萬一重疊（如年度＋學年度期別並存、頻次改過留舊排程）才分列。
 * first-fit：依第一區間起始月排序後，依序放入第一個無重疊的組，否則開新組。
 */
export function groupSchedulesForRows(
  schedules: ScheduleSpanInput[],
): ScheduleSpanGroup[] {
  const firstStart = (s: ScheduleSpanInput): number => {
    let best = Number.POSITIVE_INFINITY;
    for (const iv of s.intervals) {
      best = Math.min(best, iv.startYear * 12 + iv.startMonth);
    }
    return best;
  };
  const monthsOf = (s: ScheduleSpanInput): Set<string> =>
    new Set(
      s.intervals.flatMap((iv) => iv.months.map((m) => monthKeyOf(m))),
    );
  const sorted = [...schedules].sort((a, b) => firstStart(a) - firstStart(b));
  const groups: ScheduleSpanGroup[] = [];
  for (const s of sorted) {
    const sMonths = monthsOf(s);
    let placed = false;
    for (const g of groups) {
      const gMonths = new Set(
        g.intervals.flatMap((iv) => iv.months.map((m) => monthKeyOf(m))),
      );
      let overlap = false;
      for (const k of sMonths) {
        if (gMonths.has(k)) {
          overlap = true;
          break;
        }
      }
      if (!overlap) {
        g.periodLabels.push(s.periodLabel);
        g.intervals.push(...s.intervals);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push({
        key: s.key,
        periodLabels: [s.periodLabel],
        intervals: [...s.intervals],
      });
    }
  }
  for (const g of groups) {
    g.intervals.sort(
      (a, b) => a.startYear - b.startYear || a.startMonth - b.startMonth,
    );
  }
  return groups;
}

/* ================= 曲線圖 X 軸標籤（v1.88.45） ================= */

/**
 * 一個區間一個點，點以區間的第一個月為主：X 軸標籤取 span 內第一個月
 *（如 9-11 月區間的點標為 2026/9）。單月格回傳該月本身。
 * hover 提示仍用 span 完整標籤（起訖），不經此函式。
 */
export function firstMonthLabel(col: AnalysisPeriodColumn): string {
  const m = col.months[0];
  return fmtYm(m.year, m.month);
}

/** 由一支排程推導其（已裁切到查詢範圍的）區間；範圍外無區間回 []。 */
export function scheduleIntervalsInRange(
  sched: {
    category: ScheduleCategory;
    period: string;
    months: number[];
    frequency: ReviewFrequency | null;
    intervalMonths: ReviewInterval | null;
  },
  rangeMonths: CalendarMonth[],
): ScheduleReviewInterval[] {
  return clipIntervalsToMonths(buildReviewIntervals(sched), rangeMonths);
}
