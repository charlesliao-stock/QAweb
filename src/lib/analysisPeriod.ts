/**
 * 結果分析期間模型（v1.25.0 新增）。
 * 純函式：年別／年份／年數／區間／子選項 → 期間欄（曆年月集合＋標籤）。
 * 年份為起算年，年數為自年份起算的年數（往後數）。
 */

export type AnalysisCycle = "year" | "academic";
export type AnalysisInterval = "quarter" | "year";
export type QuarterSub = 1 | 2 | 3 | 4;
export type YearSub = "half" | "full";
export type AnalysisSub = QuarterSub | YearSub;

export interface CalendarMonth {
  year: number;
  month: number;
}

export interface AnalysisPeriodColumn {
  /** 起始曆年月（唯一鍵） */
  key: string;
  /** 月範圍標籤（例 2026/1-3、2026/8-2027/1、2026/1-12） */
  label: string;
  months: CalendarMonth[];
}

export interface AnalysisPeriod {
  cycle: AnalysisCycle;
  startYear: number;
  yearCount: number;
  interval: AnalysisInterval;
  sub: AnalysisSub;
}

interface MonthSpec {
  month: number;
  yearOffset: number;
}

/**
 * 季月份：年度＝曆年季（Q1 1-3、Q2 4-6、Q3 7-9、Q4 10-12）；
 * 學年＝按學年起算（Q1 8-10、Q2 11-1、Q3 2-4、Q4 5-7）。
 */
export function quarterMonths(
  cycle: AnalysisCycle,
  q: QuarterSub,
): MonthSpec[] {
  if (cycle === "year") {
    const base = [1, 4, 7, 10][q - 1];
    return [0, 1, 2].map((i) => ({ month: base + i, yearOffset: 0 }));
  }
  const table: MonthSpec[][] = [
    [
      { month: 8, yearOffset: 0 },
      { month: 9, yearOffset: 0 },
      { month: 10, yearOffset: 0 },
    ],
    [
      { month: 11, yearOffset: 0 },
      { month: 12, yearOffset: 0 },
      { month: 1, yearOffset: 1 },
    ],
    [
      { month: 2, yearOffset: 1 },
      { month: 3, yearOffset: 1 },
      { month: 4, yearOffset: 1 },
    ],
    [
      { month: 5, yearOffset: 1 },
      { month: 6, yearOffset: 1 },
      { month: 7, yearOffset: 1 },
    ],
  ];
  return table[q - 1];
}

/**
 * 半年月份：年度＝上半年 1-6／下半年 7-12；學年＝上半年 8-1（跨年）／下半年 2-7。
 */
export function halfYearMonths(
  cycle: AnalysisCycle,
  half: 1 | 2,
): MonthSpec[] {
  if (cycle === "year") {
    const base = half === 1 ? 1 : 7;
    return [0, 1, 2, 3, 4, 5].map((i) => ({ month: base + i, yearOffset: 0 }));
  }
  if (half === 1) {
    return [8, 9, 10, 11, 12]
      .map((m) => ({ month: m, yearOffset: 0 }))
      .concat([{ month: 1, yearOffset: 1 }]);
  }
  return [2, 3, 4, 5, 6, 7].map((m) => ({ month: m, yearOffset: 1 }));
}

/** 全年月份：年度＝1-12；學年＝8 月至隔年 7 月 */
export function fullYearMonths(cycle: AnalysisCycle): MonthSpec[] {
  if (cycle === "year") {
    return Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      yearOffset: 0,
    }));
  }
  return [8, 9, 10, 11, 12]
    .map((m) => ({ month: m, yearOffset: 0 }))
    .concat([1, 2, 3, 4, 5, 6, 7].map((m) => ({ month: m, yearOffset: 1 })));
}

/** 月範圍標籤：同年「2026/1-3」；跨年「2026/8-2027/1」；單月「2026/8」 */
export function rangeLabel(months: CalendarMonth[]): string {
  if (months.length === 0) return "—";
  const first = months[0];
  const last = months[months.length - 1];
  if (months.length === 1) return `${first.year}/${first.month}`;
  if (first.year === last.year) {
    return `${first.year}/${first.month}-${last.month}`;
  }
  return `${first.year}/${first.month}-${last.year}/${last.month}`;
}

function toMonths(specs: MonthSpec[], baseYear: number): CalendarMonth[] {
  return specs.map((s) => ({ year: baseYear + s.yearOffset, month: s.month }));
}

function columnFromMonths(months: CalendarMonth[]): AnalysisPeriodColumn {
  return {
    key: `${months[0].year}-${months[0].month}`,
    label: rangeLabel(months),
    months,
  };
}

/**
 * 期間欄展開：
 * - 季＋第 N 季：每一年一欄＝該年的第 N 季
 * - 年＋半年：每一年兩欄＝上半年與下半年
 * - 年＋一年：每一年一欄＝全年
 */
export function expandAnalysisColumns(p: AnalysisPeriod): AnalysisPeriodColumn[] {
  const count = Math.max(1, Math.floor(p.yearCount) || 1);
  const years = Array.from({ length: count }, (_, i) => p.startYear + i);
  const out: AnalysisPeriodColumn[] = [];
  if (p.interval === "quarter") {
    const q =
      typeof p.sub === "number" && p.sub >= 1 && p.sub <= 4
        ? (p.sub as QuarterSub)
        : 1;
    for (const y of years) {
      out.push(columnFromMonths(toMonths(quarterMonths(p.cycle, q), y)));
    }
    return out;
  }
  if (p.sub === "half") {
    for (const y of years) {
      out.push(columnFromMonths(toMonths(halfYearMonths(p.cycle, 1), y)));
      out.push(columnFromMonths(toMonths(halfYearMonths(p.cycle, 2), y)));
    }
    return out;
  }
  for (const y of years) {
    out.push(columnFromMonths(toMonths(fullYearMonths(p.cycle), y)));
  }
  return out;
}

/** 當前所在的季（預設子選項用）：年度＝曆年季；學年＝按學年起算 */
export function currentQuarterSub(
  cycle: AnalysisCycle,
  now: Date = new Date(),
): QuarterSub {
  const m = now.getMonth() + 1;
  if (cycle === "year") {
    return m <= 3 ? 1 : m <= 6 ? 2 : m <= 9 ? 3 : 4;
  }
  if (m >= 8 && m <= 10) return 1;
  if (m >= 11 || m === 1) return 2;
  if (m >= 2 && m <= 4) return 3;
  return 4;
}

/** 期間欄涵蓋的曆年（查詢用，已排序去重） */
export function calendarYearsOf(columns: AnalysisPeriodColumn[]): number[] {
  return [
    ...new Set(columns.flatMap((c) => c.months.map((m) => m.year))),
  ].sort((a, b) => a - b);
}
