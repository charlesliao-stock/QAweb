import { usePermissions } from "../../../lib/usePermissions";
import { useAuth } from "../../../lib/auth";
import { useMemo, useState } from "react";
import { useOrgMeta } from "../../../lib/useOrgMeta";
import { titleFlagsOf, hasRoleCategory } from "../../../lib/orgMeta";
import type { View, IndicatorLite, UnitLite, UserLite, ReviewerLite, RowItem } from "../model/types";
import type { IndicatorSchedule, IndicatorAssignment } from "../../../lib/scheduling";
import type { TaskUnitIndex } from "../../../lib/taskIndex";

export function useScheduleState() {
  const { can, catalog } = usePermissions();
  const { user } = useAuth();
  // 排程編輯權限依角色＋職稱矩陣交集判斷；不再以舊角色名稱繞過設定。
  const canEdit = can("manageSchedule");
  const actor = useMemo(
    () => ({ id: user?.staffId ?? "", name: user?.name ?? "" }),
    [user],
  );
  // v1.40.5：單位主管改以職稱旗標／角色類別判斷，不再比對職稱名稱
  const orgMeta = useOrgMeta();
  const isHeadNurse =
    titleFlagsOf(user?.title ?? "", user?.titleId, orgMeta.titleMeta, orgMeta.titleMetaById).isUnitHead ||
    hasRoleCategory(user?.roles ?? [], "unitHead", orgMeta.roleMeta);
  const myUnitCode = user?.unitCode ?? "";

  const [view, setView] = useState<View>({ kind: "list" });
  const [loading, setLoading] = useState(false);
  const [queried, setQueried] = useState(false);

  const [indicators, setIndicators] = useState<IndicatorLite[]>([]);
  const [groupMap, setGroupMap] = useState<Map<string, string>>(new Map());
  const [schedules, setSchedules] = useState<IndicatorSchedule[]>([]);
  const [assignments, setAssignments] = useState<Map<string, IndicatorAssignment>>(
    new Map(),
  );
  const [units, setUnits] = useState<UnitLite[]>([]);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [reviewersByGroup, setReviewersByGroup] = useState<
    Map<string, ReviewerLite[]>
  >(new Map());
  /** 任務索引：指標 id → "曆年-月" → {pending, done}（產生排程確認＋已排程 pill 用） */
  const [taskIndex, setTaskIndex] = useState<
    Map<string, Map<string, { pending: number; done: number }>>
  >(new Map());
  /** v1.88.5：任務單位索引（與 taskIndex 同一批文件；單位排程者只計自己單位的任務數，unitId ""＝不限單位任務） */
  const [taskUnitIndex, setTaskUnitIndex] = useState<TaskUnitIndex>(new Map());
  const [deadlineDay, setDeadlineDay] = useState(10);

  // 篩選（v1.18）：年份／年別（鎖定系統統計週期）／組別／關鍵字／顯示加審
  // v1.20：組別旁新增指標下拉（依組別連動）
  const [filterYear, setFilterYear] = useState(() => new Date().getFullYear());
  const [taskReloadTick, setTaskReloadTick] = useState(0);
  const [statsCycle, setStatsCycle] = useState<"year" | "academic">("year");
  const [showTemp, setShowTemp] = useState(false);
  const [filterGroup, setFilterGroup] = useState("");
  const [filterIndicator, setFilterIndicator] = useState("");
  const [filterKeyword, setFilterKeyword] = useState("");

  const [generatingKey, setGeneratingKey] = useState<string | null>(null);
  const [addAuditRow, setAddAuditRow] = useState<RowItem | null>(null);
  const [selfAuditOpen, setSelfAuditOpen] = useState(false);

  return {
    users,
    orgMeta,
    user,
    units,
    catalog,
    myUnitCode,
    indicators,
    setStatsCycle,
    setDeadlineDay,
    setGroupMap,
    setIndicators,
    setQueried,
    setLoading,
    setSchedules,
    setAssignments,
    setUnits,
    setUsers,
    setReviewersByGroup,
    setTaskReloadTick,
    queried,
    filterYear,
    setTaskIndex,
    setTaskUnitIndex,
    taskReloadTick,
    statsCycle,
    filterGroup,
    filterIndicator,
    filterKeyword,
    groupMap,
    schedules,
    showTemp,
    assignments,
    taskUnitIndex,
    taskIndex,
    canEdit,
    setView,
    actor,
    setGeneratingKey,
    deadlineDay,
    view,
    isHeadNurse,
    setSelfAuditOpen,
    setFilterGroup,
    setFilterIndicator,
    setFilterKeyword,
    setFilterYear,
    setShowTemp,
    loading,
    generatingKey,
    setAddAuditRow,
    addAuditRow,
    reviewersByGroup,
    selfAuditOpen,
  };
}
