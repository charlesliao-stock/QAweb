/**
 * 審查員名單（reviewReviewers）同步（v1.51.0）。
 *
 * 排程搜尋審查員只讀 reviewReviewers 集合；所有授予審查員角色的路徑
 * （人員編輯、角色頁籤加入成員、人員批次匯入、grantReviewerRole）
 * 都必須同步此集合，否則人員有角色卻在排程搜尋不到。
 * 自動連動的文件一律寫 groupId "__uncategorized__"（未分類）；
 * 移除角色時只刪自動加入的未分類文件，手動指派的不動。
 */
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "./db";
import {
  reviewerDocId,
  shouldAutoLinkReviewer,
  UNCATEGORIZED_GROUP_ID,
} from "./scheduling";
import { isReviewerAccessActive } from "./reviewerValidity";
import type { RoleMetaMap } from "./orgMeta";

/**
 * 同步單一人員的審查員名單文件。
 * 有審查員身分 → 無文件時建檔（未分類）；無身分 → 刪自動加入的未分類文件。
 * 回傳 linked（新建）／removed（刪除）／unchanged。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function syncReviewerDoc(
  db: any,
  staffId: string,
  roles: string[],
  roleMeta?: RoleMetaMap,
): Promise<"linked" | "removed" | "unchanged"> {
  if (shouldAutoLinkReviewer(roles, roleMeta)) {
    const existing = await getDocs(
      query(
        collection(db, "reviewReviewers"),
        where("personId", "==", staffId),
        limit(1),
      ),
    );
    if (existing.empty) {
      await setDoc(
        doc(
          db,
          "reviewReviewers",
          reviewerDocId(UNCATEGORIZED_GROUP_ID, staffId),
        ),
        {
          groupId: UNCATEGORIZED_GROUP_ID,
          personId: staffId,
          createdAt: serverTimestamp(),
        },
      );
      return "linked";
    }
    return "unchanged";
  }
  const ref = doc(
    db,
    "reviewReviewers",
    reviewerDocId(UNCATEGORIZED_GROUP_ID, staffId),
  );
  const snap = await getDoc(ref);
  if (snap.exists()) {
    await deleteDoc(ref);
    return "removed";
  }
  return "unchanged";
}

/**
 * 一次性回填：為現有全部具審查員角色且效期有效、但尚無名單文件的人員
 * 補建審查員名單文件（未分類）。回傳新建筆數。
 */
export async function backfillReviewerDocs(
  db: any,
  roleMeta?: RoleMetaMap,
): Promise<number> {
  const [usersSnap, reviewersSnap] = await Promise.all([
    getDocs(collection(db, "users")),
    getDocs(collection(db, "reviewReviewers")),
  ]);
  const hasDoc = new Set<string>();
  reviewersSnap.docs.forEach((d) => {
    const personId = d.data().personId;
    if (typeof personId === "string" && personId) hasDoc.add(personId);
  });
  let created = 0;
  for (const d of usersSnap.docs) {
    const data = d.data() as Record<string, unknown>;
    const staffId = d.id;
    if (hasDoc.has(staffId)) continue;
    const roles = Array.isArray(data.roles)
      ? (data.roles as unknown[]).map(String)
      : [];
    if (!shouldAutoLinkReviewer(roles, roleMeta)) continue;
    if (!isReviewerAccessActive(data.reviewerAccessExpiresAt)) continue;
    await setDoc(
      doc(
        db,
        "reviewReviewers",
        reviewerDocId(UNCATEGORIZED_GROUP_ID, staffId),
      ),
      {
        groupId: UNCATEGORIZED_GROUP_ID,
        personId: staffId,
        createdAt: serverTimestamp(),
      },
    );
    created += 1;
  }
  return created;
}
