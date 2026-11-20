/**
 * 儀表板四群（v1.88.35 儀表板設定；取代 7 版變體的顯示分群）。
 * 純函式：依登入者職稱／角色決定所屬群、資料範圍與各群比率。
 * 不碰 Firestore，可在 node 直接單元測試。
 *
 * 四群（用戶 2026-11-20 定案）：
 * - 第 1 群：委員會各角色、部級各職稱（全院三率；督導範圍仍限轄區）
 * - 第 2 群：品管組召集人、執行幹事、組長；單位護理長／副護理長（單位四項）
 * - 第 3 群：品管組審查員（本人任務）
 * - 第 4 群：護理師（本人＋自己單位）
 * 未寫到的身分按 Q1-A 推導：系統管理員進第 1 群；單位召集人／執行幹事進
 * 第 2 群；單位審查員進第 3 群；單位組長／指標負責人／一般人員進第 4 群。
 * 多重身分沿用 VARIANT_ORDER 優先序映射到四群（最高者為準）。
 */

import {
  getDashboardVariants,
  type DashboardVariant,
} from "./dashboardVariant";
import {
  titleFlagsOf,
  type RoleMetaMap,
  type TitleFlags,
  type TitleMetaMap,
} from "./orgMeta";
import { avgRateOf, type StatsCycle } from "./resultAnalysis";
import { requiredCases } from "./reviewProgress";
import {
  taskProgressCount,
  type DashRecord,
  type DashTask,
} from "./dashboardStats";
import { pad2 } from "./ym";

export type DashboardGroup = "g1" | "g2" | "g3" | "g4";

export const DASHBOARD_GROUP_LABELS: Record<DashboardGroup, string> = {
  g1: "第 1 群",
  g2: "第 2 群",
  g3: "第 3 群",
  g4: "第 4 群",
};

export const DASHBOARD_GROUP_TITLES: Record<DashboardGroup, string> = {
  g1: "第 1 群 · 全院品質總覽",
  g2: "第 2 群 · 單位品質總覽",
  g3: "第 3 群 · 我的審查",
  g4: "第 4 群 · 單位重點與我的受審",
};

/** 變體 → 四群（委員會的召集人／執行幹事才進第 1 群，其餘進第 2 群）。 */
export function dashboardGroupForVariant(
  variant: DashboardVariant,
  isCommitteeRole: boolean,
  isGroupLeader: boolean,
): DashboardGroup {
  switch (variant) {
    case "director":
    case "supervisor":
      return "g1";
    case "headNurse":
      return "g2";
    case "officer":
    case "convener":
      return isCommitteeRole ? "g1" : "g2";
    case "reviewer":
      return "g3";
    case "nurse":
      return isGroupLeader ? "g2" : "g4";
  }
}

export interface GroupIdentityInput {
  roles: string[];
  title: string;
  titleId?: string;
  isAdmin: boolean;
  roleMeta?: RoleMetaMap;
  titleMeta?: TitleMetaMap;
  titleMetaById?: Map<string, TitleFlags>;
  /** 角色主檔：名稱 → 所屬層級 id（useOrgMeta 的 roleTargets）。 */
  roleLevelIdByName?: Map<string, string>;
  /** 層級：id → 層級名稱（useOrgMeta 的 roleLevels）。 */
  roleLevelNameById?: Map<string, string>;
}

const COMMITTEE_LEVEL_ID = "rl-committee";

/** 該角色是否為委員會層級（層級名稱＝委員會；無層級資料時退回名稱推導）。 */
export function isCommitteeRoleName(
  roleName: string,
  roleLevelIdByName?: Map<string, string>,
  roleLevelNameById?: Map<string, string>,
): boolean {
  const levelId = roleLevelIdByName?.get(roleName);
  if (levelId) {
    if (levelId === COMMITTEE_LEVEL_ID) return true;
    const levelName = roleLevelNameById?.get(levelId);
    if (levelName != null) return levelName === "委員會";
    return false;
  }
  return roleName.includes("委員會");
}

