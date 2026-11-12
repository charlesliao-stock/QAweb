/**
 * 角色身分新舊並認（v1.21.0；v1.40.5 改吃 orgMeta 詮釋資料；
 * v1.57.0 A3：詮釋資料改由層級＋名稱關鍵字推導，見 lib/roleDerivation.ts）。
 *
 * 身分判斷改以層級＋名稱關鍵字推導（見 lib/orgMeta.ts）；
 * 本檔的函式保留舊簽名，僅傳名稱字串時以關鍵字推導（行為與舊版一致，
 * 供既有測試與尚未載入角色主檔的純函式使用）。正式流程請傳入 roleMeta
 *（由 roles 集合建立）。
 */

import {
  hasRoleCategoryWithScope,
  hasSchedulePermissionMeta,
  isConvenerRoleMeta,
  isGroupConvenerRoleMeta,
  isGroupOfficerRoleMeta,
  isGroupScopedRoleMeta,
  isOfficerRoleMeta,
  isReviewerRoleMeta,
  isUnitLevelRoleMeta,
  legacyRoleCategory,
  legacyRoleScope,
  type RoleMetaMap,
} from "./orgMeta";

export type { RoleCategory, RoleMeta, RoleMetaMap, RoleScope } from "./orgMeta";

/**
 * 舊名稱對照已移除（v1.57.0 A3）：身分改由名稱關鍵字推導，
 * 精確比對名單會讓新名稱（如「品管組副召集人」）掉級；
 * 需要名稱→身分時請用 deriveRoleCategory（lib/roleDerivation.ts）。
 */
export { legacyRoleCategory, legacyRoleScope };

/** 是否為群組範圍角色（人員表單中走 memberships 配對列） */
export function isGroupScopedRole(
  role: string,
  roleMeta?: RoleMetaMap,
): boolean {
  return isGroupScopedRoleMeta(role, roleMeta);
}

/** 審查員身分：類別為審查員（無詮釋資料時以名稱關鍵字推導）。 */
export function isReviewerRole(
  roles: string[] | undefined,
  roleMeta?: RoleMetaMap,
): boolean {
  return isReviewerRoleMeta(roles, roleMeta);
}

/** 召集人身分：類別為召集人（無詮釋資料時以名稱關鍵字推導）。 */
export function isConvenerRole(
  roles: string[] | undefined,
  roleMeta?: RoleMetaMap,
): boolean {
  return isConvenerRoleMeta(roles, roleMeta);
}

/** 執行幹事身分：類別為執行幹事（無詮釋資料時以名稱關鍵字推導）。 */
export function isOfficerRole(
  roles: string[] | undefined,
  roleMeta?: RoleMetaMap,
): boolean {
  return isOfficerRoleMeta(roles, roleMeta);
}

/** 組級召集人（排程權限用） */
export function isGroupConvenerRole(
  roles: string[] | undefined,
  roleMeta?: RoleMetaMap,
): boolean {
  return isGroupConvenerRoleMeta(roles, roleMeta);
}

/** 組級執行幹事（排程權限用） */
export function isGroupOfficerRole(
  roles: string[] | undefined,
  roleMeta?: RoleMetaMap,
): boolean {
  return isGroupOfficerRoleMeta(roles, roleMeta);
}

/** 是否有排程權限：組級召集人或組級執行幹事 */
export function hasSchedulePermission(
  roles: string[] | undefined,
  roleMeta?: RoleMetaMap,
): boolean {
  return hasSchedulePermissionMeta(roles, roleMeta);
}

/** 是否為單位級角色 */
export function isUnitLevelRole(
  role: string,
  roleMeta?: RoleMetaMap,
): boolean {
  return isUnitLevelRoleMeta(role, roleMeta);
}

/** 單位級執行幹事（AuditPage 自審範圍用）。 */
export function hasUnitOfficerRole(
  roles: string[] | undefined,
  roleMeta?: RoleMetaMap,
): boolean {
  return hasRoleCategoryWithScope(roles, "officer", "unit", roleMeta);
}

