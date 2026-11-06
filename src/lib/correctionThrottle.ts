/**
 * 儀表板任務狀態校正寫入節流（v1.28 階段 6 B8）。
 *
 * 背景：v1.27.2 已把逐筆 updateDoc 改為收集後 writeBatch（400 筆分段），
 * 但 batch 內每筆 update 仍各計 1 次寫入；階段 2 已把校正範圍縮小到
 * 本月＋次月＋鎖定＋逾期任務。本模組再節流「重複寫入同一狀態」：
 * 同一任務在同一工作階段（記憶體內、重整頁面即重置）一小時內已寫入過
 * 相同目標狀態，就不再重寫；目標狀態變了仍寫。
 *
 * 接受的代價：狀態顯示最多延遲一小時（任務狀態被他人改回、又需再校正時）。
 * 寫入失敗不記入節流（下次載入再試），由呼叫端顯示可見提示。
 * 呼叫端只在 batch.commit() 成功後才 markCorrectionWritten。
 */

/** 同一任務、同一目標狀態，一小時內不重複寫入 */
export const CORRECTION_THROTTLE_MS = 60 * 60 * 1000;
/** 記憶體上限（防無界增長；達上限時清掉最舊的一批） */
const MAX_ENTRIES = 500;

const written = new Map<string, { status: string; at: number }>();

export function shouldWriteCorrection(
  taskId: string,
  status: string,
  now: number = Date.now(),
): boolean {
  const prev = written.get(taskId);
  if (!prev) return true;
  if (prev.status !== status) return true; // 目標狀態變了，仍須寫
  return now - prev.at >= CORRECTION_THROTTLE_MS;
}

export function markCorrectionWritten(
  taskId: string,
  status: string,
  now: number = Date.now(),
): void {
  written.set(taskId, { status, at: now });
  if (written.size > MAX_ENTRIES) {
    const sorted = [...written.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [id] of sorted.slice(0, written.size - MAX_ENTRIES)) {
      written.delete(id);
    }
  }
}

/** 測試用：清空節流紀錄 */
export function clearCorrectionThrottle(): void {
  written.clear();
}
