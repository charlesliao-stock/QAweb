/**
 * 角色身分新舊並認（v1.21.0）。
 *
 * 舊角色：審查員／召集人／執行幹事（另有「各組召集人」「執行幹事」等
 * 集合型命名）；新角色：品管組召集人／品管組執行幹事／品管組審查員／
 * 單位召集人／單位執行幹事／單位審查員。
 * 權限判斷一律以本檔的集合為準，不再用 `roles.includes("審查員")`
 * 之類的精確比對。
 *
 * 本檔零依賴、不碰 Firestore，可在 node 直接單元測試。
 */

export const REVIEWER_ROLES = ["審查員", "品管組審查員", "單位審查員"];
export const CONVENER_ROLES = [
  "召集人",
  "各組召集人",
  "品管組召集人",
  "單位召集人",
];
export const OFFICER_ROLES = ["執行幹事", "品管組執行幹事", "單位執行幹事"];
/** 排程權限（召集人＋執行幹事）只認組級角色，不含單位級 */
export const GROUP_CONVENER_ROLES = ["召集人", "品管組召集人"];
export const GROUP_OFFICER_ROLES = ["執行幹事", "品管組執行幹事"];
/** 單位級角色（以其單位所屬群組計群組範圍） */
export const UNIT_LEVEL_ROLES = ["單位召集人", "單位執行幹事", "單位審查員"];

/** 群組範圍角色：召集人／執行幹事／審查員（新舊皆含） */
export const GROUP_SCOPED_ROLES = [
  ...new Set([...CONVENER_ROLES, ...OFFICER_ROLES, ...REVIEWER_ROLES]),
];

/** 是否為群組範圍角色（人員表單中走 memberships 配對列） */
export function isGroupScopedRole(role: string): boolean {
  return GROUP_SCOPED_ROLES.includes(role);
}

function hasAny(roles: string[] | undefined, names: string[]): boolean {
  if (!roles) return false;
  return roles.some((r) => names.includes(r));
}

/** 審查員身分：舊「審查員」或新品管組／單位審查員任一 */
export function isReviewerRole(roles: string[] | undefined): boolean {
  return hasAny(roles, REVIEWER_ROLES);
}

/** 召集人身分：舊「召集人」或新品管組／單位召集人任一 */
export function isConvenerRole(roles: string[] | undefined): boolean {
  return hasAny(roles, CONVENER_ROLES);
}

/** 執行幹事身分：舊「執行幹事」或新品管組／單位執行幹事任一 */
export function isOfficerRole(roles: string[] | undefined): boolean {
  return hasAny(roles, OFFICER_ROLES);
}

/** 組級召集人（排程權限用） */
export function isGroupConvenerRole(roles: string[] | undefined): boolean {
  return hasAny(roles, GROUP_CONVENER_ROLES);
}

/** 組級執行幹事（排程權限用） */
export function isGroupOfficerRole(roles: string[] | undefined): boolean {
  return hasAny(roles, GROUP_OFFICER_ROLES);
}

/** 是否有排程權限：組級召集人或組級執行幹事 */
export function hasSchedulePermission(roles: string[] | undefined): boolean {
  return isGroupConvenerRole(roles) || isGroupOfficerRole(roles);
}

/** 是否為單位級角色 */
export function isUnitLevelRole(role: string): boolean {
  return UNIT_LEVEL_ROLES.includes(role);
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
 */
export function groupsForRoles(
  memberships: Membership[],
  roleNames: string[],
  unitGroupId?: string,
): string[] {
  const out: string[] = [];
  const push = (g: string) => {
    if (g && !out.includes(g)) out.push(g);
  };
  for (const m of memberships) {
    for (const r of m.roles) {
      if (!roleNames.includes(r)) continue;
      if (isUnitLevelRole(r)) {
        // 單位級角色以其單位所屬群組計；單位未知時退回該筆 membership 的群組
        push(unitGroupId ?? m.groupId);
      } else {
        push(m.groupId);
      }
    }
  }
  return out;
}
