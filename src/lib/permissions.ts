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
 * 權限範本（v1.38.0 名稱範本制，v1.39.0 判斷改吃人員指派情境）：
 * 權限按名稱存一份，不再按各群組／單位的文件各存一份。
 * 例如「召集人」只有一份範本，加護組、病房組、腫瘤組的召集人都共用
 * 同一組權限與跨設定；改一處，全部同名角色／職稱一起改。
 * 文件存於 `permissionTemplates` 集合，文件 id＝`${category}__${name}`。
 * v1.39.0 起角色／職稱文件上的群組／範圍欄位不再作為判斷依據；
 * 範圍改看人員自己的指派情境（memberships、title、unitCode）＋範本跨設定。
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

/**
 * 權限頁列來源（v1.39.2 只取系統實際建立的職稱／角色，不寫死名單；
 * v1.39.3 分類改穩健名稱判斷；v1.57.0 A3：角色 kind 欄位已移除，
 * 分類一律看名稱——含「單位」→單位角色，其餘一律→群組
 *（舊版只認 10 個固定名稱，「品管召集人」「組長」「組員」等會被誤歸
 * 單位角色、群組目標看不到，這就是 v1.39.3 要修的 bug）。
 * 分類永遠不靜默丟名：任何角色名至少出現在一個目標下。
 * 職稱一律歸單位，不看 level 欄位。系統管理員、一般人員永不列入。
 * 範本 category（group／unit／unitRole）本身不動。
 */
export function deriveTemplateRowNames(
  roles: Array<{ name: string }>,
  titles: Array<{ name: string }>,
): Record<TemplateCategory, string[]> {
  const out: Record<TemplateCategory, string[]> = {
    group: [],
    unit: [],
    unitRole: [],
  };
  const push = (category: TemplateCategory, name: string) => {
    if (!name || out[category].includes(name)) return;
    out[category].push(name);
  };
  for (const role of roles) {
    const name = role.name;
    if (!name || (EXCLUDED_ROLE_NAMES as readonly string[]).includes(name)) {
      continue;
    }
    // 看名稱：含「單位」→單位角色，其餘一律→群組
    //（不只認固定清單，任何新名稱都不會被靜默丟到別的目標）。
    const category: TemplateCategory = name.includes("單位")
      ? "unitRole"
      : "group";
    push(category, name);
  }
  for (const title of titles) {
    push("unit", title.name);
  }
  for (const category of Object.keys(out) as TemplateCategory[]) {
    out[category].sort((a, b) => a.localeCompare(b, "zh-Hant"));
  }
  return out;
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

export interface PermissionCatalog {
  /** 範本：以 `${category}:${name}` 為鍵；無範本＝無權限，不再給預設值。 */
  templates: Record<string, PermissionTemplate>;
  /** 單位→所屬群組對照（unitCode → groupId；供單位角色不跨單位時比對）。 */
  unitGroups: Record<string, string>;
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
 * 群組角色範本是否授權（v1.39.0：只看 membership 指派情境，不讀角色文件）：
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
 * 單位角色範本是否授權（v1.39.0：只看人員指派情境，不讀角色文件 unitCode）：
 * - 範本不存在或該鍵未勾選 → 不授權；
 * - 跨單位：持有（roles 含該角色名）即生效；
 * - 不跨單位：只在使用者本人的 unitCode 內生效——以其單位所屬群組為準，
 *   須在該群組的 membership 中持有此角色（單位級角色的指派即以單位群組計）。
 *   舊文件欄位（groupId／unitCode）一律忽略。
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
  const ownGroup = catalog.unitGroups[user.unitCode];
  if (!ownGroup) return false;
  return groupsHoldingRole(user, roleName).includes(ownGroup);
}

/**
 * 角色側是否授權：使用者的每個角色名找對應範本（群組角色範本／單位角色
 * 範本都找），取聯集。角色文件不再作為判斷依據（v1.39.0 一名一檔，
 * 文件只剩名稱；種類由範本所屬目標決定）。
 */
function roleSideAllows(
  user: PermUser,
  key: PermKey,
  catalog: PermissionCatalog,
  targetGroupId?: string,
): boolean {
  for (const roleName of new Set(user.roles)) {
    if (groupRoleTemplateAllows(user, roleName, key, catalog, targetGroupId)) {
      return true;
    }
    if (unitRoleTemplateAllows(user, roleName, key, catalog)) {
      return true;
    }
  }
  return false;
}

/**
 * 職稱側是否授權（v1.39.0：只看範本，不讀職稱文件 unitCodes）：
 * - 範本不存在或該鍵未勾選 → 不授權；
 * - 跨單位：全單位生效；
 * - 不跨單位：只在使用者本人的 unitCode 內生效；使用者本就在自己的單位，
 *   故範本勾選即生效（跨設定影響的是「能看／能管哪些單位的資料」，
 *   由各頁的資料範圍過濾處理，不影響 can() 本身）。
 */
function titleSideAllows(
  user: PermUser,
  key: PermKey,
  catalog: PermissionCatalog,
): boolean {
  const template = templateFor(catalog, "unit", user.title);
  if (!template || template.permissions[key] !== true) return false;
  return true;
}

/**
 * 權限採交集（v1.39.0 範本制＋指派情境）：至少一個有效角色範本
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
