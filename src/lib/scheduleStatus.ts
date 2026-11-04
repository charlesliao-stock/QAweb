import type { ScheduleTask } from "../types";

export type ScheduleTaskDisplayStatus =
  | "已完成"
  | "進行中"
  | "待開始"
  | "逾期補審"
  | "資料異常";

type ProgressFields = Pick<ScheduleTask, "done" | "total" | "status">;

/** A stored "已完成" label is never trusted unless all required work is done. */
export function getScheduleTaskDisplayStatus(
  task: ProgressFields,
): ScheduleTaskDisplayStatus {
  if (
    !Number.isFinite(task.done) ||
    !Number.isFinite(task.total) ||
    task.done < 0 ||
    task.total <= 0
  ) {
    return "資料異常";
  }
  if (task.done >= task.total) return "已完成";
  if (task.status === "逾期補審") return "逾期補審";
  if (task.done > 0) return "進行中";
  return task.status === "進行中" ? "進行中" : "待開始";
}

export function getScheduleTaskProgress(
  task: Pick<ScheduleTask, "done" | "total">,
) {
  if (
    !Number.isFinite(task.done) ||
    !Number.isFinite(task.total) ||
    task.total <= 0
  ) {
    return 0;
  }
  return Math.round(Math.max(0, Math.min(1, task.done / task.total)) * 100);
}
