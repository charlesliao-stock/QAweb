/** 指標排程資料模型與共用邏輯（v1.8.0 新增；v1.16.0 新增三類別排程） */
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from "./db";
import { logAudit } from "./audit";
import { isReviewerRole } from "./roleIdentity";
import {
  categoryLabel,
  monthToCalendarYear,
  periodLabel,
  type CycleCategory,
} from "./cycle";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** 月份快捷：一年 2 / 3 / 4 次，12 個月平均分配的起始月份（v1.18 前 UI 用；保留供舊資料相容） */
export const QUICK_MONTHS: Record<2 | 3 | 4, number[]> = {
  2: [1, 7],
  3: [1, 5, 9],
  4: [1, 4, 7, 10],
};

/** 審查頻次：一年幾次（v1.18 排程設定下拉） */
export type ReviewFrequency = 2 | 3 | 4;
/**
 * 審查區間：每次審查連續涵蓋幾個月。
 * v1.18 由下拉選 2／3／4；v1.20 起由頻次衍生（12／頻次：2次→6、3次→4、4次→3），
 * 舊資料可能存 2，解析時一併接受。
 */
export type ReviewInterval = 2 | 3 | 4 | 6;

export const FREQUENCY_OPTIONS: ReviewFrequency[] = [2, 3, 4];

/** 預設審查頻次（v1.18：季審） */
export const DEFAULT_FREQUENCY: ReviewFrequency = 4;

/** 頻次 → 每次間隔月數（12 個月平分；v1.20） */
export function intervalMonthsForFrequency(f: ReviewFrequency): ReviewInterval {
  return (12 / f) as ReviewInterval;
}

export function frequencyLabel(f: ReviewFrequency): string {
  return `${f}次/年`;
}
export function intervalLabel(m: ReviewInterval): string {
  return `${m}個月`;
}

/** 防禦性解析頻次（只接受 2／3／4） */
export function parseFrequency(raw: unknown): ReviewFrequency | null {
  return raw === 2 || raw === 3 || raw === 4 ? raw : null;
}

/** 防禦性解析區間（接受 2／3／4／6；6 為 v1.20 頻次衍生值） */
export function parseIntervalMonths(raw: unknown): ReviewInterval | null {
  return raw === 2 || raw === 3 || raw === 4 || raw === 6 ? raw : null;
}

/** 年份篩選選項：2024～2033（v1.18） */
export const YEAR_FILTER_OPTIONS: number[] = Array.from(
  { length: 10 },
  (_, i) => 2024 + i,
);

/** 年份選項顯示：「2024 (113)」（西元年＋民國年） */
export function yearOptionLabel(year: number): string {
  return `${year} (${year - 1911})`;
}

/**
 * 篩選器（年份＋年別）→ 排程週期鍵（v1.18）。
 * 年度→西元年字串；學年度→民國學年字串（該年 8 月起算的新學年）。
 */
export function periodForFilter(
  cycle: "year" | "academic",
  year: number,
): string {
  return cycle === "academic" ? String(year - 1911) : String(year);
}

/**
 * 依頻次自動預選起始月份（v1.20，純函式）：12 個月依頻次平分。
 * 從週期月份序列第 0 個起，每隔 12／頻次 取一個，共 frequency 個。
 * 年度：[1..12] 從 1 月起（2次→[1,7]、3次→[1,5,9]、4次→[1,4,7,10]）；
 * 學年度：[8..12,1..7] 從 8 月起（2次→[8,2]、3次→[8,12,4]、4次→[8,11,2,5]）。
 * 回傳依曆月排序（1–12）。
 */
