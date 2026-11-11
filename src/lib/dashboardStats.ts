/**
 * 角色儀表板聚合邏輯（v1.15.0 新增）。
 * 純函式：個人趨勢／常犯缺失／48h 通報／落後燈號／柏拉圖／下滑警訊／雷達矩陣，
 * 可單元測試。
 */
import { avgRateOf, type RagState, type StatsCycle } from "./resultAnalysis";
import { requiredCases } from "./reviewProgress";
import { toCycleKey } from "./cycle";
import { todayStr } from "./scheduling";

/** 儀表板用的任務列（已含完成數） */
export interface DashTask {
  id: string;
  indicatorId: string;
  unitId: string;
  reviewerId: string;
  year: number;
  month: number;
  caseCount: number | null;
  deadline: string;
  status: "pending" | "done" | "locked";
  doneCount: number;
  quotaVersion?: 1;
  quotaGroupId?: string;
  quotaCategory?: "year" | "academic";
  quotaIntervalStartYear?: number;
  quotaIntervalStartMonth?: number;
  quotaIntervalEndYear?: number;
  quotaIntervalEndMonth?: number;
  /** 年度／學年度週期整個區間、同單位跨審查員共用的完成數。 */
  quotaDoneCount?: number;
  quotaDoneCountUnknown?: boolean;
  /**
   * v1.28 階段 2：鎖定／逾期任務的紀錄以 taskId in 查詢分批補（每批 30 個、
   * 上限 90 個任務）；超過上限者完成進度未知，畫面顯示「—」而非錯誤的 0。
   */
  doneCountUnknown?: boolean;
}

/** 任務狀態/配額進度使用 quota count；月度實際紀錄仍使用 doneCount。 */
export function taskProgressCount(
  task: Pick<
    DashTask,
    | "doneCount"
    | "doneCountUnknown"
    | "quotaGroupId"
    | "quotaDoneCount"
    | "quotaDoneCountUnknown"
  >,
): number | null {
  if (task.quotaGroupId) {
    return task.quotaDoneCountUnknown ? null : task.quotaDoneCount ?? null;
  }
  return task.doneCountUnknown ? null : task.doneCount;
}

export function taskProgressLabel(
  task: Pick<DashTask, "caseCount"> & Parameters<typeof taskProgressCount>[0],
): string {
  const count = taskProgressCount(task);
  return count == null ? "—" : `${count}/${requiredCases(task.caseCount)}`;
}

/** 儀表板用的逐件紀錄列 */
export interface DashRecord {
  id: string;
  taskId: string;
  indicatorId: string;
  unitId: string;
  year: number;
  month: number;
  reviewDate: string;
  reviewerName: string;
  reviewedPersonEmpNo: string;
  reviewedPersonName: string;
  rate: number | null;
  quotaGroupId?: string;
  source?: string;
  answers: {
    questionId: string;
    itemText: string;
    optionLabel: string;
    score: number;
    /** v1.17：不適用＝不計入（缺失統計需排除） */
    excluded?: boolean;
    note?: string;
  }[];
  submittedAt: unknown;
}

