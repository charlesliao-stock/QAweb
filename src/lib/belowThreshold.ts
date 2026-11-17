/**
 * 加審「未達閾值挑選」清單（v1.60.0）。
 *
 * 純函式，不碰 DOM／Firestore，可單元測試。
 * 未達定義用 A（矩陣定義，與 lib/analysisRates.ts 一致）：
 * 該單位該月達標人次占比＜閾值；單筆達標＝rate ≥ 閾值，
 * 閾值取紀錄的 thresholdAtSchedule，缺值才用當前指標 effectiveThreshold。
 * 不用平均分定義（lib/resultAnalysis.ts 的 unitMonthRows 是另一種定義）。
 *
 * 常規／加審判定：紀錄以 taskId join reviewTasks.scheduleCategory，
 * scheduleCategory === "temp" 者為加審／自審紀錄，排除；
 * 任務缺 scheduleCategory（舊任務）視為常規；任務已被刪除、
 * 或 taskId 為空（匯入紀錄，無任務可對應）亦視為常規。
 * 只用（指標、單位、年月）鍵比對會在混合月份誤判，此處不用。
 */

import { isPassing } from "./analysisRates";
import {
  scheduleReviewCalendarMonths,
  type IndicatorSchedule,
} from "./scheduling";

export interface BelowThresholdRecordLike {
  taskId: string;
  indicatorId: string;
  unitId: string;
  year: number;
  month: number;
  rate: number | null;
  thresholdAtSchedule?: number;
}

export interface BelowThresholdTaskLike {
  id: string;
  scheduleCategory?: string;
}

export interface BelowThresholdUnit {
  unitId: string;
  pass: number;
  total: number;
  /** 達標人次占比（0–100，小數 1 位）；無紀錄時為 null（此處不會出現） */
  rate: number | null;
}

export interface BelowThresholdRow {
  year: number;
  month: number;
  /** 比較用的指標閾值（effectiveThreshold） */
  threshold: number;
  /** 該月未達閾值的單位（依單位代碼排序） */
  units: BelowThresholdUnit[];
  /** 該失敗月的下一個月是否已有加審覆蓋（且單位重疊） */
  alreadyAddReviewed: boolean;
}

/** 下一個曆月（2025/12 → 2026/1） */
export function nextCalendarMonth(
  year: number,
  month: number,
): { year: number; month: number } {
  return month >= 12
    ? { year: year + 1, month: 1 }
    : { year, month: month + 1 };
}

/**
 * 單位該月達標人次占比（與 passRateOf 同一算法：逐筆用
 * thresholdAtSchedule，缺值用傳入的 threshold）。
 */
export function unitMonthPassRate(
  records: BelowThresholdRecordLike[],
  threshold: number,
): { pass: number; total: number; rate: number | null } {
  const total = records.length;
  const pass = records.filter((r) =>
    isPassing(
      r.rate,
      typeof r.thresholdAtSchedule === "number"
        ? r.thresholdAtSchedule
        : threshold,
    ),
  ).length;
  return {
    pass,
    total,
    rate:
      total > 0 ? Math.round((pass / total) * 1000) / 10 : null,
  };
}

function isRegularRecord(
  record: BelowThresholdRecordLike,
  taskById: Map<string, BelowThresholdTaskLike>,
): boolean {
  if (!record.taskId) return true; // 匯入紀錄，無任務可對應，視為常規
  const task = taskById.get(record.taskId);
  if (!task) return true; // 任務已被刪除，無法證明為加審，視為常規
  return task.scheduleCategory !== "temp"; // 缺 scheduleCategory 的舊任務視為常規
}

/**
 * 建未達閾值清單：只限常規紀錄，按（年、月）分組，每列為該月未達單位。
 * 排序：最新年月在前；列內單位依代碼排序。
 */
export function buildBelowThresholdRows(input: {
  records: BelowThresholdRecordLike[];
  tasks: BelowThresholdTaskLike[];
  indicatorId: string;
  threshold: number;
  /** 該指標的臨時排程（含自審；函式內自行排除自審） */
  tempSchedules: IndicatorSchedule[];
}): BelowThresholdRow[] {
  const taskById = new Map(input.tasks.map((t) => [t.id, t]));
  const regular = input.records.filter(
    (r) =>
      r.indicatorId === input.indicatorId &&
      isRegularRecord(r, taskById),
  );
  const byMonth = new Map<
    string,
    Map<string, BelowThresholdRecordLike[]>
  >();
  for (const r of regular) {
    const mk = `${r.year}-${r.month}`;
    let units = byMonth.get(mk);
    if (!units) {
      units = new Map();
      byMonth.set(mk, units);
    }
    const arr = units.get(r.unitId) ?? [];
    arr.push(r);
    units.set(r.unitId, arr);
  }
  const rows: BelowThresholdRow[] = [];
  for (const [mk, units] of byMonth) {
    const [y, m] = mk.split("-").map(Number);
    const failed: BelowThresholdUnit[] = [];
    for (const [unitId, rs] of units) {
      const pr = unitMonthPassRate(rs, input.threshold);
      if (
        pr.rate != null &&
        input.threshold > 0 &&
        pr.rate < input.threshold
      ) {
        failed.push({
          unitId,
          pass: pr.pass,
          total: pr.total,
          rate: pr.rate,
        });
      }
    }
    if (failed.length === 0) continue;
    failed.sort((a, b) => a.unitId.localeCompare(b.unitId, "zh-Hant"));
    const target = nextCalendarMonth(y, m);
    const failedIds = new Set(failed.map((u) => u.unitId));
    const alreadyAddReviewed = input.tempSchedules.some((s) => {
      if (s.category !== "temp" || s.selfReview) return false;
      const covers = scheduleReviewCalendarMonths(s).some(
        (ym) => ym.year === target.year && ym.month === target.month,
      );
      if (!covers) return false;
      if (s.unlimitedUnits) return true;
      return s.unitIds.some((u) => failedIds.has(u));
    });
    rows.push({
      year: y,
      month: m,
      threshold: input.threshold,
      units: failed,
      alreadyAddReviewed,
    });
  }
  rows.sort((a, b) => b.year - a.year || b.month - a.month);
  return rows;
}
