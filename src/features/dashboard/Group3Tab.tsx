/**
 * 儀表板第 3 群（v1.88.35）：品管組審查員（另含單位審查員）。
 * 本月我的審查（待完成＝待審項目格式：只列審查項目＋截止日期，點選進入審查；
 * 已完成頁籤不變）、草稿數、逾期補審、次月預告。
 */
import { useMemo, useState } from "react";
import { CircleAlert, Lock } from "lucide-react";
import { SectionTitle } from "../../components/ui";
import { isOverdue, todayStr } from "../../lib/scheduling";
import { displayUnitCode } from "../../lib/mask";
import { requiredCases } from "../../lib/reviewProgress";
import {
  daysBetween,
  taskProgressCount,
  taskProgressLabel,
} from "../../lib/dashboardStats";
import type { DashboardData } from "./useDashboardData";
import type { ExecuteTarget } from "../ReviewExecutePage";
import { fmtYm } from "../../lib/ym";
import { stripInternalIdPrefix } from "../../lib/indicators";

export function Group3Tab({
  data,
  staffId,
  onExecute,
}: {
  data: DashboardData;
  staffId: string;
  onExecute: (t: ExecuteTarget) => void;
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

  const isDone = (task: (typeof myTasks)[number]) => {
    const doneCount = taskProgressCount(task);
    return doneCount != null && doneCount >= requiredCases(task.caseCount);
  };
  const pendingTasks = myTasks.filter((t) => !isDone(t));
  const doneTasks = myTasks.filter((t) => isDone(t));
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
  const today = todayStr();
  const dueSoon = pendingTasks.filter((t) => {
    if (t.status !== "pending") return false;
    const d = daysBetween(today, t.deadline);
    return d >= 0 && d <= 7;
  });

  const ymTitle = `${fmtYm(curYear, curMonth)} 我的審查`;

  const statusPill = (t: (typeof myTasks)[number]) => {
    if (t.status === "locked")
      return (
        <span className="status-pill danger">
          <Lock size={12} style={{ verticalAlign: "-1px" }} /> 已鎖定
        </span>
      );
    const done = isDone(t);
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
        <SectionTitle
          title={ymTitle}
          note={`共 ${myTasks.length} 筆任務；週期排程件數為區間共用`}
        />
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
        ) : tab === "pending" ? (
          // 待審項目：只列審查項目＋截止日期，點選進入審查
          <>
            <div className="table-scroll task-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>審查項目</th>
                    <th>截止日期</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((t) => {
                    const overdue = isOverdue(t.deadline, "pending");
                    return (
                      <tr key={t.id}>
                        <td>
                          {data.indicatorMap.get(t.indicatorId) ?? stripInternalIdPrefix(t.indicatorId)}
                        </td>
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
                        <td>
                          <button
                            className="text-button"
                            onClick={() =>
                              onExecute({ mode: "task", taskId: t.id })
                            }
                          >
                            審查
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="task-cards">
              {shown.map((t) => (
                <div key={t.id} className="task-card">
                  <div className="task-card-top">
                    <b>
                      {data.indicatorMap.get(t.indicatorId) ?? stripInternalIdPrefix(t.indicatorId)}
                    </b>
                    {statusPill(t)}
                  </div>
                  <div className="task-card-meta">
                    <span>截止：{t.deadline}</span>
                  </div>
                  <button
                    className="button button-primary task-card-btn"
                    onClick={() => onExecute({ mode: "task", taskId: t.id })}
                  >
                    審查
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="table-scroll task-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>指標名稱</th>
                    <th>審查單位</th>
                    <th>完成/應審</th>
                    <th>截止日期</th>
                    <th>狀態</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((t) => {
                    const done = isDone(t);
                    const overdue = isOverdue(
                      t.deadline,
                      done ? "done" : "pending",
                    );
                    return (
                      <tr key={t.id}>
                        <td>
                          {data.indicatorMap.get(t.indicatorId) ?? stripInternalIdPrefix(t.indicatorId)}
                        </td>
                        <td>{displayUnitCode(t.unitId)}</td>
                        <td>{taskProgressLabel(t)}</td>
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
                const done = isDone(t);
                return (
                  <div key={t.id} className="task-card">
                    <div className="task-card-top">
                      <b>
                        {data.indicatorMap.get(t.indicatorId) ?? stripInternalIdPrefix(t.indicatorId)}
                      </b>
                      {statusPill(t)}
                    </div>
                    <div className="task-card-meta">
                      <span>審查單位：{displayUnitCode(t.unitId)}</span>
                      <span>
                        完成/應審：{taskProgressLabel(t)}
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

      {/* 草稿數：伺服器端 reviewDrafts 本人未送出草稿 */}
      <section className="panel">
        <SectionTitle title="草稿數" note="伺服器端暫存（未送出），點「繼續編輯」回到該任務的暫存紀錄" />
        {data.drafts.length === 0 ? (
          <p className="settings-note">目前沒有未送出的草稿。</p>
        ) : (
          <>
            <p style={{ margin: "0 0 8px" }}>
              <strong style={{ fontSize: 24 }}>{data.drafts.length}</strong>
              <span className="muted-text"> 份草稿</span>
            </p>
            <div className="table-scroll dashboard-responsive-table">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>審查項目</th>
                    <th>受審人員</th>
                    <th>審查日期</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {data.drafts.map((d) => (
                    <tr key={d.id}>
                      <td data-label="審查項目">
                        {data.indicatorMap.get(d.indicatorId) ?? stripInternalIdPrefix(d.indicatorId)}
                      </td>
                      <td data-label="受審人員">{d.reviewedPersonName || d.reviewedPersonEmpNo || "—"}</td>
                      <td data-label="審查日期">{d.reviewDate || "—"}</td>
                      <td data-label="操作">
                        <button
                          className="text-button"
                          onClick={() =>
                            onExecute({ mode: "task", taskId: d.taskId })
                          }
                        >
                          繼續編輯
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {/* 逾期補審區 */}
      {(lockedTasks.length > 0 || dueSoon.length > 0) && (
        <section className="panel">
          <SectionTitle title="逾期補審" note="鎖定任務可申請解鎖；7 天內到期請儘速完成" />
          {lockedTasks.length > 0 && (
            <>
              <p className="settings-note" style={{ marginBottom: 8 }}>
                已鎖定（{lockedTasks.length} 筆）：點「審查」進入可填寫原因申請解鎖。
              </p>
              <div className="table-scroll dashboard-responsive-table">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>指標名稱</th>
                      <th>審查單位</th>
                      <th>完成/應審</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lockedTasks.map((t) => (
                      <tr key={t.id}>
                        <td data-label="指標名稱">
                          {data.indicatorMap.get(t.indicatorId) ?? stripInternalIdPrefix(t.indicatorId)}
                        </td>
                        <td data-label="審查單位">{displayUnitCode(t.unitId)}</td>
                        <td data-label="完成／應審件數">{taskProgressLabel(t)}</td>
                        <td data-label="操作">
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
                  {data.indicatorMap.get(t.indicatorId) ?? stripInternalIdPrefix(t.indicatorId)}／
                  {displayUnitCode(t.unitId)}：{t.deadline} 截止
                  <span className="status-pill warning" style={{ marginLeft: 8 }}>
                    剩餘 {daysBetween(today, t.deadline)} 天
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* 次月預告 */}
      <section className="panel">
        <SectionTitle
          title={`次月預告（${fmtYm(nextYear, nextMonth)}）`}
          note={`共 ${upcomingTasks.length} 筆任務`}
        />
        {upcomingTasks.length === 0 ? (
          <p className="settings-note">次月尚無排定任務。</p>
        ) : (
          <div className="table-scroll dashboard-responsive-table">
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
                    <td data-label="指標名稱">
                      {data.indicatorMap.get(t.indicatorId) ?? stripInternalIdPrefix(t.indicatorId)}
                    </td>
                    <td data-label="審查單位">{displayUnitCode(t.unitId)}</td>
                    <td data-label="應審件數">{t.caseCount ?? "未設定"}</td>
                    <td data-label="截止日期">{t.deadline}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
