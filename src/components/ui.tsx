import type { ReactNode } from "react";
import { Check, ChevronRight, Inbox } from "lucide-react";
import type { PageId, Rag } from "../types";

export const PAGE_COPY: Record<PageId, { title: string; description: string }> =
  {
    dashboard: {
      title: "品質總覽",
      description: "本月指標進度與需要關注的單位",
    },
    indicators: {
      title: "指標管理",
      description: "管理指標版本、閾值與審核狀態",
    },
    schedule: {
      title: "指標排程",
      description: "設定指標年度審查月份、分工表並產生全年審查任務",
    },
    audit: {
      title: "指標審查",
      description: "依指標檢視各單位、各輪次的審查進度與紀錄",
    },
    results: {
      title: "結果分析",
      description: "追蹤各項品質指標的趨勢與達標狀況",
    },
    groups: {
      title: "人員管理",
      description: "群組、單位、職稱與人員主檔維護（含批次上傳）",
    },
    capa: {
      title: "CAPA 改善追蹤",
      description: "追蹤改善措施、成效驗證與結案",
    },
    admin: { title: "系統管理", description: "角色權限與系統參數展示設定" },
    reviewers: {
      title: "審查員管理",
      description: "檢視審查員名單、依組別篩選並授予審查員角色",
    },
  };

export function ragFor(value: number, threshold: number): Rag {
  if (value >= threshold) return "green";
  if (value >= threshold - 5) return "amber";
  return "red";
}

export function RagBadge({
  value,
  threshold,
  compact = false,
}: {
  value: number;
  threshold: number;
  compact?: boolean;
}) {
  const state = ragFor(value, threshold);
  const label =
    state === "green" ? "達標" : state === "amber" ? "接近閾值" : "未達標";
  return (
    <span className={`rag-badge rag-${state}${compact ? " compact" : ""}`}>
      <i />
      {compact ? label : `${label} · ${value}%`}
    </span>
  );
}

export function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark${small ? " small" : ""}`} aria-hidden="true">
      <Check size={small ? 16 : 19} strokeWidth={2.8} />
    </span>
  );
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <section className="panel">
      <div className="empty-state-block">
        <span className="empty-state-icon">
          <Inbox size={28} strokeWidth={1.6} />
        </span>
        <b>{title}</b>
        {description && <p>{description}</p>}
      </div>
    </section>
  );
}

export function PageHeading({
  page,
  action,
}: {
  page: PageId;
  action?: ReactNode;
}) {
  const copy = PAGE_COPY[page];
  return (
    <div className="page-heading">
      <div>
        <div className="breadcrumb">
          品質管理 <ChevronRight size={13} /> <span>{copy.title}</span>
        </div>
        <h1>{copy.title}</h1>
        <p>{copy.description}</p>
      </div>
      {action && <div className="heading-action">{action}</div>}
    </div>
  );
}

export function SectionTitle({
  title,
  note,
  action,
}: {
  title: string;
  note?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-title">
      <div>
        <h2>{title}</h2>
        {note && <span>{note}</span>}
      </div>
      {action}
    </div>
  );
}

export function SummaryCell({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="summary-cell">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}
