import { useState, useRef, useEffect, type ReactNode, useMemo } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, TrendingUp, FileText, X } from "lucide-react";
import { pad2, fmtYm } from "../../../lib/ym";
import { type PassRate, formatPassRate, type AnalysisRecord, causeRecordEntries, type OptionDetailRow, type QuestionErrorRow } from "../../../lib/analysisRates";
import type { CapaCase } from "../../capa/model";
import { type RowSpan, singleMonthSpan } from "../../../lib/analysisSpans";
import type { AnalysisPeriodColumn } from "../../../lib/analysisPeriod";
import type { CellValue, IndicatorOpt } from "../model/types";
import { isBelow, fmtRate } from "../model/format";
import { EmptyState } from "../../../components/ui";
import { stripInternalIdPrefix } from "../../../lib/indicators";
import { staffLabel } from "../../../lib/mask";

export function ResultMonthPicker({
  label,
  value,
  onChange,
  ariaLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [displayYear, setDisplayYear] = useState(() => Number(value.slice(0, 4)));
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [year, month] = value.split("-").map(Number);
  const months = Array.from({ length: 12 }, (_, index) => index + 1);
  // 2026-11-19：下方空間不足時改往上開（手機橫放／矮螢幕、篩選器靠近頁面底部時），
  // 避免日曆下半被底部導覽或視窗下緣切掉；高度另以 CSS 上限＋內部捲動兜底。
  const [openAbove, setOpenAbove] = useState(false);
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const popoverHeight = 320;
      const below = window.innerHeight - rect.bottom;
      const above = rect.top;
      setOpenAbove(below < popoverHeight + 8 && above > below);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open ]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  return (
    <div className="results-month-field" ref={pickerRef}>
      <span>{label}</span>
      <span className="results-month-picker">
        <button
          type="button"
          className="results-month-trigger"
          ref={triggerRef}
          aria-label={ariaLabel}
          aria-expanded={open}
          onClick={() => {
            setDisplayYear(year || new Date().getFullYear());
            setOpen((current) => !current);
          }}
        >
          {year}年{month}月
          <ChevronDown size={15} />
        </button>
        {open && (
          <div className={`results-month-popover${openAbove ? " results-month-popover--above" : ""}`} role="dialog" aria-label={`${ariaLabel}選擇器`}>
            <span className="results-month-year">
              <button
                type="button"
                aria-label="前一年"
                onClick={() => setDisplayYear((current) => current - 1)}
              >
                <ChevronLeft size={17} />
              </button>
              <strong>{displayYear}年</strong>
              <button
                type="button"
                aria-label="下一年"
                onClick={() => setDisplayYear((current) => current + 1)}
              >
                <ChevronRight size={17} />
              </button>
            </span>
            <span className="results-month-grid">
              {months.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={year === displayYear && month === item ? "active" : ""}
                  onClick={() => {
                    onChange(`${displayYear}-${pad2(item)}`);
                    setOpen(false);
                  }}
                >
                  {item}月
                </button>
              ))}
            </span>
          </div>
        )}
      </span>
    </div>
  );
}

/**
 * 矩陣格內容（v1.76.5）：百分比在上、(分子/分母) 在下以縮減欄寬；
 * 加審字樣置於右側垂直置中。無紀錄顯示「—」（v1.88.18：未排程、無資料；
 * v1.88.17 曾改為另一文案，v1.88.18 改回 —）。
 */
