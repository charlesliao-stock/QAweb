import type { PageId } from "../types";
import { isGroupScopedRole, type Membership } from "./roleIdentity";

/** 導覽頁面與功能權限使用同一矩陣；尚未實作的 reviewers 不列入。 */
export const PAGE_PERMISSION_KEYS = {
  dashboard: "page.dashboard",
  indicators: "page.indicators",
  schedule: "page.schedule",
  audit: "page.audit",
  results: "page.results",
  capa: "page.capa",
  groups: "page.groups",
  handoff: "page.handoff",
  admin: "page.admin",
  permissions: "page.permissions",
} as const satisfies Partial<Record<PageId, string>>;

export const PAGE_PERMISSION_ITEMS = [
  { key: "page.dashboard", label: "總覽儀表板" },
  { key: "page.indicators", label: "指標管理" },
  { key: "page.schedule", label: "品管審查排程" },
  { key: "page.audit", label: "品管審查" },
  { key: "page.results", label: "結果分析" },
  { key: "page.capa", label: "CAPA 改善追蹤" },
  { key: "page.groups", label: "群組與人員" },
  { key: "page.handoff", label: "任務交接" },
  { key: "page.admin", label: "系統管理" },
  { key: "page.permissions", label: "權限管理" },
] as const;

export const ACTION_PERMISSION_ITEMS = [
  { key: "resultQuery", label: "查詢審查結果" },
  { key: "viewPhotos", label: "檢視審查照片" },
  { key: "manageSchedule", label: "建立／改派排程" },
  { key: "editSubmitted", label: "修改已提交審查" },
  { key: "manageRoles", label: "管理角色與權限" },
] as const;

export const PERM_KEYS = [
  ...PAGE_PERMISSION_ITEMS.map((item) => item.key),
  ...ACTION_PERMISSION_ITEMS.map((item) => item.key),
] as const;

export type PermKey = (typeof PERM_KEYS)[number];
export type RolePermissions = Partial<Record<PermKey, boolean>>;

export const PERM_LABELS: Record<PermKey, string> = Object.fromEntries(
  [...PAGE_PERMISSION_ITEMS, ...ACTION_PERMISSION_ITEMS].map((item) => [
    item.key,
    item.label,
  ]),
) as Record<PermKey, string>;

/**
 * 權限鍵分組（v1.37.0 權限管理重建）：
 * - 共用 7 鍵：單位職稱、單位角色、群組角色三類都列；
 * - 群組專屬 4 鍵：只有群組角色列；
 * - 管理員專屬 4 鍵：永不列出（系統管理員另有 bypass）。
 */
export const SHARED_PERM_KEYS = [
  "page.dashboard",
  "page.schedule",
  "page.audit",
  "page.results",
  "page.capa",
  "resultQuery",
  "viewPhotos",
] as const satisfies readonly PermKey[];

export const GROUP_ONLY_PERM_KEYS = [
  "page.indicators",
  "page.handoff",
  "manageSchedule",
  "editSubmitted",
] as const satisfies readonly PermKey[];

export const ADMIN_ONLY_PERM_KEYS = [
  "page.admin",
  "page.permissions",
  "manageRoles",
  "page.groups",
] as const satisfies readonly PermKey[];

/** 不列出的角色名：系統管理員（bypass）、一般人員（不用設定權限）。 */
export const EXCLUDED_ROLE_NAMES = ["系統管理員", "一般人員"] as const;

const PAGE_KEY_BY_ID = PAGE_PERMISSION_KEYS as Partial<Record<PageId, PermKey>>;

export function pagePermissionKey(page: PageId): PermKey | undefined {
  return PAGE_KEY_BY_ID[page] as PermKey | undefined;
}

/** 全 false（新建角色與職稱的起始權限）。 */
export function emptyPermissions(): Record<PermKey, boolean> {
  return Object.fromEntries(PERM_KEYS.map((key) => [key, false])) as Record<
    PermKey,
    boolean
  >;
}

/** 防禦性解析 roles/titles 文件的 permissions 欄位；缺鍵明確視為 false。 */
export function parsePermissions(raw: unknown): Record<PermKey, boolean> {
  const out = emptyPermissions();
  if (raw && typeof raw === "object") {
    for (const key of PERM_KEYS) {
      out[key] = (raw as Record<string, unknown>)[key] === true;
    }
  }
  return out;
}

export function scopedRoleKey(groupId: string, roleName: string): string {
  return `${encodeURIComponent(groupId)}::${encodeURIComponent(roleName)}`;
}

/**
 * 權限範圍模式（v1.36.0）：
 * - "all"＝不分單位，適用全部單位；
 * - "units"＝分單位，只適用 unitCodes 清單內的單位。
 * 既有資料無 scopeMode 時由 unitCodes 推斷：有單位清單→分單位，無→不分單位。
 */
export type ScopeMode = "all" | "units";

export function parseScopeMode(raw: unknown, unitCodes: string[]): ScopeMode {
  if (raw === "all" || raw === "units") return raw;
  return unitCodes.length > 0 ? "units" : "all";
}

export function scopeAppliesToUnit(
  scopeMode: ScopeMode,
  unitCodes: string[],
  unitCode: string,
): boolean {
  if (scopeMode === "all") return true;
  return unitCode !== "" && unitCodes.includes(unitCode);
}

/**
 * 角色種類（v1.37.0）：
 * - "unit"＝單位角色（有所屬單位 unitCode，單位限制由職稱側把關）；
 * - "group"＝群組角色（有所屬群組 groupId，另有跨群組模式）。
 * 舊文件無 kind 時由 groupId 推斷：有群組→群組角色，無→單位角色。
 */
export type RoleKind = "unit" | "group";

