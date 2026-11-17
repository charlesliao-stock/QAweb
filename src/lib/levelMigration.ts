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
  NEW_ROLES,
  OLD_ROLE_NAME,
  OLD_ROLE_REPLACEMENT,
  roleLevelIdForName,
  titleLevelIdForName,
} from "./orgLevels";

export const ORG_LEVELS_MIGRATION_MARKER = "configs/orgLevelsV155";

/** v1.87.0：職稱層級拆分遷移旗標（部級→主任／副主任／督導／單位） */
export const TITLE_LEVELS_MIGRATION_MARKER = "configs/titleLevelsV187";

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
