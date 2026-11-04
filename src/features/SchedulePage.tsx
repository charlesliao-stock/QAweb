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
  Pencil,
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
  QUICK_MONTHS,
  buildTasksFromSchedule,
  createTempSchedule,
  deleteSchedule,
  findDuplicateUnits,
  getSchedule,
  listSchedules,
  normalizeAssignmentItem,
  parseCaseCount,
  previousPeriodSchedule,
  saveSchedule,
  type AssignmentItem,
  type IndicatorAssignment,
  type IndicatorSchedule,
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

/** 期間下拉選項：年度→曆年；學年度→民國學年 */
function periodOptionsFor(cat: CycleCategory): string[] {
  if (cat === "academic") {
    const roc = academicYearOf(new Date());
    return [roc - 1, roc, roc + 1, roc + 2].map(String);
  }
  const cy = new Date().getFullYear();
  return [cy - 1, cy, cy + 1, cy + 2].map(String);
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

type CatFilter = "all" | CycleCategory;

interface RowItem {
  key: string;
  indicatorId: string;
  name: string;
  groupId: string;
  groupName: string;
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
      category: CycleCategory;
      period: string;
    }
  | { kind: "assignment"; indicatorId: string }
  | { kind: "tasks"; row: RowItem };

const PILL_OK = "status-pill success";
const PILL_NONE = "status-pill muted";

const TASK_STATUS_LABEL: Record<string, string> = {
  pending: "未執行",
  done: "已完成",
  locked: "已鎖定",
};

const CAT_ORDER: CycleCategory[] = ["year", "academic", "temp"];

/* ================= 純函式（UI 判定邏輯，可單元測試） ================= */

/** 排程 pill：有排程且受審單位非空 → "done"（已排），否則 "none"（未排） */
export function schedulePillState(
  schedule: IndicatorSchedule | null,
): "done" | "none" {
  return schedule && schedule.unitIds.length > 0 ? "done" : "none";
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

  // 篩選：類別／期間／組別／關鍵字
  const [catFilter, setCatFilter] = useState<CatFilter>("all");
  const [period, setPeriod] = useState(() => String(new Date().getFullYear()));
  const [filterGroup, setFilterGroup] = useState("");
  const [filterKeyword, setFilterKeyword] = useState("");

  const [generatingKey, setGeneratingKey] = useState<string | null>(null);
  const [addAuditRow, setAddAuditRow] = useState<RowItem | null>(null);
  const [selfAuditOpen, setSelfAuditOpen] = useState(false);

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

  // 系統參數：統計週期（預設期間用）＋補審截止日（產生任務用）
  useEffect(() => {
    (async () => {
      try {
        const snap = await getDoc(doc(getFirebaseDb(), "systemParams", "config"));
        const data = snap.data() as Record<string, unknown> | undefined;
        const sc = data?.statsCycle === "academic" ? "academic" : "year";
        setPeriod(defaultPeriodForStatsCycle(sc));
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

  const defaultYearPeriod = useMemo(() => defaultPeriodForStatsCycle("year"), []);
  const defaultAcademicPeriod = useMemo(
    () => defaultPeriodForStatsCycle("academic"),
    [],
  );

  // ---------- 主畫面列：一列＝（指標×類別）當期；無排程也列出以便建立 ----------
  const rows: RowItem[] = useMemo(() => {
    const cats: CycleCategory[] =
      catFilter === "all" ? ["year", "academic", "temp"] : [catFilter];
    let inds = indicators;
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
      for (const cat of cats) {
        if (cat === "temp") {
          const temps = schedules
            .filter((s) => s.indicatorId === ind.id && s.category === "temp")
            .sort((a, b) => b.period.localeCompare(a.period));
          if (temps.length === 0) {
            out.push({
              key: `${ind.id}||temp||new`,
              indicatorId: ind.id,
              name: ind.name,
              groupId: ind.groupId,
              groupName,
              category: cat,
              period: "",
              schedule: null,
            });
          } else {
            for (const s of temps) {
              out.push({
                key: `${ind.id}||temp||${s.period}`,
                indicatorId: ind.id,
                name: ind.name,
                groupId: ind.groupId,
                groupName,
                category: cat,
                period: s.period,
                schedule: s,
              });
            }
          }
        } else {
          const p =
            catFilter === "all"
              ? cat === "year"
                ? defaultYearPeriod
                : defaultAcademicPeriod
              : period;
          const s =
            schedules.find(
              (x) =>
                x.indicatorId === ind.id && x.category === cat && x.period === p,
            ) ?? null;
          out.push({
            key: `${ind.id}||${cat}||${p}`,
            indicatorId: ind.id,
            name: ind.name,
            groupId: ind.groupId,
            groupName,
            category: cat,
            period: p,
            schedule: s,
          });
        }
      }
    }
    return out.sort(
      (a, b) =>
        a.groupName.localeCompare(b.groupName, "zh-Hant") ||
        a.name.localeCompare(b.name, "zh-Hant") ||
        CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category),
    );
  }, [
    indicators,
    schedules,
    groupMap,
    catFilter,
    period,
    filterGroup,
    filterKeyword,
    defaultYearPeriod,
    defaultAcademicPeriod,
  ]);

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

  function changeCatFilter(v: CatFilter) {
    setCatFilter(v);
    if (v === "year" || v === "academic") setPeriod(defaultPeriodForStatsCycle(v));
  }

  // 加審對話框的審核員候選：該組審查員 ∪ 分工表審查員
  const addAuditReviewers: ReviewerLite[] = useMemo(() => {
    if (!addAuditRow) return [];
    const map = new Map<string, string>();
    for (const r of reviewersByGroup.get(addAuditRow.groupId) ?? []) {
      map.set(r.personId, r.name);
    }
    for (const it of assignments.get(addAuditRow.indicatorId)?.items ?? []) {
      if (!map.has(it.reviewerId)) {
        map.set(it.reviewerId, usersMap.get(it.reviewerId) ?? it.reviewerId);
      }
    }
    return [...map.entries()]
      .map(([personId, name]) => ({ personId, name }))
      .sort((a, b) => a.personId.localeCompare(b.personId, "zh-Hant"));
  }, [addAuditRow, reviewersByGroup, assignments, usersMap]);

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
            <div className="form-field" style={{ maxWidth: 160 }}>
              <label className="field-label">類別</label>
              <div className="select-wrap">
                <select
                  value={catFilter}
                  onChange={(e) => changeCatFilter(e.target.value as CatFilter)}
                >
                  <option value="all">全部</option>
                  <option value="year">年度</option>
                  <option value="academic">學年度</option>
                  <option value="temp">臨時</option>
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
            {catFilter !== "all" && catFilter !== "temp" && (
              <div className="form-field" style={{ maxWidth: 160 }}>
                <label className="field-label">期間</label>
                <div className="select-wrap">
                  <select
                    value={period}
                    onChange={(e) => setPeriod(e.target.value)}
                  >
                    {periodOptionsFor(catFilter).map((p) => (
                      <option key={p} value={p}>
                        {catFilter === "academic" ? `${p}學年度` : `${p}年`}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={15} />
                </div>
              </div>
            )}
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
          {catFilter === "all" && (
            <p className="settings-note">
              全部類別：年度列為今年、學年度列為本學年度；臨時列出所有臨時排程。
            </p>
          )}
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
                    <th>類別</th>
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
                    const canGenerate =
                      canEdit && !!sched && schedDone && asgDone;
                    const isTemp = r.category === "temp";
                    return (
                      <tr key={r.key}>
                        <td>{r.groupName}</td>
                        <td>
                          {categoryLabel(r.category)}
                          {isTemp && sched?.selfReview && (
                            <div>
                              <span className="status-pill info">自審</span>
                            </div>
                          )}
                          {!isTemp && (
                            <div className="muted-text">
                              {periodLabel(r.category, r.period)}
                            </div>
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
                                  category: r.category,
                                  period: r.period,
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
                                      ? "請先完成排程／單位設定"
                                      : !asgDone
                                        ? "請先完成單位／審查員設定"
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
                            <button
                              className="button button-outline button-sm"
                              onClick={() => setAddAuditRow(r)}
                              title="建立臨時加審排程"
                            >
                              <Plus size={14} /> 加審
                            </button>
                          )}{" "}
                          {!!sched && (
                            <button
                              className="text-button"
                              onClick={() => setView({ kind: "tasks", row: r })}
                              title="查閱此排程產生的任務"
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
            groupMap={groupMap}
            assignment={assignments.get(addAuditRow.indicatorId) ?? null}
            reviewerOptions={addAuditReviewers}
            actor={actor}
            deadlineDay={deadlineDay}
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
  const indicator =
    subView.kind === "tasks"
      ? indicatorOf(subView.row.indicatorId)
      : indicatorOf(subView.indicatorId);
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
              initialPeriod={view.period}
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
              reviewers={reviewersByGroup.get(indicator.groupId) ?? []}
              units={units}
              groupMap={groupMap}
              usersMap={usersMap}
              initial={assignments.get(indicator.id) ?? null}
              canEdit={canEdit}
              onAction={onAction}
              onSaved={backToList}
            />
          )}
          {view.kind === "tasks" && (
            <TasksView
              row={view.row}
              usersMap={usersMap}
              unitNameOf={unitNameOf}
              onAction={onAction}
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

/** 群組→單位樹（複選／全選） */
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

  function toggle(code: string) {
    const next = new Set(sel);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange([...next]);
  }
  function toggleGroup(gid: string) {
    const codes = (unitsByGroup.get(gid) ?? []).map((u) => u.code);
    const next = new Set(sel);
    const allChecked = codes.length > 0 && codes.every((c) => next.has(c));
    if (allChecked) codes.forEach((c) => next.delete(c));
    else codes.forEach((c) => next.add(c));
    onChange([...next]);
  }

  return (
    <>
      {[...unitsByGroup.entries()].map(([gid, list]) => {
        const codes = list.map((u) => u.code);
        const allChecked = codes.length > 0 && codes.every((c) => sel.has(c));
        return (
          <div key={gid} className="unit-group-block">
            <label className="check-row unit-group-head">
              <input
                type="checkbox"
                checked={allChecked}
                disabled={disabled}
                onChange={() => toggleGroup(gid)}
              />
              <b>
                {groupMap.get(gid) ?? gid}（全選）
              </b>
            </label>
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
          </div>
        );
      })}
    </>
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

/* ================= 排程設定編輯器（年度／學年度） ================= */

function ScheduleEditor({
  indicatorId,
  indicatorName,
  category,
  initialPeriod,
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
  category: CycleCategory;
  initialPeriod: string;
  units: UnitLite[];
  groupMap: Map<string, string>;
  canEdit: boolean;
  actor: { id: string; name: string };
  onAction: (m: string) => void;
  onSaved: () => void;
  onBack: () => void;
}) {
  const periodOptions = useMemo(
    () => periodOptionsFor(category),
    [category],
  );
  const [period, setPeriod] = useState(
    periodOptions.includes(initialPeriod) ? initialPeriod : periodOptions[1],
  );
  const [months, setMonths] = useState<number[]>([]);
  const caseCount = useCaseCountInput();
  const [unitIds, setUnitIds] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [exists, setExists] = useState(false);
  const [prev, setPrev] = useState<IndicatorSchedule | null>(null);
  const [loadingPeriod, setLoadingPeriod] = useState(true);
  const [saving, setSaving] = useState(false);

  const monthOrder = useMemo(() => cycleMonths(category, period), [category, period]);
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
        setMonths(s?.months ?? []);
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

  function applyQuick(times: 2 | 3 | 4) {
    setMonths([...QUICK_MONTHS[times]]);
  }

  function handleCopyPrev() {
    if (!prev) return;
    setMonths([...prev.months]);
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
    setSaving(true);
    try {
      const db = getFirebaseDb();
      const cc =
        caseCount.value.trim() === "" ? null : Number(caseCount.value);
      await saveSchedule(
        db,
        {
          indicatorId,
          category,
          period,
          periodLabel: periodLabel(category, period),
          months: [...months].sort((a, b) => a - b),
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
              <div className="form-field" style={{ maxWidth: 220 }}>
                <label className="field-label">期間</label>
                <div className="select-wrap">
                  <select
                    value={period}
                    onChange={(e) => setPeriod(e.target.value)}
                  >
                    {periodOptions.map((p) => (
                      <option key={p} value={p}>
                        {category === "academic" ? `${p}學年度` : `${p}年`}
                      </option>
                    ))}
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
                      ? `帶入 ${prev.periodLabel} 的月份／件數／單位／備註`
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

            <div className="form-field">
              <label className="field-label">
                審查月份（可複選）
                {months.length > 0 && `：已選 ${months.length} 個月`}
              </label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                {category === "year" &&
                  ([2, 3, 4] as const).map((t) => (
                    <button
                      key={t}
                      className="button button-outline button-sm"
                      disabled={!canEdit}
                      onClick={() => applyQuick(t)}
                    >
                      {t}次/年
                    </button>
                  ))}
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
              {category === "academic" && (
                <p className="settings-note">
                  學年度月份依 8 月制順序排列（8–12 月為前一年曆年、1–7
                  月為後一年曆年）。
                </p>
              )}
            </div>

            <div className="form-field">
              <label className="field-label">
                審查件數
                <span className="muted-text">
                  （適用該期間所有單位；留白＝未設定）
                </span>
              </label>
              <span className="case-count-field">
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={caseCount.value}
                  placeholder="未設定"
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

/* ================= 加審（臨時排程） ================= */

function AddAuditDialog({
  row,
  units,
  groupMap,
  assignment,
  reviewerOptions,
  actor,
  deadlineDay,
  onAction,
  onClose,
  onDone,
}: {
  row: RowItem;
  units: UnitLite[];
  groupMap: Map<string, string>;
  assignment: IndicatorAssignment | null;
  reviewerOptions: ReviewerLite[];
  actor: { id: string; name: string };
  deadlineDay: number;
  onAction: (m: string) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const [unitIds, setUnitIds] = useState<string[]>(row.schedule?.unitIds ?? []);
  const [months, setMonths] = useState<number[]>([]);
  const caseCount = useCaseCountInput();
  const [reviewerIds, setReviewerIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const unitNameOf = useCallback(
    (code: string) => units.find((u) => u.code === code)?.name ?? code,
    [units],
  );

  // 審核員預設＝分工表中涵蓋所選單位者（單位變更時重算；不動單位時可手動調整）
  useEffect(() => {
    setReviewerIds(defaultAddAuditReviewers(assignment, unitIds));
  }, [unitIds, assignment]);

  function toggleReviewer(id: string) {
    setReviewerIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  const previewTasks = previewTempTaskCount(months, unitIds, reviewerIds);

  async function handleConfirm() {
    if (unitIds.length === 0) {
      onAction("請至少選擇一個受審單位");
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
        indicatorId: row.indicatorId,
        unitIds: [...unitIds],
        months: [...months].sort((a, b) => a - b),
        caseCount: parseCaseCount(cc),
        reviewerIds: [...reviewerIds],
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
      note="建立臨時排程並直接產生任務（加審）"
      onClose={onClose}
    >
      <div className="form-field">
        <label className="field-label">
          受審單位（可複選）
          {unitIds.length > 0 && `：已選 ${unitIds.length} 個`}
        </label>
        <div style={{ maxHeight: 220, overflow: "auto" }}>
          <UnitTreePicker
            units={units}
            groupMap={groupMap}
            selected={unitIds}
            onChange={setUnitIds}
            disabled={false}
            unitNameOf={unitNameOf}
          />
        </div>
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
          <span className="muted-text">（所有單位共用；留白＝未設定）</span>
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
          審核員（可複選；已依分工表自動帶入涵蓋所選單位者）
        </label>
        {reviewerOptions.length === 0 ? (
          <p className="settings-note">
            尚無審核員候選人（該組未設審查員且分工表空白）。
          </p>
        ) : (
          <div className="unit-check-grid">
            {reviewerOptions.map((r) => (
              <label key={r.personId} className="check-row">
                <input
                  type="checkbox"
                  checked={reviewerIds.includes(r.personId)}
                  onChange={() => toggleReviewer(r.personId)}
                />
                <span>
                  {maskName(r.name)}
                  <span className="muted-text">（{r.personId}）</span>
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
            （{months.length} 個月 × {unitIds.length} 單位 ×{" "}
            {reviewerIds.length} 位審核員）
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
  const [indicatorId, setIndicatorId] = useState(indicators[0]?.id ?? "");
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
            {indicators.map((i) => (
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

/* ================= 查閱：該排程產生的任務 ================= */

interface TaskLite {
  year: number;
  month: number;
  unitId: string;
  reviewerId: string;
  status: string;
  deadline: string;
  caseCount: number | null;
}

function TasksView({
  row,
  usersMap,
  unitNameOf,
  onAction,
}: {
  row: RowItem;
  usersMap: Map<string, string>;
  unitNameOf: (code: string) => string;
  onAction: (m: string) => void;
}) {
  const sched = row.schedule;
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

  if (!sched) return null;
  return (
    <section className="panel">
      <SectionTitle
        title="排程任務查閱"
        note={`${row.name}・${sched.periodLabel}${sched.selfReview ? "・自審" : ""}・${sched.months.length} 個月`}
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
    </section>
  );
}
/* ================= 單位／審查員設定 ================= */

function AssignmentEditor({
  indicatorId,
  initial,
  reviewers,
  units,
  groupMap,
  usersMap,
  canEdit,
  onAction,
  onSaved,
}: {
  indicatorId: string;
  initial: IndicatorAssignment | null;
  reviewers: ReviewerLite[];
  units: UnitLite[];
  groupMap: Map<string, string>;
  usersMap: Map<string, string>;
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
  const [selReviewer, setSelReviewer] = useState("");
  /** 已勾選的單位代碼（v1.10.0 起件數改在年度排程設定，此處不再編輯件數） */
  const [selUnits, setSelUnits] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const reviewerName = (id: string) =>
    maskName(
      usersMap.get(id) ?? reviewers.find((r) => r.personId === id)?.name ?? id,
    );

  const unitsByGroup = useMemo(() => {
    const map = new Map<string, UnitLite[]>();
    units.forEach((u) => {
      const arr = map.get(u.groupId) ?? [];
      arr.push(u);
      map.set(u.groupId, arr);
    });
    return map;
  }, [units]);

  const duplicates = useMemo(() => findDuplicateUnits(items), [items]);

  function pickReviewer(id: string) {
    setSelReviewer(id);
    const existing = items.find((it) => it.reviewerId === id);
    setSelUnits(new Set((existing?.units ?? []).map((u) => u.unitId)));
  }

  function toggleUnit(code: string) {
    setSelUnits((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function toggleGroupUnits(gid: string) {
    const list = unitsByGroup.get(gid) ?? [];
    const codes = list.map((u) => u.code);
    setSelUnits((prev) => {
      const next = new Set(prev);
      const allChecked = codes.every((c) => next.has(c));
      if (allChecked) codes.forEach((c) => next.delete(c));
      else codes.forEach((c) => next.add(c));
      return next;
    });
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
    if (!selReviewer) {
      onAction("請先選擇審查員");
      return;
    }
    if (selUnits.size === 0) {
      onAction("請至少勾選一個單位");
      return;
    }
    // 保留既有 caseCount（v1.10.0 起件數改在年度排程設定，此處只透傳不編輯）
    const existing = items.find((it) => it.reviewerId === selReviewer);
    const existingMap = new Map(
      (existing?.units ?? []).map((u) => [u.unitId, u.caseCount]),
    );
    const units = [...selUnits]
      .map((unitId) => ({
        unitId,
        caseCount: existingMap.get(unitId) ?? null,
      }))
      .sort((a, b) => a.unitId.localeCompare(b.unitId, "zh-Hant"));
    setItems((prev) => {
      const rest = prev.filter((it) => it.reviewerId !== selReviewer);
      return [...rest, { reviewerId: selReviewer, units }].sort((a, b) =>
        a.reviewerId.localeCompare(b.reviewerId, "zh-Hant"),
      );
    });
    setSelReviewer("");
    setSelUnits(new Set());
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
      onAction("已儲存單位／審查員分工表");
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
          title="單位／審查員設定"
          note="先選審查員，再複選其負責單位；同一單位可指派給多位審查員（會警示但不阻擋）。審查件數改在「審核排程設定」中按年度設定。"
        />
        {reviewers.length === 0 ? (
          <p className="settings-note">
            此組別尚未設定審查員，請先到「群組與人員」→「審查員」頁籤新增。
          </p>
        ) : (
          <>
            <div className="form-field" style={{ maxWidth: 320 }}>
              <label className="field-label">1. 選擇審查員</label>
              <div className="select-wrap">
                <select
                  value={selReviewer}
                  disabled={!canEdit}
                  onChange={(e) => pickReviewer(e.target.value)}
                >
                  <option value="">請選擇審查員</option>
                  {reviewers.map((r) => (
                    <option key={r.personId} value={r.personId}>
                      {reviewerName(r.personId)}（{r.personId}）
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
            </div>

            <div className="form-field">
              <label className="field-label">
                2. 複選負責單位
                {selUnits.size > 0 && `（已選 ${selUnits.size} 個）`}
              </label>
              {[...unitsByGroup.entries()].map(([gid, list]) => {
                const codes = list.map((u) => u.code);
                const allChecked =
                  codes.length > 0 && codes.every((c) => selUnits.has(c));
                return (
                  <div key={gid} className="unit-group-block">
                    <label className="check-row unit-group-head">
                      <input
                        type="checkbox"
                        checked={allChecked}
                        disabled={!canEdit || !selReviewer}
                        onChange={() => toggleGroupUnits(gid)}
                      />
                      <b>{groupMap.get(gid) ?? gid}（全選）</b>
                    </label>
                    <div className="unit-check-grid">
                      {list.map((u) => (
                        <label key={u.code} className="check-row">
                          <input
                            type="checkbox"
                            checked={selUnits.has(u.code)}
                            disabled={!canEdit || !selReviewer}
                            onChange={() => toggleUnit(u.code)}
                          />
                          <span>
                            {u.code}
                            {duplicates.has(u.code) && (
                              <CircleAlert
                                size={14}
                                className="dup-warn"
                                aria-label="重複指派"
                              />
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            {canEdit && (
              <div className="form-actions">
                <button
                  className="button button-outline"
                  disabled={!selReviewer}
                  onClick={applyToTable}
                >
                  <Plus size={15} /> 加入分工表
                </button>
              </div>
            )}
          </>
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
                          onClick={() => pickReviewer(it.reviewerId)}
                        >
                          <Pencil size={13} /> 調整
                        </button>{" "}
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

