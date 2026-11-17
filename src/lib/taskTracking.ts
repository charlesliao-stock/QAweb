/**
 * 查閱彈窗任務追蹤（v1.88.4）：純函式，不碰 Firestore，可 node 測試。
 *
 * 已審件數務必用配額感知計數（沿用儀表板做法，不直接數單筆任務紀錄）：
 * - 非配額任務：doneCount＝countRecordsByTaskWithImports（單筆任務紀錄按
 *   taskId 計，匯入紀錄按「指標＋單位＋年月」歸屬，含不限單位 NA 任務）；
 * - 週期共用配額任務（quotaVersion 1 且有 quotaGroupId）：doneCount＝
 *   loadPeriodicQuotaCounts 的整組區間計數（同組任務共用，見
 *   dashboard/periodicQuotaCounts；紀錄以 quotaGroupId 標記歸屬，
 *   匯入紀錄以區間比對歸屬），經 taskProgressCount 取用。
 * - 應審件數＝requiredCases(caseCount)，caseCount 為 null 時視為 1。
 * - 狀態以 correctTaskStatus 校正（完成數 ≧ 應審 → done；否則逾期 → locked；
 *   否則 pending）；進度未知（紀錄讀取失敗／配額群組查詢失敗）時不校正，
 *   沿用任務儲存的狀態，已審顯示「—」。
 *
 * 審查員小計（本期已審／應審）：同一審查員的任務加總；同一配額群組的
 * 多筆任務只計一次（共用配額與應審件數皆以組為單位，否則會重複放大）。
 */

import {
  taskProgressCount,
  type DashTask,
} from "./dashboardStats";
import {
  correctTaskStatus,
  requiredCases,
} from "./reviewProgress";
import type { ReviewTaskStatus } from "./scheduling";

/** 追蹤表輸入的任務（ScheduleDetailModal 的 TaskLite 形狀） */
export interface TrackedTaskInput {
  id: string;
  year: number;
  month: number;
  unitId: string;
  reviewerId: string;
  status: string;
  deadline: string;
  caseCount: number | null;
  completedAt: string;
  quotaVersion?: number;
  quotaGroupId?: string;
  quotaIntervalStartYear?: number;
  quotaIntervalStartMonth?: number;
  quotaIntervalEndYear?: number;
  quotaIntervalEndMonth?: number;
}

export interface TrackedTaskRow {
  id: string;
  year: number;
  month: number;
  unitId: string;
  reviewerId: string;
  deadline: string;
  completedAt: string;
  quotaGroupId?: string;
  /** 週期共用配額的區間（有值時顯示於年月旁） */
  quotaInterval?: {
    startYear: number;
    startMonth: number;
    endYear: number;
    endMonth: number;
  };
  /** 已審件數；null＝進度未知 */
  done: number | null;
  required: number;
  /** 進度％（0–100；未知時為 null） */
  pct: number | null;
  status: ReviewTaskStatus;
}

function toDashTask(input: TrackedTaskInput, doneCount: number): DashTask {
  return {
    id: input.id,
    indicatorId: "",
    unitId: input.unitId,
    reviewerId: input.reviewerId,
    year: input.year,
    month: input.month,
    caseCount: input.caseCount,
    deadline: input.deadline,
    status:
      input.status === "done"
        ? "done"
        : input.status === "locked"
          ? "locked"
          : "pending",
    doneCount,
    quotaVersion: input.quotaVersion === 1 ? 1 : undefined,
    quotaGroupId: input.quotaGroupId,
    quotaIntervalStartYear: input.quotaIntervalStartYear,
    quotaIntervalStartMonth: input.quotaIntervalStartMonth,
    quotaIntervalEndYear: input.quotaIntervalEndYear,
    quotaIntervalEndMonth: input.quotaIntervalEndMonth,
  };
}

