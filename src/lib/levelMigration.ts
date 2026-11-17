/**
 * v1.55.0 一次性層級遷移（隨版上線時由管理員開頁執行一次）。
 *
 * 1. 建立預設層級（titleLevels／roleLevels；已存在的不動）。
 * 2. 回填既有職稱／角色的 levelId（職稱按名、角色按名稱前綴；
 *    對不上的留空＝未分層級；已有 levelId 的不動）。
 * 3. 建立 6 個新角色（零權限，附稽核紀錄）。
 * 4. 清理舊名「品管執行幹事」：有人持有先遷移到「品管組執行幹事」
 *    再刪，無人直接刪；權限範本同名遷移（目標已存在時不覆蓋）。
 *
 * 防重跑：configs/orgLevelsV155 { done: true }；各步驟本身具等冪性，
 * 旗標只在全部成功後才寫入，失敗時下次開頁重試。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocsFromServer,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "./db";
import { templateDocId } from "./permissions";
import { syncReviewerDoc } from "./reviewerSync";
import { deriveStoredRoles } from "./roleIdentity";
import {
  DEFAULT_ROLE_LEVELS,
  DEFAULT_TITLE_LEVELS,
  LEGACY_DEPT_TITLE_LEVEL_ID,
  LEGACY_TITLE_LEVEL_IDS,
  MERGED_HEAD_NURSE_TITLE,
  NEW_ROLES,
  OLD_ROLE_NAME,
  OLD_ROLE_REPLACEMENT,
  planHeadNurseMerge,
  roleLevelIdForName,
  seedOrderForRole,
  seedOrderForTitle,
  titleLevelIdForName,
} from "./orgLevels";

export const ORG_LEVELS_MIGRATION_MARKER = "configs/orgLevelsV155";

/** v1.87.0：職稱層級拆分遷移旗標（部級→主任／副主任／督導／單位） */
export const TITLE_LEVELS_MIGRATION_MARKER = "configs/titleLevelsV187";

/** v1.88.8：職稱層級併回遷移旗標（主任／副主任／督導／單位→部級／單位） */
export const TITLE_LEVELS_V188_MIGRATION_MARKER = "configs/titleLevelsV188";

/** v1.88.8 補項：職稱／角色順序回填遷移旗標（order 欄位初值） */
export const TITLE_ROLE_ORDER_MIGRATION_MARKER = "configs/titleRoleOrderV188";

export interface TitleLevelsMigrationResult {
  levelsCreated: string[];
  titlesRemapped: number;
  /** 舊部級層級文件是否已刪除（無職稱再引用時才刪） */
  deptLevelRemoved: boolean;
}

export interface OrgLevelMigrationResult {
  levelsCreated: string[];
  titlesBackfilled: number;
  rolesBackfilled: number;
  rolesCreated: string[];
  oldRole: "none" | "deleted-empty" | "migrated";
  oldRoleHolders: number;
}

