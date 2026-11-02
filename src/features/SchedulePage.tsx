import { useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  ChevronDown,
  MoreHorizontal,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { DEMO_SCHEDULES } from "../data/demo";
import { PageHeading } from "../components/ui";

export function SchedulePage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  const [period, setPeriod] = useState("2026 年 11 月");
  return (
    <>
      <PageHeading
        page="schedule"
        action={
          <button
            className="button button-primary"
            onClick={() => onAction("展示版不會儲存新增排程")}
          >
            <Plus size={16} />
            建立排程
          </button>
        }
      />
      <div className="schedule-banner">
        <div className="schedule-banner-icon">
          <CalendarDays size={20} />
        </div>
        <div>
          <b>{period}排程完成率</b>
          <span>共 84 項審查任務，尚有 24 項待完成</span>
        </div>
        <strong>
          71%<small>60 / 84 項</small>
        </strong>
        <div className="banner-progress">
          <i style={{ width: "71%" }} />
        </div>
      </div>
      <div className="toolbar schedule-toolbar">
        <div className="tabs">
          <button className="tab active">
            全部任務 <span>84</span>
          </button>
          <button className="tab">
            待審查 <span>24</span>
          </button>
          <button className="tab">
            逾期補審 <span>4</span>
          </button>
        </div>
        <div className="toolbar-actions">
          <button
            className="select-like"
            onClick={() =>
              setPeriod(
                period === "2026 年 11 月" ? "2026 年 12 月" : "2026 年 11 月",
              )
            }
          >
            <CalendarDays size={15} />
            {period}
            <ChevronDown size={14} />
          </button>
          <button
            className="button button-outline"
            onClick={() => onAction("排程資料為虛構展示內容")}
          >
            <SlidersHorizontal size={15} />
            篩選
          </button>
        </div>
      </div>
      <section className="panel data-panel">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>指標／受審單位</th>
                <th>審查員</th>
                <th>排程月份</th>
                <th>任務進度</th>
                <th>截止日</th>
                <th>狀態</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {DEMO_SCHEDULES.map((task) => (
                <tr key={task.id}>
                  <td>
                    <div className="indicator-title">
                      <b>{task.indicator}</b>
                      <span>{task.unit}</span>
                    </div>
                  </td>
                  <td>
                    <div className="person-cell">
                      <span className="person-avatar">
                        {task.reviewer.slice(-1)}
                      </span>
                      {task.reviewer}
                    </div>
                  </td>
                  <td>{task.month}</td>
                  <td>
                    <div className="schedule-progress">
                      <span>
                        {task.done} / {task.total}
                      </span>
                      <div className="mini-progress">
                        <i
                          style={{
                            width: `${Math.round((task.done / task.total) * 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                  </td>
                  <td>{task.due}</td>
                  <td>
                    <span
                      className={`status-pill ${task.status === "逾期補審" ? "danger" : task.status === "待開始" ? "muted" : "info"}`}
                    >
                      {task.status}
                    </span>
                  </td>
                  <td>
                    <button
                      className="icon-button"
                      onClick={() =>
                        onAction(`排程「${task.indicator}」僅供展示`)
                      }
                      aria-label="排程更多選項"
                    >
                      <MoreHorizontal size={17} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="table-footer">
          <span>目前顯示 4 筆虛構排程</span>
          <button
            className="text-button"
            onClick={() => onAction("已複製上月展示排程（未儲存）")}
          >
            複製上個月 <ArrowRight size={14} />
          </button>
        </div>
      </section>
      <div className="dashboard-footnote">
        <ShieldCheck size={14} />{" "}
        利益迴避規則：審查員不得審查自己所屬單位；加審超過當月次數時提示但不阻擋，正式排程須記錄改派與加派。
      </div>
    </>
  );
}
