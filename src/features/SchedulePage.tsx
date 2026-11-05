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
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "../lib/db";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { getFirebaseDb } from "../lib/firebase";
import { usePermissions } from "../lib/usePermissions";
import { useAuth } from "../lib/auth";
import { maskName } from "../lib/mask";
import {
  academicYearOf,
  categoryLabel,
  cycleMonths,
  monthToCalendarYear,
  periodLabel,
  type CycleCategory,
} from "../lib/cycle";
import {
  MONTH_LABELS,
  autoSelectMonths,
  buildTasksFromSchedule,
  createTempSchedule,
  DEFAULT_FREQUENCY,
  DEFAULT_INTERVAL,
  deleteSchedule,
  findDuplicateUnits,
  FREQUENCY_OPTIONS,
  frequencyLabel,
  getSchedule,
  INTERVAL_OPTIONS,
  intervalLabel,
  listSchedules,
  normalizeAssignmentItem,
  parseCaseCount,
  periodForFilter,
  previousPeriodSchedule,
  saveSchedule,
  scheduleSetupComplete,
  YEAR_FILTER_OPTIONS,
  yearOptionLabel,
  type AssignmentItem,
  type IndicatorAssignment,
  type IndicatorSchedule,
  type ReviewFrequency,
  type ReviewInterval,
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

/** 排程月份 → 曆年月清單（學年度會跨兩個曆年） */
function scheduleCalendarMonths(
  s: IndicatorSchedule,
): { year: number; month: number }[] {
  return s.months.map((m) => ({
    year: monthToCalendarYear(s.category, s.period, m),
    month: m,
  }));
}

interface IndicatorLite {
  id: string;
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
}

interface ReviewerLite {
  personId: string;
  name: string;
}

interface RowItem {
  key: string;
  indicatorId: string;
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

const TASK_STATUS_LABEL: Record<string, string> = {
  pending: "未執行",
  done: "已完成",
  locked: "已鎖定",
};

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
 * 純函式，可單元測試。
 */
export function mergeItemsWithUnits(
  prev: AssignmentItem[],
  reviewerIds: string[],
  unitIds: string[],
): AssignmentItem[] {
  const next = prev.map((it) => ({
    reviewerId: it.reviewerId,
    units: it.units.map((u) => ({ ...u })),
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
    if (idx >= 0) next[idx] = { reviewerId: rid, units: merged };
    else next.push({ reviewerId: rid, units: merged });
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
  const canEdit = can("manageSchedule");
  const actor = useMemo(
    () => ({ id: user?.staffId ?? "", name: user?.name ?? "" }),
    [user],
  );
  const isHeadNurse = (user?.title ?? "").includes("護理長");
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
  const [filterYear, setFilterYear] = useState(() => new Date().getFullYear());
  const [statsCycle, setStatsCycle] = useState<"year" | "academic">("year");
  const [showTemp, setShowTemp] = useState(false);
  const [filterGroup, setFilterGroup] = useState("");
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
        const snap = await getDoc(doc(getFirebaseDb(), "systemParams", "config"));
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
          getDocs(collection(db, "indicators")),
          getDocs(collection(db, "groups")),
          getDocs(collection(db, "indicatorAssignments")),
          getDocs(collection(db, "units")),
          getDocs(collection(db, "users")),
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
          };
        }),
      );

      const um = new Map<string, string>();
      unsnap.docs.forEach((d) => {
        const name = d.data().name;
        um.set(d.id, typeof name === "string" ? name : d.id);
      });
      const rbm = new Map<string, ReviewerLite[]>();
      rsnap.docs.forEach((d) => {
        const data = d.data();
        const groupId = typeof data.groupId === "string" ? data.groupId : "";
        const personId = typeof data.personId === "string" ? data.personId : "";
        if (!groupId || !personId) return;
        const arr = rbm.get(groupId) ?? [];
        arr.push({ personId, name: um.get(personId) ?? personId });
        rbm.set(groupId, arr);
      });
      rbm.forEach((arr) =>
        arr.sort((a, b) => a.personId.localeCompare(b.personId, "zh-Hant")),
      );
      setReviewersByGroup(rbm);

      // 任務索引（單欄位 where，不需複合索引）
      const idx = new Map<string, Map<string, { pending: number; done: number }>>();
      await Promise.all(
        inds.map(async (ind) => {
          try {
            const tsnap = await getDocs(
              query(
                collection(db, "reviewTasks"),
                where("indicatorId", "==", ind.id),
              ),
            );
            const m = new Map<string, { pending: number; done: number }>();
            tsnap.docs.forEach((d) => {
              const v = d.data() as Record<string, unknown>;
              const y = Number(v.year ?? 0);
              const mo = Number(v.month ?? 0);
              if (!y || !mo) return;
              const k = `${y}-${mo}`;
              const e = m.get(k) ?? { pending: 0, done: 0 };
              if (v.status === "done") e.done += 1;
              else e.pending += 1;
              m.set(k, e);
            });
            idx.set(ind.id, m);
          } catch {
            /* 單一指標失敗不影響其他 */
          }
        }),
      );
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

  // ---------- 主畫面列：一列＝（啟用指標×當期）；無排程也列出以便建立 ----------
  const rows: RowItem[] = useMemo(() => {
    let inds = indicators.filter((i) => i.status === "啟用");
    if (filterGroup) inds = inds.filter((i) => i.groupId === filterGroup);
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

  /** 各指標的臨時（加審）筆數：加審按鈕下方顯示用 */
  const tempCountByIndicator = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of schedules) {
      if (s.category !== "temp") continue;
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
        `${sched.periodLabel}已有 ${pending} 筆未執行、${done} 筆已完成任務。產生排程將刪除未執行的任務後重建；已完成的月份不會被修改（含當初的審查件數），確定嗎？`,
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
                  onChange={(e) => setFilterGroup(e.target.value)}
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
                            <>
                              臨時
                              {sched?.selfReview && (
                                <div>
                                  <span className="status-pill info">自審</span>
                                </div>
                              )}
                              {sched?.refYear != null && (
                                <div className="muted-text">
                                  {sched.refYear}年加審
                                </div>
                              )}
                            </>
                          ) : (
                            <>
                              {categoryLabel(r.category)}
                              <div className="muted-text">
                                {periodLabel(r.category, r.period)}
                              </div>
                            </>
                          )}
                        </td>
                        <td className="muted-text">{r.indicatorId}</td>
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
                          {schedDone && sched && (
                            <div className="muted-text">
                              {sched.months.length} 個月・{sched.unitIds.length}{" "}
                              單位
                              {sched.caseCount != null &&
                                `・${sched.caseCount} 件/輪`}
                            </div>
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
                            </div>
                          )}
                        </td>
                        <td>
                          {!!sched && !isTemp && (
                            <>
                              <div style={{ marginBottom: 4 }}>
                                <span className={hasTasks ? PILL_OK : PILL_NONE}>
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
                              </div>
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
                              </button>{" "}
                            </>
                          )}
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
                                臨時 {tempCount} 筆
                              </div>
                            </>
                          )}{" "}
                          {!!sched && (
                            <button
                              className="text-button"
                              onClick={() => setDetailRow(r)}
                              title="查閱設定內容與任務"
                            >
                              <Eye size={14} /> 查閱
                            </button>
                          )}
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
              onBack={backToList}
            />
          )}
          {view.kind === "assignment" && (
            <AssignmentEditor
              indicatorId={indicator.id}
              indicatorGroupId={indicator.groupId}
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
  children,
}: {
  title: string;
  note?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="reviewer-modal-backdrop" onClick={onClose}>
      <div
        className="reviewer-modal panel"
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
  onBack,
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
  onBack: () => void;
}) {
  const [year, setYear] = useState(initialYear);
  const period = periodForFilter(category, year);
  const [months, setMonths] = useState<number[]>([]);
  const [frequency, setFrequency] =
    useState<ReviewFrequency>(DEFAULT_FREQUENCY);
  const [intervalMonths, setIntervalMonths] =
    useState<ReviewInterval>(DEFAULT_INTERVAL);
  const caseCount = useCaseCountInput();
  const [unitIds, setUnitIds] = useState<string[]>([]);
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
          // 編輯舊排程：保留原月份，不強制重算（v1.18）
          setMonths(s.months);
          setFrequency(s.frequency ?? DEFAULT_FREQUENCY);
          setIntervalMonths(s.intervalMonths ?? DEFAULT_INTERVAL);
        } else {
          // 新排程：依預設頻次＋區間自動預選月份
          setMonths(
            autoSelectMonths(DEFAULT_FREQUENCY, DEFAULT_INTERVAL, monthOrder),
          );
          setFrequency(DEFAULT_FREQUENCY);
          setIntervalMonths(DEFAULT_INTERVAL);
        }
        caseCount.setValue(s?.caseCount != null ? String(s.caseCount) : "");
        setUnitIds(s?.unitIds ?? []);
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

  /** 切換頻次／區間下拉 → 重新依規則預選月份（覆蓋手動勾選） */
  function handleFrequencyChange(f: ReviewFrequency) {
    setFrequency(f);
    setMonths(autoSelectMonths(f, intervalMonths, monthOrder));
  }
  function handleIntervalChange(m: ReviewInterval) {
    setIntervalMonths(m);
    setMonths(autoSelectMonths(frequency, m, monthOrder));
  }

  function handleCopyPrev() {
    if (!prev) return;
    setMonths([...prev.months]);
    if (prev.frequency) setFrequency(prev.frequency);
    if (prev.intervalMonths) setIntervalMonths(prev.intervalMonths);
    caseCount.setValue(prev.caseCount != null ? String(prev.caseCount) : "");
    setUnitIds([...prev.unitIds]);
    setNotes(prev.notes);
    onAction(`已帶入前一期（${prev.periodLabel}）設定，請確認後儲存`);
  }

  async function handleSave() {
    if (months.length === 0) {
      onAction("請至少選擇一個審查月份");
      return;
    }
    if (unitIds.length === 0) {
      onAction("請至少選擇一個受審單位");
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
          intervalMonths,
          refYear: null,
          caseCount: parseCaseCount(cc),
          unitIds: [...unitIds],
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
      <div style={{ marginBottom: 12 }}>
        <button className="button button-outline" onClick={onBack}>
          <ArrowLeft size={15} /> 返回品管審查排程
        </button>
      </div>
      <section className="panel">
        <SectionTitle
          title="排程設定"
          note={`${categoryLabel(category)}・${periodLabel(category, period)}`}
        />
        {loadingPeriod ? (
          <p className="settings-note">讀取中…</p>
        ) : (
          <>
            <div className="form-grid">
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
                      ? `帶入 ${prev.periodLabel} 的頻次／區間／月份／件數／單位／備註`
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
                {unitIds.length > 0 && `：已選 ${unitIds.length} 個`}
              </label>
              <UnitTreePicker
                units={units}
                groupMap={groupMap}
                selected={unitIds}
                onChange={setUnitIds}
                disabled={!canEdit}
                unitNameOf={unitNameOf}
              />
            </div>

            <div className="form-grid">
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
                    value={intervalMonths}
                    disabled={!canEdit}
                    onChange={(e) =>
                      handleIntervalChange(Number(e.target.value) as ReviewInterval)
                    }
                  >
                    {INTERVAL_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {intervalLabel(m)}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={15} />
                </div>
              </div>
            </div>
            <p className="settings-note">
              審查區間＝每次審查連續涵蓋的月數（例：4次/年＋3個月 → 1–3月、4–6月、7–9月、10–12月）。
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
                  onClick={() =>
                    setMonths(autoSelectMonths(frequency, intervalMonths, monthOrder))
                  }
                >
                  依頻次／區間預選
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
                切換審查頻次／區間會依規則重新預選月份（覆蓋手動勾選），之後可再手動調整。
                {category === "academic" &&
                  "學年度月份依 8 月制順序排列（8–12 月為前一年曆年、1–7 月為後一年曆年）。"}
              </p>
            </div>

            <div className="form-field">
              <label className="field-label">
                審查件數 *
                <span className="muted-text">（適用該期間所有單位；必填）</span>
              </label>
              <span className="case-count-field">
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={caseCount.value}
                  placeholder="必填"
                  disabled={!canEdit}
                  onChange={(e) => caseCount.onInput(e.target.value)}
                  aria-label="審查件數"
                />
                件
              </span>
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
  const [selReviewers, setSelReviewers] = useState<string[]>(() =>
    defaultAddAuditReviewers(assignment, row.schedule?.unitIds ?? []),
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
          label: `${maskName(m.name)}（${id}）`,
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
    (id: string) => maskName(reviewerMeta.get(id)?.name ?? id),
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
        .map((it) =>
          it.reviewerId === reviewerId
            ? { ...it, units: it.units.filter((u) => u.unitId !== unitId) }
            : it,
        )
        .filter((it) => it.units.length > 0),
    );
  }

  const pairCount = items.reduce((n, it) => n + it.units.length, 0);
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

      <OptionMultiPicker
        title="選擇受審單位"
        options={unitOptions}
        groupMap={groupMap}
        selected={selUnits}
        onToggle={(id) => setSelUnits((prev) => toggleId(prev, id))}
        searchPlaceholder="搜尋單位名稱或代碼"
      />

      <OptionMultiPicker
        title="選擇審核員"
        options={reviewerOptions}
        groupMap={groupMap}
        defaultGroupId={row.groupId}
        selected={selReviewers}
        onToggle={(id) => setSelReviewers((prev) => toggleId(prev, id))}
        searchPlaceholder="搜尋姓名或職編"
      />

      <div className="form-actions">
        <button
          className="button button-outline"
          disabled={selReviewers.length === 0 || selUnits.length === 0}
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
            : `${items.length} 位審核員・${pairCount} 單位指派`
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
                    {it.units.map((u) => (
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
                    ))}
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
            （{months.length} 個月 × {pairCount} 組審核員-單位配對）
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
      note="護理長為自己單位建立的臨時自審排程（清單類別顯示「臨時」＋自審標籤）"
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
                  {maskName(usersMap.get(u.id) ?? u.id)}
                  <span className="muted-text">（{u.id}）</span>
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

  if (!sched) return null;
  return (
    <Modal
      title={`查閱：${row.name}`}
      note={`${isTemp ? "臨時" : categoryLabel(row.category)}・${sched.periodLabel}${sched.selfReview ? "・自審" : ""}`}
      onClose={onClose}
    >
      <SectionTitle title="排程／單位設定" />
      <div className="table-scroll">
        <table className="data-table">
          <tbody>
            <tr>
              <td style={{ whiteSpace: "nowrap" }}><b>期間</b></td>
              <td>
                {sched.periodLabel}
                {sched.refYear != null && `（${sched.refYear}年加審）`}
              </td>
            </tr>
            <tr>
              <td style={{ whiteSpace: "nowrap" }}><b>審查月份</b></td>
              <td>{monthLabels || "—"}</td>
            </tr>
            {!isTemp && (
              <>
                <tr>
                  <td style={{ whiteSpace: "nowrap" }}><b>審查頻次</b></td>
                  <td>
                    {sched.frequency != null
                      ? frequencyLabel(sched.frequency)
                      : "—"}
                  </td>
                </tr>
                <tr>
                  <td style={{ whiteSpace: "nowrap" }}><b>審查區間</b></td>
                  <td>
                    {sched.intervalMonths != null
                      ? intervalLabel(sched.intervalMonths)
                      : "—"}
                  </td>
                </tr>
              </>
            )}
            <tr>
              <td style={{ whiteSpace: "nowrap" }}><b>受審單位</b></td>
              <td>
                {sched.unitIds.length === 0
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
              <td>
                {sched.caseCount != null ? `${sched.caseCount} 件/輪` : "—"}
              </td>
            </tr>
            {sched.notes && (
              <tr>
                <td style={{ whiteSpace: "nowrap" }}><b>備註</b></td>
                <td>{sched.notes}</td>
              </tr>
            )}
            <tr>
              <td style={{ whiteSpace: "nowrap" }}><b>最後編輯</b></td>
              <td>
                {sched.updatedByName || "—"}・{fmtTs(sched.updatedAt)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <SectionTitle
        title="審查員／單位設定"
        note={isTemp ? "臨時排程不存分工表，審核員見任務清單" : undefined}
      />
      {isTemp ? (
        tempReviewers.length === 0 ? (
          <p className="settings-note">尚無任務</p>
        ) : (
          <p>
            {tempReviewers.map(([id, name]) => (
              <span key={id} className="chip" style={{ marginRight: 6 }}>
                {maskName(name)}（{id}）
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
                  <td>
                    <b>{maskName(usersMap.get(it.reviewerId) ?? it.reviewerId)}</b>
                    <div className="muted-text">{it.reviewerId}</div>
                  </td>
                  <td>
                    {it.units
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

      <SectionTitle
        title="已產生任務"
        note={loading ? "讀取中…" : `${tasks.length} 筆`}
      />
      <p className="settings-note">
        依指標編號＋排程曆年月查出（任務未記錄所屬排程 id；同指標同時段的其他排程任務可能一併列出）。
      </p>
      {loading ? (
        <p className="settings-note">讀取中…</p>
      ) : tasks.length === 0 ? (
        <EmptyState title="尚無任務" description="此排程尚未產生任務。" />
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>曆年月</th>
                <th>受審單位</th>
                <th>審核員</th>
                <th>件數</th>
                <th>狀態</th>
                <th>截止日</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t, i) => (
                <tr key={i}>
                  <td>
                    {t.year}年{t.month}月
                  </td>
                  <td>
                    {unitNameOf(t.unitId)}
                    <div className="muted-text">{t.unitId}</div>
                  </td>
                  <td>{maskName(usersMap.get(t.reviewerId) ?? t.reviewerId)}</td>
                  <td>{t.caseCount != null ? `${t.caseCount} 件` : "—"}</td>
                  <td>{TASK_STATUS_LABEL[t.status] ?? t.status}</td>
                  <td>{t.deadline || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
  indicatorGroupId,
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
  indicatorGroupId: string;
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
        }))
      : [],
  );
  const [selReviewers, setSelReviewers] = useState<string[]>([]);
  const [selUnits, setSelUnits] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // 審查員候選：全部組別的審查員主檔（組別下拉篩選）
  const reviewerOptions: PickerOption[] = useMemo(() => {
    const out: PickerOption[] = [];
    reviewersByGroup.forEach((arr, gid) => {
      for (const r of arr) {
        out.push({
          id: r.personId,
          label: `${maskName(r.name)}（${r.personId}）`,
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
        if (r) return maskName(r.name);
      }
      return maskName(usersMap.get(id) ?? id);
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
        .map((it) =>
          it.reviewerId === reviewerId
            ? { ...it, units: it.units.filter((u) => u.unitId !== unitId) }
            : it,
        )
        .filter((it) => it.units.length > 0),
    );
  }

  function applyToTable() {
    if (selReviewers.length === 0) {
      onAction("請先選擇審查員");
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
            尚未設定審查員，請先到「群組與人員」→「審查員」頁籤新增。
          </p>
        ) : (
          <OptionMultiPicker
            title="1. 選擇審查員"
            options={reviewerOptions}
            groupMap={groupMap}
            defaultGroupId={indicatorGroupId}
            selected={selReviewers}
            onToggle={(id) => setSelReviewers((prev) => toggleId(prev, id))}
            disabled={!canEdit}
            searchPlaceholder="搜尋姓名或職編"
          />
        )}
        <OptionMultiPicker
          title="2. 選擇負責單位"
          options={unitOptions}
          groupMap={groupMap}
          selected={selUnits}
          onToggle={(id) => setSelUnits((prev) => toggleId(prev, id))}
          disabled={!canEdit}
          searchPlaceholder="搜尋單位名稱或代碼"
        />
        {canEdit && (
          <div className="form-actions">
            <button
              className="button button-outline"
              disabled={selReviewers.length === 0 || selUnits.length === 0}
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
              : `${items.length} 位審查員・${items.reduce((n, it) => n + it.units.length, 0)} 單位指派`
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
                      {it.units.map((u) => (
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
                      ))}
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

