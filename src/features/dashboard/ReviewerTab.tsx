/**
 * 審查員儀表板頁籤（v1.15.0）：原「YYYY/MM 我的審查」待完成／已完成雙頁籤，
 * 加上次月預告與逾期補審區。
 */
import { useMemo, useState } from "react";
import { CircleAlert, Lock } from "lucide-react";
import { SectionTitle } from "../../components/ui";
import { isOverdue, todayStr } from "../../lib/scheduling";
import { progressLabel, requiredCases } from "../../lib/reviewProgress";
import { daysBetween } from "../../lib/dashboardStats";
import {
  DEFAULT_DASHBOARD_SECTIONS,
  type DashboardSections,
} from "../../lib/dashboardSections";
import type { DashboardData } from "./useDashboardData";
import type { ExecuteTarget } from "../ReviewExecutePage";

export function ReviewerTab({
  data,
  staffId,
  onExecute,
  sections = DEFAULT_DASHBOARD_SECTIONS,
}: {
  data: DashboardData;
  staffId: string;
  onExecute: (t: ExecuteTarget) => void;
  /** v1.28 階段 2：顯示設定旗標（預設本月待辦／逾期補審／次月預告全留） */
  sections?: DashboardSections;
}) {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;
  const nextMonth = curMonth === 12 ? 1 : curMonth + 1;
  const nextYear = curMonth === 12 ? curYear + 1 : curYear;
  const [tab, setTab] = useState<"pending" | "done">("pending");

  const myTasks = useMemo(
    () =>
      data.tasks
        .filter(
          (t) =>
            t.reviewerId === staffId &&
            t.year === curYear &&
            t.month === curMonth,
        )
        .sort((a, b) => {
          const c = (data.indicatorMap.get(a.indicatorId) ?? "").localeCompare(
            data.indicatorMap.get(b.indicatorId) ?? "",
            "zh-Hant",
          );
          return c !== 0 ? c : a.unitId.localeCompare(b.unitId, "zh-Hant");
        }),
    [data, staffId, curYear, curMonth],
  );

  const isDone = (doneCount: number, caseCount: number | null) =>
    doneCount >= requiredCases(caseCount);
  const pendingTasks = myTasks.filter(
    (t) => !isDone(t.doneCount, t.caseCount),
  );
  const doneTasks = myTasks.filter((t) => isDone(t.doneCount, t.caseCount));
  const shown = tab === "pending" ? pendingTasks : doneTasks;

  const lockedTasks = pendingTasks.filter((t) => t.status === "locked");
  const upcomingTasks = useMemo(
    () =>
      data.tasks.filter(
        (t) =>
          t.reviewerId === staffId &&
          t.year === nextYear &&
          t.month === nextMonth,
      ),
    [data, staffId, nextYear, nextMonth],
  );
  // 7 天內到期的待完成任務（未鎖定）
  const today = todayStr();
  const dueSoon = pendingTasks.filter((t) => {
    if (t.status !== "pending") return false;
    const d = daysBetween(today, t.deadline);
    return d >= 0 && d <= 7;
  });

  const ymTitle = `${curYear}/${String(curMonth).padStart(2, "0")} 我的審查`;

  const statusPill = (t: (typeof myTasks)[number]) => {
    if (t.status === "locked")
      return (
        <span className="status-pill danger">
          <Lock size={12} style={{ verticalAlign: "-1px" }} /> 已鎖定
        </span>
      );
    const done = isDone(t.doneCount, t.caseCount);
    const overdue = isOverdue(t.deadline, done ? "done" : "pending");
    if (overdue)
      return <span className="status-pill danger">逾期未完成</span>;
    return (
      <span className={`status-pill${done ? " success" : " warning"}`}>
        {done ? "已完成" : "待完成"}
      </span>
    );
  };

  return (
    <>
      <section className="panel my-review">
        <SectionTitle title={ymTitle} note={`共 ${myTasks.length} 筆任務`} />
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
        {data.loading ? (
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
                    <th>狀態</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((t) => {
                    const done = isDone(t.doneCount, t.caseCount);
                    const overdue = isOverdue(
                      t.deadline,
                      done ? "done" : "pending",
                    );
                    return (
                      <tr key={t.id}>
                        <td>
                          {data.indicatorMap.get(t.indicatorId) ?? t.indicatorId}
                        </td>
                        <td>{t.unitId}</td>
                        <td>{progressLabel(t.doneCount, t.caseCount)}</td>
                        <td
                          style={
                            overdue && t.status !== "locked"
                              ? { color: "#b3372f", fontWeight: 600 }
                              : undefined
                          }
                        >
                          {t.deadline}
                          {overdue && t.status !== "locked" && (
                            <>
                              {" "}
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
                        <td>{statusPill(t)}</td>
                        <td>
                          <button
                            className="text-button"
                            onClick={() =>
                              onExecute(
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
            <div className="task-cards">
              {shown.map((t) => {
                const done = isDone(t.doneCount, t.caseCount);
                return (
                  <div key={t.id} className="task-card">
                    <div className="task-card-top">
                      <b>
                        {data.indicatorMap.get(t.indicatorId) ?? t.indicatorId}
                      </b>
                      {statusPill(t)}
                    </div>
                    <div className="task-card-meta">
                      <span>審查單位：{t.unitId}</span>
                      <span>
                        完成/應審：{progressLabel(t.doneCount, t.caseCount)}
                      </span>
                      <span>截止：{t.deadline}</span>
                    </div>
                    <button
                      className="button button-primary task-card-btn"
                      onClick={() =>
                        onExecute(
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

      {/* 逾期補審區（v1.15.0） */}
      {sections.overdueLocked &&
        (lockedTasks.length > 0 || dueSoon.length > 0) && (
        <section className="panel">
          <SectionTitle title="逾期補審" note="鎖定任務可申請解鎖；7 天內到期請儘速完成" />
          {lockedTasks.length > 0 && (
            <>
              <p className="settings-note" style={{ marginBottom: 8 }}>
                已鎖定（{lockedTasks.length} 筆）：點「審查」進入可填寫原因申請解鎖。
              </p>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>指標名稱</th>
                      <th>審查單位</th>
                      <th>完成/應審件數</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lockedTasks.map((t) => (
                      <tr key={t.id}>
                        <td>
                          {data.indicatorMap.get(t.indicatorId) ?? t.indicatorId}
                        </td>
                        <td>{t.unitId}</td>
                        <td>{progressLabel(t.doneCount, t.caseCount)}</td>
                        <td>
                          <button
                            className="text-button"
                            onClick={() =>
                              onExecute({ mode: "task", taskId: t.id })
                            }
                          >
                            申請解鎖
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {dueSoon.length > 0 && (
            <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
              {dueSoon.map((t) => (
                <li key={t.id}>
                  {data.indicatorMap.get(t.indicatorId) ?? t.indicatorId}／
                  {t.unitId}：{t.deadline} 截止
                  <span className="status-pill warning" style={{ marginLeft: 8 }}>
                    剩餘 {daysBetween(today, t.deadline)} 天
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* 次月預告（v1.15.0） */}
      {sections.nextMonthPreview && (
        <section className="panel">
          <SectionTitle
            title={`次月預告（${nextYear}/${String(nextMonth).padStart(2, "0")}）`}
            note={`共 ${upcomingTasks.length} 筆任務`}
          />
        {upcomingTasks.length === 0 ? (
          <p className="settings-note">次月尚無排定任務。</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>指標名稱</th>
                  <th>審查單位</th>
                  <th>應審件數</th>
                  <th>截止日期</th>
                </tr>
              </thead>
              <tbody>
                {upcomingTasks.map((t) => (
                  <tr key={t.id}>
                    <td>
                      {data.indicatorMap.get(t.indicatorId) ?? t.indicatorId}
                    </td>
                    <td>{t.unitId}</td>
                    <td>{t.caseCount ?? "未設定"}</td>
                    <td>{t.deadline}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </section>
      )}
    </>
  );
}
