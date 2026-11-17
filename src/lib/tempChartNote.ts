/**
 * 結果分析曲線圖「加審」標註判別（v1.59.0）。
 *
 * 純函式，不碰 DOM／Firestore，可單元測試。
 * 判別來源（前端反查，不改寫入端、不改 AnalysisRecord）：
 * - reviewTasks：scheduleCategory === "temp" 的任務；
 * - indicatorSchedules：以任務的 schedulePeriod 對應臨時排程，
 *   selfReview === true 者為自審任務，不標註。
 * 匯入紀錄（taskId 為空、無任務可反查）視為一般，不加註。
 *
 * 限制（見測試與版次回報）：
 * - 以（指標、單位、曆年月）比對任務與紀錄：同一（指標、單位、月）
 *   同時有加審與一般任務時，紀錄無法用 taskId 精確歸屬，
 *   只要該月有任一加審任務且該欄有紀錄即加註。
 * - 舊任務缺 scheduleCategory／schedulePeriod 時：缺 scheduleCategory
 *   視為一般（不標）；有 scheduleCategory === "temp" 但缺
 *   schedulePeriod、對不上排程時視為加審（自審任務皆帶 period）。
 * - 臨時排程文件若已被刪除，對不上自審，其任務亦視為加審。
 */

export interface TempTaskLike {
  indicatorId: string;
  year: number;
  month: number;
  unitId: string;
  scheduleCategory?: string;
  schedulePeriod?: string;
}

export interface TempRecordLike {
  indicatorId: string;
  year: number;
  month: number;
  unitId: string;
}

/** 加審任務月鍵：`${indicatorId}|${year}-${month}|${unitId}` */
export function tempTaskKey(
  indicatorId: string,
  year: number,
  month: number,
  unitId: string,
): string {
  return `${indicatorId}|${year}-${month}|${unitId}`;
}

/**
 * 由任務表建加審任務月鍵集合。
 * @param tasks 查詢年份內的 reviewTasks（需含 indicatorId／year／month／
 *   unitId／scheduleCategory／schedulePeriod）
 * @param selfReviewPeriodKeys 自審臨時排程鍵集合（`${indicatorId}|${period}`）
 */
export function buildTempTaskKeys(
  tasks: TempTaskLike[],
  selfReviewPeriodKeys: ReadonlySet<string>,
): Set<string> {
  const keys = new Set<string>();
  for (const t of tasks) {
    if (t.scheduleCategory !== "temp") continue;
    if (
      t.schedulePeriod &&
      selfReviewPeriodKeys.has(`${t.indicatorId}|${t.schedulePeriod}`)
    )
      continue;
    keys.add(tempTaskKey(t.indicatorId, t.year, t.month, t.unitId));
  }
  return keys;
}

/**
 * 期間欄加註文字。
 * - 該欄任一紀錄對上加審任務月鍵才加註（待執行、尚未產生紀錄的
 *   加審任務不加註；匯入紀錄對不上任務鍵，不加註）。
 * - 單月欄（monthCount === 1）：「（加審）」；季／半年／年欄：「（有加審）」。
 * - 無加審紀錄回 null。
 */
export function columnTempNote(
  records: TempRecordLike[],
  tempTaskKeys: ReadonlySet<string>,
  monthCount: number,
): string | null {
  if (tempTaskKeys.size === 0) return null;
  const hasTemp = records.some((r) =>
    tempTaskKeys.has(tempTaskKey(r.indicatorId, r.year, r.month, r.unitId)),
  );
  if (!hasTemp) return null;
  return monthCount === 1 ? "（加審）" : "（有加審）";
}
