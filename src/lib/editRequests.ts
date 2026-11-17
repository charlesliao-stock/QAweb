/**
 * 封存後修改審查紀錄的待審流程（v1.64.1）。
 * 區間已封存摘要（reviewArchives）時，修改紀錄不直接寫入，改建立
 * reviewEditRequests（pending）；召集人／執行幹事／管理員核准後才套用到
 * reviewRecords，並重新封存摘要。駁回則紀錄維持原狀。
 */
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from "./db";
import { SUMMARY_COLLECTION } from "./summaryStore";
import { writeAuditLog } from "./audit";
/* eslint-disable @typescript-eslint/no-explicit-any */

export const EDIT_REQUEST_COLLECTION = "reviewEditRequests";

export interface EditRequest {
  id: string;
  status: "pending" | "approved" | "rejected";
  recordId: string;
  taskId: string;
  indicatorId: string;
  groupId: string;
  unitId: string;
  year: number;
  month: number;
  archiveIds: string[];
  reason: string;
  requestedBy: string;
  requestedByName: string;
  /** 欄位異動：{ 欄位: { before, after } } */
  changes: Record<string, { before: unknown; after: unknown }>;
  /** 核准時要寫入紀錄的欄位值（不含時間戳與 version） */
  nextValues: Record<string, unknown>;
  /** 申請當時紀錄的 version（核准時比對，不符＝紀錄已被改動，需重新申請） */
  baseVersion: number | null;
  oldUniqueKey: string;
  newUniqueKey: string;
  intervalId: string;
  personEmpNo: string;
  reviewedByName?: string;
  decisionNote?: string;
}

function fromDoc(id: string, d: Record<string, unknown>): EditRequest {
  return {
    id,
    status:
      d.status === "approved" ? "approved" : d.status === "rejected" ? "rejected" : "pending",
    recordId: String(d.recordId ?? ""),
    taskId: String(d.taskId ?? ""),
    indicatorId: String(d.indicatorId ?? ""),
    groupId: String(d.groupId ?? ""),
    unitId: String(d.unitId ?? ""),
    year: Number(d.year ?? 0),
    month: Number(d.month ?? 0),
    archiveIds: Array.isArray(d.archiveIds) ? (d.archiveIds as string[]) : [],
    reason: String(d.reason ?? ""),
    requestedBy: String(d.requestedBy ?? ""),
    requestedByName: String(d.requestedByName ?? ""),
    changes: (d.changes ?? {}) as EditRequest["changes"],
    nextValues: (d.nextValues ?? {}) as Record<string, unknown>,
    baseVersion: typeof d.baseVersion === "number" ? d.baseVersion : null,
    oldUniqueKey: String(d.oldUniqueKey ?? ""),
    newUniqueKey: String(d.newUniqueKey ?? ""),
    intervalId: String(d.intervalId ?? ""),
    personEmpNo: String(d.personEmpNo ?? ""),
    reviewedByName: typeof d.reviewedByName === "string" ? d.reviewedByName : undefined,
    decisionNote: typeof d.decisionNote === "string" ? d.decisionNote : undefined,
  };
}

/** 查詢該指標涵蓋指定年月的全部封存摘要（年度與加審區間可能重疊）；不可限制前 200 筆。 */
export async function findArchiveIdsForRecord(
  db: any,
  indicatorId: string,
  year: number,
  month: number,
): Promise<string[]> {
  const snap = await getDocs(
    query(
      collection(db, SUMMARY_COLLECTION),
      where("indicatorId", "==", indicatorId),
    ),
  );
  const key = year * 100 + month;
  const ids: string[] = [];
  snap.docs.forEach((d: any) => {
    const v = d.data() as Record<string, any>;
    const s = v.start;
    const e = v.end;
    if (!s || !e) return;
    if (key >= s.year * 100 + s.month && key <= e.year * 100 + e.month) ids.push(d.id);
  });
  return ids;
}

export async function hasPendingEditRequest(db: any, recordId: string): Promise<boolean> {
  const snap = await getDocs(
    query(
      collection(db, EDIT_REQUEST_COLLECTION),
      where("recordId", "==", recordId),
      where("status", "==", "pending"),
      limit(1),
    ),
  );
  return !snap.empty;
}

export async function createEditRequest(
  db: any,
  req: Omit<EditRequest, "id" | "status">,
): Promise<void> {
  const ref = doc(collection(db, EDIT_REQUEST_COLLECTION));
  const batch = writeBatch(db);
  batch.set(ref, { ...req, status: "pending", requestedAt: serverTimestamp() });
  batch.set(doc(collection(db, "auditLogs")), {
    actor: req.requestedBy,
    actorName: req.requestedByName,
    action: "申請修改已封存審查結果",
    targetType: "reviewRecord",
    targetId: req.recordId,
    detail: `指標「${req.indicatorId}」／單位「${req.unitId}」；異動欄位：${Object.keys(req.changes).join("、")}；原因：${req.reason}`,
    createdAt: serverTimestamp(),
  });
  await batch.commit();
}

