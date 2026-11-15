/**
 * 儀表板顯示設定旗標。管理者的角色／職稱覆寫由 dashboardVisibility.ts
 * 解析；舊版全域 dashboardSections 與 resolveDashboardSections API 保留相容。
 */

export type DashboardSectionKey =
  | "monthlyTodo"
  | "nextMonthPreview"
  | "overdueLocked"
  | "unlockReview"
  | "lagLights"
  | "alert48h"
  | "focusIndicators"
  | "overAudit"
  | "personalTrend"
  | "weakTop3"
  | "unitAvg"
  | "pareto"
  | "trendAlerts"
  | "unitProgress"
  | "groupPassRate"
  | "overview"
  | "radar"
  | "redFlags"
  | "riskyUnits"
  | "capaPendingReview";

export type DashboardSections = Record<DashboardSectionKey, boolean>;

export const DASHBOARD_SECTION_KEYS: DashboardSectionKey[] = [
  "monthlyTodo",
  "nextMonthPreview",
  "overdueLocked",
  "unlockReview",
  "lagLights",
  "alert48h",
  "focusIndicators",
  "overAudit",
  "personalTrend",
  "weakTop3",
  "unitAvg",
  "pareto",
  "trendAlerts",
  "unitProgress",
  "groupPassRate",
  "overview",
  "radar",
  "redFlags",
  "riskyUnits",
  "capaPendingReview",
];

/** 未另行設定時延續既有預設；CAPA 摘要預設開啟但只用於護理長以上視角。 */
export const DEFAULT_DASHBOARD_SECTIONS: DashboardSections = {
  monthlyTodo: true,
  nextMonthPreview: true,
  overdueLocked: true,
  unlockReview: true,
  lagLights: true,
  alert48h: true,
  focusIndicators: true,
  overAudit: true,
  personalTrend: false,
  weakTop3: false,
  unitAvg: false,
  pareto: false,
  trendAlerts: false,
  unitProgress: true,
  groupPassRate: true,
  overview: true,
  radar: false,
  redFlags: false,
  riskyUnits: false,
  capaPendingReview: true,
};

/** 只收布林值、只收已知鍵；其餘一律忽略（設定檔寫錯也不炸版）。 */
export function parseDashboardSections(raw: unknown): Partial<DashboardSections> {
  const out: Partial<DashboardSections> = {};
  if (raw == null || typeof raw !== "object") return out;
  for (const k of DASHBOARD_SECTION_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

/** 舊 API 相容：預設 ← 管理員全域定義 ← 本機個人偏好。 */
export function resolveDashboardSections(
  admin?: unknown,
  personal?: unknown,
): DashboardSections {
  return {
    ...DEFAULT_DASHBOARD_SECTIONS,
    ...parseDashboardSections(admin),
    ...parseDashboardSections(personal),
  };
}

const PERSONAL_KEY = "qi-dashboard-sections";

/** 舊版本機偏好讀取 API 保留相容；儀表板頁面不再讓個人偏好覆蓋管理政策。 */
export function getPersonalDashboardSections(): Partial<DashboardSections> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(PERSONAL_KEY);
    if (!raw) return {};
    return parseDashboardSections(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}
