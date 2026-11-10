/**
 * 組織身分詮釋資料（v1.40.5：寫死名稱稽核）。
 *
 * 問題：舊程式以角色／職稱「名稱字串」決定身分（例如 roles.includes("審查員")、
 * title.includes("護理長")），換一家名稱不同的醫院就全部失效。
 *
 * 新模型：身分由角色／職稱文件上的「使用者設定欄位」決定——
 * - 角色文件：`category`（功能類別）＋ `kind`（適用範圍：group／unit）；
 * - 職稱文件：`isUnitHead`／`isDistrictHead`／`isHospitalHead`／`isOfficer`／`isConvener`
 *  （是否為單位主管／轄區主管／院級主管／執行幹事職能／召集人職能）。
 * 人員與範本的對應一律以文件 id／參照欄位為準，不以名稱比對關聯。
 *
 * 相容：舊文件沒有這些欄位時，以名稱推導（legacy*，僅限遷移相容；管理員在
 * 人員管理頁補設欄位後即不再依賴名稱）。新醫院自訂名稱時，只要建角色／職稱
 * 時設定好類別與主管旗標，全部流程即按設定走，與名稱無關。
 *
 * 本檔零依賴、不碰 Firestore，可在 node 直接單元測試。
 */

export type RoleCategory =
  | "reviewer"
  | "convener"
  | "officer"
  | "unitHead"
  | "senior"
  | "general";

export type RoleScope = "group" | "unit";

export const ROLE_CATEGORY_LABELS: Record<RoleCategory, string> = {
  reviewer: "審查員",
  convener: "召集人",
  officer: "執行幹事",
  unitHead: "單位主管",
  senior: "院級主管",
  general: "一般",
};

export const ROLE_SCOPE_LABELS: Record<RoleScope, string> = {
  group: "群組角色",
  unit: "單位角色",
};

/** 下拉選項（類別／範圍），供人員管理頁建立／編輯角色使用。 */
export const ROLE_CATEGORY_OPTIONS: Array<{ value: RoleCategory; label: string }> =
  (Object.keys(ROLE_CATEGORY_LABELS) as RoleCategory[]).map((value) => ({
    value,
    label: ROLE_CATEGORY_LABELS[value],
  }));

export const ROLE_SCOPE_OPTIONS: Array<{ value: RoleScope; label: string }> =
  (Object.keys(ROLE_SCOPE_LABELS) as RoleScope[]).map((value) => ({
    value,
    label: ROLE_SCOPE_LABELS[value],
  }));

export interface RoleMetaInput {
  name: string;
  /** 功能類別（新欄位；缺失時以名稱推導，見 legacyRoleCategory）。 */
  category?: unknown;
  /** 適用範圍（沿用既有 kind 語義；缺失時以名稱推導）。 */
  kind?: unknown;
  scope?: unknown;
}

export interface RoleMeta {
  name: string;
  category: RoleCategory;
  scope: RoleScope;
}

export interface TitleMetaInput {
  id?: unknown;
  name: string;
  isUnitHead?: unknown;
  isDistrictHead?: unknown;
  isHospitalHead?: unknown;
  isOfficer?: unknown;
  isConvener?: unknown;
}

export interface TitleFlags {
  isUnitHead: boolean;
  isDistrictHead: boolean;
  isHospitalHead: boolean;
  isOfficer: boolean;
  isConvener: boolean;
}

export type RoleMetaMap = Map<string, RoleMeta>;
export type TitleMetaMap = Map<string, TitleFlags>;

/* ================= 舊名稱對照（僅遷移相容） =================
 * 以下名單只用於「文件缺少新欄位時」的推導，等同舊版 roleIdentity.ts 的
 * 寫死集合。正式流程不再直接比對這些名稱；新建立的角色／職稱一律以欄位為準。
 */