/** 依 VARIANT_ORDER 優先序取最高變體，再映射到四群。 */
export function dashboardGroupFor(input: GroupIdentityInput): DashboardGroup {
  if (input.isAdmin) return "g1";
  const variants = getDashboardVariants(
    {
      roles: input.roles,
      title: input.title,
      titleId: input.titleId,
      isAdmin: false,
    },
    {
      roleMeta: input.roleMeta,
      titleMeta: input.titleMeta,
      titleMetaById: input.titleMetaById,
    },
  );
  const first = variants[0] ?? "nurse";
  const isCommittee = (input.roles ?? []).some((r) =>
    isCommitteeRoleName(r, input.roleLevelIdByName, input.roleLevelNameById),
  );
  const isGroupLeader = (input.roles ?? []).some((r) => r.includes("組長"));
  return dashboardGroupForVariant(first, isCommittee, isGroupLeader);
}

/** 四群的資料範圍。g1 督導限轄區（titleUnitCodes）；其餘 g1 為全院。 */
export type DashboardScope =
  | { kind: "all" }
  | { kind: "units"; unitCodes: string[] }
  | { kind: "unit"; unitCode: string };

export function dashboardGroupScope(
  group: DashboardGroup,
  user: {
    title: string;
    titleId?: string;
    titleUnitCodes?: string[];
    unitCode?: string;
  },
  meta?: {
    titleMeta?: TitleMetaMap;
    titleMetaById?: Map<string, TitleFlags>;
  },
): DashboardScope {
  if (group === "g1") {
    const flags = titleFlagsOf(
      user.title ?? "",
      user.titleId,
      meta?.titleMeta,
      meta?.titleMetaById,
    );
    if (flags.isDistrictHead && !flags.isHospitalHead) {
      return { kind: "units", unitCodes: user.titleUnitCodes ?? [] };
    }
    return { kind: "all" };
  }
  // g2／g4 皆為「自己單位」；g3 用 staffId（審查任務）篩選，不用單位範圍。
  return { kind: "unit", unitCode: user.unitCode ?? "" };
}

/** 範圍內的單位代碼清單（null＝全院；空陣列＝未設定範圍）。 */
export function scopeUnitCodes(scope: DashboardScope): string[] | null {
  if (scope.kind === "all") return null;
  if (scope.kind === "units") return scope.unitCodes;
  return scope.unitCode ? [scope.unitCode] : [];
}

export interface RateResult {
  done: number;
  total: number;
  rate: number | null;
}

function rateOf(done: number, total: number): number | null {
  return total > 0 ? Math.round((done / total) * 1000) / 10 : null;
}

/** 週期配額任務去重（與 DirectorTab 相同：同一 quotaGroupId 只算一次）。 */
export function dedupeQuotaTasks(tasks: DashTask[]): DashTask[] {
  const seen = new Set<string>();
  return tasks.filter((task) => {
    if (!task.quotaGroupId) return true;
    if (seen.has(task.quotaGroupId)) return false;
    seen.add(task.quotaGroupId);
    return true;
  });
}

function inScopeUnit(task: DashTask, units: string[] | null): boolean {
  return units === null || units.includes(task.unitId);
}

/**
 * Q4：查核完成率＝已完成任務數／總任務數（本月；已完成＝進度達應審件數）。
 */
export function auditCompletionRate(
  tasks: DashTask[],
  year: number,
  month: number,
  scopeUnits: string[] | null,
): RateResult {
  const counted = dedupeQuotaTasks(
    tasks.filter(
      (t) => t.year === year && t.month === month && inScopeUnit(t, scopeUnits),
    ),
  );
  const done = counted.filter((task) => {
    const count = taskProgressCount(task);
    return count != null && count >= requiredCases(task.caseCount);
  }).length;
  return { done, total: counted.length, rate: rateOf(done, counted.length) };
}

/**
 * Q5／Q7b：單位達閾值率＝達閾值單位數／總審查單位數（本月）。
 * 每單位每指標月平均 vs 該指標閾值；一單位在其所有受審指標皆達閾值才算達標
 *（閾值 ≤0 的指標視為不達標，與結果分析「≤0 不達標」一致）。
 * 分母＝本月有紀錄的單位數。
 */
