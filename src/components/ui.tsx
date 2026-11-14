import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  Inbox,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const getFocusable = () => Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.getClientRects().length > 0);

    const frame = window.requestAnimationFrame(() => {
      (getFocusable()[0] ?? dialog).focus({ preventScroll: true });
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      const backdrops = document.querySelectorAll<HTMLElement>(
        ".reviewer-modal-backdrop",
      );
      const ownBackdrop = dialog.closest<HTMLElement>(
        ".reviewer-modal-backdrop",
      );
      if (!ownBackdrop || backdrops.item(backdrops.length - 1) !== ownBackdrop) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = getFocusable();
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      if (previousFocus?.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  return (
    <div
      className={`reviewer-modal-backdrop${layer > 1 ? ` reviewer-modal-layer-${layer}` : ""}`}
      onClick={onClose}
    >
      <div
        className={`reviewer-modal panel${wide ? " wide" : ""}${medium ? " medium" : ""}`}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
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

export function LoadingState({ label = "資料載入中…" }: { label?: string }) {
  return (
    <section className="async-state panel" role="status" aria-live="polite">
      <LoaderCircle className="async-state-spinner" size={22} aria-hidden="true" />
      <span>{label}</span>
    </section>
  );
}

export function ErrorState({
  title = "資料載入失敗",
  description,
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <section className="async-state async-state-error panel" role="alert">
      <AlertCircle size={22} aria-hidden="true" />
      <div className="async-state-copy">
        <b>{title}</b>
        {description && <p>{description}</p>}
      </div>
      {onRetry && (
        <button type="button" className="button button-outline" onClick={onRetry}>
          <RefreshCw size={15} aria-hidden="true" /> 重試
        </button>
      )}
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

/* ===== 統一頁面模板：篩選區塊 + 列表區塊（可排序） =====
 * 全站列表頁一律「篩選區塊 → 列表區塊」兩段式；樣式在 shared-components.css
 * 的 .filter-panel / .list-panel，隨主題 token 變化。 */

/** 篩選區塊：放篩選欄位與搜尋，actions 放「清除」等按鈕。 */
export function FilterPanel({
  title = "篩選條件",
  children,
  actions,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="panel filter-panel" aria-label={title}>
      <div className="filter-panel-head">
        <h2>{title}</h2>
        {actions && <div className="filter-panel-actions">{actions}</div>}
      </div>
      <div className="filter-panel-body">{children}</div>
    </section>
  );
}

/** 列表區塊：標題＋筆數＋工具列（新增／匯出等）＋可橫向捲動的表格。 */
export function ListPanel({
  title,
  count,
  actions,
  children,
}: {
  title: string;
  count?: number;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel data-panel list-panel" aria-label={title}>
      <div className="list-panel-head">
        <div>
          <h2>{title}</h2>
          {count !== undefined && (
            <span className="list-panel-count">共 {count} 筆</span>
          )}
        </div>
        {actions && <div className="list-panel-actions">{actions}</div>}
      </div>
      <div className="table-scroll">{children}</div>
    </section>
  );
}

export type SortDirection = "asc" | "desc";
export type SortState<K extends string> = { key: K; direction: SortDirection };
export type SortValue = string | number | boolean | null | undefined;

function compareSortValues(a: SortValue, b: SortValue): number {
  const aEmpty = a === null || a === undefined || a === "";
  const bEmpty = b === null || b === undefined || b === "";
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "zh-Hant", { numeric: true });
}

/**
 * 列表排序 hook。accessors 以欄位 key 對應取值函式；空值永遠排在最後，
 * 中文用 zh-Hant、數字字串用 numeric 比較。點同一欄位切換升／降冪。
 */
export function useTableSort<T, K extends string>(
  rows: readonly T[],
  accessors: Record<K, (row: T) => SortValue>,
  initial?: SortState<K>,
) {
  const [sort, setSort] = useState<SortState<K> | null>(initial ?? null);
  const toggleSort = useCallback((key: K) => {
    setSort((cur) =>
      cur && cur.key === key
        ? { key, direction: cur.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" },
    );
  }, []);
  // 資料量為單頁列表，每次 render 直接排序，accessor 依賴的外部資料（如姓名對照）
  // 載入後才會即時反映。
  const sortedRows = (() => {
    if (!sort) return [...rows];
    const get = accessors[sort.key];
    if (!get) return [...rows];
    const sign = sort.direction === "asc" ? 1 : -1;
    const isEmpty = (v: SortValue) => v === null || v === undefined || v === "";
    // 穩定排序：同值維持原順序；空值永遠排在最後，不受升降冪影響
    return rows
      .map((row, index) => ({ row, index, value: get(row) }))
      .sort((x, y) => {
        const xe = isEmpty(x.value);
        const ye = isEmpty(y.value);
        if (xe || ye) return xe === ye ? x.index - y.index : xe ? 1 : -1;
        const c = compareSortValues(x.value, y.value);
        return c !== 0 ? c * sign : x.index - y.index;
      })
      .map((x) => x.row);
  })();
  return { sortedRows, sort, toggleSort };
}

/** 可排序表頭；sort 為 useTableSort 回傳的狀態。 */
export function SortableTh<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: K;
  sort: SortState<K> | null;
  onSort: (key: K) => void;
  className?: string;
}) {
  const direction = sort && sort.key === sortKey ? sort.direction : null;
  const Icon = direction ? (direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <th
      className={className}
      aria-sort={direction ? (direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button type="button" className="th-sort" onClick={() => onSort(sortKey)}>
        {label}
        <Icon size={14} aria-hidden="true" />
      </button>
    </th>
  );
}