function auditFields(staffId: string, isCreate: boolean) {
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

export async function migrateOrgLevels(
  db: any,
  staffId: string,
  staffName: string,
): Promise<OrgLevelMigrationResult> {
  const markerRef = doc(db, ORG_LEVELS_MIGRATION_MARKER);
  const markerSnap = await getDoc(markerRef);
  if (markerSnap.exists() && markerSnap.data()?.done === true) {
    return {
      levelsCreated: [],
      titlesBackfilled: 0,
      rolesBackfilled: 0,
      rolesCreated: [],
      oldRole: "none",
      oldRoleHolders: 0,
    };
  }

  const result: OrgLevelMigrationResult = {
    levelsCreated: [],
    titlesBackfilled: 0,
    rolesBackfilled: 0,
    rolesCreated: [],
    oldRole: "none",
    oldRoleHolders: 0,
  };

  // 1. 預設層級（缺的才建）
  for (const [coll, levels] of [
    ["titleLevels", DEFAULT_TITLE_LEVELS],
    ["roleLevels", DEFAULT_ROLE_LEVELS],
  ] as const) {
    for (const level of levels) {
      const ref = doc(db, coll, level.id);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        await setDoc(ref, {
          name: level.name,
          order: level.order,
          ...auditFields(staffId, true),
        });
        result.levelsCreated.push(`${coll}/${level.name}`);
      }
    }
  }

  // 2. 回填 levelId（已有者不動）
  const titleSnap = await getDocsFromServer(collection(db, "titles"));
  for (const d of titleSnap.docs) {
    const data = d.data() as Record<string, unknown>;
    const name = typeof data.name === "string" ? data.name : "";
    const levelId = titleLevelIdForName(name);
    if (levelId && typeof data.levelId !== "string") {
      await updateDoc(doc(db, "titles", d.id), {
        levelId,
        ...auditFields(staffId, false),
      });
      result.titlesBackfilled += 1;
    }
  }
  const roleSnap = await getDocsFromServer(collection(db, "roles"));
  for (const d of roleSnap.docs) {
    const data = d.data() as Record<string, unknown>;
    const name = typeof data.name === "string" ? data.name : "";
    const levelId = roleLevelIdForName(name);
    if (levelId && typeof data.levelId !== "string") {
      await updateDoc(doc(db, "roles", d.id), {
        levelId,
        ...auditFields(staffId, false),
      });
      result.rolesBackfilled += 1;
    }
  }

  // 3. 建立 6 個新角色（同名已存在的不建）
  const existingRoleNames = new Set(
    roleSnap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      return typeof data.name === "string" ? data.name : d.id;
    }),
  );
  for (const spec of NEW_ROLES) {
    if (existingRoleNames.has(spec.name)) continue;
    const roleRef = doc(collection(db, "roles"));
    await setDoc(roleRef, {
      name: spec.name,
      description: spec.description,
      levelId: spec.levelId,
      ...auditFields(staffId, true),
    });
    await setDoc(doc(collection(db, "auditLogs")), {
      actor: staffId,
      actorName: staffName,
      action: "角色建立",
      targetType: "role",
      targetId: roleRef.id,
      detail: `層級遷移建立角色「${spec.name}」（v1.55.0）`,
      before: null,
      after: {
        name: spec.name,
        levelId: spec.levelId,
      },
      createdAt: serverTimestamp(),
    });
    result.rolesCreated.push(spec.name);
  }

  // 4. 清理舊名「品管執行幹事」
  const oldRoleDoc = roleSnap.docs.find((d) => {
    const data = d.data() as Record<string, unknown>;
    return data.name === OLD_ROLE_NAME;
  });
  if (oldRoleDoc) {
    const usersSnap = await getDocsFromServer(collection(db, "users"));
    const holders = usersSnap.docs.filter((d) => {
      const data = d.data() as Record<string, unknown>;
      const roles = Array.isArray(data.roles) ? data.roles.map(String) : [];
      const memberships = Array.isArray(data.memberships) ? data.memberships : [];
      return (
        roles.includes(OLD_ROLE_NAME) ||
        memberships.some(
          (m: any) =>
            Array.isArray(m?.roles) && m.roles.map(String).includes(OLD_ROLE_NAME),
        )
      );
    });
    result.oldRoleHolders = holders.length;
    if (holders.length > 0) {
      for (const d of holders) {
        const data = d.data() as Record<string, unknown>;
        const memberships = (Array.isArray(data.memberships) ? data.memberships : []).map(
          (m: any) => ({
            ...m,
            roles: (Array.isArray(m?.roles) ? m.roles.map(String) : []).map(
              (r: string) => (r === OLD_ROLE_NAME ? OLD_ROLE_REPLACEMENT : r),
            ),
          }),
        );
        // v1.58.0：roles 一律由更名後的分工表重算（僅保留系統管理員／一般人員例外）
        const roles = deriveStoredRoles(
          memberships,
          (Array.isArray(data.roles) ? data.roles.map(String) : []).map(
            (r: string) => (r === OLD_ROLE_NAME ? OLD_ROLE_REPLACEMENT : r),
          ),
        );
        await updateDoc(doc(db, "users", d.id), {
          roles,
          memberships,
          ...auditFields(staffId, false),
        });
        // 審查員名單連動（best-effort；執行幹事非審查員，預期不動）
        try {
          await syncReviewerDoc(db, d.id, roles);
        } catch {
          // 忽略：不阻擋清理
        }
      }
      result.oldRole = "migrated";
    } else {
      result.oldRole = "deleted-empty";
    }
    // 權限範本遷移（group／unitRole 兩類皆查；目標已存在時不覆蓋，舊的直接刪）
    for (const category of ["group", "unitRole"] as const) {
      const oldRef = doc(db, "permissionTemplates", templateDocId(category, OLD_ROLE_NAME));
      const oldSnap = await getDoc(oldRef);
      if (!oldSnap.exists()) continue;
      const newRef = doc(
        db,
        "permissionTemplates",
        templateDocId(category, OLD_ROLE_REPLACEMENT),
      );
      const newSnap = await getDoc(newRef);
      if (!newSnap.exists()) {
        await setDoc(newRef, {
          ...oldSnap.data(),
          name: OLD_ROLE_REPLACEMENT,
          category,
        });
      }
      await deleteDoc(oldRef);
    }
    await deleteDoc(doc(db, "roles", oldRoleDoc.id));
    await setDoc(doc(collection(db, "auditLogs")), {
      actor: staffId,
      actorName: staffName,
      action: "角色刪除",
      targetType: "role",
      targetId: oldRoleDoc.id,
      detail:
        result.oldRole === "migrated"
          ? `層級遷移：舊角色「${OLD_ROLE_NAME}」持有者 ${holders.length} 人已遷移到「${OLD_ROLE_REPLACEMENT}」，舊角色已刪除（v1.55.0）`
          : `層級遷移：舊角色「${OLD_ROLE_NAME}」無人持有，已直接刪除（v1.55.0）`,
      before: { name: OLD_ROLE_NAME },
      after: null,
      createdAt: serverTimestamp(),
    });
  }

  // 全部成功才寫旗標
  await setDoc(markerRef, {
    done: true,
    migratedAt: serverTimestamp(),
    migratedBy: staffId,
  });
  return result;
}

