/**
 * 封存提醒（v1.65.1）：區間「已結束」（過補資料日）超過一個月仍未封存摘要者，
 * 提醒召集人／執行幹事封存；結果分析對這些區間顯示「尚待確認封存」。
 * 純函式，不碰 DOM／Firestore。
 */
import {
  addMonths,
  cmpYM,
  intervalDisplay,
  scheduleIntervals,
  supplementDeadlineFor,
  type CalendarYM,
  type ReviewInterval,
  type ScheduleLike,
} from "./reviewActive";
import { summaryDocId } from "./reviewSummary";

export interface EndedIntervalInfo {
  indicatorId: string;
  category: "year" | "academic" | "temp";
  period: string;
  interval: ReviewInterval;
  /** reviewArchives 文件 ID */
  archiveId: string;
  label: string;
  /** 已結束超過一個月（應封存而未封存時＝逾期） */
  overdue: boolean;
}

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 區間結束後滿一個月的最後一天（結束月＋1 個月的月底）；今天晚於它即逾期 */
export function archiveDueDate(end: CalendarYM): string {
  const n = addMonths(end, 1);
  return ymd(new Date(n.year, n.month, 0));
}

export interface SchedForArchive extends ScheduleLike {
  indicatorId: string;
}

/** 一個排程中「已結束」（今天已過該區間補資料日）的全部區間 */
export function endedIntervalsOf(
  sched: SchedForArchive,
  today: Date,
  deadlineDay: number,
): EndedIntervalInfo[] {
  const t = ymd(today);
  const out: EndedIntervalInfo[] = [];
  for (const iv of scheduleIntervals(sched, today)) {
    if (t <= supplementDeadlineFor(iv.end, deadlineDay)) continue;
    out.push({
      indicatorId: sched.indicatorId,
      category: sched.category,
      period: sched.period,
      interval: iv,
      archiveId: summaryDocId(sched.indicatorId, sched.category, sched.period, iv.start),
      label: intervalDisplay(iv, sched.category),
      overdue: t > archiveDueDate(iv.end),
    });
  }
  return out;
}

/**
 * 逾期未封存的區間（跨全部排程）。lookbackMonths：只看結束月在最近 N 個月內者，
 * 避免舊資料遷移前的歷史區間永遠提醒（預設 24 個月）。
 */
export function unarchivedOverdue(
  schedules: SchedForArchive[],
  archiveIds: Set<string>,
  today: Date,
  deadlineDay: number,
  lookbackMonths = 24,
): EndedIntervalInfo[] {
  const floor = addMonths({ year: today.getFullYear(), month: today.getMonth() + 1 }, -lookbackMonths);
  const out: EndedIntervalInfo[] = [];
  for (const s of schedules) {
    for (const e of endedIntervalsOf(s, today, deadlineDay)) {
      if (!e.overdue || archiveIds.has(e.archiveId)) continue;
      if (cmpYM(e.interval.end, floor) < 0) continue;
      out.push(e);
    }
  }
  return out;
}
