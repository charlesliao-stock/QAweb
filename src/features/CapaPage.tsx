import {
  ArrowRight,
  CalendarDays,
  CheckCheck,
  Filter,
  MoreHorizontal,
  Plus,
  Users,
} from "lucide-react";
import { DEMO_CAPA } from "../data/demo";
import { PageHeading, SummaryCell } from "../components/ui";
import type { CapaCase } from "../types";

export function CapaPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  return (
    <>
      <PageHeading
        page="capa"
        action={
          <button
            className="button button-primary"
            onClick={() => onAction("展示版不會建立或儲存 CAPA")}
          >
            <Plus size={16} />
            開立改善追蹤
          </button>
        }
      />
      <div className="capa-summary">
        <SummaryCell label="進行中改善" value="8" note="分布於 6 個示範單位" />
        <SummaryCell label="待結案驗證" value="3" note="需確認改善成效" />
        <SummaryCell label="逾期項目" value="1" note="需追蹤改善期限" />
        <SummaryCell label="本季結案率" value="78%" note="展示統計資料" />
      </div>
      <div className="capa-toolbar">
        <div className="tabs">
          <button className="tab active">
            全部 <span>12</span>
          </button>
          <button className="tab">
            改善中 <span>8</span>
          </button>
          <button className="tab">
            待驗證 <span>3</span>
          </button>
          <button className="tab">已結案</button>
        </div>
        <button
          className="button button-outline"
          onClick={() => onAction("CAPA 篩選條件為展示操作")}
        >
          <Filter size={15} />
          篩選
        </button>
      </div>
      <div className="capa-cards">
        {DEMO_CAPA.map((item) => (
          <CapaCard item={item} key={item.id} onAction={onAction} />
        ))}
      </div>
      <div className="dashboard-footnote">
        <CheckCheck size={14} /> CAPA
        為單位結果層級的事後追蹤；題項級即時改善行動則在審查過程中開立。改善完成後須經結案驗證才可結案。
      </div>
    </>
  );
}

function CapaCard({
  item,
  onAction,
}: {
  item: CapaCase;
  onAction: (message: string) => void;
}) {
  return (
    <article className="panel capa-card">
      <div className="capa-card-top">
        <span
          className={`status-pill ${item.status === "逾期" ? "danger" : item.status === "待驗證" ? "warning" : "info"}`}
        >
          {item.status}
        </span>
        <button
          className="icon-button"
          aria-label="CAPA 更多操作"
          onClick={() => onAction(`${item.id} 僅供展示`)}
        >
          <MoreHorizontal size={17} />
        </button>
      </div>
      <span className="capa-id">
        {item.id} <i>·</i> {item.unit}
      </span>
      <h3>{item.title}</h3>
      <div className="capa-progress-head">
        <span>改善進度</span>
        <b>{item.progress}%</b>
      </div>
      <div className="capa-progress">
        <i style={{ width: `${item.progress}%` }} />
      </div>
      <div className="capa-card-meta">
        <span>
          <Users size={14} />
          {item.owner}
        </span>
        <span>
          <CalendarDays size={14} />
          期限 {item.due}
        </span>
      </div>
      <div className="capa-stage">
        <span>目前關卡</span>
        <b>{item.stage}</b>
      </div>
      <button
        className="button button-outline full-width"
        onClick={() => onAction(`${item.id} 改善前後資料為假資料`)}
      >
        {item.status === "待驗證" ? "檢視結案驗證" : "檢視改善進度"}
        <ArrowRight size={15} />
      </button>
    </article>
  );
}
