import { periodForFilter, deleteScheduleWithTasks, buildTasksFromSchedule } from "../../../lib/scheduling";
import { useMemo } from "react";
import type { RowItem } from "../model/types";
import { rowHasOwnUnitScheduleContent, scheduleInvolvesUnit, scheduleDeletableByUnit } from "../../../lib/dataScope";
import { useCompactLayout, useTableSort } from "../../../components/ui";
import { scheduleCalendarMonths } from "../model/pure";
import { periodLabel } from "../../../lib/cycle";
import { getFirebaseDb } from "../../../lib/firebase";
import { toErrorMessage } from "../../../lib/errors";
import type { SchedulePageProps } from "../model/pageProps";
import type { useScheduleState } from "./useScheduleState";
import type { useScheduleScope } from "./useScheduleScope";
import type { useScheduleData } from "./useScheduleData";

export function useScheduleRows(props: SchedulePageProps, prev: ReturnType<typeof useScheduleState> & ReturnType<typeof useScheduleScope> & ReturnType<typeof useScheduleData>) {
  const { onAction } = props;
  const { statsCycle, filterYear, indicators, filterGroup, filterIndicator, filterKeyword, groupMap, schedules, showTemp, isUnitScheduler, myUnitCode, assignments, taskUnitIndex, taskIndex, canEdit, setView, loadData, actor, setGeneratingKey, deadlineDay, users, unitNameOf } = prev;

  // v1.18：年別鎖定系統統計週期；一列＝一支啟用指標＋當期；臨時排程另列
  const cycle: "year" | "academic" = statsCycle;
  const period = periodForFilter(cycle, filterYear);

  // v1.20：指標下拉選項＝啟用指標，依已選組別連動
  const indicatorOptions = useMemo(() => {
    let inds = indicators.filter((i) => i.status === "啟用");
    if (filterGroup) inds = inds.filter((i) => i.groupId === filterGroup);
    return inds;
  }, [indicators, filterGroup]);

  // ---------- 主畫面列：一列＝（啟用指標×當期）；無排程也列出以便建立 ----------
  const rows: RowItem[] = useMemo(() => {
    let inds = indicators.filter((i) => i.status === "啟用");
    if (filterGroup) inds = inds.filter((i) => i.groupId === filterGroup);
    if (filterIndicator)
      inds = inds.filter((i) => i.id === filterIndicator);
    const kw = filterKeyword.trim().toLowerCase();
    if (kw)
      inds = inds.filter(
        (i) =>
          i.name.toLowerCase().includes(kw) || i.id.toLowerCase().includes(kw),
      );
    const out: RowItem[] = [];
    for (const ind of inds) {
      const groupName = groupMap.get(ind.groupId) ?? "—";
      const s =
        schedules.find(
          (x) =>
            x.indicatorId === ind.id &&
            x.category === cycle &&
            x.period === period,
        ) ?? null;
      out.push({
        key: `${ind.id}||${cycle}||${period}`,
        indicatorId: ind.id,
        code: ind.code,
        name: ind.name,
        groupId: ind.groupId,
        groupName,
        status: ind.status,
        category: cycle,
        period,
        schedule: s,
      });
      if (showTemp) {
        const temps = schedules
          .filter((x) => x.indicatorId === ind.id && x.category === "temp")
          .sort((a, b) => b.period.localeCompare(a.period));
        for (const t of temps) {
          out.push({
            key: `${ind.id}||temp||${t.period}`,
            indicatorId: ind.id,
            code: ind.code,
            name: ind.name,
            groupId: ind.groupId,
            groupName,
            status: ind.status,
            category: "temp",
            period: t.period,
            schedule: t,
          });
        }
      }
    }
    const sorted = out.sort(
      (a, b) =>
        a.groupName.localeCompare(b.groupName, "zh-Hant") ||
        a.name.localeCompare(b.name, "zh-Hant") ||
        (a.category === "temp" ? 1 : 0) - (b.category === "temp" ? 1 : 0) ||
        b.period.localeCompare(a.period),
    );
    // v1.88.5：單位排程者只看得到自己單位的排程列。未排（無排程、無分工表）
    // 的列保留，以便為自己單位新建排程；指標本身不設限（可來自各品管組）。
    if (!isUnitScheduler || !myUnitCode) {
      return isUnitScheduler ? [] : sorted;
    }
    return sorted.filter((r) =>
      rowHasOwnUnitScheduleContent(
        r.schedule,
        assignments.get(r.indicatorId)?.items ?? [],
        myUnitCode,
        r.category === "temp",
      ),
    );
  }, [
    indicators,
    schedules,
    assignments,
    groupMap,
    cycle,
    period,
    filterGroup,
    filterKeyword,
    showTemp,
    isUnitScheduler,
    myUnitCode,
  ]);

  const compact = useCompactLayout();

  const {
    sortedRows,
    sort: rowSort,
    toggleSort: toggleRowSort,
  } = useTableSort<
    RowItem,
    "group" | "year" | "code" | "name" | "updated"
  >(rows, {
    group: (r) => r.groupName,
    year: (r) => `${r.category === "temp" ? "z" : r.category}${r.period}`,
    code: (r) => r.code,
    name: (r) => r.name,
    updated: (r) => {
      const t = r.schedule?.updatedAt as unknown as { toMillis?: () => number } | null | undefined;
      return t && typeof t.toMillis === "function" ? t.toMillis() : null;
    },
  });

  /** 各指標的加審筆數：加審按鈕下方顯示用（v1.59.0：只計 temp 且非自審；自審不計） */
  const tempCountByIndicator = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of schedules) {
      if (s.category !== "temp" || s.selfReview) continue;
      // v1.88.5：單位排程者只計涵蓋自己單位的加審。
      if (
        isUnitScheduler &&
        myUnitCode &&
        !scheduleInvolvesUnit(s, myUnitCode)
      ) {
        continue;
      }
      m.set(s.indicatorId, (m.get(s.indicatorId) ?? 0) + 1);
    }
    return m;
  }, [schedules, isUnitScheduler, myUnitCode]);

  /** 該列排程曆年月已產生的任務數（未執行／已完成） */
  function taskCountsFor(row: RowItem): { pending: number; done: number } {
    const s = row.schedule;
    if (!s) return { pending: 0, done: 0 };
    // v1.88.5：單位排程者只計自己單位的任務（unitId ""＝不限單位任務，
    // 其排程涵蓋自己單位，計入）；其餘沿用全量索引。
    if (isUnitScheduler && myUnitCode) {
      const idx = taskUnitIndex.get(row.indicatorId);
      if (!idx) return { pending: 0, done: 0 };
      let pending = 0;
      let done = 0;
      for (const { year, month } of scheduleCalendarMonths(s)) {
        const byUnit = idx.get(`${year}-${month}`);
        if (!byUnit) continue;
        for (const unitId of [myUnitCode, ""]) {
          const e = byUnit.get(unitId);
          if (e) {
            pending += e.pending;
            done += e.done;
          }
        }
      }
      return { pending, done };
    }
    const idx = taskIndex.get(row.indicatorId);
    if (!idx) return { pending: 0, done: 0 };
    let pending = 0;
    let done = 0;
    for (const { year, month } of scheduleCalendarMonths(s)) {
      const e = idx.get(`${year}-${month}`);
      if (e) {
        pending += e.pending;
        done += e.done;
      }
    }
    return { pending, done };
  }

  /** v1.88.5：該列排程能否由單位排程者刪除——僅限排程只含自己單位時；含其他單位（或不限單位）者僅能由管理員刪除 */
  function canDeleteRow(row: RowItem): boolean {
    if (!canEdit) return false;
    if (!isUnitScheduler) return true;
    return scheduleDeletableByUnit(row.schedule, myUnitCode);
  }

  function backToList() {
    setView({ kind: "list" });
    loadData();
  }

  /** v1.60.0：刪除排程（主清單）：排程文件＋其未完成任務；已完成任務與已提交紀錄保留 */
  async function handleDeleteSchedule(row: RowItem) {
    const sched = row.schedule;
    if (!sched) return;
    // v1.88.5：單位排程者僅能刪除只含自己單位的排程（防護，正常流程下
    // 含其他單位的列根本看不到刪除按鈕）。
    if (isUnitScheduler && !scheduleDeletableByUnit(sched, myUnitCode)) {
      onAction("此排程包含其他單位，僅能由管理員刪除");
      return;
    }
    const label = sched.selfReview
      ? "自審"
      : sched.category === "temp"
        ? "加審"
        : periodLabel(sched.category, sched.period);
    const ok = window.confirm(
      `確定刪除「${label}」排程（${row.name}）？將一併刪除該排程的未完成任務；已完成任務與已提交的審查紀錄不受影響。`,
    );
    if (!ok) return;
    try {
      const db = getFirebaseDb();
      const { deletedTasks, keptDoneTasks } = await deleteScheduleWithTasks(
        db,
        row.indicatorId,
        sched.category,
        sched.period,
        actor,
      );
      onAction(
        `已刪除${label}排程（刪除 ${deletedTasks} 筆未完成任務，已完成 ${keptDoneTasks} 筆保留）`,
      );
      loadData();
    } catch (error) {
      onAction(`刪除失敗：${toErrorMessage(error)}`);
    }
  }

  async function handleGenerate(row: RowItem) {
    const sched = row.schedule;
    if (!sched) return;
    const assignment = assignments.get(row.indicatorId);
    if (!assignment || assignment.items.length === 0) {
      onAction("請先完成單位／審查員設定");
      return;
    }
    const { pending, done } = taskCountsFor(row);
    if (pending + done > 0) {
      const ok = window.confirm(
        `${sched.periodLabel}已有 ${pending} 筆未執行、${done} 筆已完成任務。重新產生會刪除未執行任務並建立新任務；${sched.unlimitedUnits ? "週期排程將按每區間 N 件計算，區間月份合併且區間內各審查員共用 N。" : "週期排程將按每單位、每區間 N 件計算，區間月份合併且同單位審查員共用 N。"}既有已完成任務與結果不回溯修改。確定嗎？`,
      );
      if (!ok) return;
    }
    setGeneratingKey(row.key);
    try {
      const db = getFirebaseDb();
      const n = await buildTasksFromSchedule(
        db,
        sched,
        assignment,
        actor,
        deadlineDay,
      );
      onAction(`${row.name}・${sched.periodLabel}排程已產生：${n} 筆任務`);
      await loadData();
    } catch (error) {
      onAction(`產生排程失敗：${toErrorMessage(error)}`);
    } finally {
      setGeneratingKey(null);
    }
  }

  // 自審：自己單位在職人員
  const myUnitUsers = useMemo(
    () =>
      users.filter((u) => u.unitCode === myUnitCode && u.status === "在職"),
    [users, myUnitCode],
  );
  const myUnitName = useMemo(
    () => unitNameOf(myUnitCode),
    [unitNameOf, myUnitCode],
  );

  return {
    indicatorOptions,
    rows,
    rowSort,
    toggleRowSort,
    compact,
    sortedRows,
    taskCountsFor,
    tempCountByIndicator,
    cycle,
    period,
    handleGenerate,
    canDeleteRow,
    handleDeleteSchedule,
    myUnitName,
    myUnitUsers,
    backToList,
  };
}
