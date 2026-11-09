/**
 * 任務交接純邏輯（v1.40.0，零依賴，可由 node 單測直接引用）。
 *
 * 交接語義（不變）：
 * - 只交接已分配但尚未完成的任務（status === "done" 的不交接）。
 * - 系統管理員可交接全部組別；召集人／執行幹事只可交接自己所屬組別的任務。
 * - 確認時至少勾選一筆＋已選新審查員；新審查員不得與任一已選任務的原審查員相同。
 * - 交接原因自由輸入，不強制必填。
 */

/** 交接頁任務列所需的最小欄位（頁面 TaskRow 為其超集）。 */
export interface HandoffTaskLike {
  id: string;
  status: string;
  groupId: string;
  unitId: string;
  reviewerId: string;
  groupName: string;
  unitName: string;
  indicatorName: string;
  month: number;
}

export interface HandoffScope {
  isAdmin: boolean;
  allowedGroupIds: string[];
}

/** 該任務是否可被交接（未完成，且在辦理人的可管範圍內）。 */
export function isHandoffEligible(task: HandoffTaskLike, scope: HandoffScope): boolean {
  if (task.status === "done") return false;
  if (scope.isAdmin) return true;
  return scope.allowedGroupIds.includes(task.groupId);
}

/** 依群組／單位下拉篩選（空字串＝不篩選）。 */
export function filterHandoffTasks<T extends HandoffTaskLike>(
  tasks: T[],
  filter: { groupId: string; unitId: string },
): T[] {
  return tasks.filter(
    (t) =>
      (!filter.groupId || t.groupId === filter.groupId) &&
      (!filter.unitId || t.unitId === filter.unitId),
  );
}

/** 與現行頁面相同的排序：群組 → 單位 → 指標 → 月份。 */
export function sortHandoffTasks<T extends HandoffTaskLike>(tasks: T[]): T[] {
  return [...tasks].sort(
    (a, b) =>
      a.groupName.localeCompare(b.groupName, "zh-Hant") ||
      a.unitName.localeCompare(b.unitName, "zh-Hant") ||
      a.indicatorName.localeCompare(b.indicatorName, "zh-Hant") ||
      a.month - b.month,
  );
}

/** 只取已勾選且未完成的任務（已完成即使被勾選也不交接）。 */
export function selectHandoffTasks<T extends HandoffTaskLike>(
  tasks: T[],
  selectedIds: string[],
): T[] {
  const picked = new Set(selectedIds);
  return tasks.filter((t) => picked.has(t.id) && t.status !== "done");
}

/** 確認交接的驗證；通過回傳 null，否則回傳要顯示的提示文字。 */
export function validateHandoff(
  selected: HandoffTaskLike[],
  newReviewerId: string,
): string | null {
  if (selected.length === 0) return "請先勾選至少一筆未完成任務";
  const to = newReviewerId.trim();
  if (!to) return "請先選取新審查員";
  if (selected.some((t) => t.reviewerId === to)) return "新審查員與原審查員相同，請重新輸入";
  return null;
}