export function unitThresholdRate(
  records: DashRecord[],
  thresholds: Map<string, number>,
  year: number,
  month: number,
  scopeUnits: string[] | null,
): RateResult {
  // (單位, 指標) → rates
  const byPair = new Map<string, { unitId: string; rates: (number | null)[]; threshold: number }>();
  for (const r of records) {
    if (r.year !== year || r.month !== month) continue;
    if (scopeUnits !== null && !scopeUnits.includes(r.unitId)) continue;
    const key = `${r.unitId}||${r.indicatorId}`;
    const entry = byPair.get(key) ?? {
      unitId: r.unitId,
      rates: [],
      threshold: thresholds.get(r.indicatorId) ?? 0,
    };
    entry.rates.push(r.rate);
    byPair.set(key, entry);
  }
  const units = new Set<string>();
  const passUnits = new Set<string>();
  const unitPass = new Map<string, boolean>();
  for (const entry of byPair.values()) {
    units.add(entry.unitId);
    const avg = avgRateOf(entry.rates);
    const ok = avg != null && entry.threshold > 0 && avg >= entry.threshold;
    if (unitPass.get(entry.unitId) === false) continue;
    unitPass.set(entry.unitId, ok);
  }
  for (const [unitId, ok] of unitPass) if (ok) passUnits.add(unitId);
  return { done: passUnits.size, total: units.size, rate: rateOf(passUnits.size, units.size) };
}

/**
 * Q6：CAPA 完成率＝正式結案案件數／總案件數（累計；總件數不含已撤案）。
 * scopeUnits 為 null＝全院；否則只算 unitCode 在清單內的案件。
 */
export function capaCompletionRate(
  cases: Array<{ stage?: unknown; unitCode?: unknown }>,
  scopeUnits: string[] | null,
): RateResult {
  const scoped = cases.filter((c) => {
    if (c.stage === "已撤案") return false;
    if (scopeUnits === null) return true;
    return typeof c.unitCode === "string" && scopeUnits.includes(c.unitCode);
  });
  const done = scoped.filter((c) => c.stage === "正式結案").length;
  return { done, total: scoped.length, rate: rateOf(done, scoped.length) };
}

/** 次月待審指標數（Q8a）：次月任務的指標去重支數。 */
export function nextMonthDistinctIndicators(
  tasks: DashTask[],
  year: number,
  month: number,
  scopeUnits: string[] | null,
): number {
  const ids = new Set<string>();
  for (const t of tasks) {
    if (t.year !== year || t.month !== month) continue;
    if (!inScopeUnit(t, scopeUnits)) continue;
    if (t.indicatorId) ids.add(t.indicatorId);
  }
  return ids.size;
}

/** 依統計週期列出起迄月份（年度：今年 1 月～本月；學年度：本學年 8 月～本月）。 */
export function cycleMonths(
  cycle: StatsCycle,
  now: Date = new Date(),
): Array<{ year: number; month: number }> {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const startYear = cycle === "academic" ? (m >= 8 ? y : y - 1) : y;
  const startMonth = cycle === "academic" ? 8 : 1;
  const out: Array<{ year: number; month: number }> = [];
  let cy = startYear;
  let cm = startMonth;
  while (cy < y || (cy === y && cm <= m)) {
    out.push({ year: cy, month: cm });
    cm += 1;
    if (cm > 12) {
      cm = 1;
      cy += 1;
    }
  }
  return out;
}

export function cycleMonthKey(year: number, month: number): string {
  return `${year}-${pad2(month)}`;
}

/**
 * Q9：護理師被審查數／達閾值率（期間＝年度或學年度，依系統設定 statsCycle，
 * 至本月；被審查數＝該期間本人被審次數；達閾值率＝本人該期間 rate ≥ 各指標
 * 閾值的筆數／本人該期間總筆數）。
 */
export function myPeriodStats(
  records: DashRecord[],
  staffId: string,
  thresholds: Map<string, number>,
  cycle: StatsCycle,
  now: Date = new Date(),
): { count: number; pass: number; rate: number | null } {
  const wanted = new Set(
    cycleMonths(cycle, now).map((m) => cycleMonthKey(m.year, m.month)),
  );
  const mine = records.filter(
    (r) =>
      r.reviewedPersonEmpNo === staffId &&
      wanted.has(cycleMonthKey(r.year, r.month)),
  );
  const pass = mine.filter((r) => {
    const th = thresholds.get(r.indicatorId) ?? 0;
    return r.rate != null && th > 0 && r.rate >= th;
  }).length;
  return { count: mine.length, pass, rate: rateOf(pass, mine.length) };
}
