/**
 * 排程查閱整頁式（v1.88.6）：查閱改整頁式，不再用彈窗。
 *
 * 頁籤分 2 個：(1)排程基本資料 (2)審查進度追蹤。
 * - 基本資料：期間、審查月份、審查頻次、審查區間、受審單位、審查件數、
 *   最後編輯（排程設定與分工表一起顯示）；不留分工表（由追蹤頁籤代替）、
 *   不留備註欄。審查件數顯示設定值 N（不是總數）。
 * - 追蹤頁籤：篩選器為審查區間(起)／審查區間(迄)兩個月份（YYYY-MM，與結果分析
 *   月份篩選器同型；預設起＝迄＝當月，臨時排程為該單月；改了立即生效）與狀態
 *   （全部／待完成／已完成／逾期鎖定，預設全部）；標題改顯示任務統計
 *   （共 N 筆任務・已完成・待完成・逾期鎖定）；清單欄位為單位、審查員、
 *   已審／應審件數（併進度，如 7/10（70%））、狀態、完成時間。
 * - 查閱頁不放刪除排程按鈕（清單的刪除維持現狀）。
 * - 追蹤進度沿用 v1.88.4 任務追蹤邏輯（配額感知計數、狀態校正、範圍過濾），
 *   由 ScheduleDetailModal 原樣搬移，僅把「全部月份一張表」改成「按區間分表」。
 */
import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, query, where } from "../lib/db";
import { toErrorMessage } from "../lib/errors";
import { getFirebaseDb } from "../lib/firebase";
import { dbIndexedQueryApi, fetchYearDocs } from "../lib/indexedRecords";
import { countRecordsByTaskWithImports } from "../lib/dashboardStats";
import { loadPeriodicQuotaCounts } from "./dashboard/periodicQuotaCounts";
import { buildTrackedRows, taskStatusLabel } from "../lib/taskTracking";
import {
  buildReviewIntervals,
  type ScheduleReviewInterval,
} from "../lib/scheduleIntervals";
import {
  frequencyLabel,
  intervalLabel,
  type IndicatorAssignment,
  type IndicatorSchedule,
} from "../lib/scheduling";
import { categoryLabel, type CycleCategory } from "../lib/cycle";
import { staffLabel } from "../lib/mask";
import { fmtIsoDateTime, fmtTsDate, pad2, parseYmOrder, ymInRange } from "../lib/ym";
import {
  EmptyState,
  FilterPanel,
  FormSelect,
  SectionTitle,
} from "../components/ui";

/** 查閱頁的列（與 SchedulePage 的 RowItem 同形，避免循環引用） */
export interface ScheduleDetailRow {
  indicatorId: string;
  code: string;
  name: string;
  groupId: string;
  groupName: string;
  category: CycleCategory;
  period: string;
  schedule: IndicatorSchedule | null;
}

interface TaskLite {
  id: string;
  year: number;
  month: number;
  unitId: string;
  reviewerId: string;
  status: string;
  deadline: string;
  caseCount: number | null;
  /** 完成時間（ISO 字串；未完成為 ""） */
  completedAt: string;
  /** 週期共用配額（v1.88.4 追蹤進度用；無值＝非配額任務） */
  quotaVersion?: number;
  quotaGroupId?: string;
  quotaIntervalStartYear?: number;
  quotaIntervalStartMonth?: number;
  quotaIntervalEndYear?: number;
  quotaIntervalEndMonth?: number;
}

/** Firestore Timestamp／ISO 字串 → ISO 字串（缺值回 ""；完成時間用） */
function tsToIso(ts: unknown): string {
  if (typeof ts === "string") return ts;
  try {
    const t = ts as { toDate?: () => Date };
    if (t && typeof t.toDate === "function") {
      const d = t.toDate();
      if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString();
    }
  } catch {
    /* ignore */
  }
  return "";
}

/** ISO 時間字串 → 本地顯示（完成時間用；解析失敗回 "—"，v1.88.15 走 ym.ts 共用函式） */
function formatIsoTs(iso: string): string {
  return fmtIsoDateTime(iso);
}

type DetailTab = "basic" | "tracking";

