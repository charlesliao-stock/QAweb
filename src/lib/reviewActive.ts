/**
 * 品管審查進行中排程：區間計算與進度計算純函式（v1.19.0）。
 *
 * - 審核區間：年度／學年度用 frequency／intervalMonths 算出各區間；
 *   臨時＝全部月份為一區；無頻次區間資料的舊排程視整期為一區。
 * - 「現階段」＝今天所在的區間；今天早於第一區間則用第一區間；
 *   今天晚於最後區間結束月 → null（已結束）。
 * - 進度改以審查紀錄（reviewRecords）計算，不依賴任務表。
 *
 * 本檔零依賴、不碰 DOM、不碰 Firestore，可在 node 直接單元測試。
 */

export interface CalendarYM {
  year: number;
  month: number;
}

export interface ReviewInterval {
  start: CalendarYM;
  end: CalendarYM;
  /** 該區間內的審查起始月份（曆年月） */
  reviewMonths: CalendarYM[];
  /** 區間內所有曆年月（start..end） */
  allMonths: CalendarYM[];
}

export function ymKey(ym: CalendarYM): string {
  return `${ym.year}-${ym.month}`;
}

export function cmpYM(a: CalendarYM, b: CalendarYM): number {
  return a.year - b.year || a.month - b.month;
}

export function addMonths(ym: CalendarYM, n: number): CalendarYM {
  const total = ym.year * 12 + (ym.month - 1) + n;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return { year, month };
}

function monthRange(start: CalendarYM, end: CalendarYM): CalendarYM[] {
  const out: CalendarYM[] = [];
  let cur = { ...start };
  while (cmpYM(cur, end) <= 0) {
    out.push({ ...cur });
    cur = addMonths(cur, 1);
  }
  return out;
}

export interface ScheduleLike {
  category: "year" | "academic" | "temp";
  period: string;
  months: number[];
  frequency: number | null;
  intervalMonths: number | null;
  refYear: number | null;
}

function calendarYearOf(
  category: "year" | "academic" | "temp",
  period: string,
  month: number,
  refYear: number | null,
  now: Date,
): number {
  if (category === "temp" && refYear != null) return refYear;
  if (category === "academic") {
    const p = parseInt(period, 10);
    const roc = Number.isFinite(p)
      ? p
      : now.getMonth() + 1 >= 8
        ? now.getFullYear() - 1911
        : now.getFullYear() - 1912;
    return month >= 8 ? roc + 1911 : roc + 1912;
  }
  if (category === "temp") {
    const t = Number(period);
    if (Number.isFinite(t) && t > 0) return new Date(t).getFullYear();
    return now.getFullYear();
  }
  const y = parseInt(period, 10);
  return Number.isFinite(y) ? y : now.getFullYear();
}

/**
 * 排程 → 審核區間列表（依曆年月份排序）。
 * - 年度／學年度＋頻次區間：每個起始月為一區間起點，連續 intervalMonths 個月。
 * - 臨時：全部月份為一區。
 * - 舊排程（無頻次／區間）：整期為一區。
 */
export function scheduleIntervals(
  sched: ScheduleLike,
  now: Date = new Date(),
): ReviewInterval[] {
  const months = [...new Set(sched.months)]
    .filter((m) => Number.isInteger(m) && m >= 1 && m <= 12)
    .sort((a, b) => a - b);
  if (months.length === 0) return [];
  const calOf = (m: number): CalendarYM => ({
    year: calendarYearOf(sched.category, sched.period, m, sched.refYear, now),
    month: m,
  });

  if (sched.category === "temp") {
    const cals = months.map(calOf).sort(cmpYM);
    const start = cals[0];
    const end = cals[cals.length - 1];
    return [
      { start, end, reviewMonths: cals, allMonths: monthRange(start, end) },
    ];
  }

  const freq = sched.frequency;
  const len = sched.intervalMonths;
  if (freq != null && len != null && freq > 0 && len > 0) {
    // 起始月依曆年排序（學年度跨年時 8–12 月在前）
    const starts = months.map(calOf).sort(cmpYM);
    return starts.map((s) => {
      const e = addMonths(s, len - 1);
      return {
        start: s,
        end: e,
        reviewMonths: [s],
        allMonths: monthRange(s, e),
      };
    });
  }

  // 舊排程：整期為一區
  const cals = months.map(calOf).sort(cmpYM);
  const start = cals[0];
  const end = cals[cals.length - 1];
  return [
    { start, end, reviewMonths: cals, allMonths: monthRange(start, end) },
  ];
}

/**
 * 「現階段」區間：今天所在的區間；今天落在區間空隙 → 取下一個尚未結束的區間；
 * 今天早於第一區間 → 第一區間；晚於最後區間結束月 → null（已結束）。
 */
export function currentInterval(
  sched: ScheduleLike,
  today: Date = new Date(),
): ReviewInterval | null {
  const ivs = scheduleIntervals(sched, today);
  if (ivs.length === 0) return null;
  const t: CalendarYM = {
    year: today.getFullYear(),
    month: today.getMonth() + 1,
  };
  for (const iv of ivs) {
    if (cmpYM(iv.start, t) <= 0 && cmpYM(t, iv.end) <= 0) return iv;
  }
  for (const iv of ivs) {
    if (cmpYM(t, iv.end) <= 0) return iv;
  }
  return null;
}

