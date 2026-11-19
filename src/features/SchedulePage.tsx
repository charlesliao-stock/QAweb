/**
 * 品管審查排程頁（v1.16.0 重寫）。
 * 三類別排程（年度／學年度／臨時）：一列＝一支指標＋一個類別（當期），
 * 含「尚無排程」列以便建立；操作＝產生排程／加審／查閱；自審（護理長）。
 * 排程讀寫一律走 src/lib/scheduling.ts 的新模型（indicatorSchedules），
 * 稽核由 lib 內自動寫入。
 */
import { loadRefCollection } from "../lib/refLoad";
import { toErrorMessage } from "../lib/errors";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, CalendarPlus, CircleCheck, CircleDashed, Eye, Plus, Trash2 } from "lucide-react";
import { collection, doc, getDocs, query, where } from "../lib/db";
import {
  EmptyState,
  FilterPanel,
  FilterSearchField,
  ListPanel,
  PageHeading,
  SectionTitle,
  SortableTh,
  useTableSort,
  FormSelect,
  useCompactLayout,
} from "../components/ui";
import { getFirebaseDb } from "../lib/firebase";
import { getCachedRef, SYSTEM_CONFIG_KEY } from "../lib/refCache";
import { getDocCacheFirst } from "../lib/cacheFirst";
import { indicatorCodeOf, stripInternalIdPrefix } from "../lib/indicators";
import { buildTaskIndex, buildTaskUnitIndex, type TaskUnitIndex } from "../lib/taskIndex";
import { usePermissions } from "../lib/usePermissions";
import { useAuth } from "../lib/auth";
import { isReviewerAccessActive } from "../lib/reviewerValidity";
import { useOrgMeta } from "../lib/useOrgMeta";
import { hasRoleCategory, titleFlagsOf } from "../lib/orgMeta";
import { isReviewerRole } from "../lib/roleIdentity";
import { assignmentItemInvolvesUnit, deriveCrossFlags, isUnitSchedulerRole, resolveDataScope, rowHasOwnUnitScheduleContent, scheduleDeletableByUnit, scheduleInvolvesUnit } from "../lib/dataScope";
import { ScheduleDetailPage } from "./ScheduleDetailPage";
import { categoryLabel, periodLabel } from "../lib/cycle";
import { buildTasksFromSchedule, deleteScheduleWithTasks, listSchedules, normalizeAssignmentItem, periodForFilter, shouldAutoLinkReviewer, YEAR_FILTER_OPTIONS, yearOptionLabel, type AssignmentItem, type IndicatorAssignment, type IndicatorSchedule } from "../lib/scheduling";
import { fmtTsDate } from "../lib/ym";
import { type IndicatorLite, type UnitLite, type UserLite, type ReviewerLite, type RowItem, type View } from "./schedule/model/types";
import { scheduleCalendarMonths, PILL_OK, PILL_NONE, schedulePillState } from "./schedule/model/pure";
import { ScheduleEditor } from "./schedule/components/ScheduleEditor";
import { SelfAuditDialog } from "./schedule/components/SelfAuditDialog";
import { AssignmentEditor } from "./schedule/components/AssignmentEditor";
import { AddAuditDialog } from "./schedule/components/AddAuditDialog";
export { type PickerOption } from "./schedule/components/pickers";
export { schedulePillState, mergeItemsWithUnits, mergeItemsUnlimited, assignmentPillState, previewTempTaskCount, defaultPeriodForStatsCycle, defaultSelfAuditReviewers, defaultAddAuditReviewers } from "./schedule/model/pure";

