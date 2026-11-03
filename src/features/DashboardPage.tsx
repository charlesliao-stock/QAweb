import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleAlert, Download } from "lucide-react";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import {
  collection,
  getDocs,
  query,
  where,
} from "../lib/db";
import { getFirebaseDb } from "../lib/firebase";
import { useAuth } from "../lib/auth";
import { isOverdue, type ReviewTask } from "../lib/scheduling";
import {
  ReviewExecutePage,
  type ExecuteTarget,
} from "./ReviewExecutePage";
import type { Role } from "../types";

interface TaskRow extends ReviewTask {
  id: string;
  /** 審查結果正確率（來自 reviewRecords；null＝無紀錄或滿分 0） */
  rate: number | null;
}

export function DashboardPage({
  role,
  onAction,
}: {
  role: Role;
  onAction: (message: string) => void;
}) {
  const { user } = useAuth();
  const isIndividual = role === "一般人員";

  // ---- 本月我的審查（v1.8.0） ----
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [indicatorNames, setIndicatorNames] = useState<Map<string, string>>(
    new Map(),
  );
  const [unitNames, setUnitNames] = useState<Map<string, string>>(new Map());

  const loadMyTasks = useCallback(async () => {
    const staffId = user?.staffId;
    if (!staffId) return;
    setTasksLoading(true);
    try {
      const db = getFirebaseDb();
      const [tsnap, isnap, usnap, rsnap] = await Promise.all([
        getDocs(
          query(collection(db, "reviewTasks"), where("reviewerId", "==", staffId)),
        ),
        getDocs(collection(db, "indicators")),
        getDocs(collection(db, "units")),
        getDocs(
          query(
            collection(db, "reviewRecords"),
            where("reviewerId", "==", staffId),
          ),
        ),
      ]);
      const inm = new Map<string, string>();
      isnap.docs.forEach((d) => {
        const n = d.data().name;
        inm.set(d.id, typeof n === "string" ? n : d.id);
      });
      setIndicatorNames(inm);
      const unm = new Map<string, string>();
      usnap.docs.forEach((d) => {
        const n = d.data().name;
        unm.set(d.id, typeof n === "string" ? n : d.id);
      });
      setUnitNames(unm);
      // 審查結果：taskId → 正確率（v1.10.0 起數據來自實際審查結果）
      const rateMap = new Map<string, number | null>();
      rsnap.docs.forEach((d) => {
        const data = d.data();
        if (
          Number(data.year) !== curYear ||
          Number(data.month) !== curMonth
        )
          return;
        const tid = typeof data.taskId === "string" ? data.taskId : d.id;
        const rt = data.rate;
        rateMap.set(tid, typeof rt === "number" ? rt : null);
      });
      const list: TaskRow[] = [];
      tsnap.docs.forEach((d) => {
        const data = d.data();
        if (data.year !== curYear || data.month !== curMonth) return;
        const cc = data.caseCount;
        list.push({
          id: d.id,
          indicatorId: String(data.indicatorId ?? ""),
          year: Number(data.year ?? 0),
          month: Number(data.month ?? 0),
          unitId: String(data.unitId ?? ""),
          reviewerId: String(data.reviewerId ?? ""),
          caseCount:
            typeof cc === "number" && Number.isInteger(cc) && cc >= 1
              ? cc
              : null,
          deadline: String(data.deadline ?? ""),
          status: data.status === "done" ? "done" : "pending",
          completedAt: data.completedAt,
          createdAt: data.createdAt,
          rate: rateMap.has(d.id) ? (rateMap.get(d.id) ?? null) : null,
        });
      });
      list.sort((a, b) =>
        (inm.get(a.indicatorId) ?? a.indicatorId).localeCompare(
          inm.get(b.indicatorId) ?? b.indicatorId,
          "zh-Hant",
        ),
      );
      setTasks(list);
    } catch {
      // 讀不到就顯示空狀態，不阻擋儀表板
      setTasks([]);
    } finally {
      setTasksLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.staffId]);

  useEffect(() => {
    loadMyTasks();
  }, [loadMyTasks]);

  /** 審查表單執行目標（v1.10.0）：task 模式＝指定任務；indicator 模式＝點指標名稱進入 */
  const [executing, setExecuting] = useState<ExecuteTarget | null>(null);

  const byIndicator = useMemo(() => {
    const map = new Map<string, TaskRow[]>();
    tasks.forEach((t) => {
      const arr = map.get(t.indicatorId) ?? [];
      arr.push(t);
      map.set(t.indicatorId, arr);
    });
    return map;
  }, [tasks]);

  // 審查表單執行中 → 顯示執行頁（返回時重讀任務）
  if (executing) {
    return (
      <ReviewExecutePage
        target={executing}
        onBack={() => {
          setExecuting(null);
          void loadMyTasks();
        }}
        onAction={onAction}
      />
    );
  }

  return (
    <>
      <PageHeading
        page="dashboard"
        action={
          <button
            className="button button-outline"
            onClick={() => onAction("資料串接完成後才能匯出摘要")}
          >
            <Download size={16} />
            匯出摘要
          </button>
        }
      />
      <div className="dashboard-welcome">
        <div>
          <span className="welcome-kicker">QUALITY SNAPSHOT</span>
          <h2>
            {isIndividual
              ? "照顧品質，從每一次查核累積"
              : "本月品質查核進度總覽"}
          </h2>
          <p>指標進度、審查任務與單位達標狀況，將在資料串接後顯示。</p>
        </div>
        <div className="welcome-art" aria-hidden="true">
          <div className="art-ring ring-one" />
          <div className="art-ring ring-two" />
          <div className="art-cross">
            <span />
            <i />
          </div>
          <div className="art-dot dot-a" />
          <div className="art-dot dot-b" />
          <div className="art-dot dot-c" />
        </div>
      </div>

      {/* 本月我的審查（v1.8.0） */}
      <section className="panel">
        <SectionTitle
          title="本月我的審查"
          note={`${curYear} 年 ${curMonth} 月・共 ${tasks.length} 筆任務`}
        />
        {tasksLoading ? (
          <p className="settings-note">讀取中…</p>
        ) : tasks.length === 0 ? (
          <p className="settings-note">本月無指派給您的審查任務。</p>
        ) : (
          [...byIndicator.entries()].map(([indicatorId, list]) => {
            const pendingList = list.filter((t) => t.status !== "done");
            const doneList = list.filter((t) => t.status === "done");
            const sumCases = (arr: TaskRow[]) =>
              arr.reduce(
                (n, t) => n + (t.caseCount != null ? t.caseCount : 0),
                0,
              );
            return (
              <div key={indicatorId} className="unit-group-block">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    flexWrap: "wrap",
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  <button
                    className="text-button"
                    onClick={() =>
                      setExecuting({
                        mode: "indicator",
                        indicatorId,
                        year: curYear,
                        month: curMonth,
                      })
                    }
                    title="開啟該指標的審查表單"
                  >
                    <b>{indicatorNames.get(indicatorId) ?? indicatorId}</b>
                  </button>
                  <span className="muted-text">
                    待完成 {pendingList.length} 筆（{sumCases(pendingList)}{" "}
                    件）・已完成 {doneList.length} 筆（{sumCases(doneList)} 件）
                  </span>
                </div>
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>受審單位</th>
                        <th>審查件數</th>
                        <th>狀態</th>
                        <th>截止日期</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((t) => {
                        const overdue = isOverdue(t.deadline, t.status);
                        const isDone = t.status === "done";
                        return (
                          <tr key={t.id}>
                            <td>{unitNames.get(t.unitId) ?? t.unitId}</td>
                            <td>
                              {t.caseCount != null ? `${t.caseCount}件` : "—"}
                            </td>
                            <td>
                              <span
                                className={
                                  isDone
                                    ? "status-pill success"
                                    : overdue
                                      ? "status-pill danger"
                                      : "status-pill warning"
                                }
                              >
                                {isDone
                                  ? t.rate != null
                                    ? `已完成 ${t.rate}%`
                                    : "已完成"
                                  : overdue
                                    ? "逾期未完成"
                                    : "待完成"}
                              </span>
                            </td>
                            <td
                              style={
                                overdue
                                  ? { color: "#b3372f", fontWeight: 600 }
                                  : undefined
                              }
                            >
                              {t.deadline}
                              {overdue && (
                                <CircleAlert
                                  size={14}
                                  style={{
                                    verticalAlign: "-2px",
                                    marginLeft: 4,
                                  }}
                                />
                              )}
                            </td>
                            <td>
                              <button
                                className="text-button"
                                onClick={() =>
                                  setExecuting({ mode: "task", taskId: t.id })
                                }
                              >
                                {isDone ? "查看／修改" : "填寫審查表"}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })
        )}
      </section>

      <EmptyState
        title="尚未串接資料"
        description="儀表板數據將在指標、排程與審查紀錄串接完成後顯示。"
      />
    </>
  );
}
