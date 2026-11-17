/**
 * 儀表板角色變體（v1.15.0 新增；v1.40.5 改吃 orgMeta 詮釋資料）。
 * 純函式：依登入者職稱／角色決定顯示哪些儀表板頁籤。
 * 優先序（使用者拍板）：院級主管＞轄區主管＞單位主管＞執行幹事＞
 * 召集人＞審查員＞一般人員；isAdmin 七種全開。
 *
 * 變體改以職稱旗標（isHospitalHead／isDistrictHead／isUnitHead 等）與
 * 角色類別判斷，不再比對職稱／角色名稱。未傳入詮釋資料時以名稱推導
 *（legacy，行為與舊版一致；test-v1.15 即以此路徑驗證）。
 */

import {
  hasRoleCategory,
  titleFlagsOf,
  type RoleMetaMap,
  type TitleFlags,
  type TitleMetaMap,
} from "./orgMeta";

export type DashboardVariant =
  | "director"
  | "supervisor"
  | "headNurse"
  | "officer"
  | "convener"
  | "reviewer"
  | "nurse";

/** 優先序（陣列順序即優先序） */
export const VARIANT_ORDER: DashboardVariant[] = [
  "director",
  "supervisor",
  "headNurse",
  "officer",
  "convener",
  "reviewer",
  "nurse",
];

export const VARIANT_LABELS: Record<DashboardVariant, string> = {
  director: "主任",
  supervisor: "督導",
  headNurse: "護理長",
  officer: "執行幹事",
  convener: "召集人",
  reviewer: "審查員",
  nurse: "護理師",
};

export interface VariantUser {
  roles: string[];
  title: string;
  /** 新版職稱主檔 ID（有值時優先以 id 查旗標）。 */
  titleId?: string;
  isAdmin: boolean;
}

export interface VariantMeta {
  roleMeta?: RoleMetaMap;
  titleMeta?: TitleMetaMap;
  titleMetaById?: Map<string, TitleFlags>;
}

function matches(
  variant: DashboardVariant,
  user: VariantUser,
  meta?: VariantMeta,
): boolean {
  const title = user.title ?? "";
  const roles = user.roles ?? [];
  const flags = titleFlagsOf(
    title,
    user.titleId,
    meta?.titleMeta,
    meta?.titleMetaById,
  );
  switch (variant) {
    case "director":
      return flags.isHospitalHead;
    case "supervisor":
      return flags.isDistrictHead;
    case "headNurse":
      return (
        flags.isUnitHead || hasRoleCategory(roles, "unitHead", meta?.roleMeta)
      );
    case "officer":
      return (
        flags.isOfficer || hasRoleCategory(roles, "officer", meta?.roleMeta)
      );
    case "convener":
      return (
        flags.isConvener || hasRoleCategory(roles, "convener", meta?.roleMeta)
      );
    case "reviewer":
      return hasRoleCategory(roles, "reviewer", meta?.roleMeta);
    case "nurse":
      return true;
  }
}

/**
 * 該使用者可用的儀表板變體（依優先序排列；第一個為預設頁籤）。
 * 系統管理員七種全開；其餘符合幾種身分顯示幾個（護理師為保底一定有）。
 */
export function getDashboardVariants(
  user: VariantUser,
  meta?: VariantMeta,
): DashboardVariant[] {
  if (user.isAdmin) return [...VARIANT_ORDER];
  const out = VARIANT_ORDER.filter(
    (v) => v !== "nurse" && matches(v, user, meta),
  );
  out.push("nurse");
  return out;
}