export function RateCellBody({ cell, extra, capa }: { cell: PassRate; extra?: boolean; capa?: CapaCase }) {
  if (cell.rate == null) return <>—</>;
  const pct = Number.isInteger(cell.rate) ? String(cell.rate) : cell.rate.toFixed(1);
  return (
    <span className="rate-stack">
      <span className="rate-stack-main">
        <span className="rate-pct">{pct}%</span>
        <span className="rate-count">({cell.pass}/{cell.total})</span>
      </span>
      {extra ? <small className="extra-review-note rate-stack-extra">加審</small> : null}
      {capa ? (
        <button
          type="button"
          className="capa-mark"
          title={`本期已啟動 CAPA（${capa.caseNumber}），點選前往`}
          aria-label={`前往 CAPA 案件 ${capa.caseNumber}`}
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent("capa:open", { detail: { caseId: capa.id } }));
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          C
        </button>
      ) : null}
    </span>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string | number;
  onChange: (v: string) => void;
  options: { value: string | number; label: string }[];
}) {
  return (
    <label className="field-label">
      {label}
      <div className="select-wrap">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={String(o.value)} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown size={15} />
      </div>
    </label>
  );
}

/* ================= 達閾值率矩陣（組別／單位分析共用） ================= */

export function RateMatrix({
  rows,
  columns,
  cellOf,
  hasExtraReview,
  thresholdOf,
  capaMarkOf,
  onCell,
  onDetailCell,
  onChart,
  onDoc,
  onDetailChart,
  onDetailDoc,
}: {
  rows: {
    id: string;
    label: string;
    /**
     * v1.88.17：該列的合併格（表頭仍為單月欄；每列資料格按自己的排程區間
     * colspan 合併）。未傳時退回一月一格。
     */
    spans?: RowSpan[];
    details?: { key: string; label: string; cells: Record<string, PassRate> }[];
  }[];
  columns: AnalysisPeriodColumn[];
  cellOf: (rowId: string, col: AnalysisPeriodColumn) => CellValue;
  hasExtraReview?: (rowId: string, col: AnalysisPeriodColumn) => boolean;
  /** 單位分析：低於閾值顯示紅字 */
  thresholdOf?: (rowId: string) => number;
  /** 單位分析：該欄期間內有啟動 CAPA 時於結果旁顯示圓圈 C */
  capaMarkOf?: (rowId: string, col: AnalysisPeriodColumn) => CapaCase | undefined;
  onCell?: (rowId: string, col: AnalysisPeriodColumn) => void;
  /** v1.50.0：分組／逐題明細格可點下探（帶分組 key，只顯示該分組的個人結果） */
  onDetailCell?: (rowId: string, detailKey: string, col: AnalysisPeriodColumn) => void;
  onChart: (rowId: string) => void;
  onDoc: (rowId: string) => void;
  /** v1.53.0：分組子列曲線圖／文件圖示（點開看該組；同主列做法） */
  onDetailChart?: (rowId: string, detailKey: string, detailLabel: string) => void;
  onDetailDoc?: (rowId: string, detailKey: string, detailLabel: string) => void;
}) {
  return (
    <div className="analysis-table-wrap">
      <table className="data-table analysis-matrix">
        <thead>
          <tr>
            <th className="ind-col">指標</th>
            {columns.map((c) => (
              <th key={c.key} className="rate-col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.flatMap((row) => [
            <tr key={row.id}>
              <td className="ind-col">
                <div className="analysis-indicator-sticky">
                  <span className="analysis-indicator-name">{row.label}</span>
                  <span className="analysis-indicator-actions">
                    <button
                      type="button"
                      className="icon-button"
                      title="曲線圖"
                      aria-label={`${row.label} 曲線圖`}
                      onClick={() => onChart(row.id)}
                    >
                      <TrendingUp size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      title="各選項得分狀況"
                      aria-label={`${row.label} 各選項得分狀況`}
                      onClick={() => onDoc(row.id)}
                    >
                      <FileText size={16} />
                    </button>
                  </span>
                </div>
              </td>
              {(() => {
                // v1.88.17：每列用自己的 spans 渲染（合併格 colSpan）；未傳 spans 時一月一格。
                const spans = row.spans ?? columns.map((c) => singleMonthSpan(c.months[0]));
                return spans.map((span) => {
                  const cell = cellOf(row.id, span);
                  const clickable = cell.rate != null && onCell != null;
                  return (
                    <td
                      key={span.key}
                      colSpan={span.months.length}
                      className={`rate-cell${clickable ? " clickable" : ""}${isBelow(cell.rate, thresholdOf?.(row.id))}`}
                      title={clickable ? `${cell.title}（點選下探）` : cell.title}
                      onClick={
                        clickable ? () => onCell(row.id, span) : undefined
                      }
                      role={clickable ? "button" : undefined}
                      tabIndex={clickable ? 0 : undefined}
                      onKeyDown={
                        clickable
                          ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                onCell(row.id, span);
                              }
                            }
                          : undefined
                      }
                    >
                      <RateCellBody cell={cell} extra={!!hasExtraReview?.(row.id, span)} capa={capaMarkOf?.(row.id, span)} />
                    </td>
                  );
                });
              })()}
            </tr>,
            ...(row.details ?? []).map((detail) => (
              <tr key={`${row.id}-detail-${detail.key}`} className="analysis-matrix-detail-row">
                <td className="ind-col">
                  <div className="analysis-matrix-subrow">
                    <span>{detail.label}</span>
                    <span className="analysis-indicator-actions">
                      <button
                        type="button"
                        className="icon-button"
                        title="曲線圖"
                        aria-label={`${detail.label} 曲線圖`}
                        onClick={() => onDetailChart?.(row.id, detail.key, detail.label)}
                      >
                        <TrendingUp size={16} />
                      </button>
                      {/* v1.53.0：歷史分組無現行題目，選項明細為空列，故不顯示文件圖示 */}
                      {!detail.key.startsWith("historical-") && (
                        <button
                          type="button"
                          className="icon-button"
                          title="各選項得分狀況"
                          aria-label={`${detail.label} 各選項得分狀況`}
                          onClick={() => onDetailDoc?.(row.id, detail.key, detail.label)}
                        >
                          <FileText size={16} />
                        </button>
                      )}
                    </span>
                  </div>
                </td>
                {(() => {
                  // v1.88.17：明細列與主列用同一組 spans 合併（否則欄位錯位）。
                  const spans = row.spans ?? columns.map((c) => singleMonthSpan(c.months[0]));
                  return spans.map((span) => {
                    const detailCell = detail.cells[span.key] ?? { pass: 0, total: 0, rate: null };
                    const detailClickable = detailCell.rate != null && onDetailCell != null;
                    return (
                      <td
                        key={span.key}
                        colSpan={span.months.length}
                        className={`rate-cell${detailClickable ? " clickable" : ""}${isBelow(detailCell.rate, thresholdOf?.(row.id))}`}
                        title={detailClickable ? `${formatPassRate(detailCell)}（點選下探到個人審查結果）` : formatPassRate(detailCell)}
                        onClick={
                          detailClickable ? () => onDetailCell(row.id, detail.key, span) : undefined
                        }
                        role={detailClickable ? "button" : undefined}
                        tabIndex={detailClickable ? 0 : undefined}
                        onKeyDown={
                          detailClickable
                            ? (e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  onDetailCell(row.id, detail.key, span);
                                }
                              }
                            : undefined
                        }
                      >
                        <RateCellBody cell={detailCell} extra={!!hasExtraReview?.(row.id, span)} />
                      </td>
                    );
                  });
                })()}
              </tr>
            )),
          ])}
        </tbody>
      </table>
    </div>
  );
}