export const LEGACY_REVIEWER_ROLE_NAMES = ["審查員", "品管組審查員", "單位審查員"];
export const LEGACY_CONVENER_ROLE_NAMES = [
  "召集人",
  "各組召集人",
  "品管組召集人",
  "單位召集人",
];
export const LEGACY_OFFICER_ROLE_NAMES = ["執行幹事", "品管組執行幹事", "單位執行幹事"];
/** 舊組級召集人名稱（TaskHandoffPage 退路用）。 */
export const LEGACY_GROUP_CONVENER_ROLE_NAMES = ["召集人", "品管組召集人"];
/** 舊組級執行幹事名稱（TaskHandoffPage 退路用）。 */
export const LEGACY_GROUP_OFFICER_ROLE_NAMES = ["執行幹事", "品管組執行幹事"];
export const LEGACY_UNIT_HEAD_ROLE_NAMES = ["護理長", "單位護理長"];
export const LEGACY_SENIOR_ROLE_NAMES = ["主任", "副主任", "督導"];

export function legacyRoleCategory(name: string): RoleCategory {
  if (LEGACY_REVIEWER_ROLE_NAMES.includes(name)) return "reviewer";
  if (LEGACY_CONVENER_ROLE_NAMES.includes(name)) return "convener";
  if (LEGACY_OFFICER_ROLE_NAMES.includes(name)) return "officer";
  if (LEGACY_UNIT_HEAD_ROLE_NAMES.includes(name)) return "unitHead";
  if (LEGACY_SENIOR_ROLE_NAMES.includes(name)) return "senior";
  return "general";
}

export function parseRoleCategory(raw: unknown): RoleCategory | undefined {
  if (
    raw === "reviewer" ||
    raw === "convener" ||
    raw === "officer" ||
    raw === "unitHead" ||
    raw === "senior" ||
    raw === "general"
  ) {
    return raw;
  }
  return undefined;
}

export function parseRoleScope(raw: unknown): RoleScope | undefined {
  if (raw === "group" || raw === "unit") return raw;
  return undefined;
}

/** 舊角色適用範圍推導：含「單位」→單位角色，其餘→群組角色（同 v1.39.3 分類）。 */
export function legacyRoleScope(name: string): RoleScope {
  return name.includes("單位") ? "unit" : "group";
}

/** 角色文件 → 詮釋資料：欄位優先，缺失才以名稱推導。 */
export function resolveRoleMeta(input: RoleMetaInput): RoleMeta {
  const name = input.name ?? "";
  return {
    name,
    category: parseRoleCategory(input.category) ?? legacyRoleCategory(name),
    scope:
      parseRoleScope(input.kind ?? input.scope) ?? legacyRoleScope(name),
  };
}

/** 角色清單 → 以名稱為鍵的詮釋資料對照表。 */
export function buildRoleMetaMap(
  roles: Array<RoleMetaInput | string>,
): RoleMetaMap {
  const out: RoleMetaMap = new Map();
  for (const r of roles) {
    const meta =
      typeof r === "string" ? resolveRoleMeta({ name: r }) : resolveRoleMeta(r);
    if (meta.name && !out.has(meta.name)) out.set(meta.name, meta);
  }
  return out;
}

/**
 * 職稱旗標推導（舊文件相容）：
 * - 單位主管：名稱含「護理長」且不含「副」（舊 D12 排除副護理長）；
 * - 轄區主管：名稱含「督導」；院級主管：名稱含「主任」；
 * - 執行幹事／召集人職能：名稱含「執行幹事」／「召集人」
 *  （舊儀表板變體與 AuditPage 以職稱含這些字判斷）。
 * 新職稱以文件欄位為準，欄位有值時名稱推導不再作用。
 */
export function legacyTitleFlags(name: string): TitleFlags {
  return {
    isUnitHead: name.includes("護理長") && !name.includes("副"),
    isDistrictHead: name.includes("督導"),
    isHospitalHead: name.includes("主任"),
    isOfficer: name.includes("執行幹事"),
    isConvener: name.includes("召集人"),
  };
}

function asBool(raw: unknown): boolean | undefined {
  return typeof raw === "boolean" ? raw : undefined;
}

