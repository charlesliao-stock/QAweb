/**
 * 審查逐件進度（v1.11.0 新增）。
 * 純函式：逐件累計、完成判斷、頁籤分類，可單元測試。
 */

/** 應審件數：caseCount 為 null（排程未設定）時視為 1 */
export function requiredCases(caseCount: number | null): number {
  return caseCount != null && caseCount >= 1 ? caseCount : 1;
}

/** 逐件紀錄 doc id：`${taskId}_c${seq}`（seq 三位補零，例如 t1_c003） */
export function reviewCaseDocId(taskId: string, seq: number): string {
  return `${taskId}_c${String(seq).padStart(3, "0")}`;
}

/** 完成判斷：該單位完成數 ≧ 應審件數 */
export function isTaskComplete(
  doneCount: number,
  caseCount: number | null,
): boolean {
  return doneCount >= requiredCases(caseCount);
}

/** 完成/應審件數標籤，例如「12/30」 */
export function progressLabel(
  doneCount: number,
  caseCount: number | null,
): string {
  return `${doneCount}/${requiredCases(caseCount)}`;
}

/** 下一件件次：已有件數＋1（舊格式單筆紀錄也算 1 件） */
export function nextCaseSeq(existingCount: number): number {
  return existingCount + 1;
}

/**
 * 頁籤分類（v1.12.2）：純粹以計數判斷——完成數 ≧ 應審件數 → done；否則 pending。
 * 不再參考 task.status：舊版（v1.10.x）單筆提交會把 status 寫成 done，
 * 逐件制後殘留的 done 會讓 1/3 這種任務誤入已完成頁籤。
 */
export function taskTab(
  doneCount: number,
  caseCount: number | null,
): "done" | "pending" {
  return isTaskComplete(doneCount, caseCount) ? "done" : "pending";
}