export interface TitleLevelsV188MigrationResult {
  levelsCreated: string[];
  titlesRemapped: number;
  /** 護理長／副護理長是否已合併為「護理長/副護理長」 */
  headNurseMerged: boolean;
  /** 合併時轉任的人員數（titleId／title 字串重指） */
  headNurseUsersRetargeted: number;
  /** 「護士」職稱是否為本次新建 */
  nurseTitleCreated: boolean;
  /** 已刪除的舊層級文件 id（tl-director／tl-deputy／tl-supervisor） */
  legacyLevelsRemoved: string[];
}

/**
 * v1.88.8：職稱層級併回（主任／副主任／督導／單位→部級／單位）。
 *
 * 1. 建立部級（tl-dept，沿用舊 id）／單位層級文件（缺的才建；已存在的不動）。
 * 2. 既有職稱按名稱重對照 levelId（主任／副主任／督導→部級；
 *    護理長／副護理長／護理師／護士→單位；「護理部主任」等變體去前綴後對照；
 *    對不上的自訂職稱不動）。
 * 3. 護理長／副護理長合併為「護理長/副護理長」（planHeadNurseMerge）：
 *    持有舊職稱者自動轉任（titleId 重指＋title 字串改名）；權限範本
 *    目標不存在時由舊名範本複製（只取其一：護理長優先）。
 * 4. 無「護士」職稱時新建（單位層）。
 * 5. 重對照後已無職稱引用的舊層級文件（tl-director／tl-deputy／
 *    tl-supervisor）刪除；仍有引用時保留（管理員可自行移轉後刪除）。
 *
 * 防重跑：configs/titleLevelsV188 { done: true }；各步驟本身具等冪性，
 * 旗標只在全部成功後才寫入，失敗時下次開頁重試。
 */
