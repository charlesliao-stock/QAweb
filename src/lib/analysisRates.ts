/**
 * 結果分析達閾值率聚合（v1.25.0 新增；v1.27.0 改單位率定義）。
 * 純函式，可單元測試。
 *
 * - 達閾值＝紀錄 rate ≥ 指標閾值。紀錄無自帶達標旗標，一律以當前指標閾值
 *   計算（rate 為 v1.17 選項集得分％；匯入的紀錄 source="import" 同樣計入）。
 * - 所有的正確率，不論人或單位，都是「審查達閾值數／總審查數」。
 * - 人次率＝合併計算（達閾值總人次／總審查人次）。
 * - 單位達閾值率（每單位）＝單位內受審且達閾值人次／該單位總受審人次；
 *   一個單位「達閾值」＝該單位率 ≥ 指標閾值。
 * - 單位率＝達閾值單位數／總審查單位數（取代 v1.25.0 的各單位率平均）。
 *   指標分析摘要的單位正確率以 unit-period 計：一個單位在兩個期間欄
 *   受審＝兩筆審查。
 * - 矩陣格格式：正確率＋（正確數／審查數），例 75%(3/4)。
 */
import type { AuditQuestion } from "./indicators";

export interface AnalysisAnswer {
  questionId: string;
  itemText: string;
  optionLabel: string;
  score: number;
  excluded?: boolean;
}

export interface AnalysisRecord {
  indicatorId: string;
  unitId: string;
  year: number;
  month: number;
  /** 正確率％（一位小數）；滿分 0 時為 null */
  rate: number | null;
  answers: AnalysisAnswer[];
  /** 被審人員職編（v1.27.0 下探 L2 用） */
  personEmpNo: string;
  /** 被審人員姓名（顯示時遮罩） */
  personName: string;
}

export interface PassRate {
  pass: number;
  total: number;
  /** ％（一位小數）；無資料回 null */
  rate: number | null;
}

