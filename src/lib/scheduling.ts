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
  notes: string;
  updatedAt: unknown;
}

/** 分工表項目：一位審查員 → 負責單位清單 */
export interface AssignmentItem {
  /** 審查員職編 */
  reviewerId: string;
  /** 單位代碼（units 文件 id） */
  unitIds: string[];
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
  /** 截止日 YYYY-MM-DD（審查月份次月＋系統參數「補審截止（次月幾日）」） */
  deadline: string;
  status: ReviewTaskStatus;
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
    for (const u of it.unitIds) {
      const arr = map.get(u) ?? [];
      if (!arr.includes(it.reviewerId)) arr.push(it.reviewerId);
      map.set(u, arr);
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
  const pairs = items.reduce((n, it) => n + it.unitIds.length, 0);
  return months.length * pairs;
}

export interface GenerateInput {
  indicatorId: string;
  year: number;
  months: number[];
  items: AssignmentItem[];
  /** 系統參數「補審截止（次月幾日）」 */
  deadlineDay: number;
}

/**
 * 展開全年審查任務（純函式，可單元測試）。
 * 每（月份 × 審查員 × 單位）一筆，截止日＝次月 deadlineDay 日。
 */
export function buildReviewTasks(
  input: GenerateInput,
): Omit<ReviewTask, "createdAt">[] {
  const tasks: Omit<ReviewTask, "createdAt">[] = [];
  for (const month of input.months) {
    for (const it of input.items) {
      for (const unitId of it.unitIds) {
        tasks.push({
          indicatorId: input.indicatorId,
          year: input.year,
          month,
          unitId,
          reviewerId: it.reviewerId,
          deadline: deadlineFor(input.year, month, input.deadlineDay),
          status: "pending",
        });
      }
    }
  }
  return tasks;
}