export async function migrateTitleLevelsV188(
  db: any,
  staffId: string,
): Promise<TitleLevelsV188MigrationResult> {
  const markerRef = doc(db, TITLE_LEVELS_V188_MIGRATION_MARKER);
  const markerSnap = await getDoc(markerRef);
  if (markerSnap.exists() && markerSnap.data()?.done === true) {
    return {
      levelsCreated: [],
      titlesRemapped: 0,
      headNurseMerged: false,
      headNurseUsersRetargeted: 0,
      nurseTitleCreated: false,
      legacyLevelsRemoved: [],
    };
  }

  const result: TitleLevelsV188MigrationResult = {
    levelsCreated: [],
    titlesRemapped: 0,
    headNurseMerged: false,
    headNurseUsersRetargeted: 0,
    nurseTitleCreated: false,
    legacyLevelsRemoved: [],
  };

  // 1. 部級／單位層級文件（缺的才建）
  for (const level of DEFAULT_TITLE_LEVELS) {
    const ref = doc(db, "titleLevels", level.id);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        name: level.name,
        order: level.order,
        ...auditFields(staffId, true),
      });
      result.levelsCreated.push(level.name);
    }
  }

  // 2. 既有職稱按名稱重對照 levelId
  const titleSnap = await getDocsFromServer(collection(db, "titles"));
  for (const d of titleSnap.docs) {
    const data = d.data() as Record<string, unknown>;
    const name = typeof data.name === "string" ? data.name : "";
    const levelId = titleLevelIdForName(name);
    if (!levelId || data.levelId === levelId) continue;
    await updateDoc(doc(db, "titles", d.id), {
      levelId,
      ...auditFields(staffId, false),
    });
    result.titlesRemapped += 1;
  }

  // 3. 護理長／副護理長合併
  const freshSnap = await getDocsFromServer(collection(db, "titles"));
  const titleRows = freshSnap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      name: typeof data.name === "string" ? data.name : "",
    };
  });
  const plan = planHeadNurseMerge(titleRows);
  let targetId = plan.targetId;
  if (targetId === null) {
    const ref = doc(collection(db, "titles"));
    await setDoc(ref, {
      name: MERGED_HEAD_NURSE_TITLE,
      levelId: "tl-unit",
      isUnitHead: true,
      isDistrictHead: false,
      isHospitalHead: false,
      isOfficer: false,
      isConvener: false,
      ...auditFields(staffId, true),
    });
    targetId = ref.id;
    result.headNurseMerged = true;
  } else {
    const updates: Record<string, unknown> = {
      isUnitHead: true,
      ...auditFields(staffId, false),
    };
    if (plan.targetNeedsRename) updates.name = MERGED_HEAD_NURSE_TITLE;
    await updateDoc(doc(db, "titles", targetId), updates);
    result.headNurseMerged = true;
  }
  // 持有舊職稱者轉任（titleId 重指；無 titleId 者只認 title 字串）
  const oldIds = new Set(plan.mergeFromIds);
  const usersSnap = await getDocsFromServer(collection(db, "users"));
  for (const d of usersSnap.docs) {
    const data = d.data() as Record<string, unknown>;
    const uid = typeof data.titleId === "string" ? data.titleId : "";
    const title = typeof data.title === "string" ? data.title : "";
    const fromOldDoc = oldIds.has(uid);
    const fromOldNameNoId =
      !uid && (title === "護理長" || title === "副護理長");
    const staleNameOnTarget =
      uid === targetId && (title === "護理長" || title === "副護理長");
    if (!fromOldDoc && !fromOldNameNoId && !staleNameOnTarget) continue;
    await updateDoc(doc(db, "users", d.id), {
      title: MERGED_HEAD_NURSE_TITLE,
      titleId: targetId,
      ...auditFields(staffId, false),
    });
    result.headNurseUsersRetargeted += 1;
  }
  // 舊職稱文件刪除（人員已轉任）
  for (const id of plan.mergeFromIds) {
    await deleteDoc(doc(db, "titles", id));
  }
  // 權限範本：目標不存在時由舊名範本複製（護理長優先），複製後刪舊範本
  const newTplRef = doc(
    db,
    "permissionTemplates",
    templateDocId("unit", MERGED_HEAD_NURSE_TITLE),
  );
  if (!(await getDoc(newTplRef)).exists()) {
    for (const oldName of ["護理長", "副護理長"]) {
      const oldRef = doc(db, "permissionTemplates", templateDocId("unit", oldName));
      const oldSnap = await getDoc(oldRef);
      if (!oldSnap.exists()) continue;
      await setDoc(newTplRef, { ...oldSnap.data(), name: MERGED_HEAD_NURSE_TITLE });
      await deleteDoc(oldRef);
      break;
    }
  }

  // 4. 無「護士」職稱時新建（單位層）
  const afterMergeSnap = await getDocsFromServer(collection(db, "titles"));
  const hasNurse = afterMergeSnap.docs.some((d) => {
    const data = d.data() as Record<string, unknown>;
    return data.name === "護士";
  });
  if (!hasNurse) {
    await setDoc(doc(collection(db, "titles")), {
      name: "護士",
      levelId: "tl-unit",
      isUnitHead: false,
      isDistrictHead: false,
      isHospitalHead: false,
      isOfficer: false,
      isConvener: false,
      ...auditFields(staffId, true),
    });
    result.nurseTitleCreated = true;
  }

  // 5. 無人再引用的舊層級文件刪除
  const finalSnap = await getDocsFromServer(collection(db, "titles"));
  for (const legacyId of LEGACY_TITLE_LEVEL_IDS) {
    const stillReferenced = finalSnap.docs.some((d) => {
      const data = d.data() as Record<string, unknown>;
      return data.levelId === legacyId;
    });
    if (stillReferenced) continue;
    const ref = doc(db, "titleLevels", legacyId);
    if ((await getDoc(ref)).exists()) {
      await deleteDoc(ref);
      result.legacyLevelsRemoved.push(legacyId);
    }
  }

  // 稽核摘要（單筆，不逐人寫）
  await setDoc(doc(collection(db, "auditLogs")), {
    actor: staffId,
    actorName: "",
    action: "職稱層級併回",
    targetType: "title",
    targetId: targetId,
    detail: `層級併回部級／單位（v1.88.8）：職稱重對照 ${result.titlesRemapped} 筆，護理長／副護理長合併轉任 ${result.headNurseUsersRetargeted} 人，護士職稱${result.nurseTitleCreated ? "已新建" : "已存在"}，舊層級刪除 ${result.legacyLevelsRemoved.join("、") || "無"}`,
    before: null,
    after: { levelsCreated: result.levelsCreated },
    createdAt: serverTimestamp(),
  });

  // 全部成功才寫旗標
  await setDoc(markerRef, {
    done: true,
    migratedAt: serverTimestamp(),
    migratedBy: staffId,
  });
  return result;
}