export function toDateSafe(ts: unknown): Date | null {
  try {
    const t = ts as { toDate?: unknown };
    if (t && typeof t.toDate === "function") {
      const d = (t.toDate as () => Date)();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00`);
  const db = new Date(`${b}T00:00:00`);
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

/* ---------- v1.28 階段 2：儀表板瘦身查詢窗口 ---------- */
export interface DashboardMonthWindow {
  curYear: number;
  curMonth: number;
  nextYear: number;
  nextMonth: number;
  prevYear: number;
  prevMonth: number;
  /** 48h 警示起點（毫秒時間戳；查詢 submittedAt >= 此值） */
  alertSinceMs: number;
}

/**
 * 瘦身查詢窗口：本月＋次月（任務）／本月＋48h（紀錄）。
 * 12 月→次年 1 月、1 月→上年 12 月的跨年邊界由這裡統一處理。
 */
export function dashboardMonthWindow(now: Date = new Date()): DashboardMonthWindow {
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;
  const nextYear = curMonth === 12 ? curYear + 1 : curYear;
  const nextMonth = curMonth === 12 ? 1 : curMonth + 1;
  const prevYear = curMonth === 1 ? curYear - 1 : curYear;
  const prevMonth = curMonth === 1 ? 12 : curMonth - 1;
  return {
    curYear,
    curMonth,
    nextYear,
    nextMonth,
    prevYear,
    prevMonth,
    alertSinceMs: now.getTime() - 48 * 3600 * 1000,
  };
}

/** 多來源任務合併（本月＋次月＋鎖定＋逾期）：依 id 去重，先出現者優先 */
export function mergeDashTasks(...lists: DashTask[][]): DashTask[] {
  const seen = new Map<string, DashTask>();
  for (const list of lists) {
    for (const t of list) {
      if (!seen.has(t.id)) seen.set(t.id, t);
    }
  }
  return [...seen.values()];
}

/** 紀錄依 taskId 計數（doneCount 來源；呼叫端先依紀錄 id 去重再傳入） */
export function countRecordsByTask(
  records: Pick<DashRecord, "taskId">[],
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of records) {
    m.set(r.taskId, (m.get(r.taskId) ?? 0) + 1);
  }
  return m;
}

/**
 * 按任務計數（含匯入紀錄，v1.47.0）：匯入紀錄 taskId 為空，改按
 * 「指標＋單位＋年月」身分鍵歸屬到對應任務。正式紀錄仍只按 taskId 計，
 * 避免同一指標同單位同月的另一任務紀錄被重複算入。
 */
export function countRecordsByTaskWithImports(
  records: Pick<
    DashRecord,
    "taskId" | "indicatorId" | "unitId" | "year" | "month" | "source"
  >[],
  tasks: Pick<DashTask, "id" | "indicatorId" | "unitId" | "year" | "month">[],
): Map<string, number> {
  const counts = countRecordsByTask(records);
  const tasksByKey = new Map<string, string[]>();
  for (const task of tasks) {
    const key = `${task.indicatorId}||${task.unitId}||${task.year}||${task.month}`;
    const list = tasksByKey.get(key) ?? [];
    list.push(task.id);
    tasksByKey.set(key, list);
  }
  for (const record of records) {
    if (record.source !== "import") continue;
    const key = `${record.indicatorId}||${record.unitId}||${record.year}||${record.month}`;
    const ids = tasksByKey.get(key);
    if (!ids) continue;
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/* ---------- 護理師：個人受審得分走勢（近 N 次） ---------- */
export function personalTrend(
  records: DashRecord[],
  empNo: string,
  n = 6,
): DashRecord[] {
  return records
    .filter((r) => r.reviewedPersonEmpNo === empNo && r.rate != null)
    .sort((a, b) => (b.reviewDate || "").localeCompare(a.reviewDate || ""))
    .slice(0, n);
}

/* ---------- 護理師：個人常犯扣分 Top3（依題目聚合 score=0；v1.17 起排除不適用） ---------- */
export interface WeakItem {
  itemText: string;
  miss: number;
  total: number;
}
export function weakTop3(records: DashRecord[], empNo: string): WeakItem[] {
  const map = new Map<string, WeakItem>();
  for (const r of records) {
    if (r.reviewedPersonEmpNo !== empNo) continue;
    for (const a of r.answers ?? []) {
      if (a.excluded) continue;
      const e = map.get(a.itemText) ?? {
        itemText: a.itemText,
        miss: 0,
        total: 0,
      };
      e.total += 1;
      if (a.score === 0) e.miss += 1;
      map.set(a.itemText, e);
    }
  }
  return [...map.values()]
    .filter((e) => e.miss > 0)
    .sort((a, b) => b.miss - a.miss || b.total - a.total)
    .slice(0, 3);
}

/* ---------- 護理長：48 小時內即時缺失紅字通報 ---------- */
export interface AlertItem {
  itemText: string;
  optionLabel: string;
  note: string;
}
export interface UnitAlert {
  recordId: string;
  indicatorId: string;
  reviewDate: string;
  reviewerName: string;
  items: AlertItem[];
}
export function recentAlerts(
  records: DashRecord[],
  unitId: string,
  hours: number,
  nowMs: number = Date.now(),
): UnitAlert[] {
  const out: UnitAlert[] = [];
  for (const r of records) {
    if (r.unitId !== unitId) continue;
    const d = toDateSafe(r.submittedAt);
    if (!d) continue;
    if (nowMs - d.getTime() > hours * 3600 * 1000) continue;
    const items = (r.answers ?? [])
      .filter((a) => a.score === 0 && !a.excluded)
      .map((a) => ({
        itemText: a.itemText,
        optionLabel: a.optionLabel,
        note: a.note ?? "",
      }));
    if (items.length > 0) {
      out.push({
        recordId: r.id,
        indicatorId: r.indicatorId,
        reviewDate: r.reviewDate,
        reviewerName: r.reviewerName,
        items,
      });
    }
  }
  return out;
}

/* ---------- 執行幹事：進度落後紅黃燈 ---------- */
export interface LagRow {
  task: DashTask;
  /** 完成度 0–1 */
  pct: number;
  level: "red" | "yellow";
}
/**
 * 截止日在 today 起 5 天內（含今天）、未完成未鎖定：
 * 完成度＜50% 紅燈、＜80% 黃燈。
 */
export function lagLights(
  tasks: DashTask[],
  today: string = todayStr(),
): LagRow[] {
  const out: LagRow[] = [];
  for (const t of tasks) {
    if (t.status !== "pending") continue;
    const diff = daysBetween(today, t.deadline);
    if (diff < 0 || diff > 5) continue;
    const doneCount = taskProgressCount(t);
    if (doneCount == null) continue;
    const req = requiredCases(t.caseCount);
    const pct = req > 0 ? doneCount / req : 1;
    if (pct >= 0.8) continue;
    out.push({ task: t, pct, level: pct < 0.5 ? "red" : "yellow" });
  }
  out.sort((a, b) => a.task.deadline.localeCompare(b.task.deadline));
  return out;
}

/* ---------- 召集人：扣分柏拉圖 Top3 ---------- */
export interface ParetoRow {
  itemText: string;
  count: number;
  /** 累積百分比（%） */
  cumPct: number;
}
export function paretoTop3(
  records: DashRecord[],
  indicatorIds?: Set<string>,
): ParetoRow[] {
  const map = new Map<string, number>();
  let total = 0;
  for (const r of records) {
    if (indicatorIds && !indicatorIds.has(r.indicatorId)) continue;
    for (const a of r.answers ?? []) {
      if (a.score === 0 && !a.excluded) {
        map.set(a.itemText, (map.get(a.itemText) ?? 0) + 1);
        total += 1;
      }
    }
  }
  const rows = [...map.entries()]
    .map(([itemText, count]) => ({ itemText, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  let cum = 0;
  return rows.map((r) => {
    cum += r.count;
    return {
      ...r,
      cumPct: total > 0 ? Math.round((cum / total) * 1000) / 10 : 0,
    };
  });
}

/* ---------- 督導／主任：單位月份平均 ---------- */
/**
 * 週期月標籤：cycle='year' → "2026-08"；'academic' → "115-08"
 *（toCycleKey 的學年度鍵＋月份）。
 */
export function cycleMonthLabel(
  year: number,
  month: number,
  cycle: StatsCycle,
): string {
  if (cycle === "academic") {
    return `${toCycleKey(year, month, "academic")}-${String(month).padStart(2, "0")}`;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

export interface UnitMonth {
  unitId: string;
  /** 年度 "YYYY-MM"／學年度 "115-08"（依 cycle） */
  ym: string;
  avg: number | null;
}
/**
 * 各單位各週期月的平均正確率。
 * yms 仍傳曆年月字串 "YYYY-MM"（與呼叫端既有寫法相容）；
 * 輸出的 ym 依 cycle 轉為週期標籤。
 */
export function unitMonthAvgs(
  records: DashRecord[],
  yms: string[],
  cycle: StatsCycle = "year",
): UnitMonth[] {
  const ymSet = new Set(yms);
  const map = new Map<string, (number | null)[]>();
  const labelOf = new Map<string, string>(); // 曆年月 → 輸出標籤
  for (const r of records) {
    const cal = `${r.year}-${String(r.month).padStart(2, "0")}`;
    if (!ymSet.has(cal)) continue;
    if (!labelOf.has(cal))
      labelOf.set(cal, cycleMonthLabel(r.year, r.month, cycle));
    const key = `${r.unitId}||${cal}`;
    const arr = map.get(key);
    if (arr) arr.push(r.rate);
    else map.set(key, [r.rate]);
  }
  return [...map.entries()].map(([key, rates]) => {
    const [unitId, cal] = key.split("||");
    return { unitId, ym: labelOf.get(cal) ?? cal, avg: avgRateOf(rates) };
  });
}

export interface DeclineAlert {
  unitId: string;
  kind: "decline" | "below";
  detail: string;
}
/**
 * 連續三個週期月下滑（m-2 > m-1 > m，皆有數值）或最新月未達標（avg < threshold）。
 * yms 需為連續三個週期月（由舊到新），其格式需與 rows 的 ym 一致
 *（年度 "YYYY-MM"／學年度 "115-08"，見 cycleMonthLabel）。
 */
export function declineAlerts(
  rows: UnitMonth[],
  yms: [string, string, string],
  threshold = 90,
): DeclineAlert[] {
  const byUnit = new Map<string, Map<string, number | null>>();
  for (const r of rows) {
    let m = byUnit.get(r.unitId);
    if (!m) {
      m = new Map();
      byUnit.set(r.unitId, m);
    }
    m.set(r.ym, r.avg);
  }
  const out: DeclineAlert[] = [];
  for (const [unitId, m] of byUnit) {
    const [a, b, c] = [m.get(yms[0]), m.get(yms[1]), m.get(yms[2])];
    if (a != null && b != null && c != null && a > b && b > c) {
      out.push({
        unitId,
        kind: "decline",
        detail: `連續三個週期月下滑（${a}% → ${b}% → ${c}%）`,
      });
    } else if (c != null && c < threshold) {
      out.push({ unitId, kind: "below", detail: `最新月平均 ${c}% 未達 ${threshold}%` });
    }
  }
  return out;
}

/* ---------- 主任：科部雷達矩陣 ---------- */
export interface RadarMatrix {
  /** 軸＝指標分類組別名稱 */
  axes: string[];
  /** 系列＝單位群組：每軸的平均正確率（無資料為 null） */
  series: { name: string; values: (number | null)[] }[];
}
/**
 * records 依「單位所屬群組 × 指標所屬組別」聚合平均正確率。
 * unitGroupOf：unitId → 群組名稱；indGroupOf：indicatorId → 組別名稱。
 */
export function radarMatrix(
  records: DashRecord[],
  unitGroupOf: Map<string, string>,
  indGroupOf: Map<string, string>,
): RadarMatrix {
  const axes = [...new Set(indGroupOf.values())].sort((a, b) =>
    a.localeCompare(b, "zh-Hant"),
  );
  const seriesNames = [...new Set(unitGroupOf.values())].sort((a, b) =>
    a.localeCompare(b, "zh-Hant"),
  );
  const buckets = new Map<string, (number | null)[]>();
  for (const r of records) {
    const ug = unitGroupOf.get(r.unitId);
    const ig = indGroupOf.get(r.indicatorId);
    if (!ug || !ig || r.rate == null) continue;
    const key = `${ug}||${ig}`;
    const arr = buckets.get(key);
    if (arr) arr.push(r.rate);
    else buckets.set(key, [r.rate]);
  }
  const series = seriesNames.map((name) => ({
    name,
    values: axes.map((ax) => avgRateOf(buckets.get(`${name}||${ax}`) ?? [])),
  }));
  return { axes, series };
}

/** 全院兩大平均（護理長頁籤）：人員平均符合率＝全部件平均正確率 */
export function staffAvgRate(records: DashRecord[]): number | null {
  return avgRateOf(records.map((r) => r.rate));
}

/** 單位達標率＝達標單位數 ÷ 總單位數（以各單位月平均 vs 閾值判定） */
export function unitPassRate(
  records: DashRecord[],
  thresholds: Map<string, number>,
): { pass: number; total: number; rate: number | null } {
  const byUnit = new Map<string, { rates: (number | null)[]; inds: Set<string> }>();
  for (const r of records) {
    let e = byUnit.get(r.unitId);
    if (!e) {
      e = { rates: [], inds: new Set() };
      byUnit.set(r.unitId, e);
    }
    e.rates.push(r.rate);
    e.inds.add(r.indicatorId);
  }
  let pass = 0;
  for (const e of byUnit.values()) {
    const avg = avgRateOf(e.rates);
    if (avg == null) continue;
    // 單位達標：其所有指標的月平均皆達各自閾值（簡化：取最低門檻比較）
    let ok = true;
    for (const ind of e.inds) {
      const th = thresholds.get(ind) ?? 0;
      if (th > 0 && avg < th) {
        ok = false;
        break;
      }
    }
    if (ok) pass += 1;
  }
  const total = byUnit.size;
  return {
    pass,
    total,
    rate: total > 0 ? Math.round((pass / total) * 1000) / 10 : null,
  };
}

/** RAG 燈號（沿用 resultAnalysis 語義）：達標綠／未達標紅／無資料灰 */
export type { RagState };
export function ragOf(avg: number | null, threshold: number): RagState {
  if (avg == null) return "gray";
  if (!(threshold > 0)) return "gray";
  return avg >= threshold ? "green" : "red";
}
