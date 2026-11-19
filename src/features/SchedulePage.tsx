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
import { ArrowLeft, CalendarPlus, Check, CircleAlert, CircleCheck, CircleDashed, Eye, Pencil, Plus, Trash2 } from "lucide-react";
import { collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, where } from "../lib/db";
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
import { indicatorCodeOf, stripInternalIdPrefix, effectiveThreshold } from "../lib/indicators";
import { buildTaskIndex, buildTaskUnitIndex, type TaskUnitIndex } from "../lib/taskIndex";
import { usePermissions } from "../lib/usePermissions";
import { useAuth } from "../lib/auth";
import { isReviewerAccessActive } from "../lib/reviewerValidity";
import { useOrgMeta } from "../lib/useOrgMeta";
import { hasRoleCategory, titleFlagsOf } from "../lib/orgMeta";
import { isReviewerRole } from "../lib/roleIdentity";
import {
  assignmentItemInvolvesUnit,
  deriveCrossFlags,
  isUnitSchedulerRole,
  mergeAssignmentItemsByReviewer,
  resolveDataScope,
  rowHasOwnUnitScheduleContent,
  scheduleDeletableByUnit,
  scheduleInvolvesUnit,
  splitAssignmentItemsByUnit,
} from "../lib/dataScope";
import { ScheduleDetailPage } from "./ScheduleDetailPage";
import { staffLabel } from "../lib/mask";
import { categoryLabel, periodLabel, tempCycleMonths, type TempCycleMonth } from "../lib/cycle";
import { ASSIGNMENT_UNIT_FILTER_UNLIMITED, MONTH_LABELS, buildTasksFromSchedule, createTempSchedule, deleteScheduleWithTasks, findDuplicateAssignmentTriples, findDuplicateTempSchedule, findDuplicateUnits, filterAssignmentItems, isLockedAssignmentItem, listSchedules, normalizeAssignmentItem, parseCaseCount, periodForFilter, scheduleReviewCalendarMonths, shouldAutoLinkReviewer, YEAR_FILTER_OPTIONS, yearOptionLabel, type AssignmentItem, type IndicatorAssignment, type IndicatorSchedule } from "../lib/scheduling";
import {
  buildBelowThresholdRows,
  nextCalendarMonth,
  type BelowThresholdRow,
} from "../lib/belowThreshold";
import { fmtDateTime, fmtTsDate, fmtYm, normalizeReviewMonths, pad2, reviewMonthToYm } from "../lib/ym";
import { mergeImportedAssignments, type ParsedAssignmentRow } from "../lib/assignmentImport";
import { type IndicatorLite, type UnitLite, type UserLite, type ReviewerLite, type RowItem, type View } from "./schedule/model/types";
import { groupDisplayName, scheduleCalendarMonths, PILL_OK, PILL_NONE, schedulePillState, mergeItemsWithUnits, mergeItemsUnlimited, defaultAddAuditReviewers } from "./schedule/model/pure";
import { Modal } from "./schedule/components/Modal";
import { InactiveReviewerNotice, type PickerOption, OptionMultiPicker, CalendarMonthPicker, useCaseCountInput, AssignmentOverviewTools } from "./schedule/components/pickers";
import { ScheduleEditor } from "./schedule/components/ScheduleEditor";
import { SelfAuditDialog } from "./schedule/components/SelfAuditDialog";
import { AssignmentEditModal } from "./schedule/components/AssignmentEditModal";
import { AssignmentBatchImporter } from "./schedule/components/AssignmentBatchImporter";
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

/* ================= 加審（臨時排程；v1.18：合併兩邊設定＋分工表） ================= */

