/** 指標排程資料模型與共用邏輯（v1.8.0 新增） */

/** 月份快捷：一年 2 / 3 / 4 次，12 個月平均分配的起始月份 */
export const QUICK_MONTHS: Record<2 | 3 | 4, number[]> = {
  2: [1, 7],
  3: [1, 5, 9],
  4: [1, 4, 7, 10],
};

export const MONTH_LABELS = [
  "1月",
  "2月",
  "3月",
  "4月",
  "5月",
  "6月",
  "7月",
  "8月",
  "9月",
  "10月",
  "11月",
  "12月",
];

/** 審查員主檔（人員管理→審查員頁籤）：依指標分類組別分組 */
export interface ReviewReviewerDoc {
  /** 指標分類組別 id（即 groups collection 的 id） */
  groupId: string;
  /** 人員職編（users 文件 id） */
  personId: string;
  createdAt: unknown;
}

/** 審核排程設定（每支指標每年一份） */
export interface IndicatorYearSchedule {
  indicatorId: string;
  year: number;
  /** 審查起始月份（1-12，可複選） */
  months: number[];
  /** 一次涵蓋幾個月（1-3，顯示用） */
  monthsPerAudit: number;
  /** 該年度各單位每輪審查件數（v1.10.0 起：件數改在年度排程設定；key＝單位代碼） */
  unitCaseCounts: Record<string, number>;
  notes: string;
  updatedAt: unknown;
}

/**
 * 防禦性解析年度排程的 unitCaseCounts（只接受 ≥1 整數）。
 */
export function parseUnitCaseCounts(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isInteger(v) && v >= 1) out[k] = v;
    }
  }
  return out;
}

/**
 * 年度件數表單初值（字串 map，供數字輸入框用）。
 * 遷移貼心做法：若該年度 unitCaseCounts 為空，但分工表舊資料有 caseCount，
 * 自動帶入作預設值（僅初次開啟時，存檔後即寫入年度設定）。
 */
export function initialUnitCaseCounts(
  schedule: { unitCaseCounts?: Record<string, number> } | null | undefined,
  assignment: { items: AssignmentItem[] } | null | undefined,
): Record<string, string> {
  const cur = schedule?.unitCaseCounts;
  if (cur && Object.keys(cur).length > 0) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(cur)) out[k] = String(v);
    return out;
  }
  const out: Record<string, string> = {};
  assignment?.items.forEach((it) =>
    it.units.forEach((u) => {
      if (u.caseCount != null && !(u.unitId in out))
        out[u.unitId] = String(u.caseCount);
    }),
  );
  return out;
}

/**
 * 表單字串 map → 儲存用數字 map（只保留 ≥1 整數；空白或非法即省略）。
 */
export function toUnitCaseCounts(
  raw: Record<string, string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const t = (v ?? "").trim();
    if (t !== "" && /^\d+$/.test(t) && Number(t) >= 1) out[k] = Number(t);
  }
  return out;
}

/** 分工表：一位審查員負責的單位＋每輪審查件數（v1.9.0） */
export interface AssignedUnit {
  /** 單位代碼（units 文件 id） */
  unitId: string;
  /** 每輪審查件數；null＝未設定 */
  caseCount: number | null;
}

/** 分工表項目：一位審查員 → 負責單位清單（含每輪件數） */
export interface AssignmentItem {
  /** 審查員職編 */
  reviewerId: string;
  units: AssignedUnit[];
}

/**
 * 分工表項目正規化（含舊格式相容）。
 * v1.8.0 舊格式 {reviewerId, unitIds: string[]} 會自動轉為件數 null 的新格式。
 */
export function normalizeAssignmentItem(raw: unknown): AssignmentItem | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const reviewerId = typeof r.reviewerId === "string" ? r.reviewerId : "";
  if (!reviewerId) return null;
  let units: AssignedUnit[] = [];
  if (Array.isArray(r.units)) {
    units = r.units
      .map((u) => {
        const o = (u ?? {}) as Record<string, unknown>;
        const unitId = typeof o.unitId === "string" ? o.unitId : "";
        if (!unitId) return null;
        const cc = o.caseCount;
        const caseCount =
          typeof cc === "number" && Number.isInteger(cc) && cc >= 1
            ? cc
            : null;
        return { unitId, caseCount };
      })
      .filter((u): u is AssignedUnit => u !== null);
  } else if (Array.isArray(r.unitIds)) {
    units = (r.unitIds as unknown[])
      .filter((u): u is string => typeof u === "string")
      .map((unitId) => ({ unitId, caseCount: null as number | null }));
  }
  return { reviewerId, units };
}