export async function loadPendingEditRequests(db: any): Promise<EditRequest[]> {
  const snap = await getDocs(
    query(
      collection(db, EDIT_REQUEST_COLLECTION),
      where("status", "==", "pending"),
      limit(500),
    ),
  );
  return snap.docs.map((d: any) => fromDoc(d.id, d.data() as Record<string, unknown>));
}

/** 核准：套用修改到原紀錄 → 標記核准 → 重新封存受影響的摘要 */
export async function approveEditRequest(
  db: any,
  req: EditRequest,
  actor: { id: string; name: string },
  rearchive: (archiveId: string) => Promise<void>,
): Promise<void> {
  const recordRef = doc(db, "reviewRecords", req.recordId);
  const snap = await getDoc(recordRef);
  if (!snap.exists()) throw new Error("找不到要修改的審查紀錄");
  const previous = snap.data() as Record<string, unknown>;
  const curVersion = typeof previous.version === "number" ? previous.version : null;
  if (curVersion !== req.baseVersion)
    throw new Error("該紀錄在申請後已被修改，請駁回並請申請人重新送出");

  const batch = writeBatch(db);
  if (req.oldUniqueKey && req.oldUniqueKey !== req.newUniqueKey)
    batch.delete(doc(db, "reviewReservations", req.oldUniqueKey));
  if (req.newUniqueKey) {
    const resRef = doc(db, "reviewReservations", req.newUniqueKey);
    const resSnap = await getDoc(resRef);
    if (!resSnap.exists()) {
      batch.set(resRef, {
        uniqueKey: req.newUniqueKey,
        ownerId: actor.id,
        targetCollection: "reviewRecords",
        targetId: req.recordId,
        taskId: req.taskId,
        indicatorId: req.indicatorId,
        intervalId: req.intervalId,
        personEmpNo: req.personEmpNo,
        status: "submitted",
        createdAt: serverTimestamp(),
      });
    } else if (String((resSnap.data() as any).targetId ?? "") !== req.recordId) {
      throw new Error("此受審人員的唯一名額已被其他審查紀錄或暫存占用");
    }
  }
  const history = Array.isArray(previous.editHistory) ? [...previous.editHistory] : [];
  history.push({
    actorId: req.requestedBy,
    actorName: req.requestedByName,
    editedAt: new Date().toISOString(),
    approvedBy: actor.id,
    approvedByName: actor.name,
    changes: req.changes,
  });
  batch.update(recordRef, {
    ...req.nextValues,
    ...(typeof previous.quotaGroupId === "string"
      ? { version: Number(previous.version ?? 1) + 1 }
      : {}),
    editHistory: history,
    lastModifiedAt: serverTimestamp(),
    lastModifiedBy: req.requestedBy,
    lastModifiedByName: req.requestedByName,
  });
  batch.update(doc(db, EDIT_REQUEST_COLLECTION, req.id), {
    status: "approved",
    reviewedBy: actor.id,
    reviewedByName: actor.name,
    reviewedAt: serverTimestamp(),
  });
  batch.set(doc(collection(db, "auditLogs")), {
    actor: actor.id,
    actorName: actor.name,
    action: "核准修改已封存審查結果",
    targetType: "reviewRecord",
    targetId: req.recordId,
    detail: `申請人 ${req.requestedByName}；指標「${req.indicatorId}」／單位「${req.unitId}」；異動欄位：${Object.keys(req.changes).join("、")}`,
    before: Object.fromEntries(Object.entries(req.changes).map(([k, v]) => [k, v.before])),
    after: Object.fromEntries(Object.entries(req.changes).map(([k, v]) => [k, v.after])),
    createdAt: serverTimestamp(),
  });
  await batch.commit();
  for (const id of req.archiveIds) {
    try {
      await rearchive(id);
    } catch {
      // 重新封存失敗：紀錄已更新，摘要仍是舊的；呼叫端會提示手動「重新封存」
      throw new Error("修改已核准並套用，但摘要重新封存失敗，請到品管審查頁按「重新封存」");
    }
  }
}

export async function rejectEditRequest(
  db: any,
  req: EditRequest,
  actor: { id: string; name: string },
  note: string,
): Promise<void> {
  const batch = writeBatch(db);
  batch.update(doc(db, EDIT_REQUEST_COLLECTION, req.id), {
    status: "rejected",
    reviewedBy: actor.id,
    reviewedByName: actor.name,
    reviewedAt: serverTimestamp(),
    decisionNote: note,
  });
  await batch.commit();
  await writeAuditLog(db, {
    actor: actor.id,
    actorName: actor.name,
    action: "駁回修改已封存審查結果",
    targetType: "reviewRecord",
    targetId: req.recordId,
    detail: `申請人 ${req.requestedByName}；原因：${note}`,
  }).catch(() => undefined);
}