export function parseRoleKind(raw: unknown, groupId: string): RoleKind {
  if (raw === "unit" || raw === "group") return raw;
  return groupId ? "group" : "unit";
}

/**
 * 群組角色跨群組模式（v1.37.0，預設不跨）：
 * - "all"＝跨群組，任一 membership 持有該角色即生效；
 * - "group"＝不跨群組，只在角色所屬群組生效。
 */
export type GroupScopeMode = "all" | "group";

export function parseGroupScopeMode(raw: unknown): GroupScopeMode {
  return raw === "all" ? "all" : "group";
}

/** 群組角色範圍紀錄：以 scopedRoleKey(groupId, roleName) 為鍵。 */
export interface GroupRoleScope {
  groupScopeMode: GroupScopeMode;
  groupId: string;
}

/** 群組角色定義（同名角色分屬不同群組時各有一份，供跨群組判斷）。 */
export interface GroupRoleDefinition {
  groupId: string;
  groupScopeMode: GroupScopeMode;
  permissions: Record<PermKey, boolean>;
}

export interface PermissionTitleDefinition {
  id: string;
  name: string;
  scopeMode: ScopeMode;
  unitCodes: string[];
  permissions: Record<PermKey, boolean>;
  configured: boolean;
}

export interface PermissionCatalog {
  /** 單位角色權限（全域基準）：以角色名為鍵；無 catalog 紀錄時為空，不再給預設值。 */
  globalRolePerms: Record<string, Record<PermKey, boolean>>;
  /** 群組角色權限：以 scopedRoleKey(groupId, roleName) 為鍵。 */
  groupRolePerms: Record<string, Record<PermKey, boolean>>;
  /** 群組角色跨群組模式：以 scopedRoleKey(groupId, roleName) 為鍵。 */
  groupRoleScopes: Record<string, GroupRoleScope>;
  /** 群組角色定義（按角色名彙整，供跨群組 'all' 判斷）。 */
  groupRolesByName: Record<string, GroupRoleDefinition[]>;
  titles: PermissionTitleDefinition[];
}

/** 權限判斷所需的登入者身分；roles 是舊相容聯集，判斷時會扣除 membership 角色。 */
export interface PermUser {
  roles: string[];
  memberships: Membership[];
  title: string;
  titleId?: string;
  unitCode: string;
}

/**
 * 某 membership 持有角色是否授權指定功能（v1.37.0）：
 * 角色只看權限勾選＋群組歸屬，不再看角色側的單位範圍（單位限制由職稱側把關）。
 * - 群組角色：先找所屬群組文件（scoped key）；'group' 只在所屬群組生效，
 *   'all' 則任一 membership 持有即生效（同名角色任一所屬群組設為 'all' 即跨群組）。
 * - 單位角色／舊文件：持有 membership 即生效，權限取全域基準。
 * 傳 targetGroupId 時（資料操作端），membership 群組必須等於目標群組。
 */
function membershipRoleAllows(
  catalog: PermissionCatalog,
  membershipGroupId: string,
  roleName: string,
  key: PermKey,
  targetGroupId?: string,
): boolean {
  if (targetGroupId && membershipGroupId !== targetGroupId) return false;
  const scopedPerms =
    catalog.groupRolePerms[scopedRoleKey(membershipGroupId, roleName)];
  if (scopedPerms) {
    if (scopedPerms[key] !== true) return false;
    const scope = catalog.groupRoleScopes[scopedRoleKey(membershipGroupId, roleName)];
    if (!scope || scope.groupScopeMode === "group") {
      return membershipGroupId === (scope?.groupId ?? membershipGroupId);
    }
    return true;
  }
  const crossGroup = (catalog.groupRolesByName[roleName] ?? []).some(
    (definition) =>
      definition.groupScopeMode === "all" &&
      definition.permissions[key] === true,
  );
  if (crossGroup) return true;
  return catalog.globalRolePerms[roleName]?.[key] === true;
}

function titleForUser(user: PermUser, catalog: PermissionCatalog) {
  if (user.titleId) {
    return catalog.titles.find((title) => title.id === user.titleId);
  }
  const matches = catalog.titles.filter(
    (title) =>
      title.name === user.title &&
      scopeAppliesToUnit(title.scopeMode, title.unitCodes, user.unitCode),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * 權限採交集：至少一個有效角色（全域角色或指定群組 membership 角色）
 * 與使用者目前單位適用、且已設定的職稱，都必須勾選同一功能。
 * 傳 groupId 時，群組角色只對該群組生效；省略時用於導覽顯示，
 * 任一群組角色可開啟入口，但資料操作端仍必須傳入目標群組做二次判斷。
 */
export function can(
  user: PermUser | null | undefined,
  key: PermKey,
  catalog: PermissionCatalog,
  groupId?: string,
): boolean {
  if (!user || !user.roles.length || !user.title || !user.unitCode) return false;

  const membershipRoles = new Set(user.memberships.flatMap((item) => item.roles));
  const globalRoleNames = user.roles.filter(
    (role) => !membershipRoles.has(role) && !isGroupScopedRole(role),
  );
  const globalAllowed = globalRoleNames.some(
    (role) => catalog.globalRolePerms[role]?.[key] === true,
  );
  const groupAllowed = user.memberships.some((membership) =>
    membership.roles.some((role) =>
      membershipRoleAllows(catalog, membership.groupId, role, key, groupId),
    ),
  );
  if (!globalAllowed && !groupAllowed) return false;

  const title = titleForUser(user, catalog);
  if (
    !title ||
    !title.configured ||
    !scopeAppliesToUnit(title.scopeMode, title.unitCodes, user.unitCode)
  ) {
    return false;
  }
  return title.permissions[key] === true;
}
