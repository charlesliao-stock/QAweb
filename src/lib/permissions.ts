import type { PageId } from "../types";
import type { Membership } from "./roleIdentity";

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

/**
 * 權限範本（v1.38.0 名稱範本制）：
 * 權限按名稱存一份，不再按各群組／單位的文件各存一份。
 * 例如「召集人」只有一份範本，加護組、病房組、腫瘤組的召集人都共用
 * 同一組權限與跨設定；改一處，全部同名角色／職稱一起改。
 * 文件存於 `permissionTemplates` 集合，文件 id＝`${category}__${name}`。
 */
export type TemplateCategory = "group" | "unit" | "unitRole";

export interface PermissionTemplate {
  category: TemplateCategory;
  name: string;
  permissions: Record<PermKey, boolean>;
  /** true＝跨（群組目標：跨群組；單位／單位角色目標：跨單位），預設 false＝不跨。 */
  cross: boolean;
}

export function templateDocId(category: TemplateCategory, name: string): string {
  return `${category}__${name}`;
}

export function templateKey(category: TemplateCategory, name: string): string {
  return `${category}:${name}`;
}

export function parseTemplateCategory(raw: unknown): TemplateCategory | undefined {
  if (raw === "group" || raw === "unit" || raw === "unitRole") return raw;
  return undefined;
}

/** 範本基準名稱（權限頁三個目標的固定列；文件裡同類名稱會動態補上）。 */
export const GROUP_TEMPLATE_BASE_NAMES = [
  "召集人",
  "執行幹事",
  "組長",
  "組員",
] as const;

export const UNIT_TEMPLATE_BASE_NAMES = [
  "護理部主任",
  "護理部副主任",
  "護理部督導",
  "護理長",
  "副護理長",
  "護理師",
] as const;

export const UNIT_ROLE_TEMPLATE_BASE_NAMES = [
  "單位召集人",
  "單位執行幹事",
  "單位審查員",
] as const;

/** 角色文件範圍詮釋資料（供跨群組／跨單位判斷；權限本身看範本）。 */
export interface RoleDocMeta {
  kind: RoleKind;
  groupId: string;
  unitCode: string;
}

/** 職稱文件範圍詮釋資料（供不跨單位時比對適用單位；權限本身看範本）。 */
export interface TitleDocMeta {
  id: string;
  name: string;
  unitCodes: string[];
}

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

export interface PermissionCatalog {
  /** 範本：以 `${category}:${name}` 為鍵；無範本＝無權限，不再給預設值。 */
  templates: Record<string, PermissionTemplate>;
  /** 角色文件：以角色名為鍵（同名多筆各列一份，供 kind／群組／單位判斷）。 */
  roleDocs: Record<string, RoleDocMeta[]>;
  /** 職稱文件（供不跨單位時比對適用單位）。 */
  titleDocs: TitleDocMeta[];
}

/** 權限判斷所需的登入者身分；roles 是舊相容聯集，判斷時會扣除 membership 角色。 */
export interface PermUser {
  roles: string[];
  memberships: Membership[];
  title: string;
  titleId?: string;
  unitCode: string;
}

function templateFor(
  catalog: PermissionCatalog,
  category: TemplateCategory,
  name: string,
): PermissionTemplate | undefined {
  return catalog.templates[templateKey(category, name)];
}

/** 使用者以 membership 持有指定角色的群組清單。 */
function groupsHoldingRole(user: PermUser, roleName: string): string[] {
  const out: string[] = [];
  for (const membership of user.memberships) {
    if (membership.roles.includes(roleName) && !out.includes(membership.groupId)) {
      out.push(membership.groupId);
    }
  }
  return out;
}

/**
 * 群組角色範本是否授權（v1.38.0 範本制）：
 * - 範本不存在或該鍵未勾選 → 不授權；
 * - 跨群組：任一 membership 持有即生效；
 * - 不跨群組：傳入目標群組時必須持有於該群組，未傳目標群組時持有任一群組即生效（導覽用）。
 */
