import type { ReactNode } from "react";
import { Check, Inbox, X } from "lucide-react";
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
      title: "品管審查排程",
      description: "設定指標審查排程（年度／學年度／臨時）、分工表並產生審查任務",
    },
    audit: {
      title: "品管審查",
      description: "依權限列出進行中的審查排程，追蹤審核進度並執行品管審查",
    },
    results: {
      title: "結果分析",
      description: "追蹤各項品質指標的趨勢與達標狀況",
    },
    groups: {
      title: "人員管理",
      description: "群組、單位、職稱與人員主檔維護（含批次上傳）",
    },
    handoff: {
      title: "任務交接",
      description: "將原審查員尚未完成的品管審查任務交接給新審查員",
    },
    capa: {
      title: "CAPA 改善追蹤",
      description: "追蹤改善措施、成效驗證與結案",
    },
    admin: { title: "系統管理", description: "角色權限與系統參數展示設定" },
    permissions: {
      title: "權限管理",
      description: "依群組角色與單位職稱設定頁面及功能權限",
    },
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

/**
 * v1.57.0 A4：共用彈窗（沿用 reviewer-modal backdrop＋panel 樣式；點空白關閉，
 * 右上有關閉鈕）。關閉不儲存，表單的取消／儲存流程維持原樣。
 */
export function Modal({
  title,
  note,
  onClose,
  wide = false,
  medium = false,
  layer = 1,
  children,
}: {
  title: string;
  note?: string;
  onClose: () => void;
  wide?: boolean;
  /** v1.60.0：中寬（約 960px），加審對話框用 */
  medium?: boolean;
  /** v1.60.0：巢狀彈窗層級（2＝第二層，backdrop 用 layer-2 樣式） */
  layer?: 1 | 2 | 3;
  children: ReactNode;
}) {
  return (
    <div
      className={`reviewer-modal-backdrop${layer > 1 ? ` reviewer-modal-layer-${layer}` : ""}`}
      onClick={onClose}
    >
      <div
        className={`reviewer-modal panel${wide ? " wide" : ""}${medium ? " medium" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="reviewer-modal-head">
          <div>
            <h2>{title}</h2>
            {note && <p>{note}</p>}
          </div>
          <button
            type="button"
            className="button button-ghost"
            onClick={onClose}
            aria-label="關閉"
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
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
  onClick,
}: {
  label: string;
  value: string;
  note: string;
  /** v1.50.0：提供時可點選下探到個人審查結果 */
  onClick?: () => void;
}) {
  return (
    <div
      className={`summary-cell${onClick ? " clickable" : ""}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      title={onClick ? "點選下探到個人審查結果" : undefined}
    >
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}
