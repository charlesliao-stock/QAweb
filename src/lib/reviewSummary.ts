/**
 * 已結束區間的預存摘要（v1.64.0）。純函式，可在 node 單元測試。
 *
 * 設計：一份摘要＝指標×排程區間，內含「單位×月份」格（cells）。每格只存可相加
 * 的計數（人次、達標人次、各分組／逐題的達標與有效人次、逐題是／否／不適用），
 * 因此結果分析不論選哪個期間欄（單月、季、累計）都能把格子相加後，沿用
 * analysisRates 同一口徑重算，不必讀逐筆紀錄。
 *
 * 口徑一致性：
 * - 逐筆達標＝isPassing(rate, thresholdAtSchedule)。無排程快照的紀錄（匯入）
 *   其達標與否取決於「當下指標閾值」，無法預存；摘要記 noSnapshotCount 與
 *   thresholdUsed，讀取端以 isSummaryUsable 判斷，不符就退回讀原始紀錄。
 * - 單位層達標一律在讀取時以「當前指標閾值」由相加後的計數重判（與
 *   unitPassRate／unitScoringBreakdownRows 相同）。
 */
import {
  columnThresholdOf,
  isPassing,
  isUnitPassing,
  round1,
  scoringSections,
  type AnalysisRecord,
  type PassRate,
  type ScoringBreakdownRow,
} from "./analysisRates";
import type { AuditQuestion } from "./indicators";

export const SUMMARY_SCHEMA_VERSION = 1;

export interface SummarySectionCount {
  label: string;
  /** 該分組（或單題）rate 達標的人次（每人先算分組 rate 再判 ≥ 閾值） */
  pass: number;
  /** 該分組有適用題（是＋否>0）的人次 */
  applicable: number;
  /** 無分組逐題列：該題答「是」的人次 */
  hit: number;
}

export interface SummaryQuestionCount {
  questionId: string;
  itemText: string;
  yes: number;
  no: number;
  notApplicable: number;
}

export interface SummaryCell {
  unitId: string;
  year: number;
  month: number;
  total: number;
  pass: number;
  /** 該格紀錄的排程快照閾值（眾數；全無快照為 null）— 曲線圖逐月畫閾值線用 */
  threshold: number | null;
  /** 該格各快照閾值的人次（同欄多格相加後取眾數，與逐筆算法一致） */
  thresholdVotes: { value: number; count: number }[];
  /** 該格紀錄涉及的指標版本（核對用） */
  indicatorVersions: string[];
  sections: Record<string, SummarySectionCount>;
  questionsByVersion: {
    indicatorVersion: string;
    questionOptions: SummaryQuestionCount[];
  }[];
}

export type SummaryStatus = "valid" | "pending_review";

export interface ReviewSummary {
  indicatorId: string;
  scheduleCategory: string;
  schedulePeriod: string;
  start: { year: number; month: number };
  end: { year: number; month: number };
  schemaVersion: number;
  status: SummaryStatus;
  thresholdUsed: number;
  noSnapshotCount: number;
  recordCount: number;
  hasGroups: boolean;
  cells: SummaryCell[];
}

export function summaryDocId(
  indicatorId: string,
  category: string,
  period: string,
  start: { year: number; month: number },
): string {
  return `${indicatorId}__${category}__${period}__${start.year}-${start.month}`;
}

/** 摘要可否取代原始紀錄：口徑版本一致、無「依當下閾值」的紀錄或閾值未變 */
export function isSummaryUsable(
  s: Pick<ReviewSummary, "schemaVersion" | "noSnapshotCount" | "thresholdUsed">,
  currentThreshold: number,
): boolean {
  return (
    s.schemaVersion === SUMMARY_SCHEMA_VERSION &&
    (s.noSnapshotCount === 0 || s.thresholdUsed === currentThreshold)
  );
}

/** 摘要已過期：口徑版本相同，但含「依當下閾值」的紀錄，且指標閾值已與封存時不同。
 *  過期摘要仍可顯示（數字為封存當時口徑），畫面須提示重新封存。 */
