/**
 * 送出後確認儲存（v1.73.0）：batch.commit() 於伺服器確認後才完成；此處再加兩層保護：
 * 1. 逾時提示：超過 timeoutMs 仍未完成（常見於額度用盡／網路不穩）就呼叫 onSlow，
 *    提醒使用者勿關閉頁面（寫入仍會在原瀏覽器持續重試）；
 * 2. 讀回確認：commit 完成後向伺服器讀該文件，確認存在。讀回本身失敗
 *    （例如讀取額度已滿）不代表沒存到，回傳 "unverified"。
 */
import { getDocFromServer } from "./db";

export type CommitResult = "confirmed" | "unverified";

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function commitAndVerify(
  batch: { commit: () => Promise<void> },
  verifyRef: any,
  opts: { timeoutMs?: number; onSlow?: () => void } = {},
): Promise<CommitResult> {
  const timer = opts.onSlow
    ? setTimeout(opts.onSlow, opts.timeoutMs ?? 15000)
    : null;
  try {
    await batch.commit();
  } finally {
    if (timer) clearTimeout(timer);
  }
  try {
    const snap = await getDocFromServer(verifyRef);
    return snap.exists() ? "confirmed" : "unverified";
  } catch {
    return "unverified";
  }
}