/** 職稱文件 → 旗標：欄位優先，缺失的旗標才以名稱推導。 */
export function resolveTitleFlags(input: TitleMetaInput): TitleFlags {
  const legacy = legacyTitleFlags(input.name ?? "");
  return {
    isUnitHead: asBool(input.isUnitHead) ?? legacy.isUnitHead,
    isDistrictHead: asBool(input.isDistrictHead) ?? legacy.isDistrictHead,
    isHospitalHead: asBool(input.isHospitalHead) ?? legacy.isHospitalHead,
    isOfficer: asBool(input.isOfficer) ?? legacy.isOfficer,
    isConvener: asBool(input.isConvener) ?? legacy.isConvener,
  };
}

/** 職稱清單 → 以名稱為鍵的旗標對照表（另附 id 對照，見 buildTitleMetaById）。 */
export function buildTitleMetaMap(
  titles: Array<TitleMetaInput | string>,
): TitleMetaMap {
  const out: TitleMetaMap = new Map();
  for (const t of titles) {
    const input = typeof t === "string" ? { name: t } : t;
    if (!input.name || out.has(input.name)) continue;
    out.set(input.name, resolveTitleFlags(input));
  }
  return out;
}

/** 職稱清單 → 以文件 id 為鍵的旗標對照表（人員 titleId 優先以 id 查）。 */
export function buildTitleMetaById(
  titles: Array<TitleMetaInput | string>,
): Map<string, TitleFlags> {
  const out = new Map<string, TitleFlags>();
  for (const t of titles) {
    if (typeof t === "string") continue;
    const id = typeof t.id === "string" ? t.id : "";
    if (!id || out.has(id)) continue;
    out.set(id, resolveTitleFlags(t));
  }
  return out;
}

/** 查某人的職稱旗標：titleId 優先，否則以職稱名稱查；都查無則以名稱推導。 */
export function titleFlagsOf(
  titleName: string,
  titleId: string | undefined,
  byName: TitleMetaMap | undefined,
  byId: Map<string, TitleFlags> | undefined,
): TitleFlags {
  if (titleId && byId?.has(titleId)) return byId.get(titleId)!;
  if (titleName && byName?.has(titleName)) return byName.get(titleName)!;
  return legacyTitleFlags(titleName ?? "");
}

const EMPTY_FLAGS: TitleFlags = {
  isUnitHead: false,
  isDistrictHead: false,
  isHospitalHead: false,
  isOfficer: false,
  isConvener: false,
};

export function emptyTitleFlags(): TitleFlags {
  return { ...EMPTY_FLAGS };
}

/* ================= 身分判斷（吃詮釋資料，不比對名稱） ================= */

export function roleMetaOf(
  name: string,
  roleMeta: RoleMetaMap | undefined,
): RoleMeta {
  return roleMeta?.get(name) ?? resolveRoleMeta({ name });
}

export function hasRoleCategory(
  roles: string[] | undefined,
  category: RoleCategory,
  roleMeta?: RoleMetaMap,
): boolean {
  if (!roles) return false;
  return roles.some((r) => roleMetaOf(r, roleMeta).category === category);
}

export function hasRoleCategoryWithScope(
  roles: string[] | undefined,
  category: RoleCategory,
  scope: RoleScope,
  roleMeta?: RoleMetaMap,
): boolean {
  if (!roles) return false;
  return roles.some((r) => {
    const m = roleMetaOf(r, roleMeta);
    return m.category === category && m.scope === scope;
  });
}

export function isReviewerRoleMeta(
  roles: string[] | undefined,
  roleMeta?: RoleMetaMap,
): boolean {
  return hasRoleCategory(roles, "reviewer", roleMeta);
}

export function isConvenerRoleMeta(
  roles: string[] | undefined,
  roleMeta?: RoleMetaMap,
): boolean {
  return hasRoleCategory(roles, "convener", roleMeta);
}