/* ================= 人員多群組模型（v1.21.0） ================= */

/** 人員群組成員資格：一人可屬多群組，各群組角色可不同 */
export interface Membership {
  groupId: string;
  roles: string[];
}

/** 由 memberships 衍生的舊欄位（寫入時同步更新，供過渡期舊讀取使用） */
export function deriveGroupIds(memberships: Membership[]): string[] {
  const out: string[] = [];
  for (const m of memberships) {
    if (m.groupId && !out.includes(m.groupId)) out.push(m.groupId);
  }
  return out;
}

export function deriveRoles(memberships: Membership[]): string[] {
  const out: string[] = [];
  for (const m of memberships) {
    for (const r of m.roles) {
      if (r && !out.includes(r)) out.push(r);
    }
  }
  return out;
}

/**
 * v1.58.0：寫入 users.roles 的唯一規則——聯集一律由分工表衍生，
 * 不再併入「其他角色」（全域角色已刪除）。
 * 僅保留兩個不在分工表的例外：「系統管理員」（isAdmin 判斷用，
 * 從來不在分工表，清掉會讓管理員帳號失去管理員身分）與「一般人員」
 * （無分工表人員的預設，與批次匯入新建一致）。
 * 無任何角色時回 ["一般人員"]。
 */
export function deriveStoredRoles(
  memberships: Membership[],
  previousRoles: string[],
): string[] {
  const derived = deriveRoles(memberships.filter((m) => m.groupId));
  const keep = (previousRoles ?? []).filter(
    (r) => r === "系統管理員" || r === "一般人員",
  );
  const out = [...new Set([...derived, ...keep])];
  return out.length > 0 ? out : ["一般人員"];
}

/**
 * 正規化 memberships：讀取以 memberships 為主；無則 fallback 舊欄位
 * （groupIds＋roles 視為同一群組組合的配對）。
 */
export function parseMemberships(
  raw: unknown,
  fallback?: { roles?: string[]; groupIds?: string[] },
): Membership[] {
  if (Array.isArray(raw)) {
    const out: Membership[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const groupId = typeof rec.groupId === "string" ? rec.groupId : "";
      const roles = Array.isArray(rec.roles)
        ? rec.roles.map(String).filter(Boolean)
        : [];
      if (!groupId) continue;
      const dup = out.find((m) => m.groupId === groupId);
      if (dup) {
        for (const r of roles) if (!dup.roles.includes(r)) dup.roles.push(r);
      } else {
        out.push({ groupId, roles });
      }
    }
    return out;
  }
  const roles = (fallback?.roles ?? []).filter(Boolean);
  const groupIds = (fallback?.groupIds ?? []).filter(Boolean);
  if (roles.length === 0 || groupIds.length === 0) return [];
  return groupIds.map((groupId) => ({ groupId, roles: [...roles] }));
}

/**
 * 該人員擔任指定角色的群組範圍：
 * - 組級／舊角色：memberships 中持有該角色的群組；
 * - 單位級角色：以其單位所屬群組計（unitGroupId 須由呼叫端傳入）。
 * 單位級與否改以角色詮釋資料判斷（傳入 roleMeta；未傳時以名稱關鍵字推導）。
 */
/* ================= 群組＋角色分工表式列表（v1.52.0） ================= */

/**
 * 加入群組＋角色：同群組已存在時角色取聯集合併進既有列，不產生第二列；
 * 否則在尾端新增一列。回傳新陣列，不動原陣列。
 */
export function mergeMembership(
  memberships: Membership[],
  groupId: string,
  roles: string[],
): Membership[] {
  const clean = [...new Set(roles.filter(Boolean))];
  const idx = memberships.findIndex((m) => m.groupId === groupId);
  if (idx === -1) return [...memberships, { groupId, roles: clean }];
  return memberships.map((m, i) =>
    i === idx
      ? { ...m, roles: [...new Set([...m.roles, ...clean])] }
      : m,
  );
}

