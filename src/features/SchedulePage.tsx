/**
 * 品管審查排程頁（v1.16.0 重寫）。
 * 三類別排程（年度／學年度／臨時）：一列＝一支指標＋一個類別（當期），
 * 含「尚無排程」列以便建立；操作＝產生排程／加審／查閱；自審（護理長）。
 * 排程讀寫一律走 src/lib/scheduling.ts 的新模型（indicatorSchedules），
 * 稽核由 lib 內自動寫入。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  CalendarPlus,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Copy,
  Eye,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  collection,
  doc,
  getDocs,
  getDocsFromServer,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "../lib/db";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { getFirebaseDb } from "../lib/firebase";
import {
  getCachedRef,
  getCachedRefCollection,
  SYSTEM_CONFIG_KEY,
} from "../lib/refCache";
import { getDocCacheFirst, getDocsCacheFirst } from "../lib/cacheFirst";
import { indicatorCodeOf } from "../lib/indicators";
import { buildTaskIndex } from "../lib/taskIndex";
import { usePermissions } from "../lib/usePermissions";
import { useAuth } from "../lib/auth";
import { isReviewerAccessActive } from "../lib/reviewerValidity";
import { useOrgMeta } from "../lib/useOrgMeta";
import { hasRoleCategory, titleFlagsOf } from "../lib/orgMeta";
import { staffLabel } from "../lib/mask";
import {
  academicYearOf,
  categoryLabel,
  cycleMonths,
  periodLabel,
  type CycleCategory,
} from "../lib/cycle";
import {
  MONTH_LABELS,
  autoSelectMonths,
  buildTasksFromSchedule,
  clampIntervalForEditor,
  createTempSchedule,
  DEFAULT_FREQUENCY,
  DEFAULT_INTERVAL_MONTHS,
  deleteSchedule,
  findDuplicateUnits,
  FREQUENCY_OPTIONS,
  frequencyLabel,
  getSchedule,
  INTERVAL_OPTIONS,
  intervalLabel,
  intervalRangeLabels,
  listSchedules,
  normalizeAssignmentItem,
  parseCaseCount,
  periodForFilter,
  previousPeriodSchedule,
  resolveIntervalMonths,
  saveSchedule,
  scheduleReviewCalendarMonths,
  scheduleSetupComplete,
  YEAR_FILTER_OPTIONS,
  yearOptionLabel,
  type AssignmentItem,
  type IndicatorAssignment,
  type IndicatorSchedule,
  type ReviewFrequency,
} from "../lib/scheduling";

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "讀寫失敗，請檢查網路連線後再試";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Firestore Timestamp → 本地時間字串；解析失敗回 "—" */
function fmtTs(ts: unknown): string {
  try {
    const t = ts as { toDate?: () => Date };
    if (t && typeof t.toDate === "function") {
      const d = t.toDate();
      if (d instanceof Date && !Number.isNaN(d.getTime())) {
        return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      }
    }
  } catch {
    /* ignore */
  }
  return "—";
}

/** 排程 → 全部審查曆年月（起始月＋區間月數展開；v1.23） */
function scheduleCalendarMonths(
  s: IndicatorSchedule,
): { year: number; month: number }[] {
  return scheduleReviewCalendarMonths(s);
}

interface IndicatorLite {
  id: string;
  /** 顯示用編號（由複合文件 ID 解析；v1.21） */
  code: string;
  name: string;
  groupId: string;
  /** 指標狀態（v1.17：排程選擇器只列「啟用」） */
  status: string;
}

interface UnitLite {
  code: string;
  name: string;
  groupId: string;
}

interface UserLite {
  id: string;
  name: string;
  unitCode: string;
  status: string;
  reviewerAccessActive: boolean;
}

interface ReviewerLite {
  personId: string;
  name: string;
}

interface RowItem {
  key: string;
  indicatorId: string;
  /** 顯示用編號（v1.21：不顯示複合 ID） */
  code: string;
  name: string;
  groupId: string;
  groupName: string;
  /** 指標狀態（v1.17.0 補強：非「啟用」不得產生排程／加審） */
  status: string;
  category: CycleCategory;
  /** 年度／學年度的週期鍵；臨時列為該排程的 period（尚無排程則 ""） */
  period: string;
  schedule: IndicatorSchedule | null;
}

type View =
  | { kind: "list" }
  | {
      kind: "schedule";
      indicatorId: string;
      category: "year" | "academic";
      year: number;
    }
  | { kind: "assignment"; indicatorId: string };

const PILL_OK = "status-pill success";
const PILL_NONE = "status-pill muted";

/* ================= 純函式（UI 判定邏輯，可單元測試） ================= */

/**
 * 排程 pill：設定完成（受審單位≥1、月份≥1、審查件數>0）→ "done"（已排），
 * 否則 "none"（未排）。v1.18 起件數為必填，一併納入判定。
 */
export function schedulePillState(
  schedule: IndicatorSchedule | null,
): "done" | "none" {
  return scheduleSetupComplete(schedule) ? "done" : "none";
}

/**
 * 分工表合併（v1.18）：把選中的審查員 × 選中的單位併入既有分工表；
 * 已存在者保留其每單位件數（透傳），新單位件數為 null。
 * v1.51.0：既有不限單位項目併入新單位時旗標取消（改為指定單位）；
 * 新單位為空且既有項目為不限單位時保留旗標。
 * 純函式，可單元測試。
 */
export function mergeItemsWithUnits(
  prev: AssignmentItem[],
  reviewerIds: string[],
  unitIds: string[],
): AssignmentItem[] {
  const next: AssignmentItem[] = prev.map((it) => ({
    reviewerId: it.reviewerId,
    units: it.units.map((u) => ({ ...u })),
    ...(it.unlimitedUnits === true
      ? { unlimitedUnits: true as const }
      : {}),
  }));
  for (const rid of reviewerIds) {
    const existing = next.find((it) => it.reviewerId === rid);
    const existingMap = new Map(
      (existing?.units ?? []).map((u) => [u.unitId, u.caseCount]),
    );
    const merged = [...new Set([...existingMap.keys(), ...unitIds])]
      .map((unitId) => ({
        unitId,
        caseCount: existingMap.get(unitId) ?? null,
      }))
      .sort((a, b) => a.unitId.localeCompare(b.unitId, "zh-Hant"));
    const idx = next.findIndex((it) => it.reviewerId === rid);
    // 併入單位後即為指定單位項目，旗標取消；單位為空才保留原旗標
    const item: AssignmentItem =
      merged.length > 0
        ? { reviewerId: rid, units: merged }
        : existing?.unlimitedUnits === true
          ? { reviewerId: rid, units: [], unlimitedUnits: true as const }
          : { reviewerId: rid, units: [] };
    if (idx >= 0) next[idx] = item;
    else next.push(item);
  }
  return next.sort((a, b) => a.reviewerId.localeCompare(b.reviewerId, "zh-Hant"));
}

/**
 * 分工表合併（不限單位，v1.51.0）：把選中的審查員以不限單位項目併入分工表
 *（units 為空、unlimitedUnits 為 true）；已存在者保留原單位設定以外的欄位，
 * 其餘項目不動。純函式，可單元測試。
 */