/** 單位／審查員設定（每支指標一份，不分年度） */
export interface IndicatorAssignment {
  indicatorId: string;
  items: AssignmentItem[];
  updatedAt: unknown;
}

export type ReviewTaskStatus = "pending" | "done";

/** 審查任務（由「產生排程」展開：年度 months × 分工表配對） */
export interface ReviewTask {
  indicatorId: string;
  year: number;
  month: number;
  unitId: string;
  reviewerId: string;
  /** 每輪審查件數（產生時自該年度 unitCaseCounts 快照；null＝未設定） */
  caseCount: number | null;
  /** 截止日 YYYY-MM-DD（審查月份次月＋系統參數「補審截止（次月幾日）」） */
  deadline: string;
  status: ReviewTaskStatus;
  completedAt: unknown;
  createdAt: unknown;
}

export function todayStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * 截止日＝審查月份的次月第 day 日；12 月→隔年 1 月。
 * day 超過該月天數時取該月最後一日。
 */
export function deadlineFor(year: number, month: number, day: number): string {
  let y = year;
  let m = month + 1;
  if (m > 12) {
    m = 1;
    y += 1;
  }
  const lastDay = new Date(y, m, 0).getDate();
  const d = Math.min(Math.max(day, 1), lastDay);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function isOverdue(deadline: string, status: ReviewTaskStatus): boolean {
  return status !== "done" && deadline < todayStr();
}

export function reviewerDocId(groupId: string, personId: string): string {
  return `${groupId}__${personId}`;
}

export function yearScheduleDocId(indicatorId: string, year: number): string {
  return `${indicatorId}__${year}`;
}

/**
 * 找出被 2 位以上審查員選中的單位（重複指派警示用）。
 * 回傳：單位代碼 → 選中它的審查員職編清單。
 */
export function findDuplicateUnits(
  items: AssignmentItem[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const it of items) {
    for (const u of it.units) {
      const arr = map.get(u.unitId) ?? [];
      if (!arr.includes(it.reviewerId)) arr.push(it.reviewerId);
      map.set(u.unitId, arr);
    }
  }
  const dup = new Map<string, string[]>();
  for (const [u, arr] of map) {
    if (arr.length > 1) dup.set(u, arr);
  }
  return dup;
}

/** 展開任務筆數預估：月份數 × 所有 (審查員, 單位) 配對數 */
export function estimateTaskCount(
  months: number[],
  items: AssignmentItem[],
): number {
  const pairs = items.reduce((n, it) => n + it.units.length, 0);
  return months.length * pairs;
}

export interface GenerateInput {
  indicatorId: string;
  year: number;
  months: number[];
  items: AssignmentItem[];
  /** 該年度各單位每輪審查件數（v1.10.0；key＝單位代碼） */
  unitCaseCounts?: Record<string, number>;
  /** 系統參數「補審截止（次月幾日）」 */
  deadlineDay: number;
}

/**
 * 展開全年審查任務（純函式，可單元測試）。
 * 每（月份 × 審查員 × 單位）一筆，截止日＝次月 deadlineDay 日，
 * 件數取自該年度 unitCaseCounts（未設則 null；不再讀分工表 caseCount）。
 */
export function buildReviewTasks(
  input: GenerateInput,
): Omit<ReviewTask, "createdAt" | "completedAt">[] {
  const tasks: Omit<ReviewTask, "createdAt" | "completedAt">[] = [];
  for (const month of input.months) {
    for (const it of input.items) {
      for (const u of it.units) {
        tasks.push({
          indicatorId: input.indicatorId,
          year: input.year,
          month,
          unitId: u.unitId,
          reviewerId: it.reviewerId,
          caseCount: input.unitCaseCounts?.[u.unitId] ?? null,
          deadline: deadlineFor(input.year, month, input.deadlineDay),
          status: "pending",
        });
      }
    }
  }
  return tasks;
}

/** 預估全年總件數：月份數 × 各單位件數合計（未設定不計） */
export function estimateTotalCases(
  months: number[],
  unitCaseCounts: Record<string, number>,
): number {
  const perRound = Object.values(unitCaseCounts).reduce((n, v) => n + v, 0);
  return months.length * perRound;
}