/**
 * 編輯群組＋角色（加入區帶回原列改完按[更新]）：
 * - 新角色為空 → 刪列（Q6：沒有角色就取消群組）；
 * - 群組不變 → 原地更新角色；
 * - 群組改成另一已存在的群組 → 兩列角色取聯集、刪掉原列（Q5）；
 * - 群組改成新群組 → 原列改群組＋角色。
 * 原列不存在時回傳原陣列。
 */
export function applyMembershipEdit(
  memberships: Membership[],
  editingGroupId: string,
  newGroupId: string,
  newRoles: string[],
): Membership[] {
  const idx = memberships.findIndex((m) => m.groupId === editingGroupId);
  if (idx === -1) return memberships;
  const clean = [...new Set(newRoles.filter(Boolean))];
  if (clean.length === 0) return memberships.filter((_, i) => i !== idx);
  if (newGroupId === editingGroupId) {
    return memberships.map((m, i) =>
      i === idx ? { groupId: newGroupId, roles: clean } : m,
    );
  }
  const target = memberships.findIndex((m) => m.groupId === newGroupId);
  if (target === -1) {
    return memberships.map((m, i) =>
      i === idx ? { groupId: newGroupId, roles: clean } : m,
    );
  }
  return memberships
    .filter((_, i) => i !== idx)
    .map((m) =>
      m.groupId === newGroupId
        ? { ...m, roles: [...new Set([...m.roles, ...clean])] }
        : m,
    );
}

/** 依群組移除一列（直接刪，不確認；只改表單 state，儲存才生效）。 */
export function removeMembership(
  memberships: Membership[],
  groupId: string,
): Membership[] {
  return memberships.filter((m) => m.groupId !== groupId);
}

/** 人員列表角色欄：按群組分組的一段（群組名＋該群組角色）。 */
export interface GroupedRoleSegment {
  label: string;
  roles: string[];
}

/**
 * 人員列表角色欄分段：每段＝一個群組（無角色的 membership 不列）。
 * v1.58.0：「其他角色」已刪除，roles 聯集一律由分工表衍生，
 * 不再有非群組角色段；無 membership 者角色欄為空。
 */
export function groupedRolesSegments(
  memberships: Membership[],
  groupNameOf: (groupId: string) => string,
): GroupedRoleSegment[] {
  const segments: GroupedRoleSegment[] = [];
  for (const m of memberships) {
    if (m.roles.length === 0) continue;
    segments.push({ label: groupNameOf(m.groupId), roles: [...m.roles] });
  }
  return segments;
}

/**
 * 人員列表角色欄分組顯示字串，例如
 * 「病房組：品管組審查員、召集人；加護組：品管組審查員」。
 * 亦作為 `user-role` 排序鍵。
 */
export function groupedRolesLabel(
  memberships: Membership[],
  groupNameOf: (groupId: string) => string,
): string {
  return groupedRolesSegments(memberships, groupNameOf)
    .map((s) => (s.label ? `${s.label}：${s.roles.join("、")}` : s.roles.join("、")))
    .join("；");
}

export function groupsForRoles(
  memberships: Membership[],
  roleNames: string[],
  unitGroupId?: string,
  roleMeta?: RoleMetaMap,
): string[] {
  const out: string[] = [];
  const push = (g: string) => {
    if (g && !out.includes(g)) out.push(g);
  };
  for (const m of memberships) {
    for (const r of m.roles) {
      if (!roleNames.includes(r)) continue;
      if (isUnitLevelRole(r, roleMeta)) {
        // 單位級角色以其單位所屬群組計；單位未知時退回該筆 membership 的群組
        push(unitGroupId ?? m.groupId);
      } else {
        push(m.groupId);
      }
    }
  }
  return out;
}