export function mergeItemsUnlimited(
  prev: AssignmentItem[],
  reviewerIds: string[],
): AssignmentItem[] {
  const next: AssignmentItem[] = prev.map((it) => ({
    reviewerId: it.reviewerId,
    units: it.units.map((u) => ({ ...u })),
    ...(it.unlimitedUnits === true
      ? { unlimitedUnits: true as const }
      : {}),
  }));
  for (const rid of reviewerIds) {
    const idx = next.findIndex((it) => it.reviewerId === rid);
    const item: AssignmentItem = {
      reviewerId: rid,
      units: [],
      unlimitedUnits: true as const,
    };
    if (idx >= 0) next[idx] = item;
    else next.push(item);
  }
  return next.sort((a, b) => a.reviewerId.localeCompare(b.reviewerId, "zh-Hant"));
}

/** 分工表 pill：有分工表且有項目 → "done"，否則 "none" */
export function assignmentPillState(
  assignment: IndicatorAssignment | null | undefined,
): "done" | "none" {
  return assignment && assignment.items.length > 0 ? "done" : "none";
}

/** 加審／自審預覽任務數＝月份數 × 單位數 × 審核員數 */
export function previewTempTaskCount(
  months: number[],
  unitIds: string[],
  reviewerIds: string[],
): number {
  return months.length * unitIds.length * reviewerIds.length;
}

/** 預設期間：依統計週期（年度→今年西元年；學年度→本學年度民國年） */
export function defaultPeriodForStatsCycle(
  cycle: "year" | "academic",
  now: Date = new Date(),
): string {
  return cycle === "academic"
    ? String(academicYearOf(now))
    : String(now.getFullYear());
}

/** 自審審核員預設：自己單位的在職人員 */
export function defaultSelfAuditReviewers(
  users: { id: string; unitCode: string; status: string }[],
  unitCode: string,
): string[] {
  return users
    .filter((u) => u.unitCode === unitCode && u.status === "在職")
    .map((u) => u.id);
}

/** 加審審核員預設：分工表中涵蓋所選單位者 */
export function defaultAddAuditReviewers(
  assignment: IndicatorAssignment | null | undefined,
  unitIds: string[],
): string[] {
  const set = new Set<string>();
  for (const it of assignment?.items ?? []) {
    if (it.units.some((u) => unitIds.includes(u.unitId))) {
      set.add(it.reviewerId);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, "zh-Hant"));
}

