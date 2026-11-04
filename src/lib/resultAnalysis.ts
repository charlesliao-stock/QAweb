/**
 * 結果分析聚合邏輯（v1.13.0 新增）。
 * 純函式：平均正確率、RAG 燈號、月趨勢、資料範圍過濾、單位/指標統計，可單元測試。
 *
 * 資料歸屬一律依排程月份（reviewTasks 的 year/month）與單位代號；
 * reviewRecords 經由 taskId 歸屬到任務（舊格式單筆紀錄 taskId 即 doc id）。
 */
import { requiredCases } from "./reviewProgress";

/** RAG 燈號：達標綠／未達標紅／無資料灰 */
export type RagState = "green" | "red" | "gray";

export interface RateRecord {
  taskId: string;
  indicatorId: string;
  unitId: string;
  year: number;
  month: number;
  /** 單件正確率（%）；null＝該件無有效分數 */
  rate: number | null;
}

export interface AnalysisTask {
  id: string;
  indicatorId: string;
  unitId: string;
  reviewerId: string;
  year: number;
  month: number;
  caseCount: number | null;
}

/** 平均正確率：取非 null rate 的平均，四捨五入到小數 1 位；無有效值回 null */
export function avgRateOf(rates: (number | null)[]): number | null {
  const vals = rates.filter(
    (r): r is number => typeof r === "number" && !Number.isNaN(r),
  );
  if (vals.length === 0) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

/**
 * RAG 燈號：
 * - 無資料（avgRate 為 null）→ gray
 * - 閾值未設定（<=0）→ gray（只顯示正確率、不判燈）
 * - avgRate ≧ threshold → green；否則 red
 */
export function ragStatus(
  avgRate: number | null,
  threshold: number,
): RagState {
  if (avgRate == null) return "gray";
  if (!(threshold > 0)) return "gray";
  return avgRate >= threshold ? "green" : "red";
}

/** 月趨勢：某指標的各月份平均正確率（只含 rate 非 null 的月份，依月份排序） */
export function monthlyTrend(
  records: RateRecord[],
  indicatorId: string,
): { month: number; rate: number }[] {
  const byMonth = new Map<number, (number | null)[]>();
  for (const r of records) {
    if (r.indicatorId !== indicatorId) continue;
    const arr = byMonth.get(r.month);
    if (arr) arr.push(r.rate);
    else byMonth.set(r.month, [r.rate]);
  }
  const out: { month: number; rate: number }[] = [];
  for (const [month, rates] of [...byMonth.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const avg = avgRateOf(rates);
    if (avg != null) out.push({ month, rate: avg });
  }
  return out;
}

export type DataScope =
  | { kind: "admin" }
  | { kind: "reviewer"; staffId: string }
  | { kind: "staff"; unitCode: string };

/**
 * 資料範圍過濾：
 * - 管理員：全部
 * - 審查員：只看自己負責的單位（reviewTasks.reviewerId＝本人），紀錄經 taskId 歸屬
 * - 一般人員：只看自己單位（unitId＝本人 unitCode）
 */
export function filterByScope(
  tasks: AnalysisTask[],
  records: RateRecord[],
  scope: DataScope,
): { tasks: AnalysisTask[]; records: RateRecord[] } {
  if (scope.kind === "admin") return { tasks, records };
  const tids = new Set<string>();
  const ftasks = tasks.filter((t) => {
    const ok =
      scope.kind === "reviewer"
        ? t.reviewerId === scope.staffId
        : t.unitId === scope.unitCode;
    if (ok) tids.add(t.id);
    return ok;
  });
  const frecords = records.filter((r) => tids.has(r.taskId));
  return { tasks: ftasks, records: frecords };
}

export interface UnitMonthRow {
  unitId: string;
  /** 查看用：該單位該月第一筆 task id（查詢頁入口） */
  taskId: string;
  doneCount: number;
  required: number;
  avgRate: number | null;
  /** 完成：完成數 ≧ 應審件數（沿用 reviewProgress.isTaskComplete 語義） */
  complete: boolean;
  rag: RagState;
}

/** 某指標某年月的各單位列（依單位代號排序） */
export function unitMonthRows(
  tasks: AnalysisTask[],
  records: RateRecord[],
  indicatorId: string,
  year: number,
  month: number,
  threshold: number,
): UnitMonthRow[] {
  const unitOf = new Map<string, string>(); // taskId -> unitId
  const reqOf = new Map<string, number>(); // taskId -> 應審件數
  for (const t of tasks) {
    if (t.indicatorId !== indicatorId || t.year !== year || t.month !== month)
      continue;
    unitOf.set(t.id, t.unitId);
    reqOf.set(t.id, requiredCases(t.caseCount));
  }
  const agg = new Map<
    string,
    { taskIds: string[]; required: number; rates: (number | null)[]; count: number }
  >();
  const ensure = (u: string) => {
    let e = agg.get(u);
    if (!e) {
      e = { taskIds: [], required: 0, rates: [], count: 0 };
      agg.set(u, e);
    }
    return e;
  };
  for (const [tid, unit] of unitOf) {
    const e = ensure(unit);
    if (!e.taskIds.includes(tid)) e.taskIds.push(tid);
    e.required += reqOf.get(tid) ?? 0;
  }
  for (const r of records) {
    const unit = unitOf.get(r.taskId);
    if (unit == null) continue;
    const e = ensure(unit);
    e.count += 1;
    e.rates.push(r.rate);
  }
  return [...agg.entries()]
    .map(([unitId, e]) => {
      const avg = avgRateOf(e.rates);
      const complete = e.count >= e.required;
      return {
        unitId,
        taskId: e.taskIds[0] ?? "",
        doneCount: e.count,
        required: e.required,
        avgRate: avg,
        complete,
        rag: ragStatus(avg, threshold),
      };
    })
    .sort((a, b) => a.unitId.localeCompare(b.unitId, "zh-Hant"));
}

export interface IndicatorMonthStat {
  indicatorId: string;
  totalUnits: number;
  doneUnits: number;
  passUnits: number;
  /** 達標率＝達標單位數 ÷ 已完成單位數（%）；無已完成回 null */
  passRate: number | null;
  /** 燈號：無已完成→gray；全數達標→green；有未達標→red */
  rag: RagState;
}

/** 某年月的各指標達標統計 */
export function indicatorMonthStats(
  tasks: AnalysisTask[],
  records: RateRecord[],
  year: number,
  month: number,
  thresholds: Map<string, number>,
): IndicatorMonthStat[] {
  const ids = [
    ...new Set(
      tasks
        .filter((t) => t.year === year && t.month === month)
        .map((t) => t.indicatorId),
    ),
  ].sort();
  return ids.map((id) => {
    const threshold = thresholds.get(id) ?? 0;
    const rows = unitMonthRows(tasks, records, id, year, month, threshold);
    const done = rows.filter((r) => r.complete);
    // 無閾值：只顯示正確率、不判燈（達標率不計算、燈號灰）
    if (!(threshold > 0)) {
      return {
        indicatorId: id,
        totalUnits: rows.length,
        doneUnits: done.length,
        passUnits: 0,
        passRate: null,
        rag: "gray" as RagState,
      };
    }
    const pass = done.filter((r) => r.rag === "green");
    const passRate =
      done.length > 0 ? Math.round((pass.length / done.length) * 1000) / 10 : null;
    const rag: RagState =
      done.length === 0 ? "gray" : pass.length === done.length ? "green" : "red";
    return {
      indicatorId: id,
      totalUnits: rows.length,
      doneUnits: done.length,
      passUnits: pass.length,
      passRate,
      rag,
    };
  });
}
