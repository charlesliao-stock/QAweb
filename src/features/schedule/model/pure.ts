import { UNCATEGORIZED_GROUP_ID, type IndicatorSchedule, scheduleReviewCalendarMonths, scheduleSetupComplete, type AssignmentItem, mergeReviewMonths, type IndicatorAssignment } from "../../../lib/scheduling";
import { academicYearOf } from "../../../lib/cycle";

/** v1.88.3：組別 id 轉顯示名稱；審查員名單的未分類顯示為「未分類」，而非原始 id */
export function groupDisplayName(groupMap: Map<string, string>, gid: string): string {
  if (gid === UNCATEGORIZED_GROUP_ID) return "未分類";
  return groupMap.get(gid) ?? gid;
}

/** 排程 → 全部審查曆年月（起始月＋區間月數展開；v1.23） */
export function scheduleCalendarMonths(
  s: IndicatorSchedule,
): { year: number; month: number }[] {
  return scheduleReviewCalendarMonths(s);
}

export const PILL_OK = "status-pill success";

export const PILL_NONE = "status-pill muted";

/* ================= 純函式（UI 判定邏輯，可單元測試） ================= */

/**
 * 排程 pill：設定完成（受審單位≥1、月份≥1、審查件數>0）→ "done"（已排），
 * 否則 "none"（未排）。v1.18 起件數為必填，一併納入判定。
 */
export function schedulePillState(
  schedule: IndicatorSchedule | null,
): "done" | "none" {
  return scheduleSetupComplete(schedule) ? "done" : "none";
}

/**
 * 分工表合併（v1.18）：把選中的審查員 × 選中的單位併入既有分工表；
 * 已存在者保留其每單位件數（透傳），新單位件數為 null。
 * v1.51.0：既有不限單位項目併入新單位時旗標取消（改為指定單位）；
 * 新單位為空且既有項目為不限單位時保留旗標。
 * 純函式，可單元測試。
 */
export function mergeItemsWithUnits(
  prev: AssignmentItem[],
  reviewerIds: string[],
  unitIds: string[],
  reviewMonths: string[] = [],
): AssignmentItem[] {
  const next: AssignmentItem[] = prev.map((it) => ({
    ...it,
    units: it.units.map((u) => ({ ...u })),
  }));
  for (const rid of reviewerIds) {
    const existing = next.find((it) => it.reviewerId === rid);
    const existingMap = new Map(
      (existing?.units ?? []).map((u) => [u.unitId, u.caseCount]),
    );
    const merged = [...new Set([...existingMap.keys(), ...unitIds])]
      .map((unitId) => ({
        unitId,
        caseCount: existingMap.get(unitId) ?? null,
      }))
      .sort((a, b) => a.unitId.localeCompare(b.unitId, "zh-Hant"));
    const idx = next.findIndex((it) => it.reviewerId === rid);
    // v1.88.13：審查月份取聯集；既有為空（＝全部月份）時新填月份直接取代。
    const months = mergeReviewMonths(existing?.reviewMonths, reviewMonths);
    const monthsPart =
      months.length > 0 ? { reviewMonths: months } : {};
    // 併入單位後即為指定單位項目，旗標取消；單位為空才保留原旗標
    const item: AssignmentItem =
      merged.length > 0
        ? { reviewerId: rid, units: merged, ...monthsPart }
        : existing?.unlimitedUnits === true
          ? { reviewerId: rid, units: [], unlimitedUnits: true as const, ...monthsPart }
          : { reviewerId: rid, units: [] };
    if (idx >= 0) next[idx] = item;
    else next.push(item);
  }
  return next.sort((a, b) => a.reviewerId.localeCompare(b.reviewerId, "zh-Hant"));
}

/**
 * 分工表合併（不限單位，v1.51.0）：把選中的審查員以不限單位項目併入分工表
 *（units 為空、unlimitedUnits 為 true）；已存在者保留原單位設定以外的欄位，
 * 其餘項目不動。純函式，可單元測試。
 */
export function mergeItemsUnlimited(
  prev: AssignmentItem[],
  reviewerIds: string[],
  reviewMonths: string[] = [],
): AssignmentItem[] {
  const next: AssignmentItem[] = prev.map((it) => ({
    ...it,
    units: it.units.map((u) => ({ ...u })),
  }));
  for (const rid of reviewerIds) {
    const idx = next.findIndex((it) => it.reviewerId === rid);
    const existing = idx >= 0 ? next[idx] : undefined;
    // v1.88.13：審查月份取聯集；既有為空（＝全部月份）時新填月份直接取代。
    const months = mergeReviewMonths(existing?.reviewMonths, reviewMonths);
    const item: AssignmentItem = {
      reviewerId: rid,
      units: [],
      unlimitedUnits: true as const,
      ...(months.length > 0 ? { reviewMonths: months } : {}),
    };
    if (idx >= 0) next[idx] = item;
    else next.push(item);
  }
  return next.sort((a, b) => a.reviewerId.localeCompare(b.reviewerId, "zh-Hant"));
}

/** 分工表 pill：有分工表且有項目 → "done"，否則 "none" */
export function assignmentPillState(
  assignment: IndicatorAssignment | null | undefined,
): "done" | "none" {
  return assignment && assignment.items.length > 0 ? "done" : "none";
}

/** 加審／自審預覽任務數＝月份數 × 單位數 × 審核員數 */
export function previewTempTaskCount(
  months: readonly unknown[],
  unitIds: string[],
  reviewerIds: string[],
): number {
  return months.length * unitIds.length * reviewerIds.length;
}

/** 預設期間：依統計週期（年度→今年西元年；學年度→本學年度民國年） */
export function defaultPeriodForStatsCycle(
  cycle: "year" | "academic",
  now: Date = new Date(),
): string {
  return cycle === "academic"
    ? String(academicYearOf(now))
    : String(now.getFullYear());
}

/** 自審審核員預設：自己單位的在職人員 */
export function defaultSelfAuditReviewers(
  users: { id: string; unitCode: string; status: string }[],
  unitCode: string,
): string[] {
  return users
    .filter((u) => u.unitCode === unitCode && u.status === "在職")
    .map((u) => u.id);
}

/** 加審審核員預設：分工表中涵蓋所選單位者 */
export function defaultAddAuditReviewers(
  assignment: IndicatorAssignment | null | undefined,
  unitIds: string[],
): string[] {
  const set = new Set<string>();
  for (const it of assignment?.items ?? []) {
    if (it.units.some((u) => unitIds.includes(u.unitId))) {
      set.add(it.reviewerId);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, "zh-Hant"));
}
