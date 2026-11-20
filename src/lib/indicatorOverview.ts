/**
 * 指標總覽（Indicator Overview）純函式——不碰 Firestore、不碰 React。
 *
 * 取捨（2026-11-20 定案）：年份篩選只作為排程／審查／結果的年度上下文，
 * 不用來隱藏指標列——指標本身沒有年度生命週期（只有啟用／審核中／草稿
 * 狀態），按年份藏列會讓使用者誤以為指標被刪除；filterOverviewRows
 * 因此刻意不收 year 參數。
 */

export interface OverviewRow {
  /** Firestore 文件 ID（`${groupId}__${code}` 複合 ID） */
  id: string;
  code: string;
  name: string;
  groupId: string;
  groupName: string;
  /** 達標判定用閾值（基本資料閾值優先，缺值 fallback 主閾值） */
  threshold: number;
  status: string;
}

export type OverviewAction = "manage" | "schedule" | "audit" | "results" | "capa";

export const OVERVIEW_ACTION_LABELS: Record<OverviewAction, string> = {
  manage: "管理",
  schedule: "排程",
  audit: "審查",
  results: "結果",
  capa: "CAPA",
};

import type { PermKey } from "./permissions";

/** 五個操作各自沿用的現行 page 權限鍵（與 lib/permissions PAGE_PERMISSION_KEYS 一致）。 */
export const OVERVIEW_ACTION_PERMISSIONS: Record<OverviewAction, PermKey> = {
  manage: "page.indicators",
  schedule: "page.schedule",
  audit: "page.audit",
  results: "page.results",
  capa: "page.capa",
};

export function canShowOverviewAction(
  can: (key: PermKey) => boolean,
  action: OverviewAction,
): boolean {
  return can(OVERVIEW_ACTION_PERMISSIONS[action]);
}

/**
 * 總覽清單篩選：組別＋指標名稱／編號關鍵字。
 * 年份刻意不在此過濾（見檔頭取捨說明）。
 */
export function filterOverviewRows(
  rows: OverviewRow[],
  opts: { groupId: string; keyword: string },
): OverviewRow[] {
  const kw = opts.keyword.trim().toLowerCase();
  return rows.filter((row) => {
    if (opts.groupId && row.groupId !== opts.groupId) return false;
    if (!kw) return true;
    return (
      row.code.toLowerCase().includes(kw) ||
      row.name.toLowerCase().includes(kw)
    );
  });
}

/** 年份下拉選項：今年往前 2 年～往後 1 年（排程／結果的年度上下文用）。 */
export function overviewYearOptions(now: Date = new Date()): number[] {
  const y = now.getFullYear();
  return [y - 2, y - 1, y, y + 1];
}

/**
 * v1.88.33：總覽「結果」不再帶入該年全年。
 * 起迄改由結果分析頁的預設（Q5 系統設定：學年度 8 月～本月，年度 1 月～本月），
 * 見 src/features/results/model/defaults.ts defaultRangeForCycle。
 */

export function currentYearMonth(now: Date = new Date()): {
  year: number;
  month: number;
  key: string;
} {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  return { year, month, key: `${year}-${String(month).padStart(2, "0")}` };
}

/**
 * 當月有無審查排程：任一區間的 allMonths 含當月即有。
 * intervals 來自品管審查頁 ActiveRow.interval（reviewActive.ReviewInterval）。
 */
export function hasCurrentMonthSchedule(
  intervals: Array<{ allMonths: Array<{ year: number; month: number }> }>,
  now: Date = new Date(),
): boolean {
  const cur = currentYearMonth(now);
  return intervals.some((iv) =>
    iv.allMonths.some((m) => m.year === cur.year && m.month === cur.month),
  );
}

export type OverviewDestination =
  | { page: "indicators"; initialEditId: string }
  | { page: "schedule"; initial: { indicatorId: string; year: number } }
  | { page: "audit"; initialIndicatorId: string }
  | {
      page: "results";
      initial: { indicatorId: string };
    }
  | { page: "capa"; initialIndicatorId: string };

/** 五個入口的目的地參數（App.tsx 按此切頁並帶入各頁 initial prop）。 */
export function resolveOverviewDestination(
  action: OverviewAction,
  row: Pick<OverviewRow, "id">,
  year: number,
): OverviewDestination {
  switch (action) {
    case "manage":
      return { page: "indicators", initialEditId: row.id };
    case "schedule":
      return { page: "schedule", initial: { indicatorId: row.id, year } };
    case "audit":
      return { page: "audit", initialIndicatorId: row.id };
    case "results":
      return {
        page: "results",
        initial: { indicatorId: row.id },
      };
    case "capa":
      return { page: "capa", initialIndicatorId: row.id };
  }
}