export function isSummaryStale(
  s: Pick<ReviewSummary, "schemaVersion" | "noSnapshotCount" | "thresholdUsed">,
  currentThreshold: number,
): boolean {
  return (
    s.schemaVersion === SUMMARY_SCHEMA_VERSION &&
    s.noSnapshotCount > 0 &&
    s.thresholdUsed !== currentThreshold
  );
}

type Counts = { yes: number; no: number };
function countsOf(record: AnalysisRecord, ids: Set<string>): Counts {
  let yes = 0;
  let no = 0;
  for (const a of record.answers) {
    if (!ids.has(a.questionId) || a.excluded) continue;
    if (a.optionLabel === "是") yes += 1;
    else if (a.optionLabel === "否") no += 1;
  }
  return { yes, no };
}
function rateOf(c: Counts): number | null {
  return c.yes + c.no > 0 ? round1((c.yes / (c.yes + c.no)) * 100) : null;
}

export function buildReviewSummary(opts: {
  indicatorId: string;
  scheduleCategory: string;
  schedulePeriod: string;
  start: { year: number; month: number };
  end: { year: number; month: number };
  records: AnalysisRecord[];
  questions: AuditQuestion[];
  threshold: number;
}): ReviewSummary {
  const { records, questions, threshold } = opts;
  const hasGroups = questions.some((q) => Boolean(q.groupId));
  const known = new Set(questions.map((q) => q.id));
  const sections = scoringSections(questions);
  const cells = new Map<string, SummaryCell>();
  let noSnapshotCount = 0;
  const thr = (r: AnalysisRecord) =>
    typeof r.thresholdAtSchedule === "number" ? r.thresholdAtSchedule : threshold;

  for (const r of records) {
    if (typeof r.thresholdAtSchedule !== "number") noSnapshotCount += 1;
    const ck = `${r.unitId}|${r.year}-${r.month}`;
    let cell = cells.get(ck);
    if (!cell) {
      cell = {
        unitId: r.unitId,
        year: r.year,
        month: r.month,
        total: 0,
        pass: 0,
        threshold: null,
        thresholdVotes: [],
        indicatorVersions: [],
        sections: {},
        questionsByVersion: [],
      };
      cells.set(ck, cell);
    }
    cell.total += 1;
    if (typeof r.thresholdAtSchedule === "number") {
      const tv = cell.thresholdVotes.find((x) => x.value === r.thresholdAtSchedule);
      if (tv) tv.count += 1;
      else cell.thresholdVotes.push({ value: r.thresholdAtSchedule, count: 1 });
    }
    if (r.indicatorVersion && !cell.indicatorVersions.includes(r.indicatorVersion))
      cell.indicatorVersions.push(r.indicatorVersion);
    if (isPassing(r.rate, thr(r))) cell.pass += 1;

    const bump = (key: string, label: string, rate: number | null, hasApplicable: boolean, hit: boolean) => {
      const sc = (cell!.sections[key] ??= { label, pass: 0, applicable: 0, hit: 0 });
      if (hasApplicable) sc.applicable += 1;
      if (isPassing(rate, thr(r))) sc.pass += 1;
      if (hit) sc.hit += 1;
    };
    const hitOf = (ids: Set<string>) =>
      r.answers.some((a) => ids.has(a.questionId) && !a.excluded && a.optionLabel === "是");
    for (const sec of sections) {
      const c = countsOf(r, sec.ids);
      bump(sec.key, sec.label, rateOf(c), c.yes + c.no > 0, hasGroups ? false : hitOf(sec.ids));
    }
    if (hasGroups) {
      const hist = new Set<string>();
      for (const a of r.answers) if (!known.has(a.questionId)) hist.add(a.questionId);
      if (hist.size > 0) {
        const c = countsOf(r, hist);
        bump("historical-questions", "其他／歷史題目", rateOf(c), c.yes + c.no > 0, false);
      }
    } else {
      const seen = new Set<string>();
      for (const a of r.answers) {
        if (known.has(a.questionId)) continue;
        const key = `${a.questionId}::${a.itemText}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const ids = new Set([a.questionId]);
        const c = countsOf(r, ids);
        bump(`historical-${key}`, `歷史題目：${a.itemText || "未命名項目"}`, rateOf(c), c.yes + c.no > 0, hitOf(ids));
      }
    }

    // 逐題錯誤統計（同 questionErrorRows：同題只計最後一個答案）
    const version = r.indicatorVersion || "版本未記錄";
    let vb = cell.questionsByVersion.find((v) => v.indicatorVersion === version);
    if (!vb) {
      vb = { indicatorVersion: version, questionOptions: [] };
      cell.questionsByVersion.push(vb);
    }
    const latest = new Map<string, (typeof r.answers)[number]>();
    for (const a of r.answers) if (a.questionId) latest.set(a.questionId, a);
    for (const a of latest.values()) {
      const text = (a.itemText || "（題目文字未保存）").trim().replace(/\s+/g, " ");
      let q = vb.questionOptions.find((x) => x.itemText === text);
      if (!q) {
        q = { questionId: a.questionId, itemText: text, yes: 0, no: 0, notApplicable: 0 };
        vb.questionOptions.push(q);
      }
      if (a.optionLabel === "是") q.yes += 1;
      else if (a.optionLabel === "否") q.no += 1;
      else if (a.optionLabel === "不適用") q.notApplicable += 1;
    }
  }

  for (const cell of cells.values()) {
    cell.threshold = columnThresholdOf(
      records.filter(
        (r) => r.unitId === cell.unitId && r.year === cell.year && r.month === cell.month,
      ),
      0,
    );
    cell.indicatorVersions.sort();
  }

  return {
    indicatorId: opts.indicatorId,
    scheduleCategory: opts.scheduleCategory,
    schedulePeriod: opts.schedulePeriod,
    start: opts.start,
    end: opts.end,
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    status: "valid",
    thresholdUsed: threshold,
    noSnapshotCount,
    recordCount: records.length,
    hasGroups,
    cells: [...cells.values()].sort(
      (a, b) => a.year - b.year || a.month - b.month || a.unitId.localeCompare(b.unitId),
    ),
  };
}

/* ---------------- 讀取端：由格子重算（與 analysisRates 同口徑） ---------------- */

export interface MonthRef {
  year: number;
  month: number;
}
export function cellsInMonths(cells: SummaryCell[], months: MonthRef[]): SummaryCell[] {
  const keys = new Set(months.map((m) => `${m.year}-${m.month}`));
  return cells.filter((c) => keys.has(`${c.year}-${c.month}`));
}

/** 曲線圖用：期間欄閾值（格閾值眾數，以人次加權；無則 fallback；≤0 回 null） */
export function columnThresholdFromCells(cells: SummaryCell[], fallback: number): number | null {
  const votes = new Map<number, number>();
  for (const c of cells)
    for (const tv of c.thresholdVotes) votes.set(tv.value, (votes.get(tv.value) ?? 0) + tv.count);
  let best: number | null = null;
  let bv = 0;
  for (const [t, v] of votes)
    if (v > bv || (v === bv && best != null && t > best)) {
      best = t;
      bv = v;
    }
  const t = best ?? fallback;
  return t > 0 ? t : null;
}

function pooledByUnit(cells: SummaryCell[]): Map<string, SummaryCell[]> {
  const m = new Map<string, SummaryCell[]>();
  for (const c of cells) {
    const arr = m.get(c.unitId);
    if (arr) arr.push(c);
    else m.set(c.unitId, [c]);
  }
  return m;
}

/** 人次率（同 passRateOf） */
export function passRateFromCells(cells: SummaryCell[]): PassRate {
  const total = cells.reduce((n, c) => n + c.total, 0);
  const pass = cells.reduce((n, c) => n + c.pass, 0);
  return { pass, total, rate: total > 0 ? round1((pass / total) * 100) : null };
}

/** 單位率（同 unitPassRate；單一期間欄） */
export function unitPassRateFromCells(cells: SummaryCell[], threshold: number): PassRate {
  let pass = 0;
  let total = 0;
  for (const cs of pooledByUnit(cells).values()) {
    total += 1;
    if (isUnitPassing(passRateFromCells(cs).rate, threshold)) pass += 1;
  }
  return { pass, total, rate: total > 0 ? round1((pass / total) * 100) : null };
}

/** unit-period 彙總（同 unitPeriodPassRate） */
export function unitPeriodPassRateFromCells(
  cells: SummaryCell[],
  columns: { months: MonthRef[] }[],
  threshold: number,
): PassRate {
  let pass = 0;
  let total = 0;
  for (const col of columns) {
    const r = unitPassRateFromCells(cellsInMonths(cells, col.months), threshold);
    pass += r.pass;
    total += r.total;
  }
  return { pass, total, rate: total > 0 ? round1((pass / total) * 100) : null };
}

function sectionRowsOrder(
  cells: SummaryCell[],
  questions: AuditQuestion[],
): { key: string; label: string }[] {
  const out = scoringSections(questions).map((s) => ({ key: s.key, label: s.label }));
  const knownKeys = new Set(out.map((s) => s.key));
  const hist = new Map<string, string>();
  for (const c of cells)
    for (const [k, v] of Object.entries(c.sections))
      if (!knownKeys.has(k) && !hist.has(k)) hist.set(k, v.label);
  for (const [key, label] of hist) out.push({ key, label });
  return out;
}

/** 人次模式分組／逐題（同 personScoringBreakdownRows） */
export function personScoringRowsFromCells(
  cells: SummaryCell[],
  questions: AuditQuestion[],
): ScoringBreakdownRow[] {
  const total = passRateFromCells(cells);
  const hasGroups = questions.some((q) => Boolean(q.groupId));
  const rows: ScoringBreakdownRow[] = [
    { key: "indicator-total", label: "", yes: total.pass, valid: total.total, rate: total.rate, isTotal: true },
  ];
  for (const sec of sectionRowsOrder(cells, questions)) {
    let yes = 0;
    for (const c of cells) {
      const s = c.sections[sec.key];
      if (s) yes += hasGroups ? s.pass : s.hit;
    }
    rows.push({
      key: sec.key,
      label: sec.label,
      yes,
      valid: total.total,
      rate: total.total > 0 ? round1((yes / total.total) * 100) : null,
      isTotal: false,
    });
  }
  return rows;
}

/** 單位模式分組／逐題（同 unitScoringBreakdownRows） */
export function unitScoringRowsFromCells(
  cells: SummaryCell[],
  questions: AuditQuestion[],
  columns: { months: MonthRef[] }[],
  threshold: number,
): ScoringBreakdownRow[] {
  const total = unitPeriodPassRateFromCells(cells, columns, threshold);
  const rows: ScoringBreakdownRow[] = [
    { key: "indicator-total", label: "", yes: total.pass, valid: total.total, rate: total.rate, isTotal: true },
  ];
  // 單位模式只列題庫現有分組（與原函式一致：不含歷史分組）
  for (const sec of scoringSections(questions)) {
    let pass = 0;
    let valid = 0;
    for (const col of columns) {
      for (const cs of pooledByUnit(cellsInMonths(cells, col.months)).values()) {
        let applicable = 0;
        let p = 0;
        for (const c of cs) {
          const s = c.sections[sec.key];
          if (!s) continue;
          applicable += s.applicable;
          p += s.pass;
        }
        if (applicable === 0) continue;
        valid += 1;
        if (isUnitPassing(round1((p / applicable) * 100), threshold)) pass += 1;
      }
    }
    rows.push({
      key: sec.key,
      label: sec.label,
      yes: pass,
      valid,
      rate: valid > 0 ? round1((pass / valid) * 100) : null,
      isTotal: false,
    });
  }
  return rows;
}

/** 供 questionErrorRowsFromSummaries 使用 */
export function questionSummariesFromCells(cells: SummaryCell[]) {
  const byVersion = new Map<string, Map<string, SummaryQuestionCount>>();
  for (const c of cells)
    for (const vb of c.questionsByVersion) {
      const m = byVersion.get(vb.indicatorVersion) ?? new Map<string, SummaryQuestionCount>();
      byVersion.set(vb.indicatorVersion, m);
      for (const q of vb.questionOptions) {
        const t = m.get(q.itemText);
        if (t) {
          t.yes += q.yes;
          t.no += q.no;
          t.notApplicable += q.notApplicable;
        } else m.set(q.itemText, { ...q });
      }
    }
  return [...byVersion].map(([indicatorVersion, m]) => ({
    indicatorVersion,
    questionOptions: [...m.values()],
  }));
}
