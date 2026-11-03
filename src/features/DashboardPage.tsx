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
  progressLabel,
  taskTab,
} from "../lib/reviewProgress";
import {
  ReviewExecutePage,
  type ExecuteTarget,
} from "./ReviewExecutePage";
import type { Role } from "../types";

interface TaskRow extends ReviewTask {
  id: string;
  /** 該單位完成數（該 task 的 reviewRecords 筆數；舊格式單筆算 1 件） */
  doneCount: number;
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

  // ---- YYYY/MM 我的審查（v1.11.0：待完成／已完成雙頁籤） ----
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tab, setTab] = useState<"pending" | "done">("pending");
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
      // 逐件完成數：taskId → reviewRecords 筆數（v1.11.0 起數據來自實際審查結果）
      const countMap = new Map<string, number>();
      rsnap.docs.forEach((d) => {
        const data = d.data();
        if (
          Number(data.year) !== curYear ||
          Number(data.month) !== curMonth
        )
          return;
        const tid =
          typeof data.taskId === "string" ? data.taskId : d.id;
        countMap.set(tid, (countMap.get(tid) ?? 0) + 1);
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
          doneCount: countMap.get(d.id) ?? 0,
        });
      });
      list.sort((a, b) => {
        const c = (inm.get(a.indicatorId) ?? a.indicatorId).localeCompare(
          inm.get(b.indicatorId) ?? b.indicatorId,
          "zh-Hant",
        );
        if (c !== 0) return c;
        return (unm.get(a.unitId) ?? a.unitId).localeCompare(
          unm.get(b.unitId) ?? b.unitId,
          "zh-Hant",
        );
      });
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

  /** 審查表單執行目標（v1.11.0）：task＝審查表單；records＝查詢逐件結果 */
  const [executing, setExecuting] = useState<ExecuteTarget | null>(null);

  /** 頁籤分類（v1.11.0）：完成數 ≧ 應審件數 → 已完成 */
  const isDone = useCallback(
    (t: TaskRow) => taskTab(t.doneCount, t.caseCount, t.status === "done") === "done",
    [],
  );

  const pendingTasks = useMemo(
    () => tasks.filter((t) => !isDone(t)),
    [tasks, isDone],
  );
  const doneTasks = useMemo(
    () => tasks.filter((t) => isDone(t)),
    [tasks, isDone],
  );
  const shown = tab === "pending" ? pendingTasks : doneTasks;

  const overdueOf = useCallback(
    (t: TaskRow) => isOverdue(t.deadline, isDone(t) ? "done" : "pending"),
    [isDone],
  );

  // 審查表單／查詢執行中 → 顯示執行頁（返回時重讀任務）
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

  const ymTitle = `${curYear}/${String(curMonth).padStart(2, "0")} 我的審查`;

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

      {/* YYYY/MM 我的審查（v1.11.0：待完成／已完成雙頁籤） */}
      <section className="panel my-review">
        <SectionTitle title={ymTitle} note={`共 ${tasks.length} 筆任務`} />
        <div className="tabs" style={{ marginBottom: 12 }} role="tablist">
          <button
            className={`tab${tab === "pending" ? " active" : ""}`}
            role="tab"
            aria-selected={tab === "pending"}
            onClick={() => setTab("pending")}
          >
            待完成 <span>{pendingTasks.length}</span>
          </button>
          <button
            className={`tab${tab === "done" ? " active" : ""}`}
            role="tab"
            aria-selected={tab === "done"}
            onClick={() => setTab("done")}
          >
            已完成 <span>{doneTasks.length}</span>
          </button>
        </div>
        {tasksLoading ? (
          <p className="settings-note">讀取中…</p>
        ) : shown.length === 0 ? (
          <p className="settings-note">
            {tab === "pending" ? "待完成任務已全數完成。" : "尚無已完成任務。"}
          </p>
        ) : (
          <>
            <div className="table-scroll task-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>指標名稱</th>
                    <th>審查單位</th>
                    <th>完成/應審件數</th>
                    <th>截止日期</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((t) => {
                    const done = isDone(t);
                    const overdue = overdueOf(t);
                    return (
                      <tr key={t.id}>
                        <td>{indicatorNames.get(t.indicatorId) ?? t.indicatorId}</td>
                        <td>{unitNames.get(t.unitId) ?? t.unitId}</td>
                        <td>{progressLabel(t.doneCount, t.caseCount)}</td>
                        <td
                          style={
                            overdue
                              ? { color: "#b3372f", fontWeight: 600 }
                              : undefined
                          }
                        >
                          {t.deadline}
                          {overdue && (
                            <>
                              {" "}
                              <span className="status-pill danger">
                                逾期未完成
                              </span>
                              <CircleAlert
                                size={14}
                                style={{
                                  verticalAlign: "-2px",
                                  marginLeft: 4,
                                }}
                              />
                            </>
                          )}
                        </td>
                        <td>
                          <button
                            className="text-button"
                            onClick={() =>
                              setExecuting(
                                done
                                  ? { mode: "records", taskId: t.id }
                                  : { mode: "task", taskId: t.id },
                              )
                            }
                          >
                            {done ? "查詢" : "審查"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/* 手機卡片（v1.10.2：≤640px 顯示，寬螢幕隱藏） */}
            <div className="task-cards">
              {shown.map((t) => {
                const done = isDone(t);
                const overdue = overdueOf(t);
                return (
                  <div key={t.id} className="task-card">
                    <div className="task-card-top">
                      <b>{indicatorNames.get(t.indicatorId) ?? t.indicatorId}</b>
                      <span
                        className={`status-pill${overdue ? " danger" : done ? " success" : " warning"}`}
                      >
                        {overdue ? "逾期未完成" : done ? "已完成" : "待完成"}
                      </span>
                    </div>
                    <div className="task-card-meta">
                      <span>審查單位：{unitNames.get(t.unitId) ?? t.unitId}</span>
                      <span>
                        完成/應審：{progressLabel(t.doneCount, t.caseCount)}
                      </span>
                      <span
                        className={overdue ? "overdue-text" : undefined}
                      >
                        截止：{t.deadline}
                        {overdue && (
                          <CircleAlert
                            size={14}
                            style={{
                              verticalAlign: "-2px",
                              marginLeft: 4,
                            }}
                          />
                        )}
                      </span>
                    </div>
                    <button
                      className="button button-primary task-card-btn"
                      onClick={() =>
                        setExecuting(
                          done
                            ? { mode: "records", taskId: t.id }
                            : { mode: "task", taskId: t.id },
                        )
                      }
                    >
                      {done ? "查詢" : "審查"}
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>

      <EmptyState
        title="尚未串接資料"
        description="儀表板數據將在指標、排程與審查紀錄串接完成後顯示。"
      />
    </>
  );
}
