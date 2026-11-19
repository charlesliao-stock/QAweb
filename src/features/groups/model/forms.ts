import type { GroupForm, UnitForm, TitleForm, UserForm } from "./types";
import { serverTimestamp, type WriteBatch, writeBatch } from "../../../lib/db";
import { getFirebaseDb } from "../../../lib/firebase";

export function emptyGroupForm(): GroupForm {
  return { name: "" };
}

export function emptyUnitForm(): UnitForm {
  return { code: "", name: "", groupId: "", mergedFromUnitCodes: [] };
}

export function emptyTitleForm(): TitleForm {
  return {
    name: "",
    levelId: "",
    isUnitHead: false,
    isDistrictHead: false,
    isHospitalHead: false,
    isOfficer: false,
    isConvener: false,
  };
}

export function emptyUserForm(): UserForm {
  return {
    staffId: "",
    name: "",
    unitCode: "",
    title: "",
    titleId: "",
    hireDate: "",
    email: "",
    phone: "",
    memberships: [],
    mustChangePassword: false,
    titleUnitCodes: [],
    reviewerAccessExpiresAt: "",
  };
}

export function auditFields(staffId: string, isCreate: boolean) {
  const now = serverTimestamp();
  return isCreate
    ? {
        createdAt: now,
        createdBy: staffId,
        updatedAt: now,
        updatedBy: staffId,
      }
    : { updatedAt: now, updatedBy: staffId };
}

/** Firestore batch 寫入；每個操作最多包含人員更新＋auditLogs 兩次寫入 */
export async function commitInBatches(
  ops: Array<(b: WriteBatch) => void>,
): Promise<void> {
  const db = getFirebaseDb();
  for (let i = 0; i < ops.length; i += 250) {
    const b = writeBatch(db);
    ops.slice(i, i + 250).forEach((op) => op(b));
    await b.commit();
  }
}