function groupRoleTemplateAllows(
  user: PermUser,
  roleName: string,
  key: PermKey,
  catalog: PermissionCatalog,
  targetGroupId?: string,
): boolean {
  const template = templateFor(catalog, "group", roleName);
  if (!template || template.permissions[key] !== true) return false;
  const holding = groupsHoldingRole(user, roleName);
  if (holding.length === 0) return false;
  if (targetGroupId) {
    return template.cross ? true : holding.includes(targetGroupId);
  }
  return true;
}

/**
 * 單位角色範本是否授權（v1.38.0 範本制）：
 * - 範本不存在或該鍵未勾選 → 不授權；
 * - 跨單位：持有即生效；
 * - 不跨單位：角色文件 unitCode 須等於使用者單位；舊文件無 unitCode 時
 *   視為持有於本人單位（相容重置前資料，重置後新文件皆有 unitCode）；
 *   無任何角色文件時無法驗證單位範圍，範本為準。
 */
function unitRoleTemplateAllows(
  user: PermUser,
  roleName: string,
  key: PermKey,
  catalog: PermissionCatalog,
): boolean {
  const template = templateFor(catalog, "unitRole", roleName);
  if (!template || template.permissions[key] !== true) return false;
  if (!user.roles.includes(roleName)) return false;
  if (template.cross) return true;
  const docs = (catalog.roleDocs[roleName] ?? []).filter(
    (item) => item.kind === "unit",
  );
  if (docs.length === 0) return true;
  return docs.some((item) => !item.unitCode || item.unitCode === user.unitCode);
}

/**
 * 角色側是否授權：使用者的每個角色名找對應範本（群組角色範本／單位角色
 * 範本，依角色文件的 kind 區分；kind 不明時兩類範本都找），取聯集。
 * 角色跨單位不再另設，跟範本走（單位限制由職稱側把關）。
 */
function roleSideAllows(
  user: PermUser,
  key: PermKey,
  catalog: PermissionCatalog,
  targetGroupId?: string,
): boolean {
  for (const roleName of new Set(user.roles)) {
    const kinds = new Set(
      (catalog.roleDocs[roleName] ?? []).map((item) => item.kind),
    );
    const tryGroup = kinds.size === 0 || kinds.has("group");
    const tryUnitRole = kinds.size === 0 || kinds.has("unit");
    if (
      tryGroup &&
      groupRoleTemplateAllows(user, roleName, key, catalog, targetGroupId)
    ) {
      return true;
    }
    if (tryUnitRole && unitRoleTemplateAllows(user, roleName, key, catalog)) {
      return true;
    }
  }
  return false;
}

/**
 * 職稱側是否授權（v1.38.0 範本制）：
 * - 範本不存在或該鍵未勾選 → 不授權；
 * - 跨單位：全單位生效；
 * - 不跨單位：使用者單位必須在職稱文件的 unitCodes 內（以 titleId 或
 *   職稱名找文件；無文件或無 unitCodes＝不生效）。
 */
function titleSideAllows(
  user: PermUser,
  key: PermKey,
  catalog: PermissionCatalog,
): boolean {
  const template = templateFor(catalog, "unit", user.title);
  if (!template || template.permissions[key] !== true) return false;
  if (template.cross) return true;
  const docs = catalog.titleDocs.filter(
    (item) => item.id === user.titleId || item.name === user.title,
  );
  if (docs.length === 0) return false;
  return docs.some((item) => item.unitCodes.includes(user.unitCode));
}

/**
 * 權限採交集（v1.38.0 範本制）：至少一個有效角色範本
 * 與使用者職稱範本，都必須勾選同一功能。
 * 無職稱／無範本＝無權限。
 * 傳 groupId 時，群組角色只對該群組生效（不跨群組時）；省略時用於導覽顯示，
 * 任一群組角色可開啟入口，但資料操作端仍必須傳入目標群組做二次判斷。
 */
export function can(
  user: PermUser | null | undefined,
  key: PermKey,
  catalog: PermissionCatalog,
  groupId?: string,
): boolean {
  if (!user || !user.roles.length || !user.title || !user.unitCode) return false;
  if (!roleSideAllows(user, key, catalog, groupId)) return false;
  return titleSideAllows(user, key, catalog);
}