/** 格格式：75%(3/4)；無資料回 —；space=true 時為 75% (3/4) */
export function formatPassRate(pr: PassRate, space = false): string {
  if (pr.rate == null) return "—";
  const r =
    Number.isInteger(pr.rate) ? String(pr.rate) : pr.rate.toFixed(1);
  return space ? `${r}% (${pr.pass}/${pr.total})` : `${r}%(${pr.pass}/${pr.total})`;
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** 單筆達閾值：rate 非 null 且 ≥ 閾值；閾值未設定（<=0）視為不達標 */
export function isPassing(rate: number | null, threshold: number): boolean {
  return typeof rate === "number" && threshold > 0 && rate >= threshold;
}

/** 合併人次率：達閾值總人次／總審查人次 */
export function passRateOf(
  records: AnalysisRecord[],
  threshold: number,
): PassRate {
  const total = records.length;
  const pass = records.filter((r) => isPassing(r.rate, threshold)).length;
  return {
    pass,
    total,
    rate: total > 0 ? round1((pass / total) * 100) : null,
  };
}

/** 單位是否達閾值：該單位率非 null、閾值 > 0 且 ≥ 閾值 */
export function isUnitPassing(unitRate: number | null, threshold: number): boolean {
  return typeof unitRate === "number" && threshold > 0 && unitRate >= threshold;
}

function groupByUnit(
  records: AnalysisRecord[],
): Map<string, AnalysisRecord[]> {
  const byUnit = new Map<string, AnalysisRecord[]>();
  for (const r of records) {
    const arr = byUnit.get(r.unitId);
    if (arr) arr.push(r);
    else byUnit.set(r.unitId, [r]);
  }
  return byUnit;
}

/**
 * 單位率＝達閾值單位數／總審查單位數（單一期間欄內）。
 * 一個單位達閾值＝該單位內達閾值人次／總受審人次 ≥ 指標閾值。
 */
export function unitPassRate(
  records: AnalysisRecord[],
  threshold: number,
): PassRate {
  let pass = 0;
  let total = 0;
  for (const rs of groupByUnit(records).values()) {
    const pr = passRateOf(rs, threshold);
    total += 1;
    if (isUnitPassing(pr.rate, threshold)) pass += 1;
  }
  return {
    pass,
    total,
    rate: total > 0 ? round1((pass / total) * 100) : null,
  };
}

/**
 * unit-period 彙總（指標分析摘要用）：一個單位在兩個期間欄受審＝兩筆審查。
 * 逐欄算單位率（達閾值單位數／該欄單位數），再合併計數。
 */
export function unitPeriodPassRate(
  records: AnalysisRecord[],
  columns: { months: { year: number; month: number }[] }[],
  threshold: number,
): PassRate {
  let pass = 0;
  let total = 0;
  for (const col of columns) {
    const r = unitPassRate(recordsInMonths(records, col.months), threshold);
    pass += r.pass;
    total += r.total;
  }
  return {
    pass,
    total,
    rate: total > 0 ? round1((pass / total) * 100) : null,
  };
}

/** 下探 L1 的單位清單：該指標該期間欄內有審查紀錄的單位（依單位代號排序） */
export function unitsForDrill(
  records: AnalysisRecord[],
  months: { year: number; month: number }[],
): string[] {
  const ids = new Set(
    recordsInMonths(records, months).map((r) => r.unitId),
  );
  return [...ids].sort((a, b) => a.localeCompare(b, "zh-Hant"));
}

export interface PersonOptionRow {
  personEmpNo: string;
  personName: string;
  year: number;
  month: number;
  /** 正確率％；滿分 0 時為 null */
  rate: number | null;
  passing: boolean;
  /** questionId → 選項標籤（是／否／不適用／未填為 ""） */
  answers: Map<string, string>;
}

/**
 * 下探 L2：該單位該期間被審人員在各選項的審查結果。
 * 一筆紀錄＝一人一次審查（同一人在同一期間欄內多筆紀錄各列一行，
 * 以月份區分），依職編、年月排序。
 */
export function personOptionRows(
  records: AnalysisRecord[],
  threshold: number,
): PersonOptionRow[] {
  return [...records]
    .sort((a, b) =>
      a.personEmpNo.localeCompare(b.personEmpNo, "zh-Hant") ||
      a.year - b.year ||
      a.month - b.month,
    )
    .map((r) => ({
      personEmpNo: r.personEmpNo,
      personName: r.personName,
      year: r.year,
      month: r.month,
      rate: r.rate,
      passing: isPassing(r.rate, threshold),
      answers: new Map(r.answers.map((a) => [a.questionId, a.optionLabel])),
    }));
}

/** 曆年月鍵（過濾用） */
export function monthKey(year: number, month: number): number {
  return year * 100 + month;
}

/** 取出落在指定曆年月集合內的紀錄 */
export function recordsInMonths(
  records: AnalysisRecord[],
  months: { year: number; month: number }[],
): AnalysisRecord[] {
  const keys = new Set(months.map((m) => monthKey(m.year, m.month)));
  return records.filter((r) => keys.has(monthKey(r.year, r.month)));
}

/* ================= 各選項得分狀況（文件圖示／指標選項明細共用） ================= */

export interface OptionDetailRow {
  questionId: string;
  itemText: string;
  order: number;
  yes: number;
  no: number;
  /** 不適用（含未填） */
  na: number;
  total: number;
  yesRate: number | null;
  noRate: number | null;
  naRate: number | null;
  /** 得分率＝是／（是＋否），％一位小數；是＋否＝0 回 null */
  scoreRate: number | null;
}

/**
 * 各選項得分狀況：列＝題目（依指標題目順序），欄＝是／否／不適用（人次＋比率）、
 * 得分率。只計入當前題目；已刪題目的作答不列入。
 */
export function optionDetailRows(
  records: AnalysisRecord[],
  questions: AuditQuestion[],
): OptionDetailRow[] {
  const counts = new Map<string, { yes: number; no: number; na: number }>();
  for (const r of records) {
    for (const a of r.answers) {
      const c = counts.get(a.questionId) ?? { yes: 0, no: 0, na: 0 };
      if (a.optionLabel === "是") c.yes += 1;
      else if (a.optionLabel === "否") c.no += 1;
      else c.na += 1;
      counts.set(a.questionId, c);
    }
  }
  return [...questions]
    .sort((a, b) => a.order - b.order)
    .map((q) => {
      const c = counts.get(q.id) ?? { yes: 0, no: 0, na: 0 };
      const total = c.yes + c.no + c.na;
      const pct = (n: number): number | null =>
        total > 0 ? round1((n / total) * 100) : null;
      return {
        questionId: q.id,
        itemText: q.itemText,
        order: q.order,
        yes: c.yes,
        no: c.no,
        na: c.na,
        total,
        yesRate: pct(c.yes),
        noRate: pct(c.no),
        naRate: pct(c.na),
        scoreRate:
          c.yes + c.no > 0
            ? round1((c.yes / (c.yes + c.no)) * 100)
            : null,
      };
    });
}