function AddAuditDialog({
  row,
  units,
  users,
  groupMap,
  reviewersByGroup,
  assignment,
  restrictedUnitCodes,
  restrictedUnitName,
  actor,
  deadlineDay,
  filterYear,
  cycle,
  existingTemps,
  onAction,
  onClose,
  onDone,
}: {
  row: RowItem;
  units: UnitLite[];
  users: UserLite[];
  groupMap: Map<string, string>;
  reviewersByGroup: Map<string, ReviewerLite[]>;
  assignment: IndicatorAssignment | null;
  /**
   * v1.88.5：單位排程者的可排單位集合（僅自己單位；null＝不設限）。
   */
  restrictedUnitCodes: ReadonlySet<string> | null;
  /** 受限時顯示用（自己單位名稱） */
  restrictedUnitName: string;
  actor: { id: string; name: string };
  deadlineDay: number;
  filterYear: number;
  cycle: "year" | "academic";
  /** 該指標既有的臨時排程（重複加審偵測＋「已加審」判定用） */
  existingTemps: IndicatorSchedule[];
  onAction: (m: string) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const restricted = restrictedUnitCodes != null;
  const restrictedUnitCode = restricted
    ? [...restrictedUnitCodes!][0] ?? ""
    : "";
  // v1.88.19：臨時排程月份選項＝該年度／學年度 12 個月＋結束後下一個月，
  // 合計 13 個明確曆年月（年度：filterYear/1–12＋(filterYear+1)/1；
  // 學年度：filterYear/8 起連續 12 個月＋次年 8 月）。
  const monthOptions = useMemo(
    () => tempCycleMonths(cycle, filterYear),
    [cycle, filterYear],
  );
  const [months, setMonths] = useState<TempCycleMonth[]>([]);
  const caseCount = useCaseCountInput();
  const [selUnits, setSelUnits] = useState<string[]>(() => {
    const ids = row.schedule?.unitIds ?? [];
    if (!restricted) return ids;
    // 受限時只帶入自己單位；原排程為不限單位或不含自己單位時預設自己單位。
    const own = ids.filter((c) => restrictedUnitCodes!.has(c));
    return own.length > 0
      ? own
      : restrictedUnitCode
        ? [restrictedUnitCode]
        : [];
  });
  // v1.51.0：不限單位（NA 排程的加審預設為不限單位模式）
  // v1.88.5：單位排程者不提供不限單位。
  const [unlimited, setUnlimited] = useState(
    () => !restricted && row.schedule?.unlimitedUnits === true,
  );
  const [selReviewers, setSelReviewers] = useState<string[]>(() =>
    row.schedule?.unlimitedUnits === true
      ? (assignment?.items ?? []).map((it) => it.reviewerId)
      : defaultAddAuditReviewers(assignment, row.schedule?.unitIds ?? []),
  );
  const [items, setItems] = useState<AssignmentItem[]>([]);
  const inactiveIds = useMemo(
    () => new Set(users.filter((u) => !u.activated && u.status !== "停用").map((u) => u.id)),
    [users],
  );
  const [saving, setSaving] = useState(false);
  // v1.60.0：常駐錯誤區（失敗訊息留著直到關閉或下次成功，不只靠一閃即逝的 toast）
  const [submitError, setSubmitError] = useState<string | null>(null);
  // v1.60.0：未達閾值挑選帶入的目標曆年（月份只是 1–12 數字，年份須明確帶入，否則 2025/7 會變成建立當年的 7 月）
  const [pickedYear, setPickedYear] = useState<number | null>(null);
  // v1.60.0：未達閾值挑選彈窗
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerRows, setPickerRows] = useState<BelowThresholdRow[] | null>(null);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);

  // 審核員候選：全部組別審查員主檔 ∪ 分工表審查員（組別由其單位推導）
  const reviewerMeta = useMemo(() => {
    const map = new Map<string, { name: string; groupId: string }>();
    reviewersByGroup.forEach((arr, gid) => {
      for (const r of arr) {
        if (!map.has(r.personId))
          map.set(r.personId, { name: r.name, groupId: gid });
      }
    });
    for (const it of assignment?.items ?? []) {
      if (map.has(it.reviewerId)) continue;
      const u = users.find((x) => x.id === it.reviewerId);
      if (!u?.reviewerAccessActive) continue;
      const g = units.find((x) => x.code === u?.unitCode)?.groupId ?? "";
      map.set(it.reviewerId, { name: u?.name ?? it.reviewerId, groupId: g });
    }
    return map;
  }, [reviewersByGroup, assignment, users, units]);

  const reviewerOptions: PickerOption[] = useMemo(
    () =>
      [...reviewerMeta.entries()]
        .map(([id, m]) => ({
          id,
          label: staffLabel(id, m.name),
          sub: m.groupId ? groupDisplayName(groupMap, m.groupId) : "分工表",
          groupId: m.groupId,
        }))
        .sort((a, b) => a.id.localeCompare(b.id, "zh-Hant")),
    [reviewerMeta, groupMap],
  );

  const unitOptions: PickerOption[] = useMemo(
    () =>
      units
        // v1.88.5：單位排程者只看得到自己單位可選。
        .filter((u) => !restricted || restrictedUnitCodes!.has(u.code))
        .map((u) => ({
          id: u.code,
          label: `${u.name}（${u.code}）`,
          sub: groupDisplayName(groupMap, u.groupId),
          groupId: u.groupId,
        })),
    [units, groupMap, restricted, restrictedUnitCodes],
  );

  const reviewerNameOf = useCallback(
    (id: string) => staffLabel(id, reviewerMeta.get(id)?.name ?? ""),
    [reviewerMeta],
  );
  const unitNameOf = useCallback(
    (code: string) => units.find((u) => u.code === code)?.name ?? code,
    [units],
  );

  const duplicates = useMemo(() => findDuplicateUnits(items), [items]);

  // v1.88.16：分工總覽篩選＋勾選刪除（只改本地 state，確認加審時才寫入）
  const [assignSearch, setAssignSearch] = useState("");
  const [assignUnitFilter, setAssignUnitFilter] = useState("");
  const [assignChecked, setAssignChecked] = useState<string[]>([]);
  // v1.88.16：編輯分工（只改本地 state，確認加審時才寫入）
  const [editingReviewerId, setEditingReviewerId] = useState<string | null>(
    null,
  );
  const filteredItems = useMemo(
    () =>
      filterAssignmentItems(
        items,
        assignSearch,
        assignUnitFilter,
        reviewerNameOf,
      ),
    [items, assignSearch, assignUnitFilter, reviewerNameOf],
  );
  const assignUnitOptions = useMemo(() => {
    const codes = [
      ...new Set(items.flatMap((it) => it.units.map((u) => u.unitId))),
    ].sort();
    const opts = codes.map((code) => ({
      value: code,
      label: `${unitNameOf(code)}（${code}）`,
    }));
    if (items.some((it) => it.unlimitedUnits === true))
      opts.unshift({
        value: ASSIGNMENT_UNIT_FILTER_UNLIMITED,
        label: "不限單位",
      });
    return opts;
  }, [items, unitNameOf]);
  // 可勾選列＝篩選結果中未鎖定的列（受限時不限單位項目鎖定，不可勾選／刪除）
  const selectableItems = useMemo(
    () => filteredItems.filter((it) => !isLockedAssignmentItem(it, restricted)),
    [filteredItems, restricted],
  );
  const allAssignChecked =
    selectableItems.length > 0 &&
    selectableItems.every((it) => assignChecked.includes(it.reviewerId));
  // 分工列被逐列／逐單位移除後，勾選清單一併清除已不在表上的職編
  useEffect(() => {
    setAssignChecked((prev) =>
      prev.filter((id) => items.some((it) => it.reviewerId === id)),
    );
  }, [items]);

  function toggleAssignChecked(reviewerId: string, next: boolean) {
    setAssignChecked((prev) =>
      next ? [...prev, reviewerId] : prev.filter((x) => x !== reviewerId),
    );
  }

  function toggleAssignAll(next: boolean) {
    setAssignChecked((prev) =>
      next
        ? [
            ...new Set([
              ...prev,
              ...selectableItems.map((it) => it.reviewerId),
            ]),
          ]
        : prev.filter(
            (id) => !selectableItems.some((it) => it.reviewerId === id),
          ),
    );
  }

  function removeSelectedAssignments() {
    if (assignChecked.length === 0) return;
    const names = assignChecked.map((id) => reviewerNameOf(id)).join("、");
    const ok = window.confirm(
      `確定刪除以下 ${assignChecked.length} 位審查員的分工？\n${names}\n\n（只改畫面，按「確認加審」才建立；取消即復原）`,
    );
    if (!ok) return;
    const toDelete = new Set(assignChecked);
    setItems((prev) =>
      prev.filter(
        (it) =>
          !toDelete.has(it.reviewerId) ||
          isLockedAssignmentItem(it, restricted),
      ),
    );
    setAssignChecked([]);
  }

  const editingItem = useMemo(
    () => items.find((it) => it.reviewerId === editingReviewerId) ?? null,
    [items, editingReviewerId],
  );
  // 編輯單位選項＝本對話框單位選項 ∪ 該列既有單位
  // （舊單位不在選項內時併入，避免一開編輯未改就洗掉）。
  const editUnitOptions = useMemo(() => {
    if (editingItem == null) return unitOptions;
    const have = new Set(unitOptions.map((o) => o.id));
    const extra = editingItem.units
      .map((u) => u.unitId)
      .filter((c) => !have.has(c))
      .map((c) => ({
        id: c,
        label: `${unitNameOf(c)}（${c}）`,
        sub: "",
        groupId: units.find((u) => u.code === c)?.groupId ?? "",
      }));
    return [...unitOptions, ...extra];
  }, [editingItem, unitOptions, unitNameOf, units]);

  // v1.88.16：編輯儲存——按 reviewerId 原地取代（取代語意），絕對不用附加新列；
  // 每單位件數沿用原值（編輯不改件數）；reviewMonths 原值保留（對話框的列無月份欄）。
  function saveAssignmentEdit(next: {
    units: string[];
    unlimited: boolean;
    reviewMonths: string[] | undefined;
  }) {
    if (editingItem == null) return;
    const caseCountByUnit = new Map(
      editingItem.units.map((u) => [u.unitId, u.caseCount]),
    );
    const item: AssignmentItem = {
      reviewerId: editingItem.reviewerId,
      units: next.unlimited
        ? []
        : next.units
            .map((unitId) => ({
              unitId,
              caseCount: caseCountByUnit.get(unitId) ?? null,
            }))
            .sort((a, b) => a.unitId.localeCompare(b.unitId, "zh-Hant")),
      ...(next.unlimited ? { unlimitedUnits: true as const } : {}),
      ...(editingItem.reviewMonths && editingItem.reviewMonths.length > 0
        ? { reviewMonths: [...editingItem.reviewMonths] }
        : {}),
    };
    setItems((prev) =>
      prev.map((it) => (it.reviewerId === item.reviewerId ? item : it)),
    );
    setEditingReviewerId(null);
  }

  // v1.60.0：未達閾值挑選清單（開啟彈窗時載入）：該指標全部審查紀錄
  // （帶 taskId 才能 join 任務判常規／加審）＋任務表＋既有臨時排程。
  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    (async () => {
      setPickerLoading(true);
      setPickerError(null);
      setPickerRows(null);
      try {
        const db = getFirebaseDb();
        const [recSnap, taskSnap, indSnap] = await Promise.all([
          getDocs(
            query(
              collection(db, "reviewRecords"),
              where("indicatorId", "==", row.indicatorId),
            ),
          ),
          getDocs(
            query(
              collection(db, "reviewTasks"),
              where("indicatorId", "==", row.indicatorId),
            ),
          ),
          getDoc(doc(db, "indicators", row.indicatorId)),
        ]);
        if (cancelled) return;
        const threshold = effectiveThreshold(
          indSnap.exists()
            ? (indSnap.data() as Record<string, unknown>)
            : {},
        );
        const records = recSnap.docs.map((d) => {
          const v = d.data() as Record<string, unknown>;
          return {
            taskId: String(v.taskId ?? ""),
            indicatorId: String(v.indicatorId ?? ""),
            unitId: String(v.unitId ?? ""),
            year: Number(v.year ?? 0),
            month: Number(v.month ?? 0),
            rate: typeof v.rate === "number" ? v.rate : null,
            thresholdAtSchedule:
              typeof v.thresholdAtSchedule === "number"
                ? v.thresholdAtSchedule
                : undefined,
          };
        });
        const tasks = taskSnap.docs.map((d) => {
          const v = d.data() as Record<string, unknown>;
          return {
            id: d.id,
            scheduleCategory:
              typeof v.scheduleCategory === "string"
                ? v.scheduleCategory
                : undefined,
          };
        });
        // v1.88.5：單位排程者的未達閾值挑選只列自己單位的列。
        const builtRows = buildBelowThresholdRows({
          records,
          tasks,
          indicatorId: row.indicatorId,
          threshold,
          tempSchedules: existingTemps,
        });
        setPickerRows(
          restricted
            ? builtRows
                .filter((r) =>
                  r.units.some((u) => u.unitId === restrictedUnitCode),
                )
                .map((r) => ({
                  ...r,
                  units: r.units.filter(
                    (u) => u.unitId === restrictedUnitCode,
                  ),
                }))
            : builtRows,
        );
      } catch (error) {
        if (!cancelled)
          setPickerError(`讀取未達閾值清單失敗：${toErrorMessage(error)}`);
      } finally {
        if (!cancelled) setPickerLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pickerOpen, row.indicatorId, existingTemps]);

  /** v1.60.0：點某個失敗年月 → 預填下一個月（完整年月）＋該月未達單位；件數與審查員由使用者補填 */
  function applyBelowThresholdRow(r: BelowThresholdRow) {
    const target = nextCalendarMonth(r.year, r.month);
    setMonths([{ year: target.year, month: target.month }]);
    setPickedYear(target.year);
    // v1.88.5：單位排程者只帶入自己單位。
    const ownUnits = restricted
      ? r.units
          .map((u) => u.unitId)
          .filter((c) => restrictedUnitCodes!.has(c))
      : r.units.map((u) => u.unitId);
    setSelUnits(
      ownUnits.length > 0
        ? ownUnits
        : restricted && restrictedUnitCode
          ? [restrictedUnitCode]
          : [],
    );
    setUnlimited(false);
    setPickerOpen(false);
  }

  function toggleId(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  function applyToTable() {
    if (selReviewers.length === 0) {
      onAction("請先選擇審核員");
      return;
    }
    // v1.88.5：防護——單位排程者不得以不限單位加入分工表。
    if (restricted && unlimited) {
      onAction("僅能為自己單位建立加審，不提供不限單位");
      return;
    }
    if (unlimited) {
      setItems((prev) => mergeItemsUnlimited(prev, selReviewers));
      setSelReviewers([]);
      return;
    }
    if (selUnits.length === 0) {
      onAction("請至少勾選一個單位");
      return;
    }
    setItems((prev) => mergeItemsWithUnits(prev, selReviewers, selUnits));
    setSelReviewers([]);
    setSelUnits([]);
  }

  function removeItem(reviewerId: string) {
    setItems((prev) => prev.filter((it) => it.reviewerId !== reviewerId));
  }

  function removeUnit(reviewerId: string, unitId: string) {
    setItems((prev) =>
      prev
        .map((it) => {
          // v1.51.0：不限單位項目沒有單位列，守旗標不刪項目
          if (it.reviewerId === reviewerId && it.unlimitedUnits === true)
            return it;
          return it.reviewerId === reviewerId
            ? { ...it, units: it.units.filter((u) => u.unitId !== unitId) }
            : it;
        })
        .filter((it) => it.unlimitedUnits === true || it.units.length > 0),
    );
  }

  // v1.51.0：不限單位項目每位審查員計 1 組配對（每月份一筆任務）
  const pairCount = items.reduce(
    (n, it) => n + (it.unlimitedUnits === true ? 1 : it.units.length),
    0,
  );
  const previewTasks = months.length * pairCount;

  async function handleConfirm() {
    // v1.60.0：防重入（按鈕 disabled 之外再守一道，避免連點在同一個
    // React 批次內兩次進入建立流程而產生重複加審）
    if (saving) return;
    setSubmitError(null);
    if (months.length === 0) {
      onAction("請至少選擇一個審查月份");
      return;
    }
    if (caseCount.value.trim() === "") {
      onAction("請填寫審查件數");
      return;
    }
    if (items.length === 0) {
      onAction("請先將審核員與單位加入分工表");
      return;
    }
    // v1.60.0：短時間內相同內容（同月份、同單位集合）的加審擋下，
    // 避免重複建立；不同月份／單位／隔天以上的正常第二次加審不受影響
    // v1.88.19：月份為明確曆年月（13 個月可跨曆年），重複比對以曆年月為準。
    const dialogCalendarMonths = months.map(
      (m) => `${m.year}/${pad2(m.month)}`,
    );
    const dup = findDuplicateTempSchedule(
      existingTemps,
      {
        months: [...new Set(months.map((m) => m.month))].sort(
          (a, b) => a - b,
        ),
        calendarMonths: dialogCalendarMonths,
        unitIds: items.flatMap((it) => it.units.map((u) => u.unitId)),
        unlimitedUnits: items.some((it) => it.unlimitedUnits === true),
        selfReview: false,
      },
      Date.now(),
    );
    if (dup) {
      const d = new Date(Number(dup.period));
      const dupTime = Number.isNaN(d.getTime())
        ? ""
        : `（建立於 ${fmtDateTime(d)}）`;
      const dupMonthsLabel =
        dup.calendarMonths && dup.calendarMonths.length > 0
          ? dup.calendarMonths
              .map((ym) => {
                const p = reviewMonthToYm(ym);
                return p ? fmtYm(p.year, p.month) : ym;
              })
              .join("、")
          : [...dup.months]
              .sort((a, b) => a - b)
              .map((m) => MONTH_LABELS[m - 1])
              .join("、");
      const msg = `已有相同內容的加審${dupTime}建立（${dupMonthsLabel}・${dup.unlimitedUnits ? "不限單位" : `${dup.unitIds.length} 單位`}），請先查閱既有加審，確認是否重複。`;
      setSubmitError(msg);
      onAction(msg);
      return;
    }
    // v1.88.16：三元組重疊檢測——同一位審查員、同單位、同一月份重複指派時
    // 跳提醒、拒絕建立（整張表都不存）。對話框的列無 reviewMonths，
    // 有效月份＝全域審查月份＋目標年份；不限單位（unitId ""）與具體單位不算重疊。
    // v1.88.19：三元組比對用明確曆年月（dialogCalendarMonths 已在上方算出）。
    const dialogMonths = dialogCalendarMonths;
    const tripleDups = findDuplicateAssignmentTriples(items, () => dialogMonths);
    if (tripleDups.length > 0) {
      const lines = tripleDups.slice(0, 10).map((d) => {
        const ym = reviewMonthToYm(d.month);
        const monthLabel = ym ? fmtYm(ym.year, ym.month) : d.month;
        const unitLabel =
          d.unitId === ""
            ? "不限單位"
            : `${unitNameOf(d.unitId)}（${d.unitId}）`;
        return `${reviewerNameOf(d.reviewerId)}・${unitLabel}・${monthLabel} 重複指派`;
      });
      if (tripleDups.length > 10)
        lines.push(`…等共 ${tripleDups.length} 筆重複`);
      const tripleMsg = `以下分工有重複指派（同一位審查員、同單位、同一月份），請修正後再建立：\n${lines.join("\n")}`;
      setSubmitError(tripleMsg);
      onAction(tripleMsg);
      return;
    }
    setSaving(true);
    try {
      const db = getFirebaseDb();
      const { taskCount } = await createTempSchedule(db, {
        indicatorId: row.indicatorId,
        unitIds: [],
        months: [...new Set(months.map((m) => m.month))].sort(
          (a, b) => a - b,
        ),
        // v1.88.19：明確曆年月（13 個月可跨曆年），任務曆年以此為準。
        calendarMonths: dialogCalendarMonths,
        caseCount: parseCaseCount(Number(caseCount.value)),
        reviewerIds: [],
        items,
        refYear: pickedYear ?? filterYear,
        // v1.60.0：挑選帶入的目標曆年；未挑選時沿用舊行為（建立當年）
        yearOverride: pickedYear ?? undefined,
        selfReview: false,
        actor,
        deadlineDay,
      });
      onAction(`已建立加審排程（臨時）：${taskCount} 筆任務`);
      onDone();
    } catch (error) {
      const msg = `加審失敗：${toErrorMessage(error)}`;
      setSubmitError(msg);
      console.error("[加審失敗]", error);
      onAction(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Modal
        title={`加審：${row.name}`}
        note={`建立臨時排程並直接產生任務（${cycle === "academic" ? "學年度" : "年度"}月份：${fmtYm(monthOptions[0].year, monthOptions[0].month)}～${fmtYm(monthOptions[monthOptions.length - 1].year, monthOptions[monthOptions.length - 1].month)}，共 13 個月可選）`}
        onClose={onClose}
        medium
      >
      <div className="form-field">
        <label className="field-label">
          審查月份（可複選）
          {months.length > 0 && `：已選 ${months.length} 個月`}
        </label>
        <CalendarMonthPicker
          options={monthOptions}
          selected={months}
          onChange={setMonths}
          disabled={false}
        />
        <p className="settings-note">
          提供該{cycle === "academic" ? "學年度" : "年度"}全部 12
          個月＋結束後下一個月，共 13 個月可選。
        </p>
        <div className="form-actions" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="button button-outline button-sm"
            onClick={() => setPickerOpen(true)}
          >
            由未達閾值挑選
          </button>
          {pickedYear != null && (
            <span className="muted-text">
              目標年份 {pickedYear} 年（由未達閾值挑選帶入，月份／單位仍可手動改）
            </span>
          )}
        </div>
        {cycle === "academic" && (
          <p className="settings-note">
            學年度月份依 8 月制順序排列（8–12 月為前一年曆年、1–7
            月為後一年曆年）。
          </p>
        )}
      </div>

      <div className="form-field">
        <label className="field-label">
          審查件數 *
          <span className="muted-text">（必填，所有單位共用）</span>
        </label>
        <span className="case-count-field">
          <input
            type="number"
            min={1}
            step={1}
            value={caseCount.value}
            placeholder="必填"
            onChange={(e) => caseCount.onInput(e.target.value)}
            aria-label="審查件數"
          />
          件
        </span>
      </div>

      <label className="check-row" style={{ marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={unlimited}
          // v1.88.5：單位排程者不提供不限單位。
          disabled={restricted}
          onChange={(e) => setUnlimited(e.target.checked)}
        />
        <b>不限單位</b>
        <span className="muted-text">
          （不固定單位；單位顯示為 NA，審查時不用選單位）
          {restricted && "；單位召集人／執行幹事僅能為自己單位排程，不提供此選項"}
        </span>
      </label>
      {restricted && (
        <p className="settings-note">
          僅能為自己單位（{restrictedUnitName || "尚未設定所屬單位"}）建立加審。
        </p>
      )}

      <OptionMultiPicker
        title="選擇受審單位"
        options={unitOptions}
        groupMap={groupMap}
        selected={selUnits}
        onToggle={(id) => setSelUnits((prev) => toggleId(prev, id))}
        disabled={unlimited}
        searchPlaceholder="搜尋單位名稱或代碼"
      />

      <OptionMultiPicker
        title="選擇審核員"
        options={reviewerOptions}
        groupMap={groupMap}
        selected={selReviewers}
        onToggle={(id) => setSelReviewers((prev) => toggleId(prev, id))}
        searchPlaceholder="搜尋姓名或職編"
      />

      <div className="form-actions">
        <button
          className="button button-outline"
          disabled={
            selReviewers.length === 0 || (!unlimited && selUnits.length === 0)
          }
          onClick={applyToTable}
        >
          <Plus size={15} /> 加入分工表
        </button>
      </div>

      <SectionTitle
        title="分工總覽"
        note={
          items.length === 0
            ? "尚無分工資料"
            : `${items.length} 位審核員・${pairCount} 組指派${items.some((it) => it.unlimitedUnits === true) ? "（含不限單位）" : ""}`
        }
      />
      {items.length === 0 ? (
        <p className="settings-note">由上方選擇單位與審核員後加入。</p>
      ) : (
        <>
          <AssignmentOverviewTools
            search={assignSearch}
            onSearchChange={setAssignSearch}
            unitFilter={assignUnitFilter}
            onUnitFilterChange={setAssignUnitFilter}
            unitOptions={assignUnitOptions}
            checkedCount={assignChecked.length}
            onDeleteSelected={removeSelectedAssignments}
            deleteDisabled={assignChecked.length === 0}
          />
          {filteredItems.length === 0 ? (
            <p className="settings-note">無符合篩選條件的分工資料。</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>
                      <input
                        type="checkbox"
                        checked={allAssignChecked}
                        onChange={(e) => toggleAssignAll(e.target.checked)}
                        aria-label="全選"
                      />
                    </th>
                    <th>審核員</th>
                    <th>負責單位</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((it) => (
                    <tr key={it.reviewerId}>
                      <td>
                        <input
                          type="checkbox"
                          checked={assignChecked.includes(it.reviewerId)}
                          disabled={isLockedAssignmentItem(it, restricted)}
                          onChange={(e) =>
                            toggleAssignChecked(
                              it.reviewerId,
                              e.target.checked,
                            )
                          }
                          aria-label={`選擇 ${it.reviewerId}`}
                        />
                      </td>
                      <td>
                        <b>{reviewerNameOf(it.reviewerId)}</b>
                        <div className="muted-text">{it.reviewerId}</div>
                      </td>
                      <td>
                        {it.unlimitedUnits === true ? (
                          <span>不限單位</span>
                        ) : (
                          it.units.map((u) => (
                            <div key={u.unitId} className="assign-unit-row">
                              <span>
                                {unitNameOf(u.unitId)}
                                <span className="muted-text">（{u.unitId}）</span>
                                {duplicates.has(u.unitId) && (
                                  <CircleAlert
                                    size={13}
                                    className="dup-warn"
                                    aria-label="重複指派"
                                  />
                                )}
                              </span>
                              <button
                                className="text-button"
                                onClick={() => removeUnit(it.reviewerId, u.unitId)}
                                aria-label={`移除${u.unitId}`}
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          ))
                        )}
                      </td>
                      <td>
                        {isLockedAssignmentItem(it, restricted) ? (
                          <span
                            className="muted-text"
                            title="不限單位項目涵蓋所有單位，單位排程者不得移除"
                          >
                            鎖定
                          </span>
                        ) : (
                          <span style={{ display: "inline-flex", gap: 4 }}>
                            <button
                              className="text-button"
                              onClick={() =>
                                setEditingReviewerId(it.reviewerId)
                              }
                            >
                              <Pencil size={13} /> 編輯
                            </button>
                            <button
                              className="text-button"
                              onClick={() => removeItem(it.reviewerId)}
                            >
                              <Trash2 size={13} /> 移除
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <InactiveReviewerNotice
        reviewerIds={items.map((it) => it.reviewerId)}
        inactiveIds={inactiveIds}
        nameOf={(id) => users.find((u) => u.id === id)?.name ?? ""}
      />
      <div className="form-field" style={{ marginTop: 12 }}>
        <label className="field-label">預覽</label>
        <p>
          <b>{previewTasks}</b> 筆任務
          <span className="muted-text">
            （{months.length} 個月 × {pairCount}{" "}
            組審核員{unlimited ? "" : "-單位"}配對
            {items.some((it) => it.unlimitedUnits === true)
              ? "；不限單位項目每位審查員每月一筆任務"
              : ""}
            ）
          </span>
        </p>
      </div>

      {submitError && (
        <div className="form-error" role="alert">
          {submitError}
        </div>
      )}

      <div className="form-actions">
        <button
          className="button button-primary"
          disabled={saving || previewTasks === 0}
          onClick={handleConfirm}
        >
          {saving ? "建立中…" : (
            <>
              <Check size={15} /> 確認加審
            </>
          )}
        </button>
        <button className="button button-ghost" onClick={onClose}>
          取消
        </button>
      </div>
      </Modal>

      {pickerOpen && (
        <Modal
          title={`未達閾值清單：${row.name}`}
          note="常規審查中未達閾值的年月及單位（點年月自動帶入下一個月與該月未達單位）"
          onClose={() => setPickerOpen(false)}
          layer={2}
        >
          {pickerLoading ? (
            <p className="settings-note">讀取中…</p>
          ) : pickerError ? (
            <div className="form-error" role="alert">
              {pickerError}
            </div>
          ) : pickerRows && pickerRows.length === 0 ? (
            <p className="settings-note">
              此指標目前沒有常規審查未達閾值的年月。
            </p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>年月</th>
                    <th>審查結果</th>
                    <th>未達單位</th>
                    <th>狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {(pickerRows ?? []).map((r) => {
                    const target = nextCalendarMonth(r.year, r.month);
                    return (
                      <tr key={`${r.year}-${r.month}`}>
                        <td>
                          <button
                            className="text-button"
                            onClick={() => applyBelowThresholdRow(r)}
                            title={`帶入 ${fmtYm(target.year, target.month)} 與未達單位`}
                          >
                            <b>
                              {r.year}/{r.month}
                            </b>
                          </button>
                        </td>
                        <td>
                          {r.units
                            .map(
                              (u) =>
                                `${u.unitId} ${u.rate}%(${u.pass}/${u.total})`,
                            )
                            .join("、")}
                          <div className="muted-text">
                            閾值 {r.threshold}%
                          </div>
                        </td>
                        <td>
                          {r.units
                            .map(
                              (u) =>
                                `${unitNameOf(u.unitId)}（${u.unitId}）`,
                            )
                            .join("、")}
                        </td>
                        <td>
                          {r.alreadyAddReviewed ? (
                            <span className="status-pill info">已加審</span>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="settings-note">
            點年月自動選取下一個月及該月未達單位；件數與審查員請回加審對話框指定，月份／單位仍可手動增減。
          </p>
          <div className="form-actions">
            <button
              className="button button-ghost"
              onClick={() => setPickerOpen(false)}
            >
              關閉
            </button>
          </div>
        </Modal>
      )}

      {editingItem != null && (
        <AssignmentEditModal
          key={editingItem.reviewerId}
          reviewerLabel={reviewerNameOf(editingItem.reviewerId)}
          unitOptions={editUnitOptions}
          groupMap={groupMap}
          initialUnits={editingItem.units.map((u) => u.unitId)}
          initialUnlimited={editingItem.unlimitedUnits === true}
          allowUnlimited={!restricted}
          onSave={saveAssignmentEdit}
          onClose={() => setEditingReviewerId(null)}
          layer={3}
        />
      )}
    </>
  );
}

function AssignmentEditor({
  indicatorId,
  indicatorCode,
  schedule,
  reviewersByGroup,
  units,
  groupMap,
  usersMap,
  reviewerRoleIds,
  inactiveIds,
  initial,
  restrictedUnitCodes,
  restrictedUnitName,
  canEdit,
  onAction,
  onSaved,
}: {
  indicatorId: string;
  /** v1.88.13：目前頁面指標的代號（匯入核對用） */
  indicatorCode: string;
  /**
   * v1.88.13：該期「排程／單位設定」（單位與月份來源）；
   * null＝本期尚無排程，單位與月份選項為空。
   */
  schedule: IndicatorSchedule | null;
  reviewersByGroup: Map<string, ReviewerLite[]>;
  units: UnitLite[];
  groupMap: Map<string, string>;
  usersMap: Map<string, string>;
  reviewerRoleIds: Set<string>;
  inactiveIds: Set<string>;
  initial: IndicatorAssignment | null;
  /**
   * v1.88.5：單位排程者的可排單位集合（僅自己單位；null＝不設限）。
   */
  restrictedUnitCodes: ReadonlySet<string> | null;
  /** 受限時顯示用（自己單位名稱） */
  restrictedUnitName: string;
  canEdit: boolean;
  onAction: (m: string) => void;
  onSaved: () => void;
}) {
  const restricted = restrictedUnitCodes != null;
  const restrictedUnitCode = restricted
    ? [...restrictedUnitCodes!][0] ?? ""
    : "";
  // v1.88.5：受限時，初始分工表按單位拆分——state 只留自己單位的部分
  // （不限單位項目整筆保留、鎖定），其餘部分另存，儲存時合併還原，
  // 不因編輯而刪除其他單位的分工。
  const splitInitial = useMemo(
    () =>
      restricted
        ? splitAssignmentItemsByUnit(initial?.items ?? [], restrictedUnitCode)
        : {
            own: initial?.items ?? [],
            other: [] as AssignmentItem[],
          },
    // initial 只在掛載時讀取（與既有 items state 相同語意）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [otherItems] = useState<AssignmentItem[]>(splitInitial.other);
  const [items, setItems] = useState<AssignmentItem[]>(
    splitInitial.own.map((it) => ({
      reviewerId: it.reviewerId,
      units: it.units.map((u) => ({ ...u })),
      ...(it.unlimitedUnits === true
        ? { unlimitedUnits: true as const }
        : {}),
      // v1.88.13：審查月份一併帶入 state（缺值＝全部月份）。
      ...(it.reviewMonths && it.reviewMonths.length > 0
        ? { reviewMonths: [...it.reviewMonths] }
        : {}),
    })),
  );
  const [selReviewers, setSelReviewers] = useState<string[]>([]);
  const [selUnits, setSelUnits] = useState<string[]>([]);
  // v1.51.0：不限單位模式（此審查員不固定單位）
  const [unlimited, setUnlimited] = useState(false);
  // v1.88.13：第 3 步：審查月份（多選，必填；候選＝該期排程的審查曆月）
  const [selMonths, setSelMonths] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  /** 該期排程的審查曆月（"yyyy/mm"，依曆年月排序；無排程為空） */
  const scheduleMonths: string[] = useMemo(
    () =>
      schedule
        ? scheduleReviewCalendarMonths(schedule).map(
            ({ year, month }) => `${year}/${pad2(month)}`,
          )
        : [],
    [schedule],
  );
  const scheduleMonthSet = useMemo(
    () => new Set(scheduleMonths),
    [scheduleMonths],
  );

  // 審查員候選：全部組別的審查員主檔（組別下拉篩選）
  const reviewerOptions: PickerOption[] = useMemo(() => {
    const out: PickerOption[] = [];
    reviewersByGroup.forEach((arr, gid) => {
      for (const r of arr) {
        out.push({
          id: r.personId,
          label: staffLabel(r.personId, r.name),
          sub: groupDisplayName(groupMap, gid),
          groupId: gid,
        });
      }
    });
    return out.sort((a, b) => a.id.localeCompare(b.id, "zh-Hant"));
  }, [reviewersByGroup, groupMap]);

  const unitOptions: PickerOption[] = useMemo(
    () =>
      units
        // v1.88.13：要審查的單位來自該期「排程／單位設定」的 unitIds；
        // 排程不限單位時不設限；無該期排程時選項為空。
        .filter((u) =>
          schedule == null
            ? false
            : schedule.unlimitedUnits
              ? true
              : schedule.unitIds.includes(u.code),
        )
        // v1.88.5：單位排程者只看得到自己單位可選。
        .filter((u) => !restricted || restrictedUnitCodes!.has(u.code))
        .map((u) => ({
          id: u.code,
          label: `${u.name}（${u.code}）`,
          sub: groupDisplayName(groupMap, u.groupId),
          groupId: u.groupId,
        })),
    [units, groupMap, restricted, restrictedUnitCodes, schedule],
  );

  const reviewerName = useCallback(
    (id: string) => {
      for (const arr of reviewersByGroup.values()) {
        const r = arr.find((x) => x.personId === id);
        if (r) return staffLabel(id, r.name);
      }
      return staffLabel(id, usersMap.get(id) ?? "");
    },
    [reviewersByGroup, usersMap],
  );

  const unitNameOf = useCallback(
    (code: string) => units.find((u) => u.code === code)?.name ?? code,
    [units],
  );

  const duplicates = useMemo(() => findDuplicateUnits(items), [items]);

  // v1.88.16：分工總覽篩選＋勾選刪除（只改本地 state，按「儲存分工表」才寫入）
  const [assignSearch, setAssignSearch] = useState("");
  const [assignUnitFilter, setAssignUnitFilter] = useState("");
  // v1.88.16：審查月份篩選（與審查員、單位複合查詢，AND）
  const [assignMonthFilter, setAssignMonthFilter] = useState("");
  const [assignChecked, setAssignChecked] = useState<string[]>([]);
  // v1.88.16：編輯分工（只改本地 state，按「儲存分工表」才寫入）
  const [editingReviewerId, setEditingReviewerId] = useState<string | null>(
    null,
  );
  const filteredItems = useMemo(
    () =>
      filterAssignmentItems(
        items,
        assignSearch,
        assignUnitFilter,
        reviewerName,
        assignMonthFilter,
      ),
    [items, assignSearch, assignUnitFilter, reviewerName, assignMonthFilter],
  );
  // 月份篩選選項＝表內出現的月份聯集（去重排序；缺值列不貢獻選項，但篩選任一月份都算符合）
  const assignMonthOptions = useMemo(() => {
    const months = [
      ...new Set(items.flatMap((it) => normalizeReviewMonths(it.reviewMonths))),
    ].sort();
    return months.map((m) => {
      const ym = reviewMonthToYm(m);
      return { value: m, label: ym ? fmtYm(ym.year, ym.month) : m };
    });
  }, [items]);
  const assignUnitOptions = useMemo(() => {
    const codes = [
      ...new Set(items.flatMap((it) => it.units.map((u) => u.unitId))),
    ].sort();
    const opts = codes.map((code) => ({
      value: code,
      label: `${unitNameOf(code)}（${code}）`,
    }));
    if (items.some((it) => it.unlimitedUnits === true))
      opts.unshift({
        value: ASSIGNMENT_UNIT_FILTER_UNLIMITED,
        label: "不限單位",
      });
    return opts;
  }, [items, unitNameOf]);
  // 可勾選列＝篩選結果中未鎖定的列（受限時不限單位項目鎖定，不可勾選／刪除）
  const selectableItems = useMemo(
    () => filteredItems.filter((it) => !isLockedAssignmentItem(it, restricted)),
    [filteredItems, restricted],
  );
  const allAssignChecked =
    selectableItems.length > 0 &&
    selectableItems.every((it) => assignChecked.includes(it.reviewerId));
  // 分工列被逐列／逐單位移除後，勾選清單一併清除已不在表上的職編
  useEffect(() => {
    setAssignChecked((prev) =>
      prev.filter((id) => items.some((it) => it.reviewerId === id)),
    );
  }, [items]);

  function toggleAssignChecked(reviewerId: string, next: boolean) {
    setAssignChecked((prev) =>
      next ? [...prev, reviewerId] : prev.filter((x) => x !== reviewerId),
    );
  }

  function toggleAssignAll(next: boolean) {
    setAssignChecked((prev) =>
      next
        ? [
            ...new Set([
              ...prev,
              ...selectableItems.map((it) => it.reviewerId),
            ]),
          ]
        : prev.filter(
            (id) => !selectableItems.some((it) => it.reviewerId === id),
          ),
    );
  }

  function removeSelectedAssignments() {
    if (assignChecked.length === 0) return;
    const names = assignChecked.map((id) => reviewerName(id)).join("、");
    const ok = window.confirm(
      `確定刪除以下 ${assignChecked.length} 位審查員的分工？\n${names}\n\n（只改畫面，按「儲存分工表」才寫入；未儲存就離開，分工會復原）`,
    );
    if (!ok) return;
    const toDelete = new Set(assignChecked);
    setItems((prev) =>
      prev.filter(
        (it) =>
          !toDelete.has(it.reviewerId) ||
          isLockedAssignmentItem(it, restricted),
      ),
    );
    setAssignChecked([]);
  }

  const editingItem = useMemo(
    () => items.find((it) => it.reviewerId === editingReviewerId) ?? null,
    [items, editingReviewerId],
  );
  // 編輯單位選項＝該期排程單位選項 ∪ 該列既有單位
  // （舊單位不在本期排程內時併入，避免一開編輯未改就洗掉）。
  const editUnitOptions = useMemo(() => {
    if (editingItem == null) return unitOptions;
    const have = new Set(unitOptions.map((o) => o.id));
    const extra = editingItem.units
      .map((u) => u.unitId)
      .filter((c) => !have.has(c))
      .map((c) => ({
        id: c,
        label: `${unitNameOf(c)}（${c}）`,
        sub: "",
        groupId: units.find((u) => u.code === c)?.groupId ?? "",
      }));
    return [...unitOptions, ...extra];
  }, [editingItem, unitOptions, unitNameOf, units]);

  // v1.88.16：編輯儲存——按 reviewerId 原地取代（取代語意），絕對不用附加新列；
  // 每單位件數沿用原值（編輯不改件數）；「全部月份」寫回 reviewMonths 缺值（保持缺值）。
  function saveAssignmentEdit(next: {
    units: string[];
    unlimited: boolean;
    reviewMonths: string[] | undefined;
  }) {
    if (editingItem == null) return;
    const caseCountByUnit = new Map(
      editingItem.units.map((u) => [u.unitId, u.caseCount]),
    );
    const item: AssignmentItem = {
      reviewerId: editingItem.reviewerId,
      units: next.unlimited
        ? []
        : next.units
            .map((unitId) => ({
              unitId,
              caseCount: caseCountByUnit.get(unitId) ?? null,
            }))
            .sort((a, b) => a.unitId.localeCompare(b.unitId, "zh-Hant")),
      ...(next.unlimited ? { unlimitedUnits: true as const } : {}),
      ...(next.reviewMonths && next.reviewMonths.length > 0
        ? { reviewMonths: normalizeReviewMonths(next.reviewMonths) }
        : {}),
    };
    setItems((prev) =>
      prev.map((it) => (it.reviewerId === item.reviewerId ? item : it)),
    );
    setEditingReviewerId(null);
  }

  function toggleId(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  function removeUnit(reviewerId: string, unitId: string) {
    setItems((prev) =>
      prev
        .map((it) => {
          // v1.51.0：不限單位項目沒有單位列，守旗標不刪項目
          if (it.reviewerId === reviewerId && it.unlimitedUnits === true)
            return it;
          return it.reviewerId === reviewerId
            ? { ...it, units: it.units.filter((u) => u.unitId !== unitId) }
            : it;
        })
        .filter((it) => it.unlimitedUnits === true || it.units.length > 0),
    );
  }

  function applyToTable() {
    if (selReviewers.length === 0) {
      onAction("請先選擇審查員");
      return;
    }
    // v1.88.13：分工表須有該期排程才能加入（單位與月份皆來自排程／單位設定）。
    if (schedule == null) {
      onAction("請先完成排程／單位設定（本期尚無排程，無法選擇單位與月份）");
      return;
    }
    // v1.88.5：防護——單位排程者不得以不限單位加入分工表。
    if (restricted && unlimited) {
      onAction("僅能為自己單位排程，不提供不限單位");
      return;
    }
    // v1.88.13：第 3 步審查月份為必填（不限單位亦同）。
    if (selMonths.length === 0) {
      onAction("請選擇審查月份");
      return;
    }
    if (unlimited) {
      setItems((prev) => mergeItemsUnlimited(prev, selReviewers, selMonths));
      onAction(
        `已加入分工表：${selReviewers.length} 位審查員（不限單位）・${selMonths.join("、")}`,
      );
      setSelReviewers([]);
      setSelMonths([]);
      return;
    }
    if (selUnits.length === 0) {
      onAction("請至少勾選一個單位");
      return;
    }
    setItems((prev) =>
      mergeItemsWithUnits(prev, selReviewers, selUnits, selMonths),
    );
    onAction(
      `已加入分工表：${selReviewers.length} 位審查員 × ${selUnits.length} 個單位・${selMonths.join("、")}`,
    );
    setSelReviewers([]);
    setSelUnits([]);
    setSelMonths([]);
  }

  function removeItem(reviewerId: string) {
    // v1.88.5：受限時不限單位項目鎖定（涵蓋所有單位，單位排程者不得移除）。
    setItems((prev) =>
      prev.filter(
        (it) =>
          it.reviewerId !== reviewerId ||
          (restricted && it.unlimitedUnits === true),
      ),
    );
  }

  // v1.88.4：批次匯入併入分工表 state（只改畫面，儲存時才寫入 Firestore）
  function importAssignments(parsed: ParsedAssignmentRow[]) {
    setItems((prev) => {
      const merged = mergeImportedAssignments(prev, parsed);
      if (!restricted) return merged;
      // v1.88.5：匯入不得把鎖定的不限單位項目改回指定單位項目。
      const locked = new Map(
        prev
          .filter((it) => it.unlimitedUnits === true)
          .map((it) => [it.reviewerId, it]),
      );
      return merged.map((it) => locked.get(it.reviewerId) ?? it);
    });
  }

  async function handleSave() {
    // v1.88.5：受限時把其他單位的部分合併還原後再寫入（只改自己單位）。
    const mergedItems = restricted
      ? mergeAssignmentItemsByReviewer(items, otherItems)
      : items;
    if (mergedItems.length === 0) {
      onAction("分工表尚無資料，請先加入審查員與單位");
      return;
    }
    const dups = findDuplicateUnits(mergedItems);
    if (dups.size > 0) {
      const lines = [...dups.entries()].map(
        ([u, rs]) => `${u}：${rs.map((r) => reviewerName(r)).join("、")}`,
      );
      const ok = window.confirm(
        `以下單位被重複指派給 2 位以上審查員：\n${lines.join("\n")}\n\n確定要儲存嗎？（僅警示，不阻擋）`,
      );
      if (!ok) return;
    }
    // v1.88.16：三元組重疊檢測——同一位審查員、同單位、同一月份重複指派時
    // 跳提醒、拒絕儲存（整張表都不存）。月份缺值列用該期排程曆月展開；
    // 無排程曆月時缺值列不參與比對；不限單位（unitId ""）與具體單位不算重疊。
    const tripleDups = findDuplicateAssignmentTriples(mergedItems, () =>
      scheduleMonths,
    );
    if (tripleDups.length > 0) {
      const lines = tripleDups.slice(0, 10).map((d) => {
        const ym = reviewMonthToYm(d.month);
        const monthLabel = ym ? fmtYm(ym.year, ym.month) : d.month;
        const unitLabel =
          d.unitId === ""
            ? "不限單位"
            : `${unitNameOf(d.unitId)}（${d.unitId}）`;
        return `${reviewerName(d.reviewerId)}・${unitLabel}・${monthLabel} 重複指派`;
      });
      if (tripleDups.length > 10)
        lines.push(`…等共 ${tripleDups.length} 筆重複`);
      window.alert(
        `以下分工有重複指派（同一位審查員、同單位、同一月份），請修正後再儲存：\n${lines.join("\n")}`,
      );
      return;
    }
    setSaving(true);
    try {
      const db = getFirebaseDb();
      await setDoc(doc(db, "indicatorAssignments", indicatorId), {
        indicatorId,
        items: mergedItems,
        updatedAt: serverTimestamp(),
      });
      onAction("已儲存審查員／單位分工表");
      onSaved();
    } catch (error) {
      onAction(`儲存失敗：${toErrorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <section className="panel">
        <SectionTitle
          title="審查員／單位設定"
          note="三步加入分工表：1. 選審查員（可多選），2. 選負責單位（可多選，來自該期「排程／單位設定」的受審單位），3. 選審查月份（必填，可多選）；同一單位可指派給多位審查員（會警示但不阻擋）。審查件數在「排程／單位設定」中按年度設定。"
        />
        {schedule == null && (
          <p className="settings-note">
            本期尚無「排程／單位設定」，請先完成排程／單位設定（單位、月份、件數皆需設定），才能選擇負責單位與審查月份。
          </p>
        )}
        <InactiveReviewerNotice
          reviewerIds={items.map((it) => it.reviewerId)}
          inactiveIds={inactiveIds}
          nameOf={(id) => usersMap.get(id) ?? ""}
        />
        {reviewerOptions.length === 0 ? (
          <p className="settings-note">
            尚未設定審查員，請先到「群組與人員」→「人員」頁籤為人員設定審查員角色。
          </p>
        ) : (
          <OptionMultiPicker
            title="1. 選擇審查員"
            options={reviewerOptions}
            groupMap={groupMap}
            selected={selReviewers}
            onToggle={(id) => setSelReviewers((prev) => toggleId(prev, id))}
            disabled={!canEdit}
            searchPlaceholder="搜尋姓名或職編"
          />
        )}
        <label className="check-row" style={{ marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={unlimited}
            // v1.88.5：單位排程者不提供不限單位。
            disabled={!canEdit || restricted}
            onChange={(e) => setUnlimited(e.target.checked)}
          />
          <b>不限單位</b>
          <span className="muted-text">
            （勾選後不選負責單位；單位顯示為 NA，審查時不用選單位）
            {restricted && "；單位召集人／執行幹事僅能為自己單位排程，不提供此選項"}
          </span>
        </label>
        {restricted && (
          <p className="settings-note">
            僅能為自己單位（{restrictedUnitName || "尚未設定所屬單位"}）設定分工表
            {otherItems.length > 0 &&
              "；其他單位的既有分工會保留，不會因儲存而刪除"}
            。
          </p>
        )}
        <OptionMultiPicker
          title="2. 選擇負責單位"
          options={unitOptions}
          groupMap={groupMap}
          selected={selUnits}
          onToggle={(id) => setSelUnits((prev) => toggleId(prev, id))}
          onToggleAll={(ids, select) =>
            setSelUnits((prev) =>
              select
                ? [...prev, ...ids.filter((id) => !prev.includes(id))]
                : prev.filter((id) => !ids.includes(id)),
            )
          }
          disabled={!canEdit || unlimited}
          searchPlaceholder="搜尋單位名稱或代碼"
        />
        <div style={{ marginTop: 12 }}>
          <b>3. 選擇審查月份（必填，可多選）</b>
          {schedule == null ? (
            <p className="settings-note">
              請先完成排程／單位設定（本期尚無排程，無法選擇審查月份）。
            </p>
          ) : scheduleMonths.length === 0 ? (
            <p className="settings-note">
              本期排程尚未設定審查月份，請先到「排程／單位設定」設定月份。
            </p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", marginTop: 6 }}>
              {scheduleMonths.map((m) => (
                <label key={m} className="check-row">
                  <input
                    type="checkbox"
                    checked={selMonths.includes(m)}
                    disabled={!canEdit}
                    onChange={() =>
                      setSelMonths((prev) => toggleId(prev, m))
                    }
                  />
                  {m}
                </label>
              ))}
            </div>
          )}
        </div>
        {canEdit && (
          <div className="form-actions">
            <button
              className="button button-outline"
              disabled={
                selReviewers.length === 0 ||
                (!unlimited && selUnits.length === 0) ||
                selMonths.length === 0 ||
                schedule == null
              }
              onClick={applyToTable}
            >
              <Plus size={15} /> 加入分工表
            </button>
          </div>
        )}
        {canEdit && (
          <AssignmentBatchImporter
            indicatorCode={indicatorCode}
            allowedReviewMonths={schedule ? scheduleMonthSet : undefined}
            scheduleUnitCodes={
              schedule && !schedule.unlimitedUnits
                ? new Set(schedule.unitIds)
                : undefined
            }
            reviewersByGroup={reviewersByGroup}
            usersMap={usersMap}
            reviewerRoleIds={reviewerRoleIds}
            units={units}
            restrictedUnitCodes={restrictedUnitCodes}
            restrictedUnitName={restrictedUnitName}
            onImport={importAssignments}
            onAction={onAction}
          />
        )}
      </section>

      <section className="panel">
        <SectionTitle
          title="分工總覽"
          note={
            items.length === 0
              ? "尚無分工資料"
              : `${items.length} 位審查員・${items.reduce((n, it) => n + it.units.length, 0)} 單位指派${items.some((it) => it.unlimitedUnits === true) ? "（含不限單位）" : ""}`
          }
        />
        {items.length === 0 ? (
          <p className="settings-note">由上方選擇審查員與單位後加入。</p>
        ) : (
          <>
            <AssignmentOverviewTools
              search={assignSearch}
              onSearchChange={setAssignSearch}
              unitFilter={assignUnitFilter}
              onUnitFilterChange={setAssignUnitFilter}
              unitOptions={assignUnitOptions}
              monthFilter={assignMonthFilter}
              onMonthFilterChange={setAssignMonthFilter}
              monthOptions={assignMonthOptions}
              checkedCount={assignChecked.length}
              onDeleteSelected={removeSelectedAssignments}
              deleteDisabled={!canEdit || assignChecked.length === 0}
            />
            {filteredItems.length === 0 ? (
              <p className="settings-note">無符合篩選條件的分工資料。</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      {canEdit && (
                        <th style={{ width: 36 }}>
                          <input
                            type="checkbox"
                            checked={allAssignChecked}
                            onChange={(e) => toggleAssignAll(e.target.checked)}
                            aria-label="全選"
                          />
                        </th>
                      )}
                      <th>審查員</th>
                      <th>負責單位</th>
                      <th>審查月份</th>
                      {canEdit && <th>操作</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredItems.map((it) => (
                      <tr key={it.reviewerId}>
                        {canEdit && (
                          <td>
                            <input
                              type="checkbox"
                              checked={assignChecked.includes(it.reviewerId)}
                              disabled={isLockedAssignmentItem(it, restricted)}
                              onChange={(e) =>
                                toggleAssignChecked(
                                  it.reviewerId,
                                  e.target.checked,
                                )
                              }
                              aria-label={`選擇 ${it.reviewerId}`}
                            />
                          </td>
                        )}
                        <td>
                          <b>{reviewerName(it.reviewerId)}</b>
                          <div className="muted-text">{it.reviewerId}</div>
                        </td>
                    <td>
                      {it.unlimitedUnits === true ? (
                        <span>不限單位</span>
                      ) : (
                        it.units.map((u) => (
                          <div key={u.unitId} className="assign-unit-row">
                            <span>
                              {u.unitId}
                              {duplicates.has(u.unitId) && (
                                <CircleAlert
                                  size={13}
                                  className="dup-warn"
                                  aria-label="重複指派"
                                />
                              )}
                            </span>
                            {canEdit && (
                              <button
                                className="text-button"
                                onClick={() => removeUnit(it.reviewerId, u.unitId)}
                                aria-label={`移除${u.unitId}`}
                              >
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        ))
                      )}
                    </td>
                    <td>
                      {it.reviewMonths && it.reviewMonths.length > 0
                        ? it.reviewMonths
                            .map((m) => {
                              const ym = reviewMonthToYm(m);
                              return ym ? fmtYm(ym.year, ym.month) : m;
                            })
                            .join("、")
                        : "全部月份"}
                    </td>
                    {canEdit && (
                      <td>
                        {restricted && it.unlimitedUnits === true ? (
                          <span
                            className="muted-text"
                            title="不限單位項目涵蓋所有單位，單位排程者不得移除"
                          >
                            鎖定
                          </span>
                        ) : (
                          <span style={{ display: "inline-flex", gap: 4 }}>
                            <button
                              className="text-button"
                              onClick={() =>
                                setEditingReviewerId(it.reviewerId)
                              }
                            >
                              <Pencil size={13} /> 編輯
                            </button>
                            <button
                              className="text-button"
                              onClick={() => removeItem(it.reviewerId)}
                            >
                              <Trash2 size={13} /> 移除
                            </button>
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
            )}
          </>
        )}
        {duplicates.size > 0 && (
          <p className="dup-note">
            <CircleAlert size={14} /> 以下單位被重複指派（儲存時會再次確認，不阻擋）：
            {[...duplicates.keys()].join("、")}
          </p>
        )}
        {canEdit && (
          <div className="form-actions">
            <button
              className="button button-primary"
              disabled={saving}
              onClick={handleSave}
            >
              {saving ? "儲存中…" : "儲存分工表"}
            </button>
          </div>
        )}
      </section>

      {editingItem != null && (
        <AssignmentEditModal
          key={editingItem.reviewerId}
          reviewerLabel={reviewerName(editingItem.reviewerId)}
          unitOptions={editUnitOptions}
          groupMap={groupMap}
          initialUnits={editingItem.units.map((u) => u.unitId)}
          initialUnlimited={editingItem.unlimitedUnits === true}
          allowUnlimited={!restricted}
          scheduleMonths={scheduleMonths}
          initialMonths={editingItem.reviewMonths}
          onSave={saveAssignmentEdit}
          onClose={() => setEditingReviewerId(null)}
        />
      )}
    </>
  );
}