/**
 * 包含今天的區間（v1.20 品管審查清單用）：今天（本月）落在某個區間內才回傳，
 * 不像 currentInterval 會在空隙取下一個、或在區間前取第一個。
 */
export function containingInterval(
  sched: ScheduleLike,
  today: Date = new Date(),
): ReviewInterval | null {
  const ivs = scheduleIntervals(sched, today);
  if (ivs.length === 0) return null;
  const t: CalendarYM = {
    year: today.getFullYear(),
    month: today.getMonth() + 1,
  };
  for (const iv of ivs) {
    if (cmpYM(iv.start, t) <= 0 && cmpYM(t, iv.end) <= 0) return iv;
  }
  return null;
}

/** 品管審查清單篩選（v1.20）：組別／指標／關鍵字三者疊加 */
export interface AuditRowLike {
  groupId: string;
  indicatorId: string;
  indicatorName: string;
}

export function auditRowMatches(
  row: AuditRowLike,
  f: { groupId: string; indicatorId: string; keyword: string },
): boolean {
  if (f.groupId && row.groupId !== f.groupId) return false;
  if (f.indicatorId && row.indicatorId !== f.indicatorId) return false;
  const kw = f.keyword.trim().toLowerCase();
  if (
    kw &&
    !row.indicatorName.toLowerCase().includes(kw) &&
    !row.indicatorId.toLowerCase().includes(kw)
  )
    return false;
  return true;
}

/** 排程最後一個區間的結束月（曆年月）；無區間 → null */
export function scheduleLastEnd(
  sched: ScheduleLike,
  today: Date = new Date(),
): CalendarYM | null {
  const ivs = scheduleIntervals(sched, today);
  if (ivs.length === 0) return null;
  return ivs[ivs.length - 1].end;
}

/**
 * 審核區間顯示文字。
 * - 年度／學年度：「2026/1-3」；跨年「2026/11-2027/1」
 * - 臨時：「2026/3、5」（實際月份）
 * - 舊排程：「2026/1-10」（整期起訖）
 */
export function intervalDisplay(
  iv: ReviewInterval,
  category: "year" | "academic" | "temp",
): string {
  if (category === "temp") {
    const ms = iv.reviewMonths.map((m) => m.month);
    return `${iv.start.year}/${ms.join("、")}`;
  }
  const s = iv.start;
  const e = iv.end;
  if (s.year === e.year) return `${s.year}/${s.month}-${e.month}`;
  return `${s.year}/${s.month}-${e.year}/${e.month}`;
}

/** 審查紀錄年月歸屬：優先 year/month 欄位，否則用建立時間 */
export function recordYearMonth(r: {
  year?: unknown;
  month?: unknown;
  submittedAt?: unknown;
}): CalendarYM | null {
  const y = r.year;
  const m = r.month;
  if (
    typeof y === "number" &&
    Number.isInteger(y) &&
    typeof m === "number" &&
    Number.isInteger(m) &&
    m >= 1 &&
    m <= 12
  ) {
    return { year: y, month: m };
  }
  const ts = r.submittedAt as { toDate?: unknown } | undefined;
  if (ts && typeof ts.toDate === "function") {
    try {
      const d = (ts.toDate as () => Date)();
      return { year: d.getFullYear(), month: d.getMonth() + 1 };
    } catch {
      return null;
    }
  }
  return null;
}

export interface IntervalProgress {
  /** null＝件數未設定（人次欄顯示「—」） */
  totalPersons: number | null;
  donePersons: number;
  totalUnits: number;
  doneUnits: number;
  /** null＝件數未設定；total=0 視為 100 */
  personPct: number | null;
  unitPct: number;
}

function pct(done: number, total: number): number {
  if (total <= 0) return 100;
  return Math.round((done / total) * 1000) / 10;
}

/**
 * 現階段區間進度（純函式）。
 * - 總人次＝單位數×件數×審查月數；件數未設定 → totalPersons=null
 * - 已完成人次＝區間曆月份內已提交的審查筆數
 * - 總單位次＝單位數×審查月數
 * - 已完成單位次＝區間內有提交≥1筆的（單位,月）組合數
 */
export function computeIntervalProgress(opts: {
  unitCount: number;
  caseCount: number | null;
  reviewMonthCount: number;
  records: { unitId: string; year: number; month: number }[];
  intervalMonthKeys: Set<string>;
}): IntervalProgress {
  const inIv = opts.records.filter((r) =>
    opts.intervalMonthKeys.has(`${r.year}-${r.month}`),
  );
  const donePersons = inIv.length;
  const totalPersons =
    opts.caseCount == null
      ? null
      : opts.unitCount * opts.caseCount * opts.reviewMonthCount;
  const totalUnits = opts.unitCount * opts.reviewMonthCount;
  const unitMonthSet = new Set(inIv.map((r) => `${r.unitId}@${r.year}-${r.month}`));
  const doneUnits = unitMonthSet.size;
  return {
    totalPersons,
    donePersons,
    totalUnits,
    doneUnits,
    personPct: totalPersons == null ? null : pct(donePersons, totalPersons),
    unitPct: pct(doneUnits, totalUnits),
  };
}

/**
 * 進度是否達 100%（「尚未結束」判定用）。
 * 件數未設定時改看單位次。
 */
export function isProgressComplete(p: IntervalProgress): boolean {
  if (p.totalPersons != null) return p.donePersons >= p.totalPersons;
  return p.doneUnits >= p.totalUnits;
}
