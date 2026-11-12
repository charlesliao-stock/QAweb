/**
 * 組織身分詮釋資料（v1.57.0 A3：角色身分改由層級＋名稱關鍵字推導）。
 *
 * 角色文件的 `category`／`kind` 欄位已不再讀取（舊文件上的欄位留著無害，
 * 程式不再讀、也不再寫入；新角色不再寫這兩個欄位）。
 * - 身分：角色名稱關鍵字（見 lib/roleDerivation.ts deriveRoleCategory）；
 * - 範圍：所屬層級（層級名稱／id 對照），無層級資料時退回名稱推導。
 * 職稱仍以文件旗標判斷（`isUnitHead`／`isDistrictHead`／`isHospitalHead`／
 * `isOfficer`／`isConvener`），不受本版影響。
 * 人員與範本的對應一律以文件 id／參照欄位為準，不以名稱比對關聯。
 *
 * 本檔只依賴推導模組（roleDerivation）、不碰 Firestore，可在 node 直接單元測試。
 */

import { deriveRoleCategory, deriveRoleScope } from "./roleDerivation";

/**
 * 角色身分（v1.57.0 A3：名稱關鍵字推導只會產出 reviewer／convener／
 * officer／general；unitHead／senior 保留在型別內供既有
 * hasRoleCategory(roles, "unitHead"／"senior") 呼叫端編譯，
 * 角色側不再推導出這兩類——現行 12 個角色本來就沒有這兩類，
 * 單位主管／院級主管的實際判斷走職稱旗標（見各頁 titleFlagsOf）。
 */
export type RoleCategory =
  | "reviewer"
  | "convener"
  | "officer"
  | "unitHead"
  | "senior"
  | "general";

export type RoleScope = "group" | "unit";

export interface RoleMetaInput {
  name: string;
  /** 所屬層級 id（v1.55.0；空＝未分層級，範圍退回名稱推導）。 */
  levelId?: unknown;
  /** 所屬層級名稱（有值時優先於 levelId 判定範圍）。 */
  levelName?: unknown;
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

/* ================= 名稱推導（v1.57.0 A3：唯一推導來源） =================
 * 角色身分一律由 lib/roleDerivation.ts 的關鍵字／層級推導；
 * 舊版的精確比對名單（LEGACY_*）已移除——新名稱只要含關鍵字
 * 就不會掉級。以下 legacy* 僅保留舊簽名供相容，皆轉發至推導模組。
 */
export function legacyRoleCategory(name: string): RoleCategory {
  return deriveRoleCategory(name);
}

/** 舊角色適用範圍推導：無層級資料時含「單位」→單位角色，其餘→群組角色。 */
export function legacyRoleScope(name: string): RoleScope {
  return deriveRoleScope({ name });
}

/** 角色文件 → 詮釋資料：身分由名稱關鍵字、範圍由層級推導。 */
export function resolveRoleMeta(input: RoleMetaInput): RoleMeta {
  const name = input.name ?? "";
  return {
    name,
    category: deriveRoleCategory(name),
    scope: deriveRoleScope(input),
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
