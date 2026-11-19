import { useScheduleState } from "./useScheduleState";
import { useScheduleScope } from "./useScheduleScope";
import { useScheduleData } from "./useScheduleData";
import { useScheduleRows } from "./useScheduleRows";
import type { SchedulePageProps } from "../model/pageProps";

export function useScheduleCtx(props: SchedulePageProps) {
  const { onAction } = props;
  const s0 = useScheduleState();
  const { users, user, units, myUnitCode, indicators, queried, filterYear, statsCycle, filterGroup, filterIndicator, filterKeyword, groupMap, schedules, showTemp, assignments, canEdit, setView, actor, deadlineDay, view, isHeadNurse, setSelfAuditOpen, setFilterGroup, setFilterIndicator, setFilterKeyword, setFilterYear, setShowTemp, loading, generatingKey, setAddAuditRow, addAuditRow, reviewersByGroup, selfAuditOpen } = s0;
  const s1 = useScheduleScope(s0);
  const { isUnitScheduler, unitNameOf, scheduleRestrictedUnits, usersMap, indicatorOf, reviewerRoleIds, inactiveIds, scheduleScopeUnits } = s1;
  const s2 = useScheduleData(props, { ...s0, ...s1 });
  const { loadData } = s2;
  const s3 = useScheduleRows(props, { ...s0, ...s1, ...s2 });
  const { indicatorOptions, rows, rowSort, toggleRowSort, compact, sortedRows, taskCountsFor, tempCountByIndicator, cycle, period, handleGenerate, canDeleteRow, handleDeleteSchedule, myUnitName, myUnitUsers, backToList } = s3;

  return {
    view,
    isHeadNurse,
    canEdit,
    setSelfAuditOpen,
    filterGroup,
    filterIndicator,
    filterKeyword,
    setFilterGroup,
    setFilterIndicator,
    setFilterKeyword,
    filterYear,
    setFilterYear,
    statsCycle,
    showTemp,
    setShowTemp,
    indicators,
    groupMap,
    indicatorOptions,
    loadData,
    loading,
    queried,
    rows,
    rowSort,
    toggleRowSort,
    compact,
    sortedRows,
    isUnitScheduler,
    myUnitCode,
    assignments,
    taskCountsFor,
    tempCountByIndicator,
    setView,
    cycle,
    period,
    generatingKey,
    handleGenerate,
    setAddAuditRow,
    canDeleteRow,
    handleDeleteSchedule,
    addAuditRow,
    units,
    users,
    reviewersByGroup,
    scheduleRestrictedUnits,
    unitNameOf,
    actor,
    deadlineDay,
    schedules,
    onAction,
    selfAuditOpen,
    myUnitName,
    myUnitUsers,
    usersMap,
    indicatorOf,
    backToList,
    reviewerRoleIds,
    inactiveIds,
    scheduleScopeUnits,
    user,
  };
}

export type ScheduleCtx = ReturnType<typeof useScheduleCtx>;