/* ================= 單位分析矩陣下方展開面板 ================= */

export function UnitBelowPanel({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="analysis-below-panel">
      <div className="analysis-below-head">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
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
  );
}

/* ================= 下探：合併格先展開區間內各月（v1.88.17 Q5=C） ================= */

/** 點多月合併格時的中間層：列出區間內各月達閾值率，點有資料的月份進入 L1。 */
export function SpanMonthPicker({
  title,
  subtitle,
  months,
  cellOf,
  extraOf,
  onPick,
  onClose,
}: {
  title: string;
  subtitle: string;
  months: { year: number; month: number }[];
  cellOf: (month: { year: number; month: number }) => CellValue;
  /** v1.88.19：該月有加審紀錄時在成績旁標「加審」 */
  extraOf?: (month: { year: number; month: number }) => boolean;
  onPick: (month: { year: number; month: number }) => void;
  onClose: () => void;
}) {
  return (
    <div className="reviewer-modal-backdrop" onClick={onClose}>
      <div
        className="reviewer-modal panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="reviewer-modal-head">
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button
            className="button button-ghost"
            onClick={onClose}
            aria-label="關閉"
          >
            <X size={16} />
          </button>
        </div>
        <div className="analysis-table-wrap">
          <table className="data-table analysis-matrix">
            <thead>
              <tr>
                <th className="ind-col">審查月份</th>
                <th className="rate-col">達閾值率</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => {
                const cell = cellOf(m);
                const clickable = cell.rate != null;
                return (
                  <tr key={`${m.year}-${m.month}`}>
                    <td className="ind-col">{fmtYm(m.year, m.month)}</td>
                    <td
                      className={`rate-cell${clickable ? " clickable" : ""}`}
                      title={clickable ? `${cell.title}（點選看該月各單位）` : cell.title}
                      onClick={clickable ? () => onPick(m) : undefined}
                      role={clickable ? "button" : undefined}
                      tabIndex={clickable ? 0 : undefined}
                      onKeyDown={
                        clickable
                          ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                onPick(m);
                              }
                            }
                          : undefined
                      }
                    >
                      <RateCellBody cell={cell} extra={extraOf?.(m) ?? false} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ================= 下探：L1 單位矩陣 → L2 人員各選項結果 ================= */

/** 原因詞庫下探彈窗（v1.50.0）：勾選指定原因詞庫項目的個人審查結果。 */
export function CauseDrillModal({
  cause,
  onClose,
  records,
  indOf,
  unitNameOf,
}: {
  cause: string;
  onClose: () => void;
  records: AnalysisRecord[];
  indOf: Map<string, IndicatorOpt>;
  unitNameOf: Map<string, string>;
}) {
  const entries = useMemo(() => causeRecordEntries(records, cause), [records, cause]);
  return (
    <div className="reviewer-modal-backdrop" onClick={onClose}>
      <div
        className="reviewer-modal wide panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`原因：${cause}`}
      >
        <div className="reviewer-modal-head">
          <div>
            <h2>原因：{cause}</h2>
            <p>勾選該原因的個人審查結果（共 {entries.length} 筆作答）</p>
          </div>
          <button
            className="button button-ghost"
            onClick={onClose}
            aria-label="關閉"
          >
            <X size={16} />
          </button>
        </div>
        {entries.length === 0 ? (
          <EmptyState title="無資料" description="所選期間尚無勾選該原因的審查紀錄。" />
        ) : (
          <div className="analysis-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>指標</th>
                  <th>單位</th>
                  <th>年月</th>
                  <th>被審人員</th>
                  <th>題目</th>
                  <th>作答</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, i) => {
                  const ind = indOf.get(entry.record.indicatorId);
                  return (
                    <tr key={`${entry.record.personEmpNo}-${entry.record.year}-${entry.record.month}-${entry.questionId}-${i}`}>
                      <td>{ind ? `${stripInternalIdPrefix(ind.code)}・${ind.name}` : stripInternalIdPrefix(entry.record.indicatorId)}</td>
                      <td>{entry.record.unitId === "" ? "NA" : `${entry.record.unitId}・${unitNameOf.get(entry.record.unitId) ?? ""}`}</td>
                      <td>{fmtYm(entry.record.year, entry.record.month)}</td>
                      <td>{staffLabel(entry.record.personEmpNo, entry.record.personName)}</td>
                      <td>{entry.itemText}</td>
                      <td>{entry.optionLabel}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ================= 各選項得分狀況表（文件圖示／指標選項明細共用） ================= */

export function OptionDetailTable({
  rows,
  onQuestionClick,
  threshold,
}: {
  rows: OptionDetailRow[];
  /** v1.50.0：題目列可點下探到該題的個人審查結果 */
  onQuestionClick?: (questionId: string) => void;
  /**
   * v1.88.14：得分率未達閾值時該格顯示紅色，判紅用指標閾值。
   * 口徑提醒：得分率是題目層級聚合（是／（是＋否）），指標閾值原本是
   * 單筆紀錄 rate 的達標線，此處是借用同一數字；閾值 ≤0／缺值不標。
   */
  threshold?: number;
}) {
  if (rows.length === 0) {
    return <EmptyState title="無題目" description="該指標尚無審核表題目。" />;
  }
  const hasData = rows.some((r) => r.total > 0);
  const hasVersions = rows.some((row) => Boolean(row.indicatorVersion));
  const cell = (n: number, rate: number | null) =>
    `${n}（${rate == null ? "—" : `${rate.toFixed(1)}%`}）`;
  return (
    <>
      {!hasData && (
        <p className="settings-note" role="status">
          所選期間尚無審查紀錄。
        </p>
      )}
      <div className="analysis-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {hasVersions && <th>版本</th>}
              <th>題目</th>
              <th>是</th>
              <th>否</th>
              <th>不適用</th>
              <th>得分率</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const clickable = r.total > 0 && onQuestionClick != null;
              return (
                <tr
                  key={`${r.indicatorVersion ?? ""}-${r.questionId}-${i}`}
                  className={clickable ? "clickable" : undefined}
                  title={clickable ? "點選下探到該題的個人審查結果" : undefined}
                  onClick={clickable ? () => onQuestionClick(r.questionId) : undefined}
                >
                  {hasVersions && <td>{r.indicatorVersion}</td>}
                  <td>
                    {i + 1}. {r.itemText}
                  </td>
                  <td>{cell(r.yes, r.yesRate)}</td>
                  <td>{cell(r.no, r.noRate)}</td>
                  <td>{cell(r.na, r.naRate)}</td>
                  <td className={`rate-cell${isBelow(r.scoreRate, threshold)}`}>{fmtRate(r.scoreRate)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function QuestionErrorTable({
  rows,
  onQuestionClick,
}: {
  rows: QuestionErrorRow[];
  /** v1.50.0：錯題列可點下探到該題答「否」的個人審查結果 */
  onQuestionClick?: (questionId: string) => void;
}) {
  if (rows.length === 0) {
    return <EmptyState title="尚無錯題資料" description="所選期間與單位沒有可分析的題目作答。" />;
  }
  const errorTotal = rows.reduce((sum, row) => sum + row.no, 0);
  return (
    <>
      <p className="settings-note">
        所選期間共計 {errorTotal} 次「否」作答；排行依錯題次數由多至少。不同版本分列，舊資料未保存版本時標示「版本未記錄」。點選列下探到該題答「否」的個人審查結果。
      </p>
      <div className="analysis-table-wrap">
        <table className="data-table">
          <thead><tr><th>排名</th><th>版本</th><th>題目</th><th>錯題數（否）</th><th>有效作答數</th><th>錯誤率</th><th>不適用數</th></tr></thead>
          <tbody>{rows.map((row, index) => {
            const clickable = row.no > 0 && onQuestionClick != null;
            return (
              <tr
                key={`${row.indicatorVersion}-${row.questionId}-${row.itemText}`}
                className={clickable ? "clickable" : undefined}
                title={clickable ? "點選下探到該題答「否」的個人審查結果" : undefined}
                onClick={clickable ? () => onQuestionClick(row.questionId) : undefined}
              >
                <td>{index + 1}</td><td>{row.indicatorVersion}</td><td>{row.itemText}</td>
                <td>{row.no}</td><td>{row.validCount}</td>
                <td>{row.errorRate == null ? "—" : `${row.errorRate.toFixed(1)}%`}</td>
                <td>{row.notApplicable}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    </>
  );
}
