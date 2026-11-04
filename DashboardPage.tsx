import type { ReactNode } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  CircleHelp,
  ClipboardCheck,
  Clock3,
  Download,
  Gauge,
  MoreHorizontal,
} from "lucide-react";
import { DEMO_SCHEDULES, DEMO_UNITS } from "../data/demo";
import { RagBadge, PageHeading, SectionTitle } from "../components/ui";
import { TrendChart } from "../components/TrendChart";
import {
  getScheduleTaskDisplayStatus,
  getScheduleTaskProgress,
} from "../lib/scheduleStatus";
import type { Role, ScheduleTask } from "../types";

export function DashboardPage({
  role,
  onAction,
}: {
  role: Role;
  onAction: (message: string) => void;
}) {
  const isIndividual = role === "一般人員";
  return (
    <>
      <PageHeading
        page="dashboard"
        action={
          <button
            className="button button-outline"
            onClick={() =>
              onAction(
                "展示報表已準備，未連接正式資料。請勿匯出展示資料作正式用途。",
              )
            }
          >
            <Download size={16} />
            匯出摘要
          </button>
        }
      />
      <div className="dashboard-welcome">
        <div>
          <span className="welcome-kicker">
            QUALITY SNAPSHOT <span>·</span> 2026.11
          </span>
          <h2>
            {isIndividual
              ? "照顧品質，從每一次查核累積"
              : "本月品質查核，進度穩定推進"}
          </h2>
          <p>
            {isIndividual
              ? "以下為展示用的個人品質摘要，不代表正式稽核結果。"
              : "各項指標持續追蹤中，以下為目前的展示資料摘要。"}
          </p>
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
      <div className="kpi-grid">
        <MetricCard
          title={isIndividual ? "個人符合率" : "本月完成率"}
          value={isIndividual ? "94.2%" : "86.4%"}
          detail={isIndividual ? "高於指標閾值 4.2%" : "比上月增加 5.8%"}
          change="+5.8%"
          tone="teal"
          icon={<ClipboardCheck size={19} />}
          trend="up"
        />
        <MetricCard
          title={isIndividual ? "已完成審查" : "單位達標率"}
          value={isIndividual ? "12" : "82.1%"}
          detail={isIndividual ? "本年度完成項目" : "高於全院閾值 2.1%"}
          change="+2.1%"
          tone="blue"
          icon={<Gauge size={19} />}
          trend="up"
        />
        <MetricCard
          title={isIndividual ? "待檢視結果" : "待完成任務"}
          value={isIndividual ? "3" : "24"}
          detail={isIndividual ? "本月新完成的稽核" : "分布於 8 個示範單位"}
          change="需追蹤"
          tone="amber"
          icon={<Clock3 size={19} />}
          trend="flat"
        />
        <MetricCard
          title={isIndividual ? "近期改善項目" : "異常單位"}
          value={isIndividual ? "1" : "2"}
          detail={isIndividual ? "已有改善追蹤" : "未達閾值，請留意"}
          change="查看明細"
          tone="rose"
          icon={<Activity size={19} />}
          trend="down"
        />
      </div>
      <div className="dashboard-grid">
        <section className="panel trend-panel">
          <SectionTitle
            title="品質指標趨勢"
            note="近 8 個月整體達標率"
            action={
              <button
                className="select-like"
                onClick={() => onAction("展示期間：2026 年 4 月至 11 月")}
              >
                <span>近 8 個月</span>
                <ChevronDown size={14} />
              </button>
            }
          />
          <TrendChart />
        </section>
        <section className="panel focus-panel">
          <SectionTitle
            title="需要關注"
            note="依閾值與排程狀態彙整"
            action={
              <button
                className="text-button"
                onClick={() => onAction("已開啟展示提醒清單")}
              >
                全部 <ArrowRight size={14} />
              </button>
            }
          />
          <div className="focus-list">
            <FocusItem
              icon="!"
              tone="red"
              title="跌倒預防正確率"
              meta="示範急診單位 · 低於閾值 8%"
              value="87%"
            />
            <FocusItem
              icon="↗"
              tone="amber"
              title="給藥安全正確率"
              meta="示範內科病房 · 尚差 3% 達標"
              value="92%"
            />
            <FocusItem
              icon="◷"
              tone="blue"
              title="排程即將到期"
              meta="本月 4 項任務將於 5 日內到期"
              value="4 項"
            />
          </div>
        </section>
        <section className="panel unit-panel">
          <SectionTitle
            title="單位達標概況"
            note="示範單位 · 當月受審進度"
            action={
              <button
                className="text-button"
                onClick={() => onAction("單位清單僅含展示資料")}
              >
                查看單位 <ArrowRight size={14} />
              </button>
            }
          />
          <div className="unit-table">
            <div className="unit-table-head">
              <span>單位</span>
              <span>進度</span>
              <span>達標率</span>
              <span>狀態</span>
            </div>
            {DEMO_UNITS.map((unit) => (
              <div className="unit-table-row" key={unit.name}>
                <span className="unit-name">
                  <span className={`table-status status-${unit.status}`} />
                  {unit.name}
                </span>
                <span className="unit-count">{unit.count}</span>
                <span className="unit-score">{unit.score}%</span>
                <RagBadge value={unit.score} threshold={90} compact />
              </div>
            ))}
          </div>
        </section>
        <section className="panel task-panel">
          <SectionTitle
            title="近期審查任務"
            note="展示排程 · 2026 年 11 月"
            action={
              <button
                className="text-button"
                onClick={() => onAction("已開啟全部展示排程")}
              >
                全部任務 <ArrowRight size={14} />
              </button>
            }
          />
          <div className="task-list">
            {DEMO_SCHEDULES.slice(0, 3).map((task) => (
              <TaskRow key={task.id} task={task} onAction={onAction} />
            ))}
          </div>
        </section>
      </div>
      <div className="dashboard-footnote">
        <CircleHelp size={14} />{" "}
        顯示數據為虛構展示資料；達標計算依指標閾值判定，正式統計需由品管確認。
      </div>
    </>
  );
}

