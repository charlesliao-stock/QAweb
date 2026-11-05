/**
 * 結果分析達閾值率聚合（v1.25.0 新增）。純函式，可單元測試。
 *
 * - 達閾值＝紀錄 rate ≥ 指標閾值。紀錄無自帶達標旗標，一律以當前指標閾值
 *   計算（rate 為 v1.17 選項集得分％；匯入的紀錄 source="import" 同樣計入）。
 * - 人次率＝合併計算（達閾值總人次／總審查人次）。
 * - 單位達閾值率（每單位）＝單位內受審且達閾值人次／該單位總受審人次。
 * - 單元＝單位時的彙總率＝各單位「單位達閾值率」的平均（等權重），
 *   與合併人次率不同，不可混用。
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
}

export interface PassRate {
  pass: number;
  total: number;
  /** ％（一位小數）；無資料回 null */
  rate: number | null;
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

/** 各單位率平均（等權重）：回傳平均率＋計入單位數＋總人次 */
export function averageUnitPassRate(
  records: AnalysisRecord[],
  threshold: number,
): { rate: number | null; unitCount: number; total: number } {
  const byUnit = new Map<string, AnalysisRecord[]>();
  for (const r of records) {
    const arr = byUnit.get(r.unitId);
    if (arr) arr.push(r);
    else byUnit.set(r.unitId, [r]);
  }
  const unitRates: number[] = [];
  for (const rs of byUnit.values()) {
    const pr = passRateOf(rs, threshold);
    if (pr.rate != null) unitRates.push(pr.rate);
  }
  return {
    rate:
      unitRates.length > 0
        ? round1(
            unitRates.reduce((a, b) => a + b, 0) / unitRates.length,
          )
        : null,
    unitCount: unitRates.length,
    total: records.length,
  };
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