/**
 * v1.87.0：職稱層級拆分（部級→主任／副主任／督導／單位）。
 *
 * 1. 建立新層級文件（主任／副主任／督導；已存在的不動；單位層級沿用既有）。
 * 2. 既有職稱 levelId 為舊部級（tl-dept）者，按名稱重對照為新層級
 *    （主任／副主任／督導；對不上名稱的自訂職稱不動）。
 * 3. 重對照後若已無職稱引用舊部級層級，刪除 tl-dept 層級文件；
 *    仍有引用時保留（管理員可自行移轉後刪除）。
 *
 * 防重跑：configs/titleLevelsV187 { done: true }；各步驟本身具等冪性，
 * 旗標只在全部成功後才寫入，失敗時下次開頁重試。
 */
export async function migrateTitleLevelsV187(
  db: any,
  staffId: string,
): Promise<TitleLevelsMigrationResult> {
  const markerRef = doc(db, TITLE_LEVELS_MIGRATION_MARKER);
  const markerSnap = await getDoc(markerRef);
  if (markerSnap.exists() && markerSnap.data()?.done === true) {
    return { levelsCreated: [], titlesRemapped: 0, deptLevelRemoved: false };
  }

  const result: TitleLevelsMigrationResult = {
    levelsCreated: [],
    titlesRemapped: 0,
    deptLevelRemoved: false,
  };

  // 1. 新層級文件（缺的才建）
  for (const level of DEFAULT_TITLE_LEVELS) {
    const ref = doc(db, "titleLevels", level.id);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        name: level.name,
        order: level.order,
        ...auditFields(staffId, true),
      });
      result.levelsCreated.push(level.name);
    }
  }

  // 2. 舊部級職稱按名稱重對照
  const titleSnap = await getDocsFromServer(collection(db, "titles"));
  for (const d of titleSnap.docs) {
    const data = d.data() as Record<string, unknown>;
    if (data.levelId !== LEGACY_DEPT_TITLE_LEVEL_ID) continue;
    const name = typeof data.name === "string" ? data.name : "";
    const levelId = titleLevelIdForName(name);
    if (!levelId || levelId === LEGACY_DEPT_TITLE_LEVEL_ID) continue;
    await updateDoc(doc(db, "titles", d.id), {
      levelId,
      ...auditFields(staffId, false),
    });
    result.titlesRemapped += 1;
  }

  // 3. 無人再引用舊部級層級時刪除該層級文件
  // （步驟 2 後仍引用者只有對不上名稱的自訂職稱，屆時保留層級文件；
  // titleSnap 是步驟 2 之前讀的快照，故重新讀取一次再判斷）
  const freshSnap = await getDocsFromServer(collection(db, "titles"));
  const stillReferenced = freshSnap.docs.some((d) => {
    const data = d.data() as Record<string, unknown>;
    return data.levelId === LEGACY_DEPT_TITLE_LEVEL_ID;
  });
  if (!stillReferenced) {
    const deptRef = doc(db, "titleLevels", LEGACY_DEPT_TITLE_LEVEL_ID);
    const deptSnap = await getDoc(deptRef);
    if (deptSnap.exists()) {
      await deleteDoc(deptRef);
      result.deptLevelRemoved = true;
    }
  }

  // 全部成功才寫旗標
  await setDoc(markerRef, {
    done: true,
    migratedAt: serverTimestamp(),
    migratedBy: staffId,
  });
  return result;
}