export function SchedulePage({ onAction }: { onAction: (message: string) => void }) {
  const { can } = usePermissions();
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
  const [loading, setLoading] = useState(true);

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
  const [deadlineDay, setDeadlineDay] = useState(10);

  // 篩選（v1.18）：年份／年別（鎖定系統統計週期）／組別／關鍵字／顯示加審
  // v1.20：組別旁新增指標下拉（依組別連動）
  const [filterYear, setFilterYear] = useState(() => new Date().getFullYear());
  const [statsCycle, setStatsCycle] = useState<"year" | "academic">("year");
  const [showTemp, setShowTemp] = useState(false);
  const [filterGroup, setFilterGroup] = useState("");
  const [filterIndicator, setFilterIndicator] = useState("");
  const [filterKeyword, setFilterKeyword] = useState("");

  const [generatingKey, setGeneratingKey] = useState<string | null>(null);
  const [addAuditRow, setAddAuditRow] = useState<RowItem | null>(null);
  const [selfAuditOpen, setSelfAuditOpen] = useState(false);
  const [detailRow, setDetailRow] = useState<RowItem | null>(null);

  const usersMap = useMemo(() => {
    const m = new Map<string, string>();
    users.forEach((u) => m.set(u.id, u.name));
    return m;
  }, [users]);
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

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const db = getFirebaseDb();
      const [isnap, gsnap, asnap, usnap, unsnap, rsnap, scheds] =
        await Promise.all([
          getCachedRefCollection("indicators", () =>
            getDocsCacheFirst(collection(db, "indicators")),
          ),
          getCachedRefCollection("groups", () =>
            getDocsCacheFirst(collection(db, "groups")),
          ),
          getDocs(collection(db, "indicatorAssignments")),
          getCachedRefCollection("units", () =>
            getDocsCacheFirst(collection(db, "units")),
          ),
          getCachedRefCollection("users", () =>
            getDocsFromServer(collection(db, "users")),
          ),
          getDocs(collection(db, "reviewReviewers")),
          listSchedules(db),
        ]);

      const gm = new Map<string, string>();
      gsnap.docs.forEach((d) => {
        const name = d.data().name;
        if (typeof name === "string") gm.set(d.id, name);
      });
      setGroupMap(gm);

      const inds: IndicatorLite[] = isnap.docs
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
        .sort((a, b) => a.id.localeCompare(b.id, "zh-Hant"));
      setIndicators(inds);
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

      // 任務索引（v1.28 階段 6 B5）：一次拉全部 reviewTasks、前端按 indicatorId 分組，
      // 取代每支指標一次查詢（N+1 → 1）。不加年份 where：排程頁可切換檢視年份
      //（filterYear）且臨時排程可屬任何年份；全量單查與改前讀取文件數相同。
      // 分組規則見 src/lib/taskIndex.ts（純函式，測試逐筆對照改前演算法）。
      let idx = new Map<string, Map<string, { pending: number; done: number }>>();
      try {
        const tsnap = await getDocs(collection(db, "reviewTasks"));
        idx = buildTaskIndex(
          tsnap.docs as unknown as Array<{
            data: () => Record<string, unknown>;
          }>,
        );
      } catch {
        /* 任務索引讀取失敗：索引留空，任務數顯示為 0，不影響其他資料 */
      }
      setTaskIndex(idx);
    } catch (error) {
      onAction(`讀取排程資料失敗：${toErrorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, [onAction]);

  useEffect(() => {
    loadData();
  }, [loadData]);

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
    return out.sort(
      (a, b) =>
        a.groupName.localeCompare(b.groupName, "zh-Hant") ||
        a.name.localeCompare(b.name, "zh-Hant") ||
        (a.category === "temp" ? 1 : 0) - (b.category === "temp" ? 1 : 0) ||
        b.period.localeCompare(a.period),
    );
  }, [
    indicators,
    schedules,
    groupMap,
    cycle,
    period,
    filterGroup,
    filterKeyword,
    showTemp,
  ]);

  /** 各指標的加審筆數：加審按鈕下方顯示用（v1.59.0：只計 temp 且非自審；自審不計） */
  const tempCountByIndicator = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of schedules) {
      if (s.category !== "temp" || s.selfReview) continue;
      m.set(s.indicatorId, (m.get(s.indicatorId) ?? 0) + 1);
    }
    return m;
  }, [schedules]);

  /** 該列排程曆年月已產生的任務數（未執行／已完成） */
  function taskCountsFor(row: RowItem): { pending: number; done: number } {
    const s = row.schedule;
    if (!s) return { pending: 0, done: 0 };
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

  function backToList() {
    setView({ kind: "list" });
    loadData();
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
        <section className="panel">
          <div className="filter-bar">
            <div className="form-field" style={{ maxWidth: 170 }}>
              <label className="field-label">年份</label>
              <div className="select-wrap">
                <select
                  value={filterYear}
                  onChange={(e) => setFilterYear(Number(e.target.value))}
                >
                  {YEAR_FILTER_OPTIONS.map((y) => (
                    <option key={y} value={y}>
                      {yearOptionLabel(y)}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
            <div className="form-field" style={{ maxWidth: 140 }}>
              <label className="field-label">年別</label>
              <div className="select-wrap">
                <select
                  value={statsCycle}
                  disabled
                  title="年別跟隨系統管理「統計週期」設定"
                >
                  <option value="year">年度</option>
                  <option value="academic">學年度</option>
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
            <div className="form-field" style={{ maxWidth: 130 }}>
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
            <div className="form-field" style={{ maxWidth: 200 }}>
              <label className="field-label">組別篩選</label>
              <div className="select-wrap">
                <select
                  value={filterGroup}
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
                  }}
                >
                  <option value="">全部組別</option>
                  {[...groupMap.entries()].map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
            <div className="form-field" style={{ maxWidth: 260 }}>
              <label className="field-label">指標篩選</label>
              <div className="select-wrap">
                <select
                  value={filterIndicator}
                  onChange={(e) => setFilterIndicator(e.target.value)}
                >
                  <option value="">全部指標</option>
                  {indicatorOptions.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}（{i.id}）
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
            <div className="form-field" style={{ maxWidth: 260 }}>
              <label className="field-label">指標關鍵字</label>
              <input
                className="text-input"
                placeholder="指標名稱或編號"
                value={filterKeyword}
                onChange={(e) => setFilterKeyword(e.target.value)}
              />
            </div>
          </div>
          <p className="settings-note">
            年別跟隨系統管理「統計週期」設定（年度＝1–12 月；學年度＝8 月制，8
            月～隔年 7 月）。清單只列出已啟用的指標。
          </p>
        </section>

        {loading ? (
          <section className="panel">
            <p className="settings-note">讀取中…</p>
          </section>
        ) : rows.length === 0 ? (
          <EmptyState
            title="尚無指標"
            description="請先到「指標管理」建立指標，再回來設定排程。"
          />
        ) : (
          <section className="panel data-panel">
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>組別</th>
                    <th>年別</th>
                    <th>指標編號</th>
                    <th>指標名稱</th>
                    <th>排程/單位設定</th>
                    <th>審查員/單位設定</th>
                    <th>操作</th>
                    <th>最後編輯</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const sched = r.schedule;
                    const schedDone = schedulePillState(sched) === "done";
                    const asg = assignments.get(r.indicatorId);
                    const asgDone = assignmentPillState(asg) === "done";
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
                          {asgDone && asg && (
                            <div className="muted-text">
                              {asg.items.length} 位審查員・
                              {asg.items.reduce(
                                (n, it) => n + it.units.length,
                                0,
                              )}{" "}
                              單位
                              {asg.items.some(
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
                                  onClick={() => setDetailRow(r)}
                                  title="查閱設定內容"
                                >
                                  <Eye size={14} /> 查閱
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
                              {fmtTs(sched.updatedAt)}
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
            </div>
          </section>
        )}

        {addAuditRow && (
          <AddAuditDialog
            row={addAuditRow}
            units={units}
            users={users}
            groupMap={groupMap}
            reviewersByGroup={reviewersByGroup}
            assignment={assignments.get(addAuditRow.indicatorId) ?? null}
            actor={actor}
            deadlineDay={deadlineDay}
            filterYear={filterYear}
            cycle={cycle}
            onAction={onAction}
            onClose={() => setAddAuditRow(null)}
            onDone={() => {
              setAddAuditRow(null);
              loadData();
            }}
          />
        )}
        {detailRow && (
          <ScheduleDetailModal
            row={detailRow}
            assignment={assignments.get(detailRow.indicatorId) ?? null}
            usersMap={usersMap}
            unitNameOf={unitNameOf}
            onAction={onAction}
            onClose={() => setDetailRow(null)}
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
            note={`指標編號 ${indicator.id}・組別 ${groupMap.get(indicator.groupId) ?? "—"}`}
          />
          {view.kind === "schedule" && (
            <ScheduleEditor
              indicatorId={indicator.id}
              indicatorName={indicator.name}
              category={view.category}
              initialYear={view.year}
              units={units}
              groupMap={groupMap}
              canEdit={canEdit}
              actor={actor}
              onAction={onAction}
              onSaved={backToList}
            />
          )}
          {view.kind === "assignment" && (
            <AssignmentEditor
              indicatorId={indicator.id}
              reviewersByGroup={reviewersByGroup}
              units={units}
              groupMap={groupMap}
              usersMap={usersMap}
              initial={assignments.get(indicator.id) ?? null}
              canEdit={canEdit}
              onAction={onAction}
              onSaved={backToList}
            />
          )}
        </>
      )}
    </>
  );
}

/* ================= 共用小元件 ================= */

function Modal({
  title,
  note,
  onClose,
  wide,
  children,
}: {
  title: string;
  note?: string;
  onClose: () => void;
  /** v1.20：寬版（查閱視窗 2 倍寬） */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="reviewer-modal-backdrop" onClick={onClose}>
      <div
        className={`reviewer-modal panel${wide ? " wide" : ""}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="reviewer-modal-head">
          <div>
            <h2>{title}</h2>
            {note && <p>{note}</p>}
          </div>
          <button
            className="button button-ghost"
            onClick={onClose}
            aria-label="關閉"
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** 群組→單位樹（可縮放、總全選、群組全選、單位複選；v1.18） */
function UnitTreePicker({
  units,
  groupMap,
  selected,
  onChange,
  disabled,
  unitNameOf,
}: {
  units: UnitLite[];
  groupMap: Map<string, string>;
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
  unitNameOf: (code: string) => string;
}) {
  const unitsByGroup = useMemo(() => {
    const map = new Map<string, UnitLite[]>();
    units.forEach((u) => {
      const arr = map.get(u.groupId) ?? [];
      arr.push(u);
      map.set(u.groupId, arr);
    });
    return map;
  }, [units]);
  const sel = useMemo(() => new Set(selected), [selected]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const allCodes = useMemo(
    () => [...unitsByGroup.values()].flat().map((u) => u.code),
    [unitsByGroup],
  );
  const allChecked =
    allCodes.length > 0 && allCodes.every((c) => sel.has(c));

  function toggle(code: string) {
    const next = new Set(sel);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange([...next]);
  }
  function toggleGroup(gid: string) {
    const codes = (unitsByGroup.get(gid) ?? []).map((u) => u.code);
    const next = new Set(sel);
    const groupChecked = codes.length > 0 && codes.every((c) => next.has(c));
    if (groupChecked) codes.forEach((c) => next.delete(c));
    else codes.forEach((c) => next.add(c));
    onChange([...next]);
  }
  function toggleAll() {
    const next = new Set(sel);
    if (allChecked) allCodes.forEach((c) => next.delete(c));
    else allCodes.forEach((c) => next.add(c));
    onChange([...next]);
  }
  function toggleCollapse(gid: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });
  }

  return (
    <>
      <label className="check-row" style={{ marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={allChecked}
          disabled={disabled}
          onChange={toggleAll}
        />
        <b>
          全選（已選 {sel.size}／{allCodes.length}）
        </b>
      </label>
      {[...unitsByGroup.entries()].map(([gid, list]) => {
        const codes = list.map((u) => u.code);
        const groupChecked =
          codes.length > 0 && codes.every((c) => sel.has(c));
        const isCollapsed = collapsed.has(gid);
        return (
          <div key={gid} className="unit-group-block">
            <div className="unit-group-head" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                className="text-button"
                onClick={() => toggleCollapse(gid)}
                aria-label={isCollapsed ? `展開${groupMap.get(gid) ?? gid}` : `收合${groupMap.get(gid) ?? gid}`}
              >
                {isCollapsed ? "展開 ▸" : "收合 ▾"}
              </button>
              <label className="check-row" style={{ margin: 0 }}>
                <input
                  type="checkbox"
                  checked={groupChecked}
                  disabled={disabled}
                  onChange={() => toggleGroup(gid)}
                />
                <b>
                  {groupMap.get(gid) ?? gid}（全選）
                </b>
              </label>
              <span className="muted-text">
                {codes.filter((c) => sel.has(c)).length}/{codes.length}
              </span>
            </div>
            {!isCollapsed && (
              <div className="unit-check-grid">
                {list.map((u) => (
                  <label key={u.code} className="check-row">
                    <input
                      type="checkbox"
                      checked={sel.has(u.code)}
                      disabled={disabled}
                      onChange={() => toggle(u.code)}
                    />
                    <span title={u.code}>{unitNameOf(u.code)}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/** 選取選項（群組篩選＋搜尋＋複選共用；v1.18 審查員／單位選取用） */
export interface PickerOption {
  id: string;
  label: string;
  sub: string;
  groupId: string;
}

/** 群組下拉篩選＋搜尋框＋複選清單（審查員／單位選取共用） */
function OptionMultiPicker({
  title,
  options,
  groupMap,
  defaultGroupId,
  selected,
  onToggle,
  disabled,
  searchPlaceholder,
}: {
  title: string;
  options: PickerOption[];
  groupMap: Map<string, string>;
  defaultGroupId?: string;
  selected: string[];
  onToggle: (id: string) => void;
  disabled?: boolean;
  searchPlaceholder?: string;
}) {
  const [groupFilter, setGroupFilter] = useState(defaultGroupId ?? "");
  const [kw, setKw] = useState("");
  const sel = useMemo(() => new Set(selected), [selected]);
  const filtered = useMemo(() => {
    const q = kw.trim().toLowerCase();
    return options.filter((o) => {
      if (groupFilter && o.groupId !== groupFilter) return false;
      if (
        q &&
        !(
          o.label.toLowerCase().includes(q) ||
          o.id.toLowerCase().includes(q)
        )
      )
        return false;
      return true;
    });
  }, [options, groupFilter, kw]);
  return (
    <div className="form-field">
      <label className="field-label">
        {title}
        {selected.length > 0 && `：已選 ${selected.length}`}
      </label>
      <div
        style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}
      >
        <div className="select-wrap" style={{ maxWidth: 200 }}>
          <select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            disabled={disabled}
            aria-label={`${title}：組別篩選`}
          >
            <option value="">全部組別</option>
            {[...groupMap.entries()].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <ChevronDown size={15} />
        </div>
        <input
          className="text-input"
          style={{ maxWidth: 220 }}
          placeholder={searchPlaceholder ?? "搜尋名稱或代碼"}
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          disabled={disabled}
        />
      </div>
      <div
        style={{
          maxHeight: 220,
          overflow: "auto",
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          padding: 8,
        }}
      >
        {filtered.length === 0 ? (
          <p className="settings-note">無符合項目</p>
        ) : (
          <div className="unit-check-grid">
            {filtered.map((o) => (
              <label key={o.id} className="check-row">
                <input
                  type="checkbox"
                  checked={sel.has(o.id)}
                  disabled={disabled}
                  onChange={() => onToggle(o.id)}
                />
                <span>
                  {o.label}
                  {o.sub && <span className="muted-text">（{o.sub}）</span>}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 月份複選（顯示順序由呼叫端決定：學年度為 [8..12,1..7]） */
function MonthPicker({
  order,
  selected,
  onChange,
  disabled,
}: {
  order: number[];
  selected: number[];
  onChange: (months: number[]) => void;
  disabled: boolean;
}) {
  const sel = useMemo(() => new Set(selected), [selected]);
  function toggle(m: number) {
    const next = new Set(sel);
    if (next.has(m)) next.delete(m);
    else next.add(m);
    onChange([...next].sort((a, b) => a - b));
  }
  return (
    <div className="month-grid">
      {order.map((m) => {
        const checked = sel.has(m);
        return (
          <label
            key={m}
            className={`check-row month-cell${checked ? " checked" : ""}`}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={() => toggle(m)}
            />
            <span>{MONTH_LABELS[m - 1]}</span>
          </label>
        );
      })}
    </div>
  );
}

/** 件數輸入（僅接受 ≥1 整數或清空＝未設定） */
function useCaseCountInput(initial = "") {
  const [value, setValue] = useState(initial);
  const onInput = useCallback((raw: string) => {
    const t = raw.trim();
    if (t !== "" && (!/^\d+$/.test(t) || Number(t) < 1)) return;
    setValue(t);
  }, []);
  return { value, setValue, onInput };
}

/* ================= 排程設定編輯器（年度／學年度；v1.18 頻次＋區間） ================= */

function ScheduleEditor({
  indicatorId,
  indicatorName,
  category,
  initialYear,
  units,
  groupMap,
  canEdit,
  actor,
  onAction,
  onSaved,
}: {
  indicatorId: string;
  indicatorName: string;
  category: "year" | "academic";
  initialYear: number;
  units: UnitLite[];
  groupMap: Map<string, string>;
  canEdit: boolean;
  actor: { id: string; name: string };
  onAction: (m: string) => void;
  onSaved: () => void;
}) {
  const [year, setYear] = useState(initialYear);
  const period = periodForFilter(category, year);
  const [months, setMonths] = useState<number[]>([]);
  const [frequency, setFrequency] =
    useState<ReviewFrequency>(DEFAULT_FREQUENCY);
  const [interval, setInterval] =
    useState<1 | 2 | 3>(DEFAULT_INTERVAL_MONTHS);
  const caseCount = useCaseCountInput();
  const [unitIds, setUnitIds] = useState<string[]>([]);
  // v1.51.0：不限單位（不固定單位、沒有單位限制；勾選時單位清單忽略）
  const [unlimited, setUnlimited] = useState(false);
  const [notes, setNotes] = useState("");
  const [exists, setExists] = useState(false);
  const [prev, setPrev] = useState<IndicatorSchedule | null>(null);
  const [loadingPeriod, setLoadingPeriod] = useState(true);
  const [saving, setSaving] = useState(false);

  const monthOrder = useMemo(
    () => cycleMonths(category, period),
    [category, period],
  );
  const unitNameOf = useCallback(
    (code: string) => units.find((u) => u.code === code)?.name ?? code,
    [units],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingPeriod(true);
      try {
        const db = getFirebaseDb();
        const [s, pv] = await Promise.all([
          getSchedule(db, indicatorId, category, period),
          previousPeriodSchedule(db, indicatorId, category, period),
        ]);
        if (cancelled) return;
        setExists(!!s);
        if (s) {
          // 編輯舊排程：保留原月份，不強制重算（v1.18）；改頻次才重算
          setMonths(s.months);
          setFrequency(s.frequency ?? DEFAULT_FREQUENCY);
          setInterval(clampIntervalForEditor(s.intervalMonths));
        } else {
          // 新排程：依預設頻次自動預選月份（12 個月平分）
          setMonths(autoSelectMonths(DEFAULT_FREQUENCY, monthOrder));
          setFrequency(DEFAULT_FREQUENCY);
          setInterval(DEFAULT_INTERVAL_MONTHS);
        }
        caseCount.setValue(
          s?.caseCount != null ? String(s.caseCount) : "3",
        );
        setUnitIds(s?.unitIds ?? []);
        setUnlimited(s?.unlimitedUnits === true);
        setNotes(s?.notes ?? "");
        setPrev(pv);
      } catch (error) {
        if (!cancelled) onAction(`讀取排程失敗：${toErrorMessage(error)}`);
      } finally {
        if (!cancelled) setLoadingPeriod(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicatorId, category, period]);

  /** 切換頻次下拉 → 重新依規則預選月份（覆蓋手動勾選） */
  function handleFrequencyChange(f: ReviewFrequency) {
    setFrequency(f);
    setMonths(autoSelectMonths(f, monthOrder));
  }

  function handleCopyPrev() {
    if (!prev) return;
    setMonths([...prev.months]);
    if (prev.frequency) setFrequency(prev.frequency);
    setInterval(clampIntervalForEditor(prev.intervalMonths));
    caseCount.setValue(
      prev.caseCount != null ? String(prev.caseCount) : "3",
    );
    setUnitIds([...prev.unitIds]);
    setUnlimited(prev.unlimitedUnits === true);
    setNotes(prev.notes);
    onAction(`已帶入前一期（${prev.periodLabel}）設定，請確認後儲存`);
  }

  async function handleSave() {
    if (months.length === 0) {
      onAction("請至少選擇一個審查月份");
      return;
    }
    if (unitIds.length === 0 && !unlimited) {
      onAction("請勾選不限單位或至少選擇一個受審單位");
      return;
    }
    // v1.18：審查件數改為必填
    if (caseCount.value.trim() === "") {
      onAction("請填寫審查件數");
      return;
    }
    setSaving(true);
    try {
      const db = getFirebaseDb();
      const cc = Number(caseCount.value);
      await saveSchedule(
        db,
        {
          indicatorId,
          category,
          period,
          periodLabel: periodLabel(category, period),
          months: [...months].sort((a, b) => a - b),
          frequency,
          // v1.23：區間由下拉獨立選擇（1／2／3 個月），不再由頻次衍生
          intervalMonths: interval,
          refYear: null,
          caseCount: parseCaseCount(cc),
          unitIds: unlimited ? [] : [...unitIds],
          unlimitedUnits: unlimited,
          notes: notes.trim(),
          selfReview: false,
          updatedBy: actor.id,
          updatedByName: actor.name,
          updatedAt: null,
        },
        actor,
      );
      onAction(
        `已儲存 ${indicatorName}・${periodLabel(category, period)}排程設定`,
      );
      onSaved();
    } catch (error) {
      onAction(`儲存失敗：${toErrorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    const ok = window.confirm(
      `確定刪除 ${periodLabel(category, period)} 的排程設定？（已產生的任務不受影響）`,
    );
    if (!ok) return;
    try {
      const db = getFirebaseDb();
      await deleteSchedule(db, indicatorId, category, period, actor);
      onAction(`已刪除 ${periodLabel(category, period)} 排程設定`);
      onSaved();
    } catch (error) {
      onAction(`刪除失敗：${toErrorMessage(error)}`);
    }
  }

  return (
    <>
      <section className="panel">
        <SectionTitle
          title="排程設定"
          note={`${categoryLabel(category)}・${periodLabel(category, period)}`}
        />
        {loadingPeriod ? (
          <p className="settings-note">讀取中…</p>
        ) : (
          <>
            <div className="form-row">
              <div className="form-field" style={{ maxWidth: 200 }}>
                <label className="field-label">年份</label>
                <div className="select-wrap">
                  <select
                    value={year}
                    onChange={(e) => setYear(Number(e.target.value))}
                  >
                    {YEAR_FILTER_OPTIONS.map((y) => (
                      <option key={y} value={y}>
                        {yearOptionLabel(y)}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={15} />
                </div>
              </div>
              <div className="form-field" style={{ maxWidth: 160 }}>
                <label className="field-label">年別</label>
                <div className="select-wrap">
                  <select value={category} disabled>
                    <option value="year">年度</option>
                    <option value="academic">學年度</option>
                  </select>
                  <ChevronDown size={15} />
                </div>
              </div>
              <div className="form-field" style={{ maxWidth: 280 }}>
                <label className="field-label">複製前一期</label>
                <button
                  className="button button-outline"
                  disabled={!canEdit || !prev}
                  title={
                    prev
                      ? `帶入 ${prev.periodLabel} 的頻次／月份／件數／單位／備註`
                      : "前一期無排程資料"
                  }
                  onClick={handleCopyPrev}
                >
                  <Copy size={15} />{" "}
                  {prev ? `帶入 ${prev.periodLabel}` : "前一期無資料"}
                </button>
              </div>
            </div>

            <div className="form-field">
              <label className="field-label">
                受審單位（可複選）
                {!unlimited && unitIds.length > 0 && `：已選 ${unitIds.length} 個`}
              </label>
              <label className="check-row" style={{ marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={unlimited}
                  disabled={!canEdit}
                  onChange={(e) => setUnlimited(e.target.checked)}
                />
                <b>不限單位</b>
                <span className="muted-text">
                  （不固定單位、沒有單位限制；單位顯示為 NA，審查時不用選單位）
                </span>
              </label>
              <UnitTreePicker
                units={units}
                groupMap={groupMap}
                selected={unitIds}
                onChange={setUnitIds}
                disabled={!canEdit || unlimited}
                unitNameOf={unitNameOf}
              />
            </div>

            <div className="form-row">
              <div className="form-field" style={{ maxWidth: 200 }}>
                <label className="field-label">審查頻次</label>
                <div className="select-wrap">
                  <select
                    value={frequency}
                    disabled={!canEdit}
                    onChange={(e) =>
                      handleFrequencyChange(Number(e.target.value) as ReviewFrequency)
                    }
                  >
                    {FREQUENCY_OPTIONS.map((f) => (
                      <option key={f} value={f}>
                        {frequencyLabel(f)}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={15} />
                </div>
              </div>
              <div className="form-field" style={{ maxWidth: 200 }}>
                <label className="field-label">審查區間</label>
                <div className="select-wrap">
                  <select
                    value={interval}
                    disabled={!canEdit}
                    onChange={(e) =>
                      setInterval(Number(e.target.value) as 1 | 2 | 3)
                    }
                  >
                    {INTERVAL_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n}個月
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={15} />
                </div>
              </div>
              <div className="form-field" style={{ maxWidth: 200 }}>
                <label className="field-label">
                  {unlimited ? "每審查區間件數 *" : "每單位每審查區間件數 *"}
                  <span className="muted-text">
                    {unlimited
                      ? "（區間內各月份合計；區間內所有審查員共用）"
                      : "（區間內各月份合計；同單位多位審查員共用）"}
                  </span>
                </label>
                <span className="case-count-field">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={caseCount.value}
                    placeholder="3"
                    disabled={!canEdit}
                    onChange={(e) => caseCount.onInput(e.target.value)}
                    aria-label="審查件數"
                  />
                  件
                </span>
              </div>
            </div>
            <p className="settings-note">
              審查頻次將 12 個月平分（例：4次/年 → 1、4、7、10月；學年度
              3次/年 → 8、12、4月）；審查區間為每次審查連續涵蓋的月數。
              {months.length > 0 &&
                ` 本次審查區間：${intervalRangeLabels(
                  [...months].sort(
                    (a, b) => monthOrder.indexOf(a) - monthOrder.indexOf(b),
                  ),
                  interval,
                ).join("、")}`}
            </p>

            <div className="form-field">
              <label className="field-label">
                審查月份（可複選）
                {months.length > 0 && `：已選 ${months.length} 個月`}
              </label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                <button
                  className="button button-outline button-sm"
                  disabled={!canEdit}
                  onClick={() => setMonths(autoSelectMonths(frequency, monthOrder))}
                >
                  依頻次預選
                </button>
                <button
                  className="button button-outline button-sm"
                  disabled={!canEdit}
                  onClick={() => setMonths([...monthOrder])}
                >
                  全選
                </button>
                <button
                  className="button button-outline button-sm"
                  disabled={!canEdit}
                  onClick={() => setMonths([])}
                >
                  清除
                </button>
              </div>
              <MonthPicker
                order={monthOrder}
                selected={months}
                onChange={setMonths}
                disabled={!canEdit}
              />
              <p className="settings-note">
                切換審查頻次會依規則重新預選月份（覆蓋手動勾選），之後可再手動調整。
                {category === "academic" &&
                  "學年度月份依 8 月制順序排列（8–12 月為前一年曆年、1–7 月為後一年曆年）。"}
              </p>
            </div>

            <div className="form-field">
              <label className="field-label">備註</label>
              <textarea
                className="text-input"
                rows={2}
                value={notes}
                disabled={!canEdit}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="例如：避開農曆年節月份"
              />
            </div>

            <div className="form-actions">
              {canEdit && (
                <button
                  className="button button-primary"
                  disabled={saving}
                  onClick={handleSave}
                >
                  {saving ? "儲存中…" : "儲存設定"}
                </button>
              )}
              {canEdit && exists && (
                <button className="button button-ghost" onClick={handleDelete}>
                  <Trash2 size={15} /> 刪除此期間設定
                </button>
              )}
            </div>
          </>
        )}
      </section>
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
  actor,
  deadlineDay,
  filterYear,
  cycle,
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
  actor: { id: string; name: string };
  deadlineDay: number;
  filterYear: number;
  cycle: "year" | "academic";
  onAction: (m: string) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const monthOrder = useMemo(() => cycleMonths(cycle, ""), [cycle]);
  const [months, setMonths] = useState<number[]>([]);
  const caseCount = useCaseCountInput();
  const [selUnits, setSelUnits] = useState<string[]>(
    () => row.schedule?.unitIds ?? [],
  );
  // v1.51.0：不限單位（NA 排程的加審預設為不限單位模式）
  const [unlimited, setUnlimited] = useState(
    () => row.schedule?.unlimitedUnits === true,
  );
  const [selReviewers, setSelReviewers] = useState<string[]>(() =>
    row.schedule?.unlimitedUnits === true
      ? (assignment?.items ?? []).map((it) => it.reviewerId)
      : defaultAddAuditReviewers(assignment, row.schedule?.unitIds ?? []),
  );
  const [items, setItems] = useState<AssignmentItem[]>([]);
  const [saving, setSaving] = useState(false);

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
          sub: m.groupId ? (groupMap.get(m.groupId) ?? m.groupId) : "分工表",
          groupId: m.groupId,
        }))
        .sort((a, b) => a.id.localeCompare(b.id, "zh-Hant")),
    [reviewerMeta, groupMap],
  );

  const unitOptions: PickerOption[] = useMemo(
    () =>
      units.map((u) => ({
        id: u.code,
        label: `${u.name}（${u.code}）`,
        sub: groupMap.get(u.groupId) ?? u.groupId,
        groupId: u.groupId,
      })),
    [units, groupMap],
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

  function toggleId(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  function applyToTable() {
    if (selReviewers.length === 0) {
      onAction("請先選擇審核員");
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
    setSaving(true);
    try {
      const db = getFirebaseDb();
      const { taskCount } = await createTempSchedule(db, {
        indicatorId: row.indicatorId,
        unitIds: [],
        months: [...months].sort((a, b) => a - b),
        caseCount: parseCaseCount(Number(caseCount.value)),
        reviewerIds: [],
        items,
        refYear: filterYear,
        selfReview: false,
        actor,
        deadlineDay,
      });
      onAction(`已建立加審排程（臨時）：${taskCount} 筆任務`);
      onDone();
    } catch (error) {
      onAction(`加審失敗：${toErrorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={`加審：${row.name}`}
      note={`建立臨時排程並直接產生任務（${filterYear}年・${cycle === "academic" ? "學年度" : "年度"}月份）`}
      onClose={onClose}
    >
      <div className="form-field">
        <label className="field-label">
          審查月份（可複選）
          {months.length > 0 && `：已選 ${months.length} 個月`}
        </label>
        <MonthPicker
          order={monthOrder}
          selected={months}
          onChange={setMonths}
          disabled={false}
        />
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
          onChange={(e) => setUnlimited(e.target.checked)}
        />
        <b>不限單位</b>
        <span className="muted-text">
          （不固定單位；單位顯示為 NA，審查時不用選單位）
        </span>
      </label>

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
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>審核員</th>
                <th>負責單位</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.reviewerId}>
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
                    <button
                      className="text-button"
                      onClick={() => removeItem(it.reviewerId)}
                    >
                      <Trash2 size={13} /> 移除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
  );
}
/* ================= 自審（護理長，臨時排程） ================= */

function SelfAuditDialog({
  indicators,
  userUnitCode,
  userUnitName,
  unitUsers,
  usersMap,
  actor,
  deadlineDay,
  onAction,
  onClose,
  onDone,
}: {
  indicators: IndicatorLite[];
  userUnitCode: string;
  userUnitName: string;
  unitUsers: UserLite[];
  usersMap: Map<string, string>;
  actor: { id: string; name: string };
  deadlineDay: number;
  onAction: (m: string) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const [indicatorId, setIndicatorId] = useState(
    () => indicators.find((i) => i.status === "啟用")?.id ?? "",
  );
  // v1.17：自審指標選擇器只列「啟用」的指標
  const activeIndicators = indicators.filter((i) => i.status === "啟用");
  const [months, setMonths] = useState<number[]>([]);
  const caseCount = useCaseCountInput();
  const [reviewerIds, setReviewerIds] = useState<string[]>(() =>
    defaultSelfAuditReviewers(unitUsers, userUnitCode),
  );
  const [saving, setSaving] = useState(false);

  function toggleReviewer(id: string) {
    setReviewerIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  const previewTasks = previewTempTaskCount(months, [userUnitCode], reviewerIds);

  async function handleConfirm() {
    if (!indicatorId) {
      onAction("請選擇指標");
      return;
    }
    if (months.length === 0) {
      onAction("請至少選擇一個審查月份");
      return;
    }
    if (reviewerIds.length === 0) {
      onAction("請至少選擇一位審核員");
      return;
    }
    setSaving(true);
    try {
      const db = getFirebaseDb();
      const cc =
        caseCount.value.trim() === "" ? null : Number(caseCount.value);
      const { taskCount } = await createTempSchedule(db, {
        indicatorId,
        unitIds: [userUnitCode],
        months: [...months].sort((a, b) => a - b),
        caseCount: parseCaseCount(cc),
        reviewerIds: [...reviewerIds],
        selfReview: true,
        actor,
        deadlineDay,
      });
      const indName =
        indicators.find((i) => i.id === indicatorId)?.name ?? indicatorId;
      onAction(`已建立自審排程（臨時）：${indName}・${taskCount} 筆任務`);
      onDone();
    } catch (error) {
      onAction(`自審失敗：${toErrorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title="新增自審"
      note="護理長為自己單位建立的臨時自審排程（清單年別欄顯示「自審」標籤）"
      onClose={onClose}
    >
      <div className="form-field" style={{ maxWidth: 320 }}>
        <label className="field-label">指標</label>
        <div className="select-wrap">
          <select
            value={indicatorId}
            onChange={(e) => setIndicatorId(e.target.value)}
          >
            {activeIndicators.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}（{i.id}）
              </option>
            ))}
          </select>
          <ChevronDown size={15} />
        </div>
      </div>

      <div className="form-field">
        <label className="field-label">受審單位（鎖定）</label>
        <p>
          <b>{userUnitName}</b>
          <span className="muted-text">（{userUnitCode}）</span>
        </p>
      </div>

      <div className="form-field">
        <label className="field-label">
          審查月份（可複選）
          {months.length > 0 && `：已選 ${months.length} 個月`}
        </label>
        <MonthPicker
          order={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]}
          selected={months}
          onChange={setMonths}
          disabled={false}
        />
      </div>

      <div className="form-field">
        <label className="field-label">
          審查件數
          <span className="muted-text">（留白＝未設定）</span>
        </label>
        <span className="case-count-field">
          <input
            type="number"
            min={1}
            step={1}
            value={caseCount.value}
            placeholder="未設定"
            onChange={(e) => caseCount.onInput(e.target.value)}
            aria-label="審查件數"
          />
          件
        </span>
      </div>

      <div className="form-field">
        <label className="field-label">
          審核員（可複選；預設為自己單位在職人員）
        </label>
        {unitUsers.length === 0 ? (
          <p className="settings-note">自己單位尚無在職人員資料。</p>
        ) : (
          <div className="unit-check-grid">
            {unitUsers.map((u) => (
              <label key={u.id} className="check-row">
                <input
                  type="checkbox"
                  checked={reviewerIds.includes(u.id)}
                  onChange={() => toggleReviewer(u.id)}
                />
                <span>
                  {staffLabel(u.id, usersMap.get(u.id) ?? "")}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="form-field">
        <label className="field-label">預覽</label>
        <p>
          <b>{previewTasks}</b> 筆任務
          <span className="muted-text">
            （{months.length} 個月 × 1 單位 × {reviewerIds.length}{" "}
            位審核員）
          </span>
        </p>
      </div>

      <div className="form-actions">
        <button
          className="button button-primary"
          disabled={saving || previewTasks === 0 || !indicatorId}
          onClick={handleConfirm}
        >
          {saving ? "建立中…" : (
            <>
              <Check size={15} /> 確認自審
            </>
          )}
        </button>
        <button className="button button-ghost" onClick={onClose}>
          取消
        </button>
      </div>
    </Modal>
  );
}

/* ================= 查閱：設定內容＋任務（v1.18 彈窗） ================= */

interface TaskLite {
  year: number;
  month: number;
  unitId: string;
  reviewerId: string;
  status: string;
  deadline: string;
  caseCount: number | null;
}

function ScheduleDetailModal({
  row,
  assignment,
  usersMap,
  unitNameOf,
  onAction,
  onClose,
}: {
  row: RowItem;
  assignment: IndicatorAssignment | null;
  usersMap: Map<string, string>;
  unitNameOf: (code: string) => string;
  onAction: (m: string) => void;
  onClose: () => void;
}) {
  const sched = row.schedule;
  const isTemp = row.category === "temp";
  const [tasks, setTasks] = useState<TaskLite[]>([]);
  const [loading, setLoading] = useState(true);

  const ymSet = useMemo(() => {
    if (!sched) return new Set<string>();
    return new Set(
      scheduleCalendarMonths(sched).map(({ year, month }) => `${year}-${month}`),
    );
  }, [sched]);

  useEffect(() => {
    if (!sched) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const db = getFirebaseDb();
        const snap = await getDocs(
          query(
            collection(db, "reviewTasks"),
            where("indicatorId", "==", row.indicatorId),
          ),
        );
        if (cancelled) return;
        const list: TaskLite[] = [];
        snap.docs.forEach((d) => {
          const v = d.data() as Record<string, unknown>;
          const y = Number(v.year ?? 0);
          const mo = Number(v.month ?? 0);
          if (!ymSet.has(`${y}-${mo}`)) return;
          list.push({
            year: y,
            month: mo,
            unitId: String(v.unitId ?? ""),
            reviewerId: String(v.reviewerId ?? ""),
            status: String(v.status ?? "pending"),
            deadline: String(v.deadline ?? ""),
            caseCount:
              typeof v.caseCount === "number" && v.caseCount >= 1
                ? v.caseCount
                : null,
          });
        });
        list.sort(
          (a, b) =>
            a.year - b.year ||
            a.month - b.month ||
            a.unitId.localeCompare(b.unitId, "zh-Hant"),
        );
        setTasks(list);
      } catch (error) {
        if (!cancelled) onAction(`讀取任務失敗：${toErrorMessage(error)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sched, row.indicatorId, ymSet, onAction]);

  // 臨時排程：審核員由任務推導（臨時排程不存分工表）
  const tempReviewers = useMemo(() => {
    if (!isTemp) return [];
    const m = new Map<string, string>();
    for (const t of tasks) {
      if (!m.has(t.reviewerId))
        m.set(t.reviewerId, usersMap.get(t.reviewerId) ?? t.reviewerId);
    }
    return [...m.entries()].sort((a, b) =>
      a[0].localeCompare(b[0], "zh-Hant"),
    );
  }, [isTemp, tasks, usersMap]);

  const monthLabels = useMemo(() => {
    if (!sched) return "";
    return [...sched.months]
      .sort((a, b) => a - b)
      .map((m) => MONTH_LABELS[m - 1])
      .join("、");
  }, [sched]);

  // v1.23：年度／學年度顯示各期區間（例：8-9月、12-1月、4-5月）；臨時／舊排程顯示起始月份
  const intervalRangeText = useMemo(() => {
    if (!sched || sched.category === "temp") return "";
    const len = resolveIntervalMonths(sched.frequency, sched.intervalMonths);
    if (len == null) return "";
    const order = cycleMonths(sched.category, sched.period);
    const starts = [...sched.months].sort(
      (a, b) => order.indexOf(a) - order.indexOf(b),
    );
    return intervalRangeLabels(starts, len).join("、");
  }, [sched]);

  if (!sched) return null;
  return (
    <Modal
      title={`查閱：${row.name}`}
      note={`${isTemp ? (sched.selfReview ? "自審" : "加審") : categoryLabel(row.category)}・${sched.periodLabel}`}
      onClose={onClose}
      wide
    >
      <SectionTitle title="排程／單位設定" />
      <div className="table-scroll">
        <table className="data-table">
          <tbody>
            <tr>
              <td style={{ whiteSpace: "nowrap" }}><b>期間</b></td>
              <td data-label="期間">
                {sched.periodLabel}
                {isTemp &&
                  !sched.selfReview &&
                  sched.refYear != null &&
                  `（${sched.refYear}年加審）`}
              </td>
            </tr>
            <tr>
              <td style={{ whiteSpace: "nowrap" }}><b>審查月份</b></td>
              <td data-label="審查月份">{intervalRangeText || monthLabels || "—"}</td>
            </tr>
            {!isTemp && (
              <>
                <tr>
                  <td style={{ whiteSpace: "nowrap" }}><b>審查頻次</b></td>
                  <td data-label="審查頻次">
                    {sched.frequency != null
                      ? frequencyLabel(sched.frequency)
                      : "—"}
                  </td>
                </tr>
                <tr>
                  <td style={{ whiteSpace: "nowrap" }}><b>審查區間</b></td>
                  <td data-label="審查區間">
                    {sched.intervalMonths != null
                      ? intervalLabel(sched.intervalMonths)
                      : "—"}
                  </td>
                </tr>
              </>
            )}
            <tr>
              <td style={{ whiteSpace: "nowrap" }}><b>受審單位</b></td>
              <td data-label="受審單位">
                {sched.unlimitedUnits
                  ? "不限單位"
                  : sched.unitIds.length === 0
                    ? "—"
                    : sched.unitIds
                        .map(
                          (c) => `${unitNameOf(c)}（${c}）`,
                        )
                        .join("、")}
              </td>
            </tr>
            <tr>
              <td style={{ whiteSpace: "nowrap" }}><b>審查件數</b></td>
              <td data-label="審查件數">
                {sched.caseCount != null
                  ? sched.category === "temp"
                    ? `${sched.caseCount} 件/輪`
                    : sched.unlimitedUnits
                      ? `${sched.caseCount} 件/每區間（跨月份、區間內審查員共用）`
                      : `${sched.caseCount} 件/每單位每區間（跨月份、同單位審查員共用）`
                  : "—"}
              </td>
            </tr>
            {sched.notes && (
              <tr>
                <td style={{ whiteSpace: "nowrap" }}><b>備註</b></td>
                <td data-label="備註">{sched.notes}</td>
              </tr>
            )}
            <tr>
              <td style={{ whiteSpace: "nowrap" }}><b>最後編輯</b></td>
              <td data-label="最後編輯">
                {sched.updatedByName || "—"}・{fmtTs(sched.updatedAt)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <SectionTitle
        title="審查員／單位設定"
        note={isTemp ? "臨時排程不存分工表" : undefined}
      />
      {isTemp ? (
        loading ? (
          <p className="settings-note">讀取中…</p>
        ) : tempReviewers.length === 0 ? (
          <p className="settings-note">尚無任務</p>
        ) : (
          <p>
            {tempReviewers.map(([id, name]) => (
              <span key={id} className="chip" style={{ marginRight: 6 }}>
                {staffLabel(id, name)}
              </span>
            ))}
          </p>
        )
      ) : assignment && assignment.items.length > 0 ? (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>審查員</th>
                <th>負責單位</th>
              </tr>
            </thead>
            <tbody>
              {assignment.items.map((it) => (
                <tr key={it.reviewerId}>
                  <td data-label="審查員">
                    <b>{staffLabel(it.reviewerId, usersMap.get(it.reviewerId) ?? "")}</b>
                  </td>
                  <td data-label="負責單位">
                    {it.unlimitedUnits === true
                      ? "不限單位"
                      : it.units
                          .map((u) => `${unitNameOf(u.unitId)}（${u.unitId}）`)
                          .join("、")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="settings-note">尚未設定分工表</p>
      )}

      <div className="form-actions">
        <button className="button button-outline" onClick={onClose}>
          關閉
        </button>
      </div>
    </Modal>
  );
}
/* ================= 審查員／單位設定（v1.18：組別篩選＋搜尋多選） ================= */

function AssignmentEditor({
  indicatorId,
  reviewersByGroup,
  units,
  groupMap,
  usersMap,
  initial,
  canEdit,
  onAction,
  onSaved,
}: {
  indicatorId: string;
  reviewersByGroup: Map<string, ReviewerLite[]>;
  units: UnitLite[];
  groupMap: Map<string, string>;
  usersMap: Map<string, string>;
  initial: IndicatorAssignment | null;
  canEdit: boolean;
  onAction: (m: string) => void;
  onSaved: () => void;
}) {
  const [items, setItems] = useState<AssignmentItem[]>(
    initial
      ? initial.items.map((it) => ({
          reviewerId: it.reviewerId,
          units: it.units.map((u) => ({ ...u })),
          ...(it.unlimitedUnits === true
            ? { unlimitedUnits: true as const }
            : {}),
        }))
      : [],
  );
  const [selReviewers, setSelReviewers] = useState<string[]>([]);
  const [selUnits, setSelUnits] = useState<string[]>([]);
  // v1.51.0：不限單位模式（此審查員不固定單位）
  const [unlimited, setUnlimited] = useState(false);
  const [saving, setSaving] = useState(false);

  // 審查員候選：全部組別的審查員主檔（組別下拉篩選）
  const reviewerOptions: PickerOption[] = useMemo(() => {
    const out: PickerOption[] = [];
    reviewersByGroup.forEach((arr, gid) => {
      for (const r of arr) {
        out.push({
          id: r.personId,
          label: staffLabel(r.personId, r.name),
          sub: groupMap.get(gid) ?? gid,
          groupId: gid,
        });
      }
    });
    return out.sort((a, b) => a.id.localeCompare(b.id, "zh-Hant"));
  }, [reviewersByGroup, groupMap]);

  const unitOptions: PickerOption[] = useMemo(
    () =>
      units.map((u) => ({
        id: u.code,
        label: `${u.name}（${u.code}）`,
        sub: groupMap.get(u.groupId) ?? u.groupId,
        groupId: u.groupId,
      })),
    [units, groupMap],
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

  const duplicates = useMemo(() => findDuplicateUnits(items), [items]);

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
    if (unlimited) {
      setItems((prev) => mergeItemsUnlimited(prev, selReviewers));
      onAction(
        `已加入分工表：${selReviewers.length} 位審查員（不限單位）`,
      );
      setSelReviewers([]);
      return;
    }
    if (selUnits.length === 0) {
      onAction("請至少勾選一個單位");
      return;
    }
    setItems((prev) => mergeItemsWithUnits(prev, selReviewers, selUnits));
    onAction(
      `已加入分工表：${selReviewers.length} 位審查員 × ${selUnits.length} 個單位`,
    );
    setSelReviewers([]);
    setSelUnits([]);
  }

  function removeItem(reviewerId: string) {
    setItems((prev) => prev.filter((it) => it.reviewerId !== reviewerId));
  }

  async function handleSave() {
    if (items.length === 0) {
      onAction("分工表尚無資料，請先加入審查員與單位");
      return;
    }
    const dups = findDuplicateUnits(items);
    if (dups.size > 0) {
      const lines = [...dups.entries()].map(
        ([u, rs]) => `${u}：${rs.map((r) => reviewerName(r)).join("、")}`,
      );
      const ok = window.confirm(
        `以下單位被重複指派給 2 位以上審查員：\n${lines.join("\n")}\n\n確定要儲存嗎？（僅警示，不阻擋）`,
      );
      if (!ok) return;
    }
    setSaving(true);
    try {
      const db = getFirebaseDb();
      await setDoc(doc(db, "indicatorAssignments", indicatorId), {
        indicatorId,
        items,
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
          note="先選審查員（可多選），再選其負責單位（可多選），按「加入分工表」；同一單位可指派給多位審查員（會警示但不阻擋）。審查件數在「排程／單位設定」中按年度設定。"
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
            disabled={!canEdit}
            onChange={(e) => setUnlimited(e.target.checked)}
          />
          <b>不限單位</b>
          <span className="muted-text">
            （勾選後不選負責單位；單位顯示為 NA，審查時不用選單位）
          </span>
        </label>
        <OptionMultiPicker
          title="2. 選擇負責單位"
          options={unitOptions}
          groupMap={groupMap}
          selected={selUnits}
          onToggle={(id) => setSelUnits((prev) => toggleId(prev, id))}
          disabled={!canEdit || unlimited}
          searchPlaceholder="搜尋單位名稱或代碼"
        />
        {canEdit && (
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
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>審查員</th>
                  <th>負責單位</th>
                  {canEdit && <th>操作</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.reviewerId}>
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
                    {canEdit && (
                      <td>
                        <button
                          className="text-button"
                          onClick={() => removeItem(it.reviewerId)}
                        >
                          <Trash2 size={13} /> 移除
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
    </>
  );
}