function MetricCard({
  title,
  value,
  detail,
  change,
  tone,
  icon,
  trend,
}: {
  title: string;
  value: string;
  detail: string;
  change: string;
  tone: string;
  icon: ReactNode;
  trend: "up" | "down" | "flat";
}) {
  return (
    <article className="metric-card">
      <div className="metric-top">
        <span>{title}</span>
        <span className={`metric-icon ${tone}`}>{icon}</span>
      </div>
      <strong>{value}</strong>
      <div className="metric-bottom">
        <span>{detail}</span>
        <span className={`metric-change ${trend}`}>
          {trend === "down" ? (
            <ArrowDownRight size={13} />
          ) : trend === "up" ? (
            <ArrowUpRight size={13} />
          ) : null}
          {change}
        </span>
      </div>
    </article>
  );
}

function FocusItem({
  icon,
  tone,
  title,
  meta,
  value,
}: {
  icon: string;
  tone: string;
  title: string;
  meta: string;
  value: string;
}) {
  return (
    <div className="focus-item">
      <span className={`focus-icon ${tone}`}>{icon}</span>
      <div className="focus-copy">
        <b>{title}</b>
        <span>{meta}</span>
      </div>
      <strong>{value}</strong>
    </div>
  );
}

function TaskRow({
  task,
  onAction,
}: {
  task: ScheduleTask;
  onAction: (message: string) => void;
}) {
  const pct = getScheduleTaskProgress(task);
  const status = getScheduleTaskDisplayStatus(task);
  return (
    <div className="task-row">
      <div className="task-date">
        <b>{task.due.split("/")[0]}</b>
        <span>{task.due.split("/")[1]} 月</span>
      </div>
      <div className="task-copy">
        <b>{task.indicator}</b>
        <span>
          {task.unit} · {task.reviewer}
        </span>
        <div className="task-progress">
          <i style={{ width: `${pct}%` }} />
        </div>
      </div>
      <span
        className={`status-pill ${status === "逾期補審" || status === "資料異常" ? "danger" : status === "待開始" ? "muted" : status === "已完成" ? "success" : "info"}`}
      >
        {status}
      </span>
      <button
        className="icon-button task-more"
        aria-label="開啟展示任務"
        onClick={() => onAction(`展示任務：${task.indicator}`)}
      >
        <MoreHorizontal size={17} />
      </button>
    </div>
  );
}
