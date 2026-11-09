import type { PageId } from "../types";
import { ROLE_PAGES } from "./access";
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

const BASE_ROLE_ACTIONS: Record<string, RolePermissions> = {
  一般人員: { resultQuery: true },
  審查員: { resultQuery: true, viewPhotos: true, editSubmitted: true },
  護理長: { resultQuery: true, viewPhotos: true },
  督導: { resultQuery: true, viewPhotos: true },
  品管執行幹事: {
    resultQuery: true,
    viewPhotos: true,
    manageSchedule: true,
    editSubmitted: true,
  },
  系統管理員: {
    resultQuery: true,
    viewPhotos: true,
    manageSchedule: true,
    editSubmitted: true,
    manageRoles: true,
  },
  指標負責人: { resultQuery: true },
  召集人: { resultQuery: true, manageSchedule: true },
  品管組審查員: { resultQuery: true, viewPhotos: true, editSubmitted: true },
  單位審查員: { resultQuery: true, viewPhotos: true, editSubmitted: true },
  品管組召集人: { resultQuery: true, manageSchedule: true },
  品管組執行幹事: {
    resultQuery: true,
    viewPhotos: true,
    manageSchedule: true,
    editSubmitted: true,
  },
  單位召集人: { resultQuery: true },
  單位執行幹事: { resultQuery: true, viewPhotos: true, editSubmitted: true },
};

/**
 * 相容既有角色頁面預設；新功能權限仍需由管理者在矩陣逐項勾選。
 * 系統管理員在 evaluator 中另有明確 super-admin bypass。
 */
export const DEFAULT_ROLE_PERMS: Record<string, RolePermissions> = Object.fromEntries(
  Object.keys(ROLE_PAGES).map((roleName) => {
    const permissions = emptyPermissions();
    for (const page of ROLE_PAGES[roleName as keyof typeof ROLE_PAGES]) {
      const key = pagePermissionKey(page);
      if (key) permissions[key] = true;
    }
    Object.assign(permissions, BASE_ROLE_ACTIONS[roleName] ?? {});
    return [roleName, permissions];
  }),
);

export function defaultRolePermissions(roleName: string): Record<PermKey, boolean> {
  return {
    ...emptyPermissions(),
    ...(DEFAULT_ROLE_PERMS[roleName] ?? {}),
  };
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

export interface PermissionTitleDefinition {
  id: string;
  name: string;
  unitCodes: string[];
  permissions: Record<PermKey, boolean>;
  configured: boolean;
}

export interface PermissionCatalog {
  globalRolePerms: Record<string, Record<PermKey, boolean>>;
  groupRolePerms: Record<string, Record<PermKey, boolean>>;
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

function rolePermissionsForGroup(
  catalog: PermissionCatalog,
  groupId: string,
  roleName: string,
): Record<PermKey, boolean> | undefined {
  return (
    catalog.groupRolePerms[scopedRoleKey(groupId, roleName)] ??
    (isGroupScopedRole(roleName) ? catalog.globalRolePerms[roleName] : undefined)
  );
}

function titleForUser(user: PermUser, catalog: PermissionCatalog) {
  if (user.titleId) {
    return catalog.titles.find((title) => title.id === user.titleId);
  }
  const matches = catalog.titles.filter(
    (title) =>
      title.name === user.title &&
      user.unitCode !== "" &&
      title.unitCodes.includes(user.unitCode),
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
  const groupAllowed = user.memberships.some(
    (membership) =>
      (!groupId || membership.groupId === groupId) &&
      membership.roles.some(
        (role) => rolePermissionsForGroup(catalog, membership.groupId, role)?.[key] === true,
      ),
  );
  if (!globalAllowed && !groupAllowed) return false;

  const title = titleForUser(user, catalog);
  if (!title || !title.configured || !title.unitCodes.includes(user.unitCode)) {
    return false;
  }
  return title.permissions[key] === true;
}