/**
 * 由任務＋計數表組出追蹤列。
 * - counts：countRecordsByTaskWithImports 的結果（taskId → 已審件數）；
 * - quotaCounts：loadPeriodicQuotaCounts 的結果（quotaGroupId → 整組已審件數）；
 * - quotaFailedGroups：配額查詢失敗的群組（該組任務進度未知）；
 * - countsUnknown：紀錄讀取失敗（非配額任務進度未知）。
 */
export function buildTrackedRows(
  tasks: TrackedTaskInput[],
  counts: Map<string, number>,
  quotaCounts: Map<string, number>,
  quotaFailedGroups: Set<string>,
  countsUnknown: boolean,
): TrackedTaskRow[] {
  return tasks.map((task) => {
    const required = requiredCases(task.caseCount);
    const dash = toDashTask(task, counts.get(task.id) ?? 0);
    if (task.quotaGroupId) {
      if (quotaFailedGroups.has(task.quotaGroupId)) {
        dash.quotaDoneCountUnknown = true;
      } else {
        // 儀表板同款：群組查回但零筆＝0（只有查詢失敗才未知）
        dash.quotaDoneCount = quotaCounts.get(task.quotaGroupId) ?? 0;
      }
    }
    if (countsUnknown && !task.quotaGroupId) {
      dash.doneCountUnknown = true;
    }
    const done = taskProgressCount(dash);
    const status =
      done == null
        ? dash.status
        : correctTaskStatus(done, task.caseCount, task.deadline, dash.status);
    const interval =
      task.quotaIntervalStartYear != null &&
      task.quotaIntervalStartMonth != null &&
      task.quotaIntervalEndYear != null &&
      task.quotaIntervalEndMonth != null
        ? {
            startYear: task.quotaIntervalStartYear,
            startMonth: task.quotaIntervalStartMonth,
            endYear: task.quotaIntervalEndYear,
            endMonth: task.quotaIntervalEndMonth,
          }
        : undefined;
    return {
      id: task.id,
      year: task.year,
      month: task.month,
      unitId: task.unitId,
      reviewerId: task.reviewerId,
      deadline: task.deadline,
      completedAt: task.completedAt,
      quotaGroupId: task.quotaGroupId,
      quotaInterval: interval,
      done,
      required,
      pct: done == null ? null : Math.min(100, Math.round((done / required) * 100)),
      status,
    };
  });
}

export interface ReviewerSubtotal {
  /** 已審小計；null＝該審查員有進度未知的任務 */
  done: number | null;
  required: number;
  unknown: boolean;
}

/**
 * 審查員本期小計（已審／應審）：同一配額群組的多筆任務只計一次。
 * rows 應為同一排程期間（查閱彈窗的任務集合）。
 */
export function reviewerSubtotals(
  rows: TrackedTaskRow[],
): Map<string, ReviewerSubtotal> {
  const out = new Map<string, ReviewerSubtotal>();
  const seenQuotaGroups = new Map<string, Set<string>>();
  for (const row of rows) {
    const sub = out.get(row.reviewerId) ?? { done: 0, required: 0, unknown: false };
    if (row.quotaGroupId) {
      const seen = seenQuotaGroups.get(row.reviewerId) ?? new Set<string>();
      if (seen.has(row.quotaGroupId)) continue;
      seen.add(row.quotaGroupId);
      seenQuotaGroups.set(row.reviewerId, seen);
    }
    sub.required += row.required;
    if (row.done == null) {
      sub.unknown = true;
    } else if (sub.done != null) {
      sub.done += row.done;
    }
    out.set(row.reviewerId, sub);
  }
  for (const sub of out.values()) {
    if (sub.unknown) sub.done = null;
  }
  return out;
}

/** 任務狀態顯示文字（追蹤表／篩選共用） */
export function taskStatusLabel(status: ReviewTaskStatus): string {
  return status === "done" ? "已完成" : status === "locked" ? "逾期鎖定" : "待完成";
}