export function isOfficerRoleMeta(
  roles: string[] | undefined,
  roleMeta?: RoleMetaMap,
): boolean {
  return hasRoleCategory(roles, "officer", roleMeta);
}

/** 組級召集人／執行幹事（排程權限用）：類別相符且適用範圍為群組。 */
export function isGroupConvenerRoleMeta(
  roles: string[] | undefined,
  roleMeta?: RoleMetaMap,
): boolean {
  return hasRoleCategoryWithScope(roles, "convener", "group", roleMeta);
}

export function isGroupOfficerRoleMeta(
  roles: string[] | undefined,
  roleMeta?: RoleMetaMap,
): boolean {
  return hasRoleCategoryWithScope(roles, "officer", "group", roleMeta);
}

export function hasSchedulePermissionMeta(
  roles: string[] | undefined,
  roleMeta?: RoleMetaMap,
): boolean {
  return (
    isGroupConvenerRoleMeta(roles, roleMeta) ||
    isGroupOfficerRoleMeta(roles, roleMeta)
  );
}

/** 群組範圍角色：審查員／召集人／執行幹事類別（不含單位主管／院級主管／一般）。 */
export function isGroupScopedRoleMeta(
  name: string,
  roleMeta?: RoleMetaMap,
): boolean {
  const c = roleMetaOf(name, roleMeta).category;
  return c === "reviewer" || c === "convener" || c === "officer";
}

/**
 * 單位級角色（以其單位所屬群組計範圍）：審查員／召集人／執行幹事類別且
 * 適用範圍為單位。舊版只認三個「單位＊」名稱；新版以類別＋範圍判斷。
 */
export function isUnitLevelRoleMeta(
  name: string,
  roleMeta?: RoleMetaMap,
): boolean {
  const m = roleMetaOf(name, roleMeta);
  return (
    (m.category === "reviewer" ||
      m.category === "convener" ||
      m.category === "officer") &&
    m.scope === "unit"
  );
}

/** 單位級執行幹事（AuditPage 自審範圍用）：執行幹事類別且適用範圍為單位。 */
export function hasUnitOfficerRoleMeta(
  roles: string[] | undefined,
  roleMeta?: RoleMetaMap,
): boolean {
  return hasRoleCategoryWithScope(roles, "officer", "unit", roleMeta);
}

/** 屬於指定類別的角色名稱清單（由詮釋資料算出，不寫死名稱）。 */
export function roleNamesInCategories(
  roleMeta: RoleMetaMap | undefined,
  categories: RoleCategory[],
): string[] {
  if (!roleMeta) return [];
  const out: string[] = [];
  for (const meta of roleMeta.values()) {
    if (categories.includes(meta.category)) out.push(meta.name);
  }
  return out;
}

/** 審查員類別的角色名稱清單（審查員管理／效期清理用）。 */
export function reviewerRoleNames(roleMeta: RoleMetaMap | undefined): string[] {
  return roleNamesInCategories(roleMeta, ["reviewer"]);
}

/** 召集人類別的角色名稱清單（AuditPage 群組範圍用）。 */
export function convenerRoleNames(roleMeta: RoleMetaMap | undefined): string[] {
  return roleNamesInCategories(roleMeta, ["convener"]);
}

/** 執行幹事類別的角色名稱清單（AuditPage 群組範圍用）。 */
export function officerRoleNames(roleMeta: RoleMetaMap | undefined): string[] {
  return roleNamesInCategories(roleMeta, ["officer"]);
}

/**
 * 排程權限角色名稱清單：類別為召集人或執行幹事、且適用範圍為群組者
 *（TaskHandoffPage 管理範圍用；單位級角色以其單位所屬群組計，不列入）。
 */
export function scheduleScopeRoleNames(
  roleMeta: RoleMetaMap | undefined,
): string[] {
  if (!roleMeta) return [];
  return [...roleMeta.values()]
    .filter(
      (m) =>
        (m.category === "convener" || m.category === "officer") &&
        m.scope === "group",
    )
    .map((m) => m.name);
}
