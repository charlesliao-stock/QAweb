/**
 * 儀表板顯示設定旗標（v1.28 階段 2：儀表板瘦身）。
 *
 * 瘦身版不刪除各頁籤程式，改用旗標開關：之後的「顯示設定」就是開關這些旗標。
 * 優先序：預設值 ← 管理員統一定義（systemParams/config 的 dashboardSections
 * 欄位） ← 個人偏好（本機 localStorage，沿用 uiPrefs.ts 模式）。
 * 這階段只留接口，不做設定 UI；管理員欄位與個人偏好皆為選填、缺值即用預設。
 *
 * 預設值（階段 2 定案，列入回報供糾正）：
 * 留：本月待辦、次月預告、逾期／鎖定、解鎖審核、落後燈號、48h 警示、
 *     本月重點指標、超額加審、轄區單位進度、組別達標率、全院戰情總覽。
 * 拿掉（改去結果分析看）：護理師個人走勢／常犯扣分 Top3、護理長單位 vs
 * 全院平均、督導近 3 個月趨勢、召集人帕累托 Top3、主任雷達圖／紅旗／高風險單位。
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
  | "riskyUnits";

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
];

/** 階段 2 預設：只留「本月任務提醒」相關區塊 */
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
};

/** 只收布林值、只收已知鍵；其餘一律忽略（設定檔寫錯也不炸版） */
export function parseDashboardSections(raw: unknown): Partial<DashboardSections> {
  const out: Partial<DashboardSections> = {};
  if (raw == null || typeof raw !== "object") return out;
  for (const k of DASHBOARD_SECTION_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

/** 預設 ← 管理員定義 ← 個人偏好 */
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

/** 個人偏好（本機 localStorage；無瀏覽器環境時回空物件） */
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
