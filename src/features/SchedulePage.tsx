import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CalendarPlus,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from "../lib/db";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { getFirebaseDb } from "../lib/firebase";
import { useAuth } from "../lib/auth";
import { maskName } from "../lib/mask";
import {
  MONTH_LABELS,
  QUICK_MONTHS,
  buildReviewTasks,
  estimateTaskCount,
  findDuplicateUnits,
  normalizeAssignmentItem,
  yearScheduleDocId,
  type AssignmentItem,
  type IndicatorAssignment,
  type IndicatorYearSchedule,
} from "../lib/scheduling";

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "讀寫失敗，請檢查網路連線後再試";
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

interface ReviewerLite {
  personId: string;
  name: string;
}

type View =
  | { kind: "list" }
  | { kind: "yearSchedule"; indicatorId: string }
  | { kind: "assignment"; indicatorId: string }
  | { kind: "generate"; indicatorId: string };

type SortKey = "group" | "name" | "schedule" | "assignment";

const STATUS_PILL_OK = "status-pill success";
const STATUS_PILL_NONE = "status-pill muted";

export function SchedulePage({ onAction }: { onAction: (message: string) => void }) {
  const { user } = useAuth();
  const canEdit =
    (user?.roles ?? []).includes("系統管理員") ||
    (user?.roles ?? []).includes("品管執行幹事");

  const [view, setView] = useState<View>({ kind: "list" });
  const [loading, setLoading] = useState(true);

  const [indicators, setIndicators] = useState<IndicatorLite[]>([]);
  const [groupMap, setGroupMap] = useState<Map<string, string>>(new Map());
  const [yearSchedules, setYearSchedules] = useState<
    Map<string, IndicatorYearSchedule[]>
  >(new Map());
  const [assignments, setAssignments] = useState<Map<string, IndicatorAssignment>>(
    new Map(),
  );
  const [units, setUnits] = useState<UnitLite[]>([]);
  const [usersMap, setUsersMap] = useState<Map<string, string>>(new Map());
  const [reviewersByGroup, setReviewersByGroup] = useState<
    Map<string, ReviewerLite[]>
  >(new Map());

  // 主畫面篩選／排序
  const [filterGroup, setFilterGroup] = useState("");
  const [filterKeyword, setFilterKeyword] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("group");
  const [sortAsc, setSortAsc] = useState(true);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const db = getFirebaseDb();
      const [isnap, gsnap, ysnap, asnap, usnap, unsnap, rsnap] =
        await Promise.all([
          getDocs(collection(db, "indicators")),
          getDocs(collection(db, "groups")),
          getDocs(collection(db, "indicatorYearSchedules")),
          getDocs(collection(db, "indicatorAssignments")),
          getDocs(collection(db, "units")),
          getDocs(collection(db, "users")),
          getDocs(collection(db, "reviewReviewers")),
        ]);

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
              name: typeof data.name === "string" ? data.name : "",
              groupId: typeof data.groupId === "string" ? data.groupId : "",
            };
          })
          .sort((a, b) => a.id.localeCompare(b.id, "zh-Hant")),
      );

      const ym = new Map<string, IndicatorYearSchedule[]>();
      ysnap.docs.forEach((d) => {
        const data = d.data();
        const s: IndicatorYearSchedule = {
          indicatorId:
            typeof data.indicatorId === "string" ? data.indicatorId : "",
          year: typeof data.year === "number" ? data.year : 0,
          months: Array.isArray(data.months)
            ? data.months.filter((m): m is number => typeof m === "number")
            : [],
          monthsPerAudit:
            typeof data.monthsPerAudit === "number" ? data.monthsPerAudit : 1,
          notes: typeof data.notes === "string" ? data.notes : "",
          updatedAt: data.updatedAt,
        };
        if (!s.indicatorId || !s.year) return;
        const arr = ym.get(s.indicatorId) ?? [];
        arr.push(s);
        ym.set(s.indicatorId, arr);
      });
      ym.forEach((arr) => arr.sort((a, b) => b.year - a.year));
      setYearSchedules(ym);

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

      const um = new Map<string, string>();
      unsnap.docs.forEach((d) => {
        const name = d.data().name;
        um.set(d.id, typeof name === "string" ? name : d.id);
      });
      setUsersMap(um);

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
    } catch (error) {
      onAction(`讀取排程資料失敗：${toErrorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, [onAction]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const indicatorOf = useCallback(
    (id: string) => indicators.find((i) => i.id === id),
    [indicators],
  );

  // ---------- 主畫面列 ----------
  interface MainRow {
    id: string;
    name: string;
    groupId: string;
    groupName: string;
    years: number[];
    assignCount: number;
    assignUnits: number;
  }

  const mainRows: MainRow[] = useMemo(() => {
    let rows: MainRow[] = indicators.map((ind) => {
      const scheds = yearSchedules.get(ind.id) ?? [];
      const asg = assignments.get(ind.id);
      return {
        id: ind.id,
        name: ind.name,
        groupId: ind.groupId,
        groupName: groupMap.get(ind.groupId) ?? "—",
        years: scheds.map((s) => s.year),
        assignCount: asg ? asg.items.length : 0,
        assignUnits: asg
          ? asg.items.reduce((n, it) => n + it.units.length, 0)
          : 0,
      };
    });
    if (filterGroup) rows = rows.filter((r) => r.groupId === filterGroup);
    const kw = filterKeyword.trim().toLowerCase();
    if (kw)
      rows = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(kw) ||
          r.id.toLowerCase().includes(kw),
      );
    const dir = sortAsc ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      switch (sortKey) {
        case "group":
          return (
            a.groupName.localeCompare(b.groupName, "zh-Hant") * dir ||
            a.name.localeCompare(b.name, "zh-Hant") * dir
          );
        case "name":
          return a.name.localeCompare(b.name, "zh-Hant") * dir;
        case "schedule":
          return (
            (b.years.length - a.years.length) * dir ||
            a.name.localeCompare(b.name, "zh-Hant") * dir
          );
        case "assignment":
          return (
            (b.assignCount - a.assignCount) * dir ||
            a.name.localeCompare(b.name, "zh-Hant") * dir
          );
      }
    });
    return rows;
  }, [
    indicators,
    yearSchedules,
    assignments,
    groupMap,
    filterGroup,
    filterKeyword,
    sortKey,
    sortAsc,
  ]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  function sortMark(key: SortKey) {
    if (sortKey !== key) return "";
    return sortAsc ? " ▲" : " ▼";
  }

  // ---------- 共用：返回主畫面 ----------
  function backToList() {
    setView({ kind: "list" });
    loadAll();
  }

  // ================= 主畫面 =================
  if (view.kind === "list") {
    return (
      <>
        <PageHeading page="schedule" />
        <section className="panel">
          <div className="filter-bar">
            <div className="form-field" style={{ maxWidth: 220 }}>
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
            <div className="form-field" style={{ maxWidth: 280 }}>
              <label className="field-label">指標關鍵字</label>
              <input
                className="text-input"
                placeholder="指標名稱或編號"
                value={filterKeyword}
                onChange={(e) => setFilterKeyword(e.target.value)}
              />
            </div>
          </div>
        </section>

        {loading ? (
          <section className="panel">
            <p className="settings-note">讀取中…</p>
          </section>
        ) : mainRows.length === 0 ? (
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
                    <th
                      onClick={() => toggleSort("group")}
                      style={{ cursor: "pointer" }}
                    >
                      組別{sortMark("group")}
                    </th>
                    <th
                      onClick={() => toggleSort("name")}
                      style={{ cursor: "pointer" }}
                    >
                      指標名稱{sortMark("name")}
                    </th>
                    <th
                      onClick={() => toggleSort("schedule")}
                      style={{ cursor: "pointer" }}
                    >
                      審核排程設定{sortMark("schedule")}
                    </th>
                    <th
                      onClick={() => toggleSort("assignment")}
                      style={{ cursor: "pointer" }}
                    >
                      單位／審查員設定{sortMark("assignment")}
                    </th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {mainRows.map((r) => {
                    const schedDone = r.years.length > 0;
                    const asgDone = r.assignCount > 0;
                    const canGenerate = schedDone && asgDone && canEdit;
                    return (
                      <tr key={r.id}>
                        <td>{r.groupName}</td>
                        <td>
                          <b>{r.name}</b>
                          <div className="muted-text">{r.id}</div>
                        </td>
                        <td>
                          <button
                            className="text-button"
                            onClick={() =>
                              setView({ kind: "yearSchedule", indicatorId: r.id })
                            }
                            title="進入審核排程設定"
                          >
                            <span
                              className={
                                schedDone ? STATUS_PILL_OK : STATUS_PILL_NONE
                              }
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
                          {schedDone && (
                            <div className="muted-text">
                              {r.years.join("、")}
                            </div>
                          )}
                        </td>
                        <td>
                          <button
                            className="text-button"
                            onClick={() =>
                              setView({ kind: "assignment", indicatorId: r.id })
                            }
                            title="進入單位／審查員設定"
                          >
                            <span
                              className={
                                asgDone ? STATUS_PILL_OK : STATUS_PILL_NONE
                              }
                            >
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
                              {r.assignCount} 位審查員・{r.assignUnits} 單位
                            </div>
                          )}
                        </td>
                        <td>
                          <button
                            className="button button-outline"
                            disabled={!canGenerate}
                            title={
                              !canEdit
                                ? "需品管執行幹事以上權限"
                                : !schedDone || !asgDone
                                  ? "兩個設定都完成後才能產生排程"
                                  : "產生全年審查任務"
                            }
                            onClick={() =>
                              setView({ kind: "generate", indicatorId: r.id })
                            }
                          >
                            <CalendarPlus size={15} /> 產生排程
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </>
    );
  }

  // ================= 子畫面 =================
  // （此處 view 已被上方 early return 收斂為非 "list"，故直接取 indicatorId）
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
            <button
              className="button button-outline"
              onClick={backToList}
            >
              <ArrowLeft size={15} /> 返回指標排程
            </button>
          </div>
          <SectionTitle
            title={indicator.name}
            note={`指標編號 ${indicator.id}・組別 ${groupMap.get(indicator.groupId) ?? "—"}`}
          />
          {view.kind === "yearSchedule" && (
            <YearScheduleEditor
              indicatorId={indicator.id}
              schedules={yearSchedules.get(indicator.id) ?? []}
              canEdit={canEdit}
              onAction={onAction}
              onSaved={backToList}
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
          {view.kind === "generate" && (
            <GeneratePanel
              indicatorId={indicator.id}
              schedules={yearSchedules.get(indicator.id) ?? []}
              assignment={assignments.get(indicator.id) ?? null}
              onAction={onAction}
              onDone={backToList}
            />
          )}
        </>
      )}
    </>
  );
}

/* ================= 審核排程設定 ================= */

function YearScheduleEditor({
  indicatorId,
  schedules,
  canEdit,
  onAction,
  onSaved,
}: {
  indicatorId: string;
  schedules: IndicatorYearSchedule[];
  canEdit: boolean;
  onAction: (m: string) => void;
  onSaved: () => void;
}) {
  const thisYear = new Date().getFullYear();
  const years = schedules.map((s) => s.year);
  const [year, setYear] = useState<number>(
    years.includes(thisYear) ? thisYear : (years[0] ?? thisYear),
  );
  const [addingYear, setAddingYear] = useState(false);
  const [newYear, setNewYear] = useState(String(thisYear + 1));

  const current = schedules.find((s) => s.year === year);
  const [months, setMonths] = useState<number[]>(current?.months ?? []);
  const [monthsPerAudit, setMonthsPerAudit] = useState(
    current?.monthsPerAudit ?? 1,
  );
  const [notes, setNotes] = useState(current?.notes ?? "");
  const [saving, setSaving] = useState(false);

  function selectYear(y: number) {
    setYear(y);
    const s = schedules.find((x) => x.year === y);
    setMonths(s?.months ?? []);
    setMonthsPerAudit(s?.monthsPerAudit ?? 1);
    setNotes(s?.notes ?? "");
  }

  function toggleMonth(m: number) {
    setMonths((prev) =>
      prev.includes(m)
        ? prev.filter((x) => x !== m).sort((a, b) => a - b)
        : [...prev, m].sort((a, b) => a - b),
    );
  }

  function applyQuick(times: 2 | 3 | 4) {
    setMonths([...QUICK_MONTHS[times]]);
  }

  async function handleSave() {
    if (months.length === 0) {
      onAction("請至少選擇一個審查月份");
      return;
    }
    setSaving(true);
    try {
      const db = getFirebaseDb();
      await setDoc(
        doc(db, "indicatorYearSchedules", yearScheduleDocId(indicatorId, year)),
        {
          indicatorId,
          year,
          months: [...months].sort((a, b) => a - b),
          monthsPerAudit,
          notes: notes.trim(),
          updatedAt: serverTimestamp(),
        },
      );
      onAction(`已儲存 ${year} 年審核排程設定`);
      onSaved();
    } catch (error) {
      onAction(`儲存失敗：${toErrorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteYear(y: number) {
    const ok = window.confirm(
      `確定刪除 ${y} 年的審核排程設定？（已產生的任務不受影響）`,
    );
    if (!ok) return;
    try {
      const db = getFirebaseDb();
      await deleteDoc(
        doc(db, "indicatorYearSchedules", yearScheduleDocId(indicatorId, y)),
      );
      onAction(`已刪除 ${y} 年審核排程設定`);
      onSaved();
    } catch (error) {
      onAction(`刪除失敗：${toErrorMessage(error)}`);
    }
  }

  return (
    <section className="panel">
      <SectionTitle title="審核排程設定" note="指定年度的審查月份" />
      <div className="form-grid">
        <div className="form-field" style={{ maxWidth: 220 }}>
          <label className="field-label">年度</label>
          <div className="select-wrap">
            <select
              value={addingYear ? "__new" : String(year)}
              onChange={(e) => {
                if (e.target.value === "__new") {
                  setAddingYear(true);
                } else {
                  setAddingYear(false);
                  selectYear(Number(e.target.value));
                }
              }}
            >
              {years.map((y) => (
                <option key={y} value={String(y)}>
                  {y} 年{y === thisYear ? "（今年）" : ""}
                </option>
              ))}
              {years.length === 0 && (
                <option value={String(thisYear)}>{thisYear} 年（今年）</option>
              )}
              <option value="__new">＋ 新增年度…</option>
            </select>
            <ChevronDown size={15} />
          </div>
        </div>
        {addingYear && (
          <div className="form-field" style={{ maxWidth: 220 }}>
            <label className="field-label">新增年度</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="text-input"
                inputMode="numeric"
                value={newYear}
                onChange={(e) => setNewYear(e.target.value.replace(/\D/g, ""))}
              />
              <button
                className="button button-outline"
                onClick={() => {
                  const y = Number(newYear);
                  if (!y || y < 2000 || y > 2100) {
                    onAction("請輸入有效的年度（2000–2100）");
                    return;
                  }
                  setAddingYear(false);
                  selectYear(y);
                }}
              >
                確定
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="form-field">
        <label className="field-label">快速指定月份</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {([2, 3, 4] as const).map((t) => (
            <button
              key={t}
              className="button button-outline"
              disabled={!canEdit}
              onClick={() => applyQuick(t)}
            >
              {t}次/年
            </button>
          ))}
          <div className="form-field" style={{ maxWidth: 160, margin: 0 }}>
            <div className="select-wrap">
              <select
                value={String(monthsPerAudit)}
                disabled={!canEdit}
                onChange={(e) => setMonthsPerAudit(Number(e.target.value))}
                aria-label="一次幾個月"
              >
                {[1, 2, 3].map((n) => (
                  <option key={n} value={String(n)}>
                    一次 {n} 個月
                  </option>
                ))}
              </select>
              <ChevronDown size={15} />
            </div>
          </div>
        </div>
        <p className="settings-note">
          快捷將 12 個月平均分配（2次/年：1、7月；3次/年：1、5、9月；4次/年：1、4、7、10月），設定後仍可手動調整。
        </p>
      </div>

      <div className="form-field">
        <label className="field-label">
          審查月份（可複選）{months.length > 0 && `：已選 ${months.length} 個月`}
        </label>
        <div className="month-grid">
          {MONTH_LABELS.map((label, idx) => {
            const m = idx + 1;
            const checked = months.includes(m);
            return (
              <label
                key={m}
                className={`check-row month-cell${checked ? " checked" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!canEdit}
                  onChange={() => toggleMonth(m)}
                />
                <span>{label}</span>
              </label>
            );
          })}
        </div>
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
            {saving ? "儲存中…" : `儲存 ${year} 年設定`}
          </button>
        )}
        {canEdit && years.includes(year) && (
          <button
            className="button button-ghost"
            onClick={() => handleDeleteYear(year)}
          >
            <Trash2 size={15} /> 刪除此年度設定
          </button>
        )}
      </div>
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
  /** 已勾選單位 → 每輪審查件數（null＝未設定） */
  const [selUnits, setSelUnits] = useState<Map<string, number | null>>(
    new Map(),
  );
  const [saving, setSaving] = useState(false);

  const reviewerName = (id: string) =>
    maskName(
      usersMap.get(id) ?? reviewers.find((r) => r.personId === id)?.name ?? id,
    );
  const unitName = (code: string) =>
    units.find((u) => u.code === code)?.name ?? code;

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
    setSelUnits(
      new Map((existing?.units ?? []).map((u) => [u.unitId, u.caseCount])),
    );
  }

  function toggleUnit(code: string) {
    setSelUnits((prev) => {
      const next = new Map(prev);
      if (next.has(code)) next.delete(code);
      else next.set(code, null);
      return next;
    });
  }

  function toggleGroupUnits(gid: string) {
    const list = unitsByGroup.get(gid) ?? [];
    const codes = list.map((u) => u.code);
    setSelUnits((prev) => {
      const next = new Map(prev);
      const allChecked = codes.every((c) => next.has(c));
      if (allChecked) codes.forEach((c) => next.delete(c));
      else codes.forEach((c) => {
        if (!next.has(c)) next.set(c, null);
      });
      return next;
    });
  }

  /** 已勾選單位的件數輸入（僅接受 ≥1 整數或清空＝未設定） */
  function setSelCaseCount(code: string, raw: string) {
    const t = raw.trim();
    if (t !== "" && (!/^\d+$/.test(t) || Number(t) < 1)) return;
    setSelUnits((prev) => {
      if (!prev.has(code)) return prev;
      const next = new Map(prev);
      next.set(code, t === "" ? null : Number(t));
      return next;
    });
  }

  /** 分工總覽表內直接改件數 */
  function setItemCaseCount(reviewerId: string, unitId: string, raw: string) {
    const t = raw.trim();
    if (t !== "" && (!/^\d+$/.test(t) || Number(t) < 1)) return;
    const v = t === "" ? null : Number(t);
    setItems((prev) =>
      prev.map((it) =>
        it.reviewerId === reviewerId
          ? {
              ...it,
              units: it.units.map((u) =>
                u.unitId === unitId ? { ...u, caseCount: v } : u,
              ),
            }
          : it,
      ),
    );
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
    const units = [...selUnits.entries()]
      .map(([unitId, caseCount]) => ({ unitId, caseCount }))
      .sort((a, b) => a.unitId.localeCompare(b.unitId, "zh-Hant"));
    setItems((prev) => {
      const rest = prev.filter((it) => it.reviewerId !== selReviewer);
      return [...rest, { reviewerId: selReviewer, units }].sort((a, b) =>
        a.reviewerId.localeCompare(b.reviewerId, "zh-Hant"),
      );
    });
    setSelReviewer("");
    setSelUnits(new Map());
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
        ([u, rs]) => `${unitName(u)}：${rs.map((r) => reviewerName(r)).join("、")}`,
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
          note="先選審查員，再複選其負責單位並設定每輪審查件數；同一單位可指派給多位審查員（會警示但不阻擋）"
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
                            {u.name}
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

            {selUnits.size > 0 && (
              <div className="form-field">
                <label className="field-label">
                  3. 設定每輪審查件數
                  <span className="muted-text">
                    （每輪該單位的審查件數；留白＝未設定）
                  </span>
                </label>
                <div className="case-count-list">
                  {[...selUnits.entries()]
                    .sort((a, b) =>
                      unitName(a[0]).localeCompare(unitName(b[0]), "zh-Hant"),
                    )
                    .map(([code, count]) => (
                      <label key={code} className="case-count-row">
                        <span>
                          {unitName(code)}
                          {duplicates.has(code) && (
                            <CircleAlert
                              size={14}
                              className="dup-warn"
                              aria-label="重複指派"
                            />
                          )}
                        </span>
                        <span className="case-count-field">
                          <input
                            type="number"
                            min={1}
                            step={1}
                            value={count ?? ""}
                            placeholder="未設定"
                            disabled={!canEdit}
                            onChange={(e) =>
                              setSelCaseCount(code, e.target.value)
                            }
                            aria-label={`${unitName(code)}每輪審查件數`}
                          />
                          件
                        </span>
                      </label>
                    ))}
                </div>
              </div>
            )}

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
                            {unitName(u.unitId)}
                            {duplicates.has(u.unitId) && (
                              <CircleAlert
                                size={13}
                                className="dup-warn"
                                aria-label="重複指派"
                              />
                            )}
                          </span>
                          {canEdit ? (
                            <span className="case-count-field">
                              <input
                                type="number"
                                min={1}
                                step={1}
                                value={u.caseCount ?? ""}
                                placeholder="未設定"
                                onChange={(e) =>
                                  setItemCaseCount(
                                    it.reviewerId,
                                    u.unitId,
                                    e.target.value,
                                  )
                                }
                                aria-label={`${unitName(u.unitId)}每輪審查件數`}
                              />
                              件
                              <button
                                className="text-button"
                                onClick={() =>
                                  removeUnit(it.reviewerId, u.unitId)
                                }
                                aria-label={`移除${unitName(u.unitId)}`}
                              >
                                <Trash2 size={13} />
                              </button>
                            </span>
                          ) : (
                            <span className="muted-text">
                              {u.caseCount != null ? `${u.caseCount}件` : "—"}
                            </span>
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
            {[...duplicates.keys()].map((u) => unitName(u)).join("、")}
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

/* ================= 產生排程 ================= */

function GeneratePanel({
  indicatorId,
  schedules,
  assignment,
  onAction,
  onDone,
}: {
  indicatorId: string;
  schedules: IndicatorYearSchedule[];
  assignment: IndicatorAssignment | null;
  onAction: (m: string) => void;
  onDone: () => void;
}) {
  const thisYear = new Date().getFullYear();
  const years = schedules.map((s) => s.year);
  const [year, setYear] = useState<number>(
    years.includes(thisYear) ? thisYear : (years[0] ?? thisYear),
  );
  const [existingPending, setExistingPending] = useState<number | null>(null);
  const [existingDone, setExistingDone] = useState<number | null>(null);
  const [generating, setGenerating] = useState(false);

  const schedule = schedules.find((s) => s.year === year) ?? null;
  const items = assignment?.items ?? [];
  const pairCount = items.reduce((n, it) => n + it.units.length, 0);
  const taskCount = schedule ? estimateTaskCount(schedule.months, items) : 0;

  const loadExisting = useCallback(async () => {
    try {
      const db = getFirebaseDb();
      const snap = await getDocs(
        query(
          collection(db, "reviewTasks"),
          where("indicatorId", "==", indicatorId),
          where("year", "==", year),
        ),
      );
      let pending = 0;
      let done = 0;
      snap.docs.forEach((d) => {
        if (d.data().status === "done") done += 1;
        else pending += 1;
      });
      setExistingPending(pending);
      setExistingDone(done);
    } catch {
      setExistingPending(null);
      setExistingDone(null);
    }
  }, [indicatorId, year]);

  useEffect(() => {
    loadExisting();
  }, [loadExisting]);

  async function handleGenerate() {
    if (!schedule) {
      onAction("此年度尚未設定審查月份，請先完成設定");
      return;
    }
    if (items.length === 0) {
      onAction("分工表尚無資料，請先完成單位／審查員設定");
      return;
    }
    if ((existingPending ?? 0) + (existingDone ?? 0) > 0) {
      const ok = window.confirm(
        `${indicatorId} ${year} 年已有 ${existingPending ?? 0} 筆未執行、${existingDone ?? 0} 筆已完成任務。產生排程將刪除未執行的任務後重建，已完成的會保留，確定嗎？`,
      );
      if (!ok) return;
    }
    setGenerating(true);
    try {
      const db = getFirebaseDb();
      // 截止日：系統參數「補審截止（次月幾日）」，預設 10
      let deadlineDay = 10;
      try {
        const psnap = await getDoc(doc(db, "systemParams", "config"));
        const v = psnap.data()?.supplementDeadlineDay;
        if (typeof v === "number" && v >= 1 && v <= 31) deadlineDay = v;
      } catch {
        /* 讀不到參數就用預設值 */
      }

      // 只刪除該年度「未執行」的舊任務（已完成的保留），再展開新任務（batch 每 400 個操作 commit 一次）
      const oldSnap = await getDocs(
        query(
          collection(db, "reviewTasks"),
          where("indicatorId", "==", indicatorId),
          where("year", "==", year),
        ),
      );
      const BATCH_LIMIT = 400;
      let batch = writeBatch(db);
      let ops = 0;
      const commits: Promise<void>[] = [];
      const flush = () => {
        if (ops > 0) {
          commits.push(batch.commit());
          batch = writeBatch(db);
          ops = 0;
        }
      };
      oldSnap.docs.forEach((d) => {
        if (d.data().status === "done") return; // 已完成保留
        batch.delete(d.ref);
        ops += 1;
        if (ops >= BATCH_LIMIT) flush();
      });
      const newTasks = buildReviewTasks({
        indicatorId,
        year,
        months: schedule.months,
        items,
        deadlineDay,
      });
      newTasks.forEach((t) => {
        const ref = doc(collection(db, "reviewTasks"));
        batch.set(ref, { ...t, createdAt: serverTimestamp() });
        ops += 1;
        if (ops >= BATCH_LIMIT) flush();
      });
      flush();
      await Promise.all(commits);

      onAction(
        `${indicatorId} ${year} 年排程已產生：${schedule.months.length} 個月份 × ${pairCount} 組指派＝${taskCount} 筆任務`,
      );
      onDone();
    } catch (error) {
      onAction(`產生排程失敗：${toErrorMessage(error)}`);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <section className="panel">
      <SectionTitle
        title="產生排程"
        note="依年度審查月份 × 分工表，展開全年審查任務"
      />
      <div className="form-field" style={{ maxWidth: 220 }}>
        <label className="field-label">年度</label>
        <div className="select-wrap">
          <select
            value={String(year)}
            onChange={(e) => setYear(Number(e.target.value))}
          >
            {years.map((y) => (
              <option key={y} value={String(y)}>
                {y} 年
              </option>
            ))}
            {!years.includes(thisYear) && (
              <option value={String(thisYear)}>{thisYear} 年（今年）</option>
            )}
          </select>
          <ChevronDown size={15} />
        </div>
      </div>

      {!schedule ? (
        <p className="settings-note">
          {year} 年尚未設定審查月份，請先完成「審核排程設定」。
        </p>
      ) : (
        <>
          <div className="form-field">
            <label className="field-label">審查月份</label>
            <p>
              {schedule.months.map((m) => MONTH_LABELS[m - 1]).join("、")}
              <span className="muted-text">
                （一次 {schedule.monthsPerAudit} 個月）
              </span>
            </p>
          </div>
          <div className="form-field">
            <label className="field-label">分工</label>
            <p>
              {items.length} 位審查員・{pairCount} 組指派
            </p>
          </div>
          <div className="form-field">
            <label className="field-label">預估任務數</label>
            <p>
              <b>{taskCount}</b> 筆
              <span className="muted-text">
                （{schedule.months.length} 個月 × {pairCount} 組指派）
              </span>
            </p>
          </div>
          {(existingPending ?? 0) + (existingDone ?? 0) > 0 && (
            <p className="dup-note">
              <CircleAlert size={14} /> 此年度已有 {existingPending ?? 0}{" "}
              筆未執行、{existingDone ?? 0} 筆已完成任務；產生排程將先刪除未執行的任務後重建，已完成的會保留。
            </p>
          )}
          <div className="form-actions">
            <button
              className="button button-primary"
              disabled={generating || taskCount === 0}
              onClick={handleGenerate}
            >
              {generating ? (
                "產生中…"
              ) : (
                <>
                  <Check size={15} /> 確認產生 {year} 年排程
                </>
              )}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
