/**
 * 角色儀表板聚合邏輯（v1.15.0 新增）。
 * 純函式：個人趨勢／常犯缺失／48h 通報／落後燈號／柏拉圖／下滑警訊／雷達矩陣，
 * 可單元測試。
 */
import { avgRateOf, type RagState } from "./resultAnalysis";
import { requiredCases } from "./reviewProgress";
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
  answers: {
    questionId: string;
    itemText: string;
    optionLabel: string;
    score: number;
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

/* ---------- 護理師：個人常犯扣分 Top3（依題目聚合 score=0） ---------- */
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
      .filter((a) => a.score === 0)
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
    const req = requiredCases(t.caseCount);
    const pct = req > 0 ? t.doneCount / req : 1;
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
      if (a.score === 0) {
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
export interface UnitMonth {
  unitId: string;
  /** YYYY-MM */
  ym: string;
  avg: number | null;
}
export function unitMonthAvgs(
  records: DashRecord[],
  yms: string[],
): UnitMonth[] {
  const ymSet = new Set(yms);
  const map = new Map<string, (number | null)[]>();
  for (const r of records) {
    const ym = `${r.year}-${String(r.month).padStart(2, "0")}`;
    if (!ymSet.has(ym)) continue;
    const key = `${r.unitId}||${ym}`;
    const arr = map.get(key);
    if (arr) arr.push(r.rate);
    else map.set(key, [r.rate]);
  }
  return [...map.entries()].map(([key, rates]) => {
    const [unitId, ym] = key.split("||");
    return { unitId, ym, avg: avgRateOf(rates) };
  });
}

export interface DeclineAlert {
  unitId: string;
  kind: "decline" | "below";
  detail: string;
}
/**
 * 連續兩個月下滑（m-2 > m-1 > m，皆有數值）或最新月未達標（avg < threshold）。
 * yms 需為連續三個月（由舊到新）。
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
        detail: `連續三個月下滑（${a}% → ${b}% → ${c}%）`,
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
