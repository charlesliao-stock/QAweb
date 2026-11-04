/**
 * 稽核軌跡寫入（最小可行版本）。
 * 寫入 auditLogs collection（append-only；查詢限系統管理員，見 firestore.rules）。
 * 寫入失敗不影響主流程：稽核是附加紀錄，不該擋下使用者的儲存操作。
 */
import { collection, doc, serverTimestamp, setDoc } from "./db";
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface AuditEntry {
  /** 操作人員職編 */
  actor: string;
  /** 操作人員姓名（寫入當下快照，方便列表顯示） */
  actorName?: string;
  /** 動作，例如：建立指標、編輯指標、停用指標 */
  action: string;
  /** 對象類型，例如：indicator */
  targetType: string;
  /** 對象 ID，例如指標編號 */
  targetId: string;
  /** 補充說明 */
  detail?: string;
}

export async function writeAuditLog(db: any, entry: AuditEntry): Promise<void> {
  await setDoc(doc(collection(db, "auditLogs")), {
    actor: entry.actor,
    actorName: entry.actorName ?? "",
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    detail: entry.detail ?? "",
    createdAt: serverTimestamp(),
  });
}

/** fire-and-forget：失敗時靜默忽略，不影響主流程 */
export function logAudit(db: any, entry: AuditEntry): void {
  writeAuditLog(db, entry).catch(() => {
    /* 稽核寫入失敗不擋主流程 */
  });
}

export interface AuditFilterRow {
  actorLabel: string;
  action: string;
  target: string;
  detail: string;
  /** YYYY-MM-DD（本地日期） */
  dateKey: string;
}

/**
 * 稽核列表篩選（純函式）：關鍵字比對人員／動作／對象／說明＋日期相等。
 * 供 AdminPage 稽核軌跡的搜尋＋日期篩選用，可單元測試。
 */
export function filterAuditRows<T extends AuditFilterRow>(
  rows: T[],
  keyword: string,
  dateFilter: string,
): T[] {
  const kw = keyword.trim().toLowerCase();
  return rows.filter((r) => {
    if (dateFilter && r.dateKey !== dateFilter) return false;
    if (!kw) return true;
    return [r.actorLabel, r.action, r.target, r.detail].some((f) =>
      f.toLowerCase().includes(kw),
    );
  });
}