export function SchedulePage({ onAction }: { onAction: (message: string) => void }) {
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

  const usersMap = useMemo(() => {
    const m = new Map<string, string>();
    users.forEach((u) => m.set(u.id, u.name));
    return m;
  }, [users]);
  // v1.83.0：尚未開通帳號的在職人員（排程指派審查員時提醒用）
  const inactiveIds = useMemo(
    () => new Set(users.filter((u) => !u.activated && u.status !== "停用").map((u) => u.id)),
    [users],
  );
  // v1.88.4：具審查員角色且效期有效的職編（分工表批次匯入驗證用；
  // reviewReviewers 名單內的職編另由 reviewersByGroup 判定，兩者任一成立即可）
  const reviewerRoleIds = useMemo(
    () =>
      new Set(
        users
          .filter(
            (u) =>
              u.reviewerAccessActive &&
              shouldAutoLinkReviewer(u.roles, orgMeta.roleMeta),
          )
          .map((u) => u.id),
      ),
    [users, orgMeta.roleMeta],
  );
  // v1.88.4：查閱頁任務追蹤的可見單位（與結果分析／CAPA 同一 dataScope 口徑；
  // kind all 時為 null＝全看；審查員本人的任務在彈窗內另行放行）
  const detailScopeUnits = useMemo(() => {
    if (!user) return null;
    const scope = resolveDataScope({
      isAdmin: (user.roles ?? []).includes("系統管理員"),
      roles: user.roles ?? [],
      title: user.title ?? "",
      titleFlags: titleFlagsOf(user.title ?? "", user.titleId, orgMeta.titleMeta, orgMeta.titleMetaById),
      memberships: user.memberships ?? [],
      unitCode: user.unitCode ?? "",
      titleUnitCodes: user.titleUnitCodes ?? [],
      units,
      unitGroups: catalog.unitGroups,
      cross: deriveCrossFlags(catalog.templates, user.roles ?? [], user.title ?? ""),
      isReviewer: isReviewerRole(user.roles ?? [], orgMeta.roleMeta),
    });
    return scope.kind === "all" ? null : scope.unitCodes;
  }, [user, units, catalog, orgMeta]);
  // v1.88.5：單位排程者（單位召集人／單位執行幹事，不論 cross）——
  // 只能幫自己單位排程、只看得到自己單位的排程內容；指標不設限（見 rows
  // 與各編輯器）。系統管理員不受限；其餘角色依上節 dataScope 不變。
  const isUnitScheduler = useMemo(
    () =>
      isUnitSchedulerRole(
        user?.roles ?? [],
        (user?.roles ?? []).includes("系統管理員"),
      ),
    [user],
  );
  const scheduleRestrictedUnits = useMemo(
    () =>
      isUnitScheduler && myUnitCode
        ? new Set<string>([myUnitCode])
        : isUnitScheduler
          ? new Set<string>()
          : null,
    [isUnitScheduler, myUnitCode],
  );
  // 查閱頁用：單位排程者不論 cross 皆只看自己單位；其餘沿用 dataScope。
  const scheduleScopeUnits = scheduleRestrictedUnits ?? detailScopeUnits;
  const unitNameOf = useCallback(
    (code: string) => units.find((u) => u.code === code)?.name ?? code,
    [units],
  );
  const indicatorOf = useCallback(
    (id: string) => indicators.find((i) => i.id === id),
    [indicators],
  );

  // 系統參數：統計週期（年別篩選鎖定用；設定改了這裡跟著變）＋補審截止日（產生任務用）
  useEffect(() => {
    (async () => {
      try {
        const snap = await getCachedRef(SYSTEM_CONFIG_KEY, () =>
          getDocCacheFirst(doc(getFirebaseDb(), "systemParams", "config")),
        );
        const data = snap.data() as Record<string, unknown> | undefined;
        setStatsCycle(data?.statsCycle === "academic" ? "academic" : "year");
        const dd = data?.supplementDeadlineDay;
        if (typeof dd === "number" && dd >= 1 && dd <= 31) setDeadlineDay(dd);
      } catch {
        /* 讀不到就用預設值 */
      }
    })();
  }, []);

  // 篩選下拉用的輕量參考資料（走 refCache，不另計費）；排程本體須按「查詢」才載入
  const applyRefs = useCallback(
    (
      isnap: Awaited<ReturnType<typeof loadRefCollection>>,
      gsnap: Awaited<ReturnType<typeof loadRefCollection>>,
    ) => {
      const gm = new Map<string, string>();
      gsnap.docs.forEach((d) => {
        const name = d.data().name;
        if (typeof name === "string") gm.set(d.id, name);
      });
      setGroupMap(gm);
      setIndicators(
        isnap.docs
          .map((d) => {
            const data = d.data();
            return {
              id: d.id,
              code: indicatorCodeOf(d.id),
              name: typeof data.name === "string" ? data.name : "",
              groupId: typeof data.groupId === "string" ? data.groupId : "",
              status: typeof data.status === "string" ? data.status : "",
            };
          })
          .sort((a, b) => a.id.localeCompare(b.id, "zh-Hant")),
      );
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [isnap, gsnap] = await Promise.all([
          loadRefCollection("indicators"),
          loadRefCollection("groups"),
        ]);
        if (!cancelled) applyRefs(isnap, gsnap);
      } catch {
        /* 下拉選項讀不到時留空，按查詢仍會完整載入 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyRefs]);

  const loadData = useCallback(async () => {
    setQueried(true);
    setLoading(true);
    try {
      const db = getFirebaseDb();
      const [isnap, gsnap, asnap, usnap, unsnap, rsnap, scheds] =
        await Promise.all([
          loadRefCollection("indicators"),
          loadRefCollection("groups"),
          getDocs(collection(db, "indicatorAssignments")),
          loadRefCollection("units"),
          loadRefCollection("users"),
          getDocs(collection(db, "reviewReviewers")),
          listSchedules(db),
        ]);

      applyRefs(isnap, gsnap);
      setSchedules(scheds);

      const am = new Map<string, IndicatorAssignment>();
      asnap.docs.forEach((d) => {
        const data = d.data();
        const items: AssignmentItem[] = Array.isArray(data.items)
          ? data.items
              .map(normalizeAssignmentItem)
              .filter((it): it is AssignmentItem => it !== null)
          : [];
        const indicatorId =
          typeof data.indicatorId === "string" ? data.indicatorId : d.id;
        am.set(indicatorId, { indicatorId, items, updatedAt: data.updatedAt });
      });
      setAssignments(am);

      setUnits(
        usnap.docs
          .map((d) => {
            const data = d.data();
            return {
              code: d.id,
              name: typeof data.name === "string" ? data.name : d.id,
              groupId: typeof data.groupId === "string" ? data.groupId : "",
              mergedFromUnitCodes: Array.isArray(data.mergedFromUnitCodes)
                ? data.mergedFromUnitCodes.map(String).filter(Boolean)
                : [],
            };
          })
          .sort((a, b) => a.code.localeCompare(b.code, "zh-Hant")),
      );

      setUsers(
        unsnap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            name: typeof data.name === "string" ? data.name : d.id,
            unitCode: typeof data.unitCode === "string" ? data.unitCode : "",
            status: typeof data.status === "string" ? data.status : "在職",
            reviewerAccessActive: isReviewerAccessActive(data.reviewerAccessExpiresAt),
            activated: typeof data.activatedAt === "string" && data.activatedAt !== "",
            roles: Array.isArray(data.roles) ? data.roles.map(String) : [],
          };
        }),
      );

      const um = new Map<string, string>();
      unsnap.docs.forEach((d) => {
        const name = d.data().name;
        um.set(d.id, typeof name === "string" ? name : d.id);
      });
      const rbm = new Map<string, ReviewerLite[]>();
      const activeReviewerIds = new Set(
        unsnap.docs
          .filter((person) => isReviewerAccessActive(person.data().reviewerAccessExpiresAt))
          .map((person) => person.id),
      );
      rsnap.docs.forEach((d) => {
        const data = d.data();
        const groupId = typeof data.groupId === "string" ? data.groupId : "";
        const personId = typeof data.personId === "string" ? data.personId : "";
        if (!groupId || !personId || !activeReviewerIds.has(personId)) return;
        const arr = rbm.get(groupId) ?? [];
        arr.push({ personId, name: um.get(personId) ?? personId });
        rbm.set(groupId, arr);
      });
      rbm.forEach((arr) =>
        arr.sort((a, b) => a.personId.localeCompare(b.personId, "zh-Hant")),
      );
      setReviewersByGroup(rbm);

      // 任務索引改由 loadTaskIndex 依檢視年度讀取；操作後重載時一併刷新。
      setTaskReloadTick((t) => t + 1);
    } catch (error) {
      onAction(`讀取排程資料失敗：${toErrorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, [onAction, applyRefs]);

  // 任務索引（v1.28 階段 6 B5 起）：前端按 indicatorId 分組取代 N+1 查詢。
  // 只讀「檢視年度」的任務（年度＝該年；學年度 8 月～隔年 7 月，故讀 Y 與 Y+1 兩個
  // 日曆年），不再整個集合全掃。year 單欄位 in 查詢，免複合索引。
  // 臨時排程若屬其他年度，切換到該年度檢視時才會有任務數。
  useEffect(() => {
    if (!queried) return;
    let cancelled = false;
    (async () => {
      try {
        const db = getFirebaseDb();
        const tsnap = await getDocs(
          query(
            collection(db, "reviewTasks"),
            where("year", "in", [filterYear, filterYear + 1]),
          ),
        );
        if (cancelled) return;
        setTaskIndex(
          buildTaskIndex(
            tsnap.docs as unknown as Array<{
              data: () => Record<string, unknown>;
            }>,
          ),
        );
        // v1.88.5：同一批文件多建單位維度索引（不另讀取），供單位排程者計數。
        setTaskUnitIndex(
          buildTaskUnitIndex(
            tsnap.docs as unknown as Array<{
              data: () => Record<string, unknown>;
            }>,
          ),
        );
      } catch {
        /* 任務索引讀取失敗：索引留空，任務數顯示為 0，不影響其他資料 */
        if (!cancelled) setTaskIndex(new Map());
        if (!cancelled) setTaskUnitIndex(new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filterYear, taskReloadTick, queried]);

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

  // ================= 主畫面 =================
  if (view.kind === "list") {
    return (
      <>
        <PageHeading
          page="schedule"
          action={
            isHeadNurse && canEdit ? (
              <button
                className="button button-outline"
                onClick={() => setSelfAuditOpen(true)}
              >
                <Plus size={15} /> 新增自審
              </button>
            ) : undefined
          }
        />
        <FilterPanel
          actions={
            (filterGroup || filterIndicator || filterKeyword) && (
              <button
                type="button"
                className="button button-outline"
                onClick={() => {
                  setFilterGroup("");
                  setFilterIndicator("");
                  setFilterKeyword("");
                }}
              >
                清除篩選
              </button>
            )
          }
        >
            <FormSelect label="年份" value={filterYear}
                  onChange={(e) => setFilterYear(Number(e.target.value))}>
                  {YEAR_FILTER_OPTIONS.map((y) => (
                    <option key={y} value={y}>
                      {yearOptionLabel(y)}
                    </option>
                  ))}
                </FormSelect>
            <FormSelect label="年別" value={statsCycle}
                  disabled
                  title="年別跟隨系統管理「統計週期」設定">
                  <option value="year">年度</option>
                  <option value="academic">學年度</option>
                </FormSelect>
            <div className="form-field">
              <label className="field-label">&nbsp;</label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={showTemp}
                  onChange={(e) => setShowTemp(e.target.checked)}
                />
                <span>顯示加審</span>
              </label>
            </div>
            <FormSelect label="組別篩選" value={filterGroup}
                  onChange={(e) => {
                    const g = e.target.value;
                    setFilterGroup(g);
                    // 組別切換後，已選指標若不在該組別內則重置
                    if (filterIndicator && g) {
                      const ind = indicators.find(
                        (i) => i.id === filterIndicator,
                      );
                      if (!ind || ind.groupId !== g) setFilterIndicator("");
                    }
                  }}>
                  <option value="">全部組別</option>
                  {[...groupMap.entries()].map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </FormSelect>
            <FormSelect label="指標篩選" value={filterIndicator}
                  onChange={(e) => setFilterIndicator(e.target.value)}>
                  <option value="">全部指標</option>
                  {indicatorOptions.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}（{i.id}）
                    </option>
                  ))}
                </FormSelect>
            <FilterSearchField
              label="指標關鍵字"
              placeholder="搜尋指標名稱或編號"
              value={filterKeyword}
              onChange={setFilterKeyword}
              onSearch={() => void loadData()}
              disabled={loading}
            />
        </FilterPanel>
        <p className="settings-note">
          年別跟隨系統管理「統計週期」設定（年度＝1–12 月；學年度＝8 月制，8
          月～隔年 7 月）。清單只列出已啟用的指標。
        </p>

        {!queried ? (
          <EmptyState
            title="請先查詢"
            description="設定年份與篩選條件後，按上方「查詢」載入排程資料。"
          />
        ) : loading ? (
          <section className="panel">
            <p className="settings-note">讀取中…</p>
          </section>
        ) : rows.length === 0 ? (
          <EmptyState
            title="尚無指標"
            description="請先到「指標管理」建立指標，再回來設定排程。"
          />
        ) : (
          <ListPanel title="排程清單" count={rows.length}>
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableTh label="組別" sortKey="group" sort={rowSort} onSort={toggleRowSort} />
                    {compact ? (
                      <SortableTh label="編號／指標名稱" sortKey="code" sort={rowSort} onSort={toggleRowSort} />
                    ) : (
                      <>
                        <SortableTh label="年別" sortKey="year" sort={rowSort} onSort={toggleRowSort} />
                        <SortableTh label="指標編號" sortKey="code" sort={rowSort} onSort={toggleRowSort} />
                        <SortableTh label="指標名稱" sortKey="name" sort={rowSort} onSort={toggleRowSort} />
                      </>
                    )}
                    <th>排程/單位設定</th>
                    <th>審查員/單位設定</th>
                    <th>操作</th>
                    <SortableTh label="最後編輯" sortKey="updated" sort={rowSort} onSort={toggleRowSort} />
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((r) => {
                    const sched = r.schedule;
                    // v1.88.5：單位排程者的 pill 只反映自己單位的設定狀態。
                    const schedDone =
                      schedulePillState(sched) === "done" &&
                      (!isUnitScheduler ||
                        !sched ||
                        scheduleInvolvesUnit(sched, myUnitCode));
                    const asg = assignments.get(r.indicatorId);
                    const asgOwnItems = (
                      isUnitScheduler && myUnitCode
                        ? (asg?.items ?? []).filter((it) =>
                            assignmentItemInvolvesUnit(it, myUnitCode),
                          )
                        : (asg?.items ?? [])
                    );
                    const asgDone = asgOwnItems.length > 0;
                    const { pending, done } = taskCountsFor(r);
                    const hasTasks = pending + done > 0;
                    // v1.18：產生排程需兩邊設定都完成（排程／單位設定：
                    // 單位≥1、月份≥1、件數>0；審查員／單位設定：分工表≥1 筆）
                    const canGenerate =
                      canEdit && !!sched && schedDone && asgDone;
                    const isTemp = r.category === "temp";
                    const tempCount =
                      tempCountByIndicator.get(r.indicatorId) ?? 0;
                    return (
                      <tr key={r.key}>
                        <td>{r.groupName}</td>
                        {compact ? (
                          <td>
                            <div className="muted-text">
                              {isTemp && (
                                <>
                                  {sched?.selfReview ? (
                                    <span className="status-pill info">自審</span>
                                  ) : (
                                    <span className="status-pill danger">加審</span>
                                  )}{" "}
                                </>
                              )}
                              {r.code}
                            </div>
                            <div>
                              <b>{r.name}</b>
                            </div>
                          </td>
                        ) : (
                          <>
                            <td>
                              {isTemp ? (
                                sched?.selfReview ? (
                                  <span className="status-pill info">自審</span>
                                ) : (
                                  <span className="status-pill danger">加審</span>
                                )
                              ) : (
                                <>
                                  {categoryLabel(r.category)}
                                  <div className="muted-text">
                                    {periodLabel(r.category, r.period)}
                                  </div>
                                </>
                              )}
                            </td>
                            <td className="muted-text">{r.code}</td>
                            <td>
                              <b>{r.name}</b>
                            </td>
                          </>
                        )}
                        <td>
                          {isTemp ? (
                            <span className={schedDone ? PILL_OK : PILL_NONE}>
                              {schedDone ? (
                                <>
                                  <CircleCheck size={13} /> 已排
                                </>
                              ) : (
                                <>
                                  <CircleDashed size={13} /> 未排
                                </>
                              )}
                            </span>
                          ) : (
                            <button
                              className="text-button"
                              onClick={() =>
                                setView({
                                  kind: "schedule",
                                  indicatorId: r.indicatorId,
                                  category: r.category as "year" | "academic",
                                  year: filterYear,
                                })
                              }
                              title={
                                sched
                                  ? "編輯排程設定"
                                  : "建立排程設定"
                              }
                            >
                              <span
                                className={schedDone ? PILL_OK : PILL_NONE}
                              >
                                {schedDone ? (
                                  <>
                                    <CircleCheck size={13} /> 已排
                                  </>
                                ) : (
                                  <>
                                    <CircleDashed size={13} /> 未排
                                  </>
                                )}
                              </span>
                            </button>
                          )}
                        </td>
                        <td>
                          <button
                            className="text-button"
                            onClick={() =>
                              setView({
                                kind: "assignment",
                                indicatorId: r.indicatorId,
                                // v1.88.13：帶入當前篩選期別（年別＋週期鍵），
                                // 分工表的單位與月份以該期「排程／單位設定」為準。
                                category: cycle,
                                period,
                              })
                            }
                            title="進入單位／審查員設定"
                          >
                            <span className={asgDone ? PILL_OK : PILL_NONE}>
                              {asgDone ? (
                                <>
                                  <CircleCheck size={13} /> 已排
                                </>
                              ) : (
                                <>
                                  <CircleDashed size={13} /> 未排
                                </>
                              )}
                            </span>
                          </button>
                          {asgDone && (
                            <div className="muted-text">
                              {asgOwnItems.length} 位審查員・
                              {asgOwnItems.reduce(
                                (n, it) => n + it.units.length,
                                0,
                              )}{" "}
                              單位
                              {asgOwnItems.some(
                                (it) => it.unlimitedUnits === true,
                              ) && "（含不限單位）"}
                            </div>
                          )}
                        </td>
                        <td>
                          <div
                            style={{
                              display: "flex",
                              gap: 10,
                              alignItems: "flex-start",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: 2,
                              }}
                            >
                              {!!sched && !isTemp && (
                                <>
                                  <button
                                    className="button button-outline button-sm"
                                    disabled={
                                      !canGenerate || generatingKey === r.key
                                    }
                                    title={
                                      !canEdit
                                        ? "需排程建立／改派權限"
                                        : !schedDone
                                          ? "請先完成排程／單位設定（單位、月份、件數皆需設定）"
                                          : !asgDone
                                            ? "請先完成審查員／單位設定（分工表至少一筆）"
                                            : "依排程展開審查任務"
                                    }
                                    onClick={() => handleGenerate(r)}
                                  >
                                    <CalendarPlus size={14} />{" "}
                                    {generatingKey === r.key
                                      ? "產生中…"
                                      : "產生排程"}
                                  </button>
                                  <span
                                    className={hasTasks ? PILL_OK : PILL_NONE}
                                  >
                                    {hasTasks ? (
                                      <>
                                        <CircleCheck size={13} /> 已排程
                                      </>
                                    ) : (
                                      <>
                                        <CircleDashed size={13} /> 未排程
                                      </>
                                    )}
                                  </span>
                                </>
                              )}
                            </div>
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: 2,
                              }}
                            >
                              {!isTemp && canEdit && (
                                <>
                                  <button
                                    className="button button-outline button-sm"
                                    onClick={() => setAddAuditRow(r)}
                                    title="建立臨時加審排程"
                                  >
                                    <Plus size={14} /> 加審
                                  </button>
                                  <div className="muted-text">
                                    加審 {tempCount} 筆
                                  </div>
                                </>
                              )}
                            </div>
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: 2,
                              }}
                            >
                              {!!sched && (
                                <button
                                  className="button button-outline button-sm"
                                  onClick={() =>
                                    setView({
                                      kind: "detail",
                                      indicatorId: r.indicatorId,
                                      category: r.category,
                                      period: r.period,
                                    })
                                  }
                                  title="查閱設定內容"
                                >
                                  <Eye size={14} /> 查閱
                                </button>
                              )}
                            </div>
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: 2,
                              }}
                            >
                              {!!sched && canDeleteRow(r) && (
                                <button
                                  className="button button-outline button-sm"
                                  onClick={() => handleDeleteSchedule(r)}
                                  title="刪除此排程（含其未完成任務；已完成任務與審查紀錄保留）"
                                >
                                  <Trash2 size={14} /> 刪除
                                </button>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="muted-text">
                          {sched ? (
                            <>
                              {sched.updatedByName || "—"}
                              <br />
                              {fmtTsDate(sched.updatedAt)}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
          </ListPanel>
        )}

        {addAuditRow && (
          <AddAuditDialog
            row={addAuditRow}
            units={units}
            users={users}
            groupMap={groupMap}
            reviewersByGroup={reviewersByGroup}
            assignment={assignments.get(addAuditRow.indicatorId) ?? null}
            restrictedUnitCodes={scheduleRestrictedUnits}
            restrictedUnitName={unitNameOf(myUnitCode)}
            actor={actor}
            deadlineDay={deadlineDay}
            filterYear={filterYear}
            cycle={cycle}
            existingTemps={schedules.filter(
              (s) =>
                s.indicatorId === addAuditRow.indicatorId &&
                s.category === "temp",
            )}
            onAction={onAction}
            onClose={() => setAddAuditRow(null)}
            onDone={() => {
              setAddAuditRow(null);
              loadData();
            }}
          />
        )}
        {selfAuditOpen && (
          <SelfAuditDialog
            indicators={indicators}
            userUnitCode={myUnitCode}
            userUnitName={myUnitName}
            unitUsers={myUnitUsers}
            usersMap={usersMap}
            actor={actor}
            deadlineDay={deadlineDay}
            onAction={onAction}
            onClose={() => setSelfAuditOpen(false)}
            onDone={() => {
              setSelfAuditOpen(false);
              loadData();
            }}
          />
        )}
      </>
    );
  }

  // ================= 子畫面 =================
  const subView = view as Exclude<View, { kind: "list" }>;
  const indicator = indicatorOf(subView.indicatorId);
  // v1.88.6：查閱整頁式的列（指標＋類別＋週期鍵定位；找不到即顯示「找不到排程」）
  const detailRow =
    view.kind === "detail"
      ? (rows.find(
          (r) =>
            r.indicatorId === view.indicatorId &&
            r.category === view.category &&
            r.period === view.period,
        ) ?? null)
      : null;
  // v1.88.13：分工表期別上下文——該期「排程／單位設定」（單位與月份來源）；
  // 無該期排程時為 null（單位與月份選項為空，提示先完成排程／單位設定）。
  const assignmentSchedule =
    view.kind === "assignment"
      ? (schedules.find(
          (s) =>
            s.indicatorId === subView.indicatorId &&
            s.category === view.category &&
            s.period === view.period,
        ) ?? null)
      : null;
  return (
    <>
      <PageHeading page="schedule" />
      {!indicator ? (
        <EmptyState title="找不到指標" description="該指標可能已被刪除。" />
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <button className="button button-outline" onClick={backToList}>
              <ArrowLeft size={15} /> 返回品管審查排程
            </button>
          </div>
          <SectionTitle
            title={indicator.name}
            note={`指標編號 ${stripInternalIdPrefix(indicator.id)}・組別 ${groupMap.get(indicator.groupId) ?? "—"}`}
          />
          {view.kind === "schedule" && (
            <ScheduleEditor
              indicatorId={indicator.id}
              indicatorName={indicator.name}
              category={view.category}
              initialYear={view.year}
              units={units}
              groupMap={groupMap}
              restrictedUnitCodes={scheduleRestrictedUnits}
              restrictedUnitName={unitNameOf(myUnitCode)}
              canEdit={canEdit}
              actor={actor}
              onAction={onAction}
              onSaved={backToList}
            />
          )}
          {view.kind === "assignment" && (
            <AssignmentEditor
              indicatorId={indicator.id}
              indicatorCode={indicator.code}
              schedule={assignmentSchedule}
              reviewersByGroup={reviewersByGroup}
              units={units}
              groupMap={groupMap}
              usersMap={usersMap}
              reviewerRoleIds={reviewerRoleIds}
              inactiveIds={inactiveIds}
              initial={assignments.get(indicator.id) ?? null}
              restrictedUnitCodes={scheduleRestrictedUnits}
              restrictedUnitName={unitNameOf(myUnitCode)}
              canEdit={canEdit}
              onAction={onAction}
              onSaved={backToList}
            />
          )}
          {view.kind === "detail" &&
            (detailRow && detailRow.schedule ? (
              <ScheduleDetailPage
                row={detailRow}
                assignment={assignments.get(detailRow.indicatorId) ?? null}
                usersMap={usersMap}
                unitNameOf={unitNameOf}
                visibleUnitCodes={scheduleScopeUnits}
                viewerStaffId={user?.staffId ?? ""}
                onAction={onAction}
              />
            ) : (
              <EmptyState
                title="找不到排程"
                description="該排程可能已被刪除，或尚未建立。"
              />
            ))}
        </>
      )}
    </>
  );
}
