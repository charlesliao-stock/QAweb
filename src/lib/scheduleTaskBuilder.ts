import {
  collection,
  doc,
  getDocs,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from "./db";
import {
  auditSchedule,
  buildReviewTasks,
  parseScheduleMonths,
  periodicQuotaGroupId,
  periodicQuotaSlotDocId,
  scheduleReviewCalendarMonths,
  type IndicatorAssignment,
  type IndicatorSchedule,
} from "./scheduling";

/**
 * 依排程展開審查任務。
 * 年度／學年度按每單位、每區間建立 N 個共享 slot；臨時排程維持原逐 task 件數。
 * 新任務標記 schedule source，後續重產只清理同一排程的未完成任務。
 */
export async function buildTasksFromSchedule(
  db: any,
  sched: IndicatorSchedule,
  assignments: IndicatorAssignment,
  actor: { id: string; name: string },
  deadlineDay = 10,
): Promise<number> {
  const reviewMonths = scheduleReviewCalendarMonths(sched);
  const items = assignments?.items ?? [];
  const quotaByMonth = new Map<
    string,
    { start: { year: number; month: number }; end: { year: number; month: number } }
  >();
  if (sched.category === "year" || sched.category === "academic") {
    const { scheduleIntervals: buildReviewIntervals } = await import(
      "./reviewActive"
    );
    const intervals = buildReviewIntervals({
      category: sched.category,
      period: sched.period,
      months: parseScheduleMonths(sched.months),
      frequency: sched.frequency,
      intervalMonths: sched.intervalMonths,
      refYear: sched.refYear,
    });
    for (const interval of intervals) {
      for (const month of interval.reviewMonths) {
        quotaByMonth.set(`${month.year}-${month.month}`, {
          start: interval.start,
          end: interval.end,
        });
      }
    }
  }

  const byYear = new Map<number, number[]>();
  for (const { year, month } of reviewMonths) {
    const months = byYear.get(year) ?? [];
    months.push(month);
    byYear.set(year, months);
  }

  const BATCH_LIMIT = 400;
  let batch = writeBatch(db);
  let ops = 0;
  const commits: Promise<void>[] = [];
  const completedQuotaGroups = new Set<string>();
  const completedTaskKeys = new Set<string>();
  const flush = () => {
    if (ops > 0) {
      commits.push(batch.commit());
      batch = writeBatch(db);
      ops = 0;
    }
  };
  const isPeriodic =
    sched.category === "year" || sched.category === "academic";
  if (isPeriodic) {
    const oldSnap = await getDocs(
      query(
        collection(db, "reviewTasks"),
        where("indicatorId", "==", sched.indicatorId),
      ),
    );
    oldSnap.docs.forEach((d) => {
      const data = d.data();
      const taggedSameSchedule =
        data.scheduleCategory === sched.category &&
        String(data.schedulePeriod ?? "") === sched.period;
      const legacyInNewYears =
        !data.scheduleCategory && byYear.has(Number(data.year ?? 0));
      if (!taggedSameSchedule && !legacyInNewYears) return;
      if (data.status === "done") {
        const groupId = data.quotaGroupId;
        if (typeof groupId === "string" && groupId) {
          completedQuotaGroups.add(groupId);
        }
        if (taggedSameSchedule) {
          completedTaskKeys.add(
            `${Number(data.year ?? 0)}|${Number(data.month ?? 0)}|${String(data.unitId ?? "")}|${String(data.reviewerId ?? "")}`,
          );
        }
        return;
      }
      batch.delete(d.ref);
      ops += 1;
      if (ops >= BATCH_LIMIT) flush();
    });
  } else {
    // 臨時排程沿用既有按指標／曆年重建流程，不套用週期 quota。
    for (const year of byYear.keys()) {
      const oldSnap = await getDocs(
        query(
          collection(db, "reviewTasks"),
          where("indicatorId", "==", sched.indicatorId),
          where("year", "==", year),
        ),
      );
      oldSnap.docs.forEach((d) => {
        if (d.data().status === "done") {
          const groupId = d.data().quotaGroupId;
          if (typeof groupId === "string" && groupId) {
            completedQuotaGroups.add(groupId);
          }
          return;
        }
        batch.delete(d.ref);
        ops += 1;
        if (ops >= BATCH_LIMIT) flush();
      });
    }
  }

  let taskCount = 0;
  const quotaGroups = new Map<
    string,
    {
      indicatorId: string;
      unitId: string;
      category: "year" | "academic";
      period: string;
      startYear: number;
      startMonth: number;
      endYear: number;
      endMonth: number;
      caseCount: number;
      slotIds: string[];
    }
  >();
  const tasksToWrite: Record<string, unknown>[] = [];
  for (const [year, months] of byYear) {
    const newTasks = buildReviewTasks({
      indicatorId: sched.indicatorId,
      year,
      months,
      items,
      caseCount: sched.caseCount ?? null,
      deadlineDay,
    });
    newTasks.forEach((task) => {
      const taskKey = `${task.year}|${task.month}|${task.unitId}|${task.reviewerId}`;
      if (completedTaskKeys.has(taskKey)) return;
      const quotaInterval = quotaByMonth.get(`${task.year}-${task.month}`);
      const periodicCategory =
        sched.category === "year" || sched.category === "academic"
          ? sched.category
          : null;
      const hasPeriodicQuota = Boolean(
        quotaInterval && sched.caseCount != null && periodicCategory,
      );
      const quotaGroupId =
        quotaInterval && sched.caseCount != null && periodicCategory
          ? periodicQuotaGroupId({
              indicatorId: sched.indicatorId,
              unitId: task.unitId,
              category: periodicCategory,
              period: sched.period,
              start: quotaInterval.start,
            })
          : "";
      if (quotaGroupId && completedQuotaGroups.has(quotaGroupId)) return;
      const quota =
        hasPeriodicQuota && quotaInterval && periodicCategory
          ? {
              quotaVersion: 1 as const,
              quotaGroupId,
              quotaCategory: periodicCategory,
              quotaIntervalStartYear: quotaInterval.start.year,
              quotaIntervalStartMonth: quotaInterval.start.month,
              quotaIntervalEndYear: quotaInterval.end.year,
              quotaIntervalEndMonth: quotaInterval.end.month,
            }
          : {};
      tasksToWrite.push({
        ...task,
        ...quota,
        scheduleCategory: sched.category,
        schedulePeriod: sched.period,
      });
      if (
        quotaGroupId &&
        quotaInterval &&
        periodicCategory &&
        sched.caseCount != null &&
        !quotaGroups.has(quotaGroupId)
      ) {
        quotaGroups.set(quotaGroupId, {
          indicatorId: sched.indicatorId,
          unitId: task.unitId,
          category: periodicCategory,
          period: sched.period,
          startYear: quotaInterval.start.year,
          startMonth: quotaInterval.start.month,
          endYear: quotaInterval.end.year,
          endMonth: quotaInterval.end.month,
          caseCount: sched.caseCount,
          slotIds: Array.from({ length: sched.caseCount }, (_, index) =>
            periodicQuotaSlotDocId(quotaGroupId, index + 1),
          ),
        });
      }
    });
  }

  // Commit group allow-lists before reviewTasks become visible to reviewers.
  for (const [groupId, data] of quotaGroups) {
    batch.set(
      doc(db, "reviewQuotaGroups", groupId),
      { ...data, updatedAt: serverTimestamp() },
      { merge: true },
    );
    ops += 1;
    if (ops >= BATCH_LIMIT) flush();
  }
  flush();
  await Promise.all(commits.splice(0));
  for (const taskData of tasksToWrite) {
    batch.set(doc(collection(db, "reviewTasks")), {
      ...taskData,
      createdAt: serverTimestamp(),
    });
    ops += 1;
    taskCount += 1;
    if (ops >= BATCH_LIMIT) flush();
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
