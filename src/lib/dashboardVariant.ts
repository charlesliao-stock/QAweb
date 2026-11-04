/**
 * 儀表板角色變體（v1.15.0 新增）。
 * 純函式：依登入者職稱／角色決定顯示哪些儀表板頁籤。
 * 優先序（使用者拍板）：主任（職稱含主任）＞督導（職稱含督導）＞
 * 護理長（職稱含護理長）＞執行幹事（roles 含執行幹事）＞
 * 召集人（roles 含召集人）＞審查員（roles 含審查員）＞一般人員；
 * isAdmin 七種全開。
 */

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
  isAdmin: boolean;
}

function matches(variant: DashboardVariant, user: VariantUser): boolean {
  const title = user.title ?? "";
  const roles = user.roles ?? [];
  const roleHas = (s: string) => roles.some((r) => r.includes(s));
  switch (variant) {
    case "director":
      return title.includes("主任");
    case "supervisor":
      return title.includes("督導");
    case "headNurse":
      return title.includes("護理長");
    case "officer":
      return roleHas("執行幹事") || title.includes("執行幹事");
    case "convener":
      return roleHas("召集人") || title.includes("召集人");
    case "reviewer":
      return roleHas("審查員");
    case "nurse":
      return true;
  }
}

/**
 * 該使用者可用的儀表板變體（依優先序排列；第一個為預設頁籤）。
 * 系統管理員七種全開；其餘符合幾種身分顯示幾個（護理師為保底一定有）。
 */
export function getDashboardVariants(user: VariantUser): DashboardVariant[] {
  if (user.isAdmin) return [...VARIANT_ORDER];
  const out = VARIANT_ORDER.filter(
    (v) => v !== "nurse" && matches(v, user),
  );
  out.push("nurse");
  return out;
}