export function autoSelectMonths(
  frequency: ReviewFrequency,
  monthOrder: number[],
): number[] {
  if (monthOrder.length === 0) return [];
  const step = 12 / frequency;
  const out: number[] = [];
  for (let i = 0; i < frequency; i++) {
    out.push(monthOrder[(i * step) % monthOrder.length]);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * 排程／單位設定是否完成（v1.18）：受審單位≥1、月份≥1、審查件數>0。
 * 「已排」燈號與「產生排程」啟用條件共用此判定。
 */
export function scheduleSetupComplete(
  s: {
    unitIds?: unknown;
    months?: unknown;
    caseCount?: unknown;
  } | null,
): boolean {
  if (!s) return false;
  const units = Array.isArray(s.unitIds) ? s.unitIds : [];
  const months = Array.isArray(s.months) ? s.months : [];
  const cc = s.caseCount;
  return (
    units.length > 0 &&
    months.length > 0 &&
    typeof cc === "number" &&
    Number.isInteger(cc) &&
    cc > 0
  );
}

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

/**
 * 審核排程設定（每支指標每年一份；v1.16.0 起改用 IndicatorSchedule，
 * 本介面僅供舊資料相容讀取）。
 * @deprecated 改用 IndicatorSchedule（三類別：年度／學年度／臨時）
 */
export interface IndicatorYearSchedule {
  indicatorId: string;
  year: number;
  /** 審查起始月份（1-12，可複選） */
  months: number[];
  /** 一次涵蓋幾個月（1-3，顯示用） */
  monthsPerAudit: number;
  /** 該年度審查件數（v1.10.1 起：全單位共用單一值；null＝未設定） */
  caseCount: number | null;
  /**
   * 該年度各單位每輪審查件數（v1.10.0 舊格式；保留欄位供舊資料相容，
   * v1.10.1 起 UI 與產生任務皆改讀 caseCount，不再寫入此欄）
   * key＝單位代碼
   */
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
 * 防禦性解析單一審查件數（只接受 ≥1 整數，否則 null）。
 */
export function parseCaseCount(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1
    ? raw
    : null;
}

/**
 * 年度件數表單初值（字串，供數字輸入框用）。
 * 遷移順序：caseCount → 舊 unitCaseCounts 第一個值 → 分工表舊 caseCount 第一個值 → ""。
 * （v1.10.0 的每單位表格是過度設計；使用者確認全單位件數相同，v1.10.1 起改單一值。）
 */
export function initialCaseCount(
  schedule:
    | {
        caseCount?: number | null;
        unitCaseCounts?: Record<string, number>;
      }
    | null
    | undefined,
  assignment: { items: AssignmentItem[] } | null | undefined,
): string {
  if (schedule?.caseCount != null && schedule.caseCount >= 1)
    return String(schedule.caseCount);
  const ucc = schedule?.unitCaseCounts;
  if (ucc) {
    const first = Object.values(ucc).find(
      (v) => typeof v === "number" && Number.isInteger(v) && v >= 1,
    );
    if (first != null) return String(first);
  }
  for (const it of assignment?.items ?? []) {
    for (const u of it.units) {
      if (u.caseCount != null) return String(u.caseCount);
    }
  }
  return "";
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

export type ReviewTaskStatus = "pending" | "done" | "locked";

/** 解鎖申請（v1.15.0 新增集合 unlockRequests） */
export interface UnlockRequest {
  taskId: string;
  indicatorId: string;
  unitId: string;
  year: number;
  month: number;
  requestedBy: string;
  requestedByName: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  handledBy?: string;
  handledAt?: unknown;
  createdAt?: unknown;
}

/** 解鎖申請 doc id：taskId__unlock_<隨機>（一任務可多次申請，以時間區分） */
export function unlockRequestDocId(taskId: string): string {
  return `${taskId}__unlock_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 是否應鎖定（v1.15.0）：今天已超過截止日（次月10日，吃系統參數快照的 deadline）
 * 且任務未完成 → locked。純函式可單元測試。
 */
export function shouldLockTask(
  deadline: string,
  status: ReviewTaskStatus,
  today: string = todayStr(),
): boolean {
  return status !== "done" && status !== "locked" && deadline < today;
}

/** 審查任務（由「產生排程」展開：年度 months × 分工表配對） */
export interface ReviewTask {
  indicatorId: string;
  year: number;
  month: number;
  unitId: string;
  reviewerId: string;
  /** 每輪審查件數（產生時自該年度單一 caseCount 快照；null＝未設定） */
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

/** 審查員自動連動用的「未分類」組別代號（v1.12.0，非真實群組） */
export const UNCATEGORIZED_GROUP_ID = "__uncategorized__";

/**
 * 人員儲存時是否應自動加入審查員名單（純函式）：roles 含任一審查員身分。
 * 移除角色時，同步移除自動加入的「未分類」審查員（手動指派的不動）。
 * v1.21：新舊審查員角色並認（審查員／品管組審查員／單位審查員）。
 */
export function shouldAutoLinkReviewer(roles: string[]): boolean {
  return isReviewerRole(roles);
}

/**
 * @deprecated 改用 scheduleDocId(indicatorId, category, period)
 */
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

/**
 * @deprecated 改用 buildReviewTasksPerCalendar（經 monthToCalendarYear 換算）或 buildTasksFromSchedule
 */
export interface GenerateInput {
  indicatorId: string;
  year: number;
  months: number[];
  items: AssignmentItem[];
  /** 該年度審查件數（v1.10.1 起單一值，全單位共用；null＝未設定） */
  caseCount?: number | null;
  /** 系統參數「補審截止（次月幾日）」 */
  deadlineDay: number;
}

/**
 * 展開全年審查任務（純函式，可單元測試）。
 * @deprecated v1.16.0：跨年週期（學年度）請改用 buildTasksFromSchedule
 *（內部按曆年分組後仍呼叫本函式，reviewTasks 欄位結構不變）
 * 每（月份 × 審查員 × 單位）一筆，截止日＝次月 deadlineDay 日，
 * 件數為該年度單一值快照（未設則 null）。
 * 注意：重建時已完成（done）的任務由呼叫端保留（不得刪除或覆寫），
 * 此處只負責產生新任務；只有 pending 任務會被刪除重建。
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
          caseCount: input.caseCount ?? null,
          deadline: deadlineFor(input.year, month, input.deadlineDay),
          status: "pending",
        });
      }
    }
  }
  return tasks;
}

/** 預估全年總件數：任務筆數 × 單一審查件數（未設定則 0） */
export function estimateTotalCases(
  taskCount: number,
  caseCount: number | null,
): number {
  return caseCount != null ? taskCount * caseCount : 0;
}

/* =====================================================================
 * v1.16.0：三類別排程（年度／學年度／臨時）
 * ===================================================================== */

/** 排程類別（與 cycle.ts 的 CycleCategory 同一聯集） */
export type ScheduleCategory = CycleCategory;

/**
 * 指標排程（v1.16.0，新集合 indicatorSchedules；一列＝一支指標＋一個類別）。
 * doc id：scheduleDocId(indicatorId, category, period)
 */
export interface IndicatorSchedule {
  indicatorId: string;
  category: ScheduleCategory;
  /** 週期鍵：年度＝西元年字串（如 "2026"）；學年度＝民國學年字串（如 "115"）；臨時＝建立時間戳字串 */
  period: string;
  /** 顯示標籤：「2026年度」／「115學年度」／「臨時」 */
  periodLabel: string;
  /** 審查起始月份（1–12，可複選） */
  months: number[];
  /** 審查頻次：一年幾次（v1.18；null＝未設定／舊資料） */
  frequency: ReviewFrequency | null;
  /** 審查區間：每次審查連續涵蓋幾個月（v1.18；null＝未設定／舊資料） */
  intervalMonths: ReviewInterval | null;
  /** 關聯年份（臨時排程用，v1.18；null＝未設定） */
  refYear: number | null;
  /** 每輪審查件數（全單位共用單一值；null＝未設定） */
  caseCount: number | null;
  /** 受審單位 id 清單（各組複選／全選） */
  unitIds: string[];
  notes: string;
  /** 自審（護理長為自己單位審查） */
  selfReview: boolean;
  /** 最後編輯人員職編 */
  updatedBy: string;
  /** 最後編輯人員姓名（快照） */
  updatedByName: string;
  updatedAt: unknown;
}

/** 排程文件 id：`{indicatorId}__{category}__{period}` */
export function scheduleDocId(
  indicatorId: string,
  category: ScheduleCategory,
  period: string,
): string {
  return `${indicatorId}__${category}__${period}`;
}

/** 防禦性解析類別（只接受 year／academic／temp） */
export function parseScheduleCategory(raw: unknown): ScheduleCategory | null {
  return raw === "year" || raw === "academic" || raw === "temp" ? raw : null;
}

/** 防禦性解析月份陣列（只接受 1–12 整數，排序去重） */
export function parseScheduleMonths(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const set = new Set<number>();
  for (const m of raw) {
    if (typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= 12) {
      set.add(m);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * 防禦性解析排程文件（純函式，可單元測試）。
 * indicatorId／category／period 任一缺失 → null。
 */
export function parseIndicatorSchedule(raw: unknown): IndicatorSchedule | null {
  const d = (raw ?? {}) as Record<string, unknown>;
  const indicatorId = typeof d.indicatorId === "string" ? d.indicatorId : "";
  const category = parseScheduleCategory(d.category);
  const period = typeof d.period === "string" ? d.period : "";
  if (!indicatorId || !category || !period) return null;
  const unitIds = Array.isArray(d.unitIds)
    ? (d.unitIds as unknown[]).filter((u): u is string => typeof u === "string")
    : [];
  return {
    indicatorId,
    category,
    period,
    periodLabel:
      typeof d.periodLabel === "string" && d.periodLabel
        ? d.periodLabel
        : periodLabel(category, period),
    months: parseScheduleMonths(d.months),
    frequency: parseFrequency(d.frequency),
    intervalMonths: parseIntervalMonths(d.intervalMonths),
    refYear:
      typeof d.refYear === "number" && Number.isInteger(d.refYear)
        ? d.refYear
        : null,
    caseCount: parseCaseCount(d.caseCount),
    unitIds,
    notes: typeof d.notes === "string" ? d.notes : "",
    selfReview: d.selfReview === true,
    updatedBy: typeof d.updatedBy === "string" ? d.updatedBy : "",
    updatedByName: typeof d.updatedByName === "string" ? d.updatedByName : "",
    updatedAt: d.updatedAt,
  };
}

/**
 * 舊集合 indicatorYearSchedules（docId `{indicatorId}__{year}`）→
 * 新 IndicatorSchedule 相容物件（category:'year', period:String(year)）。
 * 純函式，可單元測試。
 */
export function legacyYearScheduleToIndicatorSchedule(
  raw: unknown,
): IndicatorSchedule | null {
  const d = (raw ?? {}) as Record<string, unknown>;
  const indicatorId = typeof d.indicatorId === "string" ? d.indicatorId : "";
  const year = typeof d.year === "number" ? d.year : 0;
  if (!indicatorId || !year) return null;
  const period = String(year);
  return {
    indicatorId,
    category: "year",
    period,
    periodLabel: periodLabel("year", period),
    months: parseScheduleMonths(d.months),
    frequency: null,
    intervalMonths: null,
    refYear: null,
    caseCount: parseCaseCount(d.caseCount),
    unitIds: [],
    notes: typeof d.notes === "string" ? d.notes : "",
    selfReview: false,
    updatedBy: "",
    updatedByName: "",
    updatedAt: d.updatedAt,
  };
}

/** 排程稽核：fire-and-forget，不擋主流程 */
function auditSchedule(
  db: any,
  actor: { id: string; name: string },
  action: string,
  sched: IndicatorSchedule,
  detail = "",
): void {
  logAudit(db, {
    actor: actor.id,
    actorName: actor.name,
    action,
    targetType: "schedule",
    targetId: scheduleDocId(sched.indicatorId, sched.category, sched.period),
    detail:
      detail ||
      `${sched.indicatorId}・${sched.periodLabel}・${categoryLabel(sched.category)}`,
  });
}

/**
 * 列出全部排程：讀新集合 indicatorSchedules，
 * 另讀舊集合 indicatorYearSchedules 轉為相容物件；
 * 兩邊同 indicatorId＋year 重複時以新集合為準。
 */
export async function listSchedules(db: any): Promise<IndicatorSchedule[]> {
  const [newSnap, oldSnap] = await Promise.all([
    getDocs(collection(db, "indicatorSchedules")),
    getDocs(collection(db, "indicatorYearSchedules")),
  ]);
  const byId = new Map<string, IndicatorSchedule>();
  newSnap.docs.forEach((d) => {
    const s = parseIndicatorSchedule(d.data());
    if (s) byId.set(scheduleDocId(s.indicatorId, s.category, s.period), s);
  });
  oldSnap.docs.forEach((d) => {
    const s = legacyYearScheduleToIndicatorSchedule(d.data());
    if (!s) return;
    const id = scheduleDocId(s.indicatorId, s.category, s.period);
    if (!byId.has(id)) byId.set(id, s); // 新集合優先，舊資料只補缺
  });
  return [...byId.values()].sort((a, b) =>
    a.indicatorId.localeCompare(b.indicatorId, "zh-Hant") ||
    a.category.localeCompare(b.category) ||
    a.period.localeCompare(b.period, undefined, { numeric: true }),
  );
}

/**
 * 讀取單一排程；category:'year' 時若新集合無資料，
 * 回退讀舊集合 indicatorYearSchedules（docId `{indicatorId}__{year}`）。
 */
export async function getSchedule(
  db: any,
  indicatorId: string,
  category: ScheduleCategory,
  period: string,
): Promise<IndicatorSchedule | null> {
  const snap = await getDoc(
    doc(db, "indicatorSchedules", scheduleDocId(indicatorId, category, period)),
  );
  if (snap.exists()) return parseIndicatorSchedule(snap.data());
  if (category === "year") {
    const legacy = await getDoc(
      doc(db, "indicatorYearSchedules", yearScheduleDocId(indicatorId, Number(period))),
    );
    if (legacy.exists()) {
      return legacyYearScheduleToIndicatorSchedule(legacy.data());
    }
  }
  return null;
}

/**
 * 儲存排程（setDoc merge，寫 updatedBy／updatedByName／updatedAt）。
 * 依文件是否存在自動判別「建立排程」或「修訂排程」，稽核 fire-and-forget。
 */
export async function saveSchedule(
  db: any,
  sched: IndicatorSchedule,
  actor: { id: string; name: string },
): Promise<void> {
  const ref = doc(
    db,
    "indicatorSchedules",
    scheduleDocId(sched.indicatorId, sched.category, sched.period),
  );
  const existed = (await getDoc(ref)).exists();
  await setDoc(
    ref,
    {
      indicatorId: sched.indicatorId,
      category: sched.category,
      period: sched.period,
      periodLabel: periodLabel(sched.category, sched.period),
      months: parseScheduleMonths(sched.months),
      frequency: parseFrequency(sched.frequency),
      intervalMonths: parseIntervalMonths(sched.intervalMonths),
      refYear:
        typeof sched.refYear === "number" && Number.isInteger(sched.refYear)
          ? sched.refYear
          : null,
      caseCount: parseCaseCount(sched.caseCount),
      unitIds: sched.unitIds.filter((u) => typeof u === "string"),
      notes: sched.notes ?? "",
      selfReview: sched.selfReview === true,
      updatedBy: actor.id,
      updatedByName: actor.name,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
  auditSchedule(db, actor, existed ? "修訂排程" : "建立排程", sched);
}

/**
 * 刪除排程（audit「刪除排程」；已產生的任務不受影響）。
 */
export async function deleteSchedule(
  db: any,
  indicatorId: string,
  category: ScheduleCategory,
  period: string,
  actor: { id: string; name: string },
): Promise<void> {
  await deleteDoc(
    doc(db, "indicatorSchedules", scheduleDocId(indicatorId, category, period)),
  );
  auditSchedule(
    db,
    actor,
    "刪除排程",
    {
      indicatorId,
      category,
      period,
      periodLabel: periodLabel(category, period),
      months: [],
      frequency: null,
      intervalMonths: null,
      refYear: null,
      caseCount: null,
      unitIds: [],
      notes: "",
      selfReview: false,
      updatedBy: actor.id,
      updatedByName: actor.name,
      updatedAt: null,
    },
  );
}

/**
 * 前一期週期鍵（純函式）：year／academic 取 period−1；temp 回 null。
 */
export function previousPeriodKey(
  category: ScheduleCategory,
  period: string,
): string | null {
  if (category === "temp") return null;
  const p = parseInt(period, 10);
  return Number.isFinite(p) ? String(p - 1) : null;
}

/** 前一期排程（複製前一期用；無資料或 temp 回 null） */
export async function previousPeriodSchedule(
  db: any,
  indicatorId: string,
  category: ScheduleCategory,
  period: string,
): Promise<IndicatorSchedule | null> {
  const prev = previousPeriodKey(category, period);
  if (prev == null) return null;
  return getSchedule(db, indicatorId, category, prev);
}

/**
 * 依排程展開審查任務。
 *
 * 沿用 buildReviewTasks 的（月份 × 審查員 × 單位）展開邏輯，但月份先經
 * monthToCalendarYear 換算成曆年月後、按曆年分組再展開（reviewTasks 欄位結構不變）。
 *
 * 產生前先刪除該排程涵蓋曆年、該指標「未執行」的舊任務（已完成的保留，
 * 沿用既有規則）；成功後 audit「產生排程」。回傳新產生任務筆數。
 */
export async function buildTasksFromSchedule(
  db: any,
  sched: IndicatorSchedule,
  assignments: IndicatorAssignment,
  actor: { id: string; name: string },
  deadlineDay = 10,
): Promise<number> {
  const months = parseScheduleMonths(sched.months);
  const items = assignments?.items ?? [];
  // 月份 → 曆年分組（學年度會跨兩個曆年）
  const byYear = new Map<number, number[]>();
  for (const m of months) {
    const cy = monthToCalendarYear(sched.category, sched.period, m);
    const arr = byYear.get(cy) ?? [];
    arr.push(m);
    byYear.set(cy, arr);
  }

  // 只刪除該指標、涵蓋曆年中「未執行」的舊任務（done 保留），沿用既有規則
  const BATCH_LIMIT = 400;
  let batch = writeBatch(db);
  let ops = 0;
  const commits: Promise<void>[] = [];
  const flush = () => {
    if (ops > 0) {
      commits.push(batch.commit());
      batch = writeBatch(db);
      ops = 0;
    }
  };
  for (const cy of byYear.keys()) {
    const oldSnap = await getDocs(
      query(
        collection(db, "reviewTasks"),
        where("indicatorId", "==", sched.indicatorId),
        where("year", "==", cy),
      ),
    );
    oldSnap.docs.forEach((d) => {
      if (d.data().status === "done") return; // 已完成保留
      batch.delete(d.ref);
      ops += 1;
      if (ops >= BATCH_LIMIT) flush();
    });
  }

  // 按曆年展開新任務
  let taskCount = 0;
  for (const [cy, ms] of byYear) {
    const newTasks = buildReviewTasks({
      indicatorId: sched.indicatorId,
      year: cy,
      months: ms,
      items,
      caseCount: sched.caseCount ?? null,
      deadlineDay,
    });
    newTasks.forEach((t) => {
      const ref = doc(collection(db, "reviewTasks"));
      batch.set(ref, { ...t, createdAt: serverTimestamp() });
      ops += 1;
      taskCount += 1;
      if (ops >= BATCH_LIMIT) flush();
    });
  }
  flush();
  await Promise.all(commits);

  auditSchedule(
    db,
    actor,
    "產生排程",
    sched,
    `${sched.indicatorId}・${sched.periodLabel}：產生 ${taskCount} 筆任務`,
  );
  return taskCount;
}

/** createTempSchedule 輸入（加審／自審） */
export interface TempScheduleInput {
  indicatorId: string;
  /** 受審單位 id 清單 */
  unitIds: string[];
  /** 審查月份（1–12） */
  months: number[];
  caseCount: number | null;
  /** 負責審查員職編清單（每位審查員負責全部 unitIds；items 提供時忽略） */
  reviewerIds: string[];
  /**
   * 分工表項目：審查員→負責單位配對（v1.18 加審；
   * 提供且非空時優先使用，不再用 reviewerIds×unitIds 交叉）。
   */
  items?: AssignmentItem[];
  /** 關聯年份（v1.18 加審；顯示／查閱用） */
  refYear?: number;
  /** true＝自審（護理長為自己單位），false＝加審 */
  selfReview: boolean;
  notes?: string;
  actor: { id: string; name: string };
  deadlineDay?: number;
}

/**
 * 建立臨時排程（加審／自審）：period 用建立時間戳字串；
 * 建排程後直接產生任務。audit：「加審」或「自審排程」。
 */
export async function createTempSchedule(
  db: any,
  input: TempScheduleInput,
): Promise<{ scheduleId: string; taskCount: number }> {
  const unitIds = (input.unitIds ?? []).filter((u) => typeof u === "string");
  const reviewerIds = (input.reviewerIds ?? []).filter(
    (r) => typeof r === "string" && r,
  );
  // 分工表：items 優先；否則每位審查員負責全部受審單位
  //（件數透傳 null；件數以排程單一值為準）
  const items: AssignmentItem[] =
    input.items && input.items.length > 0
      ? input.items.map((it) => ({
          reviewerId: it.reviewerId,
          units: it.units
            .filter((u) => typeof u.unitId === "string" && u.unitId)
            .map((u) => ({
              unitId: u.unitId,
              caseCount: null as number | null,
            })),
        }))
      : reviewerIds.map((reviewerId) => ({
          reviewerId,
          units: unitIds.map((unitId) => ({
            unitId,
            caseCount: null as number | null,
          })),
        }));
  const allUnitIds = [
    ...new Set(items.flatMap((it) => it.units.map((u) => u.unitId))),
  ];
  const sched: IndicatorSchedule = {
    indicatorId: input.indicatorId,
    category: "temp",
    period: String(Date.now()),
    periodLabel: "臨時",
    months: parseScheduleMonths(input.months),
    frequency: null,
    intervalMonths: null,
    refYear:
      typeof input.refYear === "number" && Number.isInteger(input.refYear)
        ? input.refYear
        : null,
    caseCount: parseCaseCount(input.caseCount),
    unitIds: allUnitIds.length > 0 ? allUnitIds : unitIds,
    notes: input.notes ?? "",
    selfReview: input.selfReview === true,
    updatedBy: input.actor.id,
    updatedByName: input.actor.name,
    updatedAt: serverTimestamp(),
  };
  await saveSchedule(db, sched, input.actor);
  const taskCount = await buildTasksFromSchedule(
    db,
    sched,
    { indicatorId: input.indicatorId, items, updatedAt: null },
    input.actor,
    input.deadlineDay ?? 10,
  );
  auditSchedule(
    db,
    input.actor,
    sched.selfReview ? "自審排程" : "加審",
    sched,
    `${input.indicatorId}・${sched.unitIds.length} 單位・${items.length} 位審查員・${taskCount} 筆任務`,
  );
  return {
    scheduleId: scheduleDocId(sched.indicatorId, sched.category, sched.period),
    taskCount,
  };
}