export interface TitleRoleOrderMigrationResult {
  titlesBackfilled: number;
  rolesBackfilled: number;
}

/**
 * v1.88.8 補項：職稱／角色順序回填（order 欄位初值）。
 *
 * 僅補沒有 order 欄位的職稱／角色文件（已有 order 者不動，管理員調過的
 * 順序不會被蓋掉）。同一層級內：定案清單上的名稱取種子順序
 * （seedOrderForTitle／seedOrderForRole）；清單外的自訂名稱排在已知
 * 名稱之後、按名稱排序；「護理部」變體與本名同階（鏈推導只認嚴格
 * 更大的 order，同階變體不會成為下一個）。
 *
 * 防重跑：configs/titleRoleOrderV188 { done: true }；各步驟本身具等冪性，
 * 旗標只在全部成功後才寫入，失敗時下次開頁重試。
 */
export async function migrateTitleRoleOrderV188(
  db: any,
  staffId: string,
): Promise<TitleRoleOrderMigrationResult> {
  const markerRef = doc(db, TITLE_ROLE_ORDER_MIGRATION_MARKER);
  const markerSnap = await getDoc(markerRef);
  if (markerSnap.exists() && markerSnap.data()?.done === true) {
    return { titlesBackfilled: 0, rolesBackfilled: 0 };
  }

  const result: TitleRoleOrderMigrationResult = {
    titlesBackfilled: 0,
    rolesBackfilled: 0,
  };

  for (const [coll, seedFn, key] of [
    ["titles", seedOrderForTitle, "titlesBackfilled"],
    ["roles", seedOrderForRole, "rolesBackfilled"],
  ] as const) {
    const snap = await getDocsFromServer(collection(db, coll));
    const docs = snap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        id: d.id,
        name: typeof data.name === "string" ? data.name : "",
        levelId: typeof data.levelId === "string" ? data.levelId : "",
        order: typeof data.order === "number" ? data.order : undefined,
      };
    });
    // 按層級分組；組內按（種子順序、名稱）排
    const byLevel = new Map<string, typeof docs>();
    for (const docItem of docs) {
      const list = byLevel.get(docItem.levelId) ?? [];
      list.push(docItem);
      byLevel.set(docItem.levelId, list);
    }
    for (const group of byLevel.values()) {
      const knownMax = group.reduce(
        (max, docItem) => Math.max(max, seedFn(docItem.name) ?? -1),
        -1,
      );
      let unknownIdx = 0;
      const sorted = [...group].sort(
        (a, b) =>
          (seedFn(a.name) ?? Number.POSITIVE_INFINITY) -
            (seedFn(b.name) ?? Number.POSITIVE_INFINITY) ||
          a.name.localeCompare(b.name, "zh-Hant"),
      );
      for (const docItem of sorted) {
        if (docItem.order !== undefined) continue;
        const seed = seedFn(docItem.name);
        const order = seed ?? knownMax + 1 + unknownIdx++;
        await updateDoc(doc(db, coll, docItem.id), {
          order,
          ...auditFields(staffId, false),
        });
        result[key] += 1;
      }
    }
  }

  // 全部成功才寫旗標
  await setDoc(markerRef, {
    done: true,
    migratedAt: serverTimestamp(),
    migratedBy: staffId,
  });
  return result;
}
