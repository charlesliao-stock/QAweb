/**
 * 指標審查總覽（v1.12.0 新增）。
 * 入口：排程頁指標列「審查總覽」。
 * 一指標 → 各單位（可切年度）→ 各輪次（該年度排程月份）→ 每輪次的審查紀錄；
 * 每輪次操作欄有「新增審查」（開啟該單位該輪次的審查表單，件次接續）與「查詢」。
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
} from "lucide-react";
import { collection, doc, getDoc, getDocs, query, where } from "../lib/db";
import { EmptyState, SectionTitle } from "../components/ui";
import { getFirebaseDb } from "../lib/firebase";
import { getCachedRefCollection } from "../lib/refCache";
import { maskName } from "../lib/mask";
import {
  MONTH_LABELS,
  type IndicatorYearSchedule,
} from "../lib/scheduling";
import {
  isTaskComplete,
  progressLabel,
  requiredCases,
} from "../lib/reviewProgress";
import {
  ReviewExecutePage,
  type ExecuteTarget,
} from "./ReviewExecutePage";

interface TaskLite {
  id: string;
  month: number;
  unitId: string;
  reviewerId: string;
  caseCount: number | null;
  deadline: string;
  status: string;
}

interface RecordLite {
  id: string;
  taskId: string;
  caseSeq: number | null;
  reviewDate: string;
  reviewerEmpNo: string;
  reviewerName: string;
  totalScore: number;
  maxScore: number;
  rate: number | null;
  submittedAt: unknown;
}

function fmtTs(ts: unknown): string {
  if (ts && typeof (ts as { toDate?: unknown }).toDate === "function") {
    try {
      return (ts as { toDate: () => Date })
        .toDate()
        .toLocaleString("zh-TW", { hour12: false });
    } catch {
      return "";
    }
  }
  return "";
}

function taskFromDoc(id: string, data: Record<string, unknown>): TaskLite {
  const cc = data.caseCount;
  return {
    id,
    month: Number(data.month ?? 0),
    unitId: String(data.unitId ?? ""),
    reviewerId: String(data.reviewerId ?? ""),
    caseCount:
      typeof cc === "number" && Number.isInteger(cc) && cc >= 1 ? cc : null,
    deadline: String(data.deadline ?? ""),
    status: data.status === "done" ? "done" : "pending",
  };
}

export function ReviewOverviewPage({
  indicatorId,
  indicatorName,
  onBack,
  onAction,
}: {
  indicatorId: string;
  indicatorName: string;
  onBack: () => void;
  onAction: (message: string) => void;
}) {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [years, setYears] = useState<number[]>([]);
  const [months, setMonths] = useState<number[]>([]);
  const [units, setUnits] = useState<string[]>([]);
  const [tasks, setTasks] = useState<TaskLite[]>([]);
  const [recordsByTask, setRecordsByTask] = useState<Map<string, RecordLite[]>>(
    new Map(),
  );
  const [reviewerNames, setReviewerNames] = useState<Map<string, string>>(
    new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [expandedUnits, setExpandedUnits] = useState<Set<string>>(new Set());
  const [expandedRounds, setExpandedRounds] = useState<Set<string>>(new Set());
  const [executing, setExecuting] = useState<ExecuteTarget | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const db = getFirebaseDb();
      const [ssnap, asnap, tsnap, rsnap, usnap] = await Promise.all([
        getDocs(
          query(
            collection(db, "indicatorYearSchedules"),
            where("indicatorId", "==", indicatorId),
          ),
        ),
        getDoc(doc(db, "indicatorAssignments", indicatorId)),
        getDocs(
          query(
            collection(db, "reviewTasks"),
            where("indicatorId", "==", indicatorId),
            where("year", "==", year),
          ),
        ),
        getDocs(
          query(
            collection(db, "reviewRecords"),
            where("indicatorId", "==", indicatorId),
            where("year", "==", year),
          ),
        ),
        getCachedRefCollection("users", () =>
          getDocs(collection(db, "users")),
        ),
      ]);

      const scheds: IndicatorYearSchedule[] = [];
      ssnap.docs.forEach((d) => {
        const data = d.data() as Record<string, unknown>;
        const ms = data.months;
        scheds.push({
          indicatorId,
          year: Number(data.year ?? 0),
          months: Array.isArray(ms)
            ? ms.filter((m): m is number => typeof m === "number")
            : [],
          monthsPerAudit: Number(data.monthsPerAudit ?? 1),
          caseCount:
            typeof data.caseCount === "number" ? data.caseCount : null,
          unitCaseCounts: {},
          notes: typeof data.notes === "string" ? data.notes : "",
          updatedAt: data.updatedAt,
        });
      });
      const yearList = [...new Set(scheds.map((s) => s.year))].sort(
        (a, b) => b - a,
      );
      if (!yearList.includes(thisYear)) yearList.unshift(thisYear);
      setYears(yearList);
      const cur = scheds.find((s) => s.year === year);
      setMonths([...(cur?.months ?? [])].sort((a, b) => a - b));

      const unitSet = new Set<string>();
      if (asnap.exists()) {
        const items = (asnap.data() as Record<string, unknown>).items;
        if (Array.isArray(items)) {
          for (const it of items) {
            const us = (it as Record<string, unknown>).units;
            if (Array.isArray(us)) {
              for (const u of us) {
                const uid = (u as Record<string, unknown>).unitId;
                if (typeof uid === "string" && uid) unitSet.add(uid);
              }
            }
          }
        }
      }
      const taskList = tsnap.docs.map((d) =>
        taskFromDoc(d.id, d.data() as Record<string, unknown>),
      );
      taskList.forEach((t) => unitSet.add(t.unitId));
      setUnits([...unitSet].sort((a, b) => a.localeCompare(b, "zh-Hant")));
      taskList.sort((a, b) => a.month - b.month);
      setTasks(taskList);

      const rmap = new Map<string, RecordLite[]>();
      rsnap.docs.forEach((d) => {
        const data = d.data() as Record<string, unknown>;
        const tid =
          typeof data.taskId === "string" ? data.taskId : d.id;
        const cs = data.caseSeq;
        const arr = rmap.get(tid) ?? [];
        arr.push({
          id: d.id,
          taskId: tid,
          caseSeq: typeof cs === "number" ? cs : null,
          reviewDate:
            typeof data.reviewDate === "string" ? data.reviewDate : "",
          reviewerEmpNo:
            typeof data.reviewerEmpNo === "string" ? data.reviewerEmpNo : "",
          reviewerName:
            typeof data.reviewerName === "string" ? data.reviewerName : "",
          totalScore: Number(data.totalScore ?? 0),
          maxScore: Number(data.maxScore ?? 0),
          rate: typeof data.rate === "number" ? data.rate : null,
          submittedAt: data.submittedAt,
        });
        rmap.set(tid, arr);
      });
      rmap.forEach((arr) =>
        arr.sort((a, b) => (a.caseSeq ?? 0) - (b.caseSeq ?? 0)),
      );
      setRecordsByTask(rmap);

      const rnm = new Map<string, string>();
      usnap.docs.forEach((d) => {
        const n = (d.data() as Record<string, unknown>).name;
        rnm.set(d.id, maskName(typeof n === "string" ? n : d.id));
      });
      setReviewerNames(rnm);
    } catch {
      onAction("讀取審查總覽失敗");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicatorId, year]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleUnit = (u: string) =>
    setExpandedUnits((prev) => {
      const next = new Set(prev);
      if (next.has(u)) next.delete(u);
      else next.add(u);
      return next;
    });

  const toggleRound = (taskId: string) =>
    setExpandedRounds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });

  const tasksByUnitMonth = useMemo(() => {
    const m = new Map<string, TaskLite[]>();
    for (const t of tasks) {
      const key = `${t.unitId}__${t.month}`;
      const arr = m.get(key) ?? [];
      arr.push(t);
      m.set(key, arr);
    }
    return m;
  }, [tasks]);

  const unitSummary = useCallback(
    (unitId: string) => {
      let done = 0;
      let req = 0;
      for (const t of tasks) {
        if (t.unitId !== unitId) continue;
        done += recordsByTask.get(t.id)?.length ?? 0;
        req += requiredCases(t.caseCount);
      }
      return { done, req };
    },
    [tasks, recordsByTask],
  );

  if (executing) {
    return (
      <ReviewExecutePage
        target={executing}
        onBack={() => {
          setExecuting(null);
          void load();
        }}
        onAction={onAction}
      />
    );
  }

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <button className="button button-outline" onClick={onBack}>
          <ArrowLeft size={15} /> 返回品管審查排程
        </button>
      </div>
      <SectionTitle
        title={`審查總覽：${indicatorName}`}
        note={`各單位・各輪次審查紀錄（3 次／年＝每單位 3 輪）`}
        action={
          <div className="select-wrap">
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              aria-label="年度"
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y} 年
                </option>
              ))}
            </select>
            <ChevronDown size={15} />
          </div>
        }
      />
      {loading ? (
        <p className="settings-note">讀取中…</p>
      ) : units.length === 0 ? (
        <EmptyState
          title="尚無單位"
          description="此指標尚未設定單位／審查員分工，請先到「單位／審查員設定」完成設定並產生排程。"
        />
      ) : (
        units.map((u) => {
          const sum = unitSummary(u);
          const expanded = expandedUnits.has(u);
          return (
            <section className="panel" key={u}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <b style={{ fontSize: 16 }}>單位 {u}</b>
                <span className="muted-text">
                  全年 {sum.done}/{sum.req} 件
                </span>
                <span style={{ flex: 1 }} />
                <button
                  className="text-button"
                  onClick={() => toggleUnit(u)}
                  aria-expanded={expanded}
                >
                  {expanded ? "收合" : "展開輪次"}
                  <ChevronRight
                    size={14}
                    style={{
                      transform: expanded ? "rotate(90deg)" : undefined,
                      verticalAlign: "-2px",
                    }}
                  />
                </button>
              </div>
              {expanded && (
                <div className="table-scroll" style={{ marginTop: 12 }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>輪次</th>
                        <th>審查員</th>
                        <th>完成/應審件數</th>
                        <th>狀態</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {months.length === 0 && (
                        <tr>
                          <td colSpan={5} className="muted-text">
                            該年度尚未設定審核排程月份。
                          </td>
                        </tr>
                      )}
                      {months.map((m) => {
                        const list = tasksByUnitMonth.get(`${u}__${m}`) ?? [];
                        if (list.length === 0) {
                          return (
                            <tr key={m}>
                              <td>{MONTH_LABELS[m - 1] ?? `${m}月`}</td>
                              <td colSpan={4} className="muted-text">
                                該輪次尚未產生任務
                              </td>
                            </tr>
                          );
                        }
                        return list.map((t) => {
                          const recs = recordsByTask.get(t.id) ?? [];
                          const done = isTaskComplete(recs.length, t.caseCount);
                          const roundOpen = expandedRounds.has(t.id);
                          return (
                            <Fragment key={t.id}>
                              <tr>
                                <td>{MONTH_LABELS[t.month - 1] ?? `${t.month}月`}</td>
                                <td>
                                  {reviewerNames.get(t.reviewerId) ??
                                    t.reviewerId}
                                </td>
                                <td>
                                  {progressLabel(recs.length, t.caseCount)}
                                </td>
                                <td>
                                  <span
                                    className={`status-pill ${done ? "success" : "warning"}`}
                                  >
                                    {done ? "已完成" : "進行中"}
                                  </span>
                                </td>
                                <td>
                                  <button
                                    className="text-button"
                                    onClick={() =>
                                      setExecuting({
                                        mode: "task",
                                        taskId: t.id,
                                      })
                                    }
                                  >
                                    <Plus size={13} /> 新增審查
                                  </button>{" "}
                                  <button
                                    className="text-button"
                                    onClick={() => toggleRound(t.id)}
                                  >
                                    查詢（{recs.length}）
                                  </button>
                                </td>
                              </tr>
                              {roundOpen && (
                                <tr key={`${t.id}-recs`}>
                                  <td colSpan={5}>
                                    {recs.length === 0 ? (
                                      <p className="settings-note">
                                        尚無審查紀錄。
                                      </p>
                                    ) : (
                                      <div className="table-scroll">
                                        <table className="data-table">
                                          <thead>
                                            <tr>
                                              <th>件次</th>
                                              <th>審查日期</th>
                                              <th>審查人員</th>
                                              <th>得分／正確率</th>
                                              <th>送出時間</th>
                                              <th>操作</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {recs.map((r) => (
                                              <tr key={r.id}>
                                                <td>
                                                  {r.caseSeq != null
                                                    ? `第 ${r.caseSeq} 件`
                                                    : "既有紀錄"}
                                                </td>
                                                <td>{r.reviewDate || "—"}</td>
                                                <td>
                                                  {r.reviewerEmpNo
                                                    ? `${r.reviewerEmpNo}／${maskName(r.reviewerName || r.reviewerEmpNo)}`
                                                    : "—"}
                                                </td>
                                                <td>
                                                  {r.totalScore}/{r.maxScore}
                                                  {r.rate != null
                                                    ? `（${r.rate}%）`
                                                    : ""}
                                                </td>
                                                <td>{fmtTs(r.submittedAt) || "—"}</td>
                                                <td>
                                                  <button
                                                    className="text-button"
                                                    onClick={() =>
                                                      setExecuting({
                                                        mode: "task",
                                                        taskId: t.id,
                                                        editRecordId: r.id,
                                                      })
                                                    }
                                                  >
                                                    <Pencil size={13} /> 編輯
                                                  </button>
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        });
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })
      )}
    </>
  );
}
