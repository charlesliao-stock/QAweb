import {
  DASHBOARD_SECTION_KEYS,
  parseDashboardSections,
  resolveDashboardSections,
  type DashboardSectionKey,
  type DashboardSections,
} from "./dashboardSections";
import { roleMetaOf, type RoleMetaMap, type TitleFlags } from "./orgMeta";
import type { DashboardVariant } from "./dashboardVariant";

export interface DashboardSectionOverrides {
  roles: Record<string, Partial<DashboardSections>>;
  titles: Record<string, Partial<DashboardSections>>;
}

export type DashboardTargetKind = "role" | "title";
export type DashboardOverrideValue = boolean | undefined;

export const EMPTY_DASHBOARD_SECTION_OVERRIDES: DashboardSectionOverrides = {
  roles: {},
  titles: {},
};

/** Dashboard 頁面實際提供管理開關的項目；未列入的核心內容維持固定顯示。 */
export const DASHBOARD_SECTION_KEYS_BY_VARIANT: Record<DashboardVariant, DashboardSectionKey[]> = {
  nurse: ["personalTrend", "weakTop3", "focusIndicators"],
  reviewer: ["overdueLocked", "nextMonthPreview"],
  headNurse: ["capaPendingReview", "alert48h", "nextMonthPreview", "unitAvg", "overAudit"],
  officer: ["lagLights", "overdueLocked", "unlockReview"],
  convener: ["groupPassRate", "pareto"],
  supervisor: ["capaPendingReview", "trendAlerts", "unitProgress"],
  director: ["capaPendingReview", "overview", "radar", "redFlags", "riskyUnits"],
};

export const DASHBOARD_SECTION_LABELS: Record<DashboardSectionKey, string> = {
  monthlyTodo: "本月待辦",
  nextMonthPreview: "次月排程預告",
  overdueLocked: "逾期／鎖定補審任務",
  unlockReview: "解鎖審查待辦",
  lagLights: "落後品質燈號",
  alert48h: "48 小時即時缺失通報",
  focusIndicators: "本月重點指標",
  overAudit: "超額加審提醒",
  personalTrend: "個人受審結果走勢",
  weakTop3: "個人常見扣分 Top 3",
  unitAvg: "單位與全院平均比較",
  pareto: "扣分項目 Top 3（帕累托）",
  trendAlerts: "近 3 個月品質趨勢警示",
  unitProgress: "轄區單位進度",
  groupPassRate: "組別達標率",
  overview: "全院品質戰情總覽",
  radar: "科部品質雷達圖",
  redFlags: "紅旗指標 Top 3",
  riskyUnits: "高風險單位 Top 3",
  capaPendingReview: "CAPA 待結案核准",
};

export const DASHBOARD_SECTION_DESCRIPTIONS: Partial<Record<DashboardSectionKey, string>> = {
  capaPendingReview: "只呈現待核准件數；案件範圍依實際登入者權限，不隨預覽視角變動。",
  unitAvg: "包含本單位與全院基準比較。",
  alert48h: "近 48 小時審查缺失摘要。",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTargetOverrides(raw: unknown): Record<string, Partial<DashboardSections>> {
  if (!isRecord(raw)) return {};
  const out: Record<string, Partial<DashboardSections>> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!id || !isRecord(value)) continue;
    const parsed = parseDashboardSections(value);
    if (Object.keys(parsed).length > 0) out[id] = parsed;
  }
  return out;
}

/** 防禦性解析；只接受已知項目及 boolean 值，忽略未知欄位。 */
export function parseDashboardSectionOverrides(raw: unknown): DashboardSectionOverrides {
  if (!isRecord(raw)) return { roles: {}, titles: {} };
  return {
    roles: parseTargetOverrides(raw.roles),
    titles: parseTargetOverrides(raw.titles),
  };
}

/** 純更新 helper：undefined 代表移除目標上的單一覆寫、回到繼承。 */
export function setDashboardSectionOverride(
  raw: unknown,
  kind: DashboardTargetKind,
  targetId: string,
  key: DashboardSectionKey,
  value: DashboardOverrideValue,
): DashboardSectionOverrides {
  const current = parseDashboardSectionOverrides(raw);
  if (!targetId) return current;
  const next: DashboardSectionOverrides = {
    roles: { ...current.roles },
    titles: { ...current.titles },
  };
  const scope = kind === "role" ? next.roles : next.titles;
  const target = { ...(scope[targetId] ?? {}) };
  if (value === undefined) delete target[key];
  else target[key] = value;
  if (Object.keys(target).length) scope[targetId] = target;
  else delete scope[targetId];
  return next;
}

/**
 * 基礎值 → 符合目前視角的角色覆寫 → 職稱覆寫。
 * 多個同視角角色若有衝突，隱藏優先；職稱的明確值最後生效。
 * 這是顯示設定，不會授予資料、頁面或操作權限。
 */
export function resolveDashboardSectionsForTarget(options: {
  base?: unknown;
  overrides?: unknown;
  roleIds?: string[];
  titleId?: string;
}): DashboardSections {
  const overrides = parseDashboardSectionOverrides(options.overrides);
  const result = resolveDashboardSections(options.base);
  const roleValues: Partial<DashboardSections> = {};

  for (const key of DASHBOARD_SECTION_KEYS) {
    const values = (options.roleIds ?? [])
      .map((id) => overrides.roles[id]?.[key])
      .filter((value): value is boolean => typeof value === "boolean");
    if (values.includes(false)) roleValues[key] = false;
    else if (values.includes(true)) roleValues[key] = true;
  }

  return {
    ...result,
    ...roleValues,
    ...(options.titleId ? overrides.titles[options.titleId] ?? {} : {}),
  };
}

export function dashboardVariantForRole(
  roleName: string,
  roleMeta?: RoleMetaMap,
): DashboardVariant {
  const category = roleMetaOf(roleName, roleMeta).category;
  switch (category) {
    case "senior":
      return "director";
    case "unitHead":
      return "headNurse";
    case "officer":
      return "officer";
    case "convener":
      return "convener";
    case "reviewer":
      return "reviewer";
    default:
      return "nurse";
  }
}

export function dashboardVariantForTitle(flags: TitleFlags): DashboardVariant {
  if (flags.isHospitalHead) return "director";
  if (flags.isDistrictHead) return "supervisor";
  if (flags.isUnitHead) return "headNurse";
  if (flags.isOfficer) return "officer";
  if (flags.isConvener) return "convener";
  return "nurse";
}

export function countCapaPendingReview(cases: Array<{
  stage?: unknown;
  approvalSteps?: unknown;
}>): number {
  return cases.filter((item) => {
    if (item.stage !== "結案核准" || !Array.isArray(item.approvalSteps)) return false;
    return item.approvalSteps.some(
      (step) => isRecord(step) && step.decision === "待審核",
    );
  }).length;
}