export function ScheduleDetailPage({
  row,
  assignment,
  usersMap,
  unitNameOf,
  visibleUnitCodes,
  viewerStaffId,
  onAction,
}: {
  row: ScheduleDetailRow;
  assignment: IndicatorAssignment | null;
  usersMap: Map<string, string>;
  unitNameOf: (code: string) => string;
  /** v1.88.4：任務追蹤的可見單位（null＝全看）；審查員本人的任務另行放行 */
  visibleUnitCodes: ReadonlySet<string> | null;
  viewerStaffId: string;
  onAction: (m: string) => void;
}) {
  const sched = row.schedule;
  const isTemp = row.category === "temp";
  const [tab, setTab] = useState<DetailTab>("basic");

  // ---- 任務載入（由彈窗原樣搬移） ----
  const [tasks, setTasks] = useState<TaskLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [recordCounts, setRecordCounts] = useState<Map<string, number>>(new Map());
  const [quotaCounts, setQuotaCounts] = useState<Map<string, number>>(new Map());
  const [quotaFailed, setQuotaFailed] = useState<Set<string>>(new Set());
  const [progressUnknown, setProgressUnknown] = useState(false);
  const [progressLoading, setProgressLoading] = useState(false);
  const [trackStatus, setTrackStatus] = useState("");

  // 審查區間（依排程的審查年月＋區間；1 個月如 2026/10、3 個月如 2026/10-2026/12）
  const intervals = useMemo<ScheduleReviewInterval[]>(
    () => (sched ? buildReviewIntervals(sched) : []),
    [sched],
  );
  // v1.88.14：追蹤篩選改為起迄月份（YYYY-MM，與結果分析月份篩選器同型），
  // 預設起＝迄＝當月；臨時排程（加審／自審）區間固定 1 個月，預設起＝迄＝該月。
  // 改了立即生效。起＞迄時過濾以兩者交換後的區間為準。
  const currentYm = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  };
  const defaultYm = useMemo(() => {
    if (isTemp && intervals.length > 0) {
      const iv = intervals[0];
      return `${iv.startYear}-${pad2(iv.startMonth)}`;
    }
    return currentYm();
    // intervals 依 sched 推導；sched 換指標時預設起迄跟著重設。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTemp, intervals]);
  const [fromMonth, setFromMonth] = useState(defaultYm);
  const [toMonth, setToMonth] = useState(defaultYm);
  // 排程切換後（預設起迄改變）重設為預設值。
  useEffect(() => {
    setFromMonth(defaultYm);
    setToMonth(defaultYm);
  }, [defaultYm]);

  const ymSet = useMemo(() => {
    const set = new Set<string>();
    for (const iv of intervals) {
      for (const ym of iv.months) set.add(`${ym.year}-${ym.month}`);
    }
    return set;
  }, [intervals]);

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
            id: d.id,
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
            completedAt: tsToIso(v.completedAt),
            quotaVersion:
              typeof v.quotaVersion === "number" ? v.quotaVersion : undefined,
            quotaGroupId:
              typeof v.quotaGroupId === "string" && v.quotaGroupId
                ? v.quotaGroupId
                : undefined,
            quotaIntervalStartYear:
              typeof v.quotaIntervalStartYear === "number"
                ? v.quotaIntervalStartYear
                : undefined,
            quotaIntervalStartMonth:
              typeof v.quotaIntervalStartMonth === "number"
                ? v.quotaIntervalStartMonth
                : undefined,
            quotaIntervalEndYear:
              typeof v.quotaIntervalEndYear === "number"
                ? v.quotaIntervalEndYear
                : undefined,
            quotaIntervalEndMonth:
              typeof v.quotaIntervalEndMonth === "number"
                ? v.quotaIntervalEndMonth
                : undefined,
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

  // 任務追蹤進度——任務載入後，按（指標，年）讀回審查紀錄，
  // 以 countRecordsByTaskWithImports 計非配額任務已審件數（含匯入紀錄），
  // 再以 loadPeriodicQuotaCounts 計週期共用配額群組的整組已審件數。
  // 僅顯示用，不寫回任務狀態。（由彈窗原樣搬移）
  useEffect(() => {
    if (loading) return;
    if (tasks.length === 0) {
      setRecordCounts(new Map());
      setQuotaCounts(new Map());
      setQuotaFailed(new Set());
      setProgressUnknown(false);
      setProgressLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setProgressLoading(true);
      setProgressUnknown(false);
      try {
        const db = getFirebaseDb();
        const years = [...new Set(tasks.map((t) => t.year))].sort((a, b) => a - b);
        const snaps = await Promise.all(
          years.map((y) =>
            fetchYearDocs(dbIndexedQueryApi, collection(db, "reviewRecords"), {
              indicatorId: row.indicatorId,
              year: y,
            }),
          ),
        );
        if (cancelled) return;
        const recs = snaps.flatMap((snap) =>
          snap.docs.map((d) => {
            const v = d.data() as Record<string, unknown>;
            return {
              id: d.id,
              taskId: typeof v.taskId === "string" ? v.taskId : "",
              indicatorId:
                typeof v.indicatorId === "string" ? v.indicatorId : "",
              unitId: typeof v.unitId === "string" ? v.unitId : "",
              year: Number(v.year ?? 0),
              month: Number(v.month ?? 0),
              source: typeof v.source === "string" ? v.source : undefined,
            };
          }),
        );
        const dashTasks = tasks.map((t) => ({
          id: t.id,
          indicatorId: row.indicatorId,
          unitId: t.unitId,
          year: t.year,
          month: t.month,
        }));
        setRecordCounts(countRecordsByTaskWithImports(recs, dashTasks));
        const quotaTasks = tasks
          .filter((t) => t.quotaVersion === 1 && t.quotaGroupId)
          .map((t) => ({
            id: t.id,
            indicatorId: row.indicatorId,
            unitId: t.unitId,
            reviewerId: t.reviewerId,
            year: t.year,
            month: t.month,
            caseCount: t.caseCount,
            deadline: t.deadline,
            status: "pending" as const,
            doneCount: 0,
            quotaVersion: 1 as const,
            quotaGroupId: t.quotaGroupId,
            quotaIntervalStartYear: t.quotaIntervalStartYear,
            quotaIntervalStartMonth: t.quotaIntervalStartMonth,
            quotaIntervalEndYear: t.quotaIntervalEndYear,
            quotaIntervalEndMonth: t.quotaIntervalEndMonth,
          }));
        if (quotaTasks.length > 0) {
          try {
            const { counts, failedGroups } = await loadPeriodicQuotaCounts(
              db,
              quotaTasks,
            );
            if (cancelled) return;
            setQuotaCounts(counts);
            setQuotaFailed(failedGroups);
          } catch {
            if (!cancelled) {
              setQuotaFailed(
                new Set(quotaTasks.map((t) => t.quotaGroupId!)),
              );
            }
          }
        }
      } catch {
        if (!cancelled) setProgressUnknown(true);
      } finally {
        if (!cancelled) setProgressLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loading, tasks, row.indicatorId]);

  // 追蹤列（配額感知計數＋狀態校正）→ 範圍過濾
  const trackedRows = useMemo(
    () =>
      buildTrackedRows(tasks, recordCounts, quotaCounts, quotaFailed, progressUnknown),
    [tasks, recordCounts, quotaCounts, quotaFailed, progressUnknown],
  );
  const scopedTrackedRows = useMemo(() => {
    if (visibleUnitCodes == null) return trackedRows;
    return trackedRows.filter(
      (r) => visibleUnitCodes.has(r.unitId) || r.reviewerId === viewerStaffId,
    );
  }, [trackedRows, visibleUnitCodes, viewerStaffId]);

  // v1.88.5：受審單位依可見單位過濾（null＝全看）。不限單位排程涵蓋
  // 自己單位，照常顯示「不限單位」；其餘只顯示可見單位。
  const displayUnitIds = useMemo(() => {
    if (!sched || sched.unlimitedUnits) return [];
    if (visibleUnitCodes == null) return sched.unitIds;
    return sched.unitIds.filter((c) => visibleUnitCodes.has(c));
  }, [sched, visibleUnitCodes]);

  // 所選起迄區間內的追蹤列（再依狀態篩選）；起＞迄時以交換後的區間為準。
  const intervalRows = useMemo(() => {
    const from = parseYmOrder(fromMonth);
    const to = parseYmOrder(toMonth);
    return scopedTrackedRows.filter((r) => ymInRange(r.year, r.month, from, to));
  }, [scopedTrackedRows, fromMonth, toMonth]);
  const filteredIntervalRows = useMemo(
    () => intervalRows.filter((r) => !trackStatus || r.status === trackStatus),
    [intervalRows, trackStatus],
  );
  const intervalSummary = useMemo(() => {
    let done = 0;
    let pending = 0;
    let locked = 0;
    for (const r of intervalRows) {
      if (r.status === "done") done += 1;
      else if (r.status === "locked") locked += 1;
      else pending += 1;
    }
    return { total: intervalRows.length, done, pending, locked };
  }, [intervalRows]);

  if (!sched) {
    return (
      <EmptyState
        title="尚未建立排程"
        description="此指標尚未建立排程，請先到排程清單建立排程設定。"
      />
    );
  }

  const periodNote = isTemp
    ? (sched.selfReview ? "自審" : "加審")
    : categoryLabel(row.category);

  return (
    <>
      <SectionTitle
        title={`查閱：${row.name}`}
        note={`${periodNote}・${sched.periodLabel}`}
      />
      <div className="admin-tabs" role="tablist" aria-label="查閱分類">
        <button
          role="tab"
          aria-selected={tab === "basic"}
          className={tab === "basic" ? "active" : ""}
          onClick={() => setTab("basic")}
        >
          排程基本資料
        </button>
        <button
          role="tab"
          aria-selected={tab === "tracking"}
          className={tab === "tracking" ? "active" : ""}
          onClick={() => setTab("tracking")}
        >
          審查進度追蹤
        </button>
      </div>

      {tab === "basic" && (
        <section className="panel schedule-detail-card">
          <table className="data-table detail-kv-table">
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
                <td data-label="審查月份">
                  {intervals.length === 0
                    ? "—"
                    : intervals.map((iv) => iv.label).join("、")}
                </td>
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
                    : displayUnitIds.length === 0
                      ? "—"
                      : displayUnitIds
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
              <tr>
                <td style={{ whiteSpace: "nowrap" }}><b>最後編輯</b></td>
                <td data-label="最後編輯">
                  排程：{sched.updatedByName || "—"}・{fmtTsDate(sched.updatedAt)}
                  <br />
                  分工表：
                  {isTemp
                    ? "—（臨時排程不存分工表）"
                    : assignment
                      ? fmtTsDate(assignment.updatedAt)
                      : "尚未設定分工表"}
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

      {tab === "tracking" && (
        <>
          <SectionTitle
            title="審查進度追蹤"
            note="每列一筆任務（指標×月×單位×審查員）；已審件數為配額感知計數，週期共用配額以整組區間計、匯入紀錄亦計入。只顯示您可見範圍內的任務。"
          />
          {intervals.length === 0 ? (
            <p className="settings-note">尚無審查區間。</p>
          ) : loading || progressLoading ? (
            <p className="settings-note" role="status">讀取任務進度中…</p>
          ) : tasks.length === 0 ? (
            <p className="settings-note">此排程尚無任務。</p>
          ) : (
            <>
              <FilterPanel title="追蹤篩選">
                <div className="form-field">
                  <label className="field-label" htmlFor="track-from-month">審查區間(起)</label>
                  <input
                    id="track-from-month"
                    type="month"
                    className="text-input"
                    value={fromMonth}
                    onChange={(e) => setFromMonth(e.target.value)}
                  />
                </div>
                <div className="form-field">
                  <label className="field-label" htmlFor="track-to-month">審查區間(迄)</label>
                  <input
                    id="track-to-month"
                    type="month"
                    className="text-input"
                    value={toMonth}
                    onChange={(e) => setToMonth(e.target.value)}
                  />
                </div>
                <FormSelect
                  label="狀態"
                  value={trackStatus}
                  onChange={(e) => setTrackStatus(e.target.value)}
                >
                  <option value="">全部</option>
                  <option value="pending">待完成</option>
                  <option value="done">已完成</option>
                  <option value="locked">逾期鎖定</option>
                </FormSelect>
              </FilterPanel>
              <section className="panel schedule-detail-card">
              <p>
                <b>共 {intervalSummary.total} 筆任務・已完成 {intervalSummary.done}・待完成 {intervalSummary.pending}・逾期鎖定 {intervalSummary.locked}</b>
                {progressUnknown ? "・部分進度因紀錄讀取失敗未知（顯示 —）" : ""}
              </p>
              {intervalRows.length === 0 ? (
                <p className="settings-note">
                  {tasks.length === 0
                    ? "此排程尚無任務。"
                    : "此區間尚無任務。"}
                </p>
              ) : filteredIntervalRows.length === 0 ? (
                <p className="settings-note">沒有符合篩選條件的任務。</p>
              ) : (
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>單位</th>
                        <th>審查員</th>
                        <th>已審／應審件數</th>
                        <th>狀態</th>
                        <th>完成時間</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredIntervalRows.map((r) => (
                        <tr key={r.id}>
                          <td data-label="單位">
                            {r.unitId === "" ? "NA（不限單位）" : `${unitNameOf(r.unitId)}（${r.unitId}）`}
                          </td>
                          <td data-label="審查員">{staffLabel(r.reviewerId, usersMap.get(r.reviewerId) ?? "")}</td>
                          <td data-label="已審／應審件數">
                            {r.done == null
                              ? `—/${r.required}`
                              : `${r.done}/${r.required}${r.pct == null ? "" : `（${r.pct}%）`}`}
                          </td>
                          <td data-label="狀態">
                            <span className={`status-pill ${r.status === "done" ? "success" : r.status === "locked" ? "danger" : "muted"}`}>
                              {taskStatusLabel(r.status)}
                            </span>
                          </td>
                          <td data-label="完成時間">
                            {r.status === "done" && r.completedAt ? formatIsoTs(r.completedAt) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              </section>
            </>
          )}
        </>
      )}
    </>
  );
}
