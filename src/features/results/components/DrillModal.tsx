import type { DrillState, IndicatorOpt, CellValue } from "../model/types";
import { type SummaryCell as ArchiveCell, passRateFromCells } from "../../../lib/reviewSummary";
import { type RecordIndex, recordsForIndex } from "../../../lib/resultsMatrix";
import type { RowSpan } from "../../../lib/analysisSpans";
import { useEffect, useState, useMemo } from "react";
import type { CapaCase, CapaSettings } from "../../capa/model";
import { loadCapaCasesByIndicator, loadCapaSettings } from "../../capa/store";
import { fmtYm, fmtYmd } from "../../../lib/ym";
import { resolveDrillSection, unitsForDrill, sectionUnitPassRateOf, sectionPassRateOf, passRateOf, type PassRate, personOptionRows, transposePersonOptionRows } from "../../../lib/analysisRates";
import type { AuditQuestion } from "../../../lib/indicators";
import { type CapaTrigger, detectCapaTrigger } from "../../../lib/capaTrigger";
import { mergeNoteParts } from "../../../lib/import";
import { X, ChevronLeft } from "lucide-react";
import { RateCellBody } from "./small";
import { capaInColumn, fmtRate } from "../model/format";
import { EmptyState, SectionTitle } from "../../../components/ui";

export function DrillModal({
  drill,
  onClose,
  onBackToL1,
  onSelectUnit,
  onNeedHistory,
  onNeedMonths,
  summaryCellsFor,
  historyBusy,
  historyNote,
  recordIndex,
  indOf,
  unitNameOf,
  capaSpans,
  tempReviewOf,
}: {
  drill: DrillState;
  onClose: () => void;
  onBackToL1: () => void;
  onSelectUnit: (unitId: string, month?: { year: number; month: number }) => void;
  onNeedHistory: (indicatorId: string, beforeKey: number, n: number) => Promise<void>;
  onNeedMonths: (indicatorId: string, months: { year: number; month: number }[]) => Promise<void>;
  summaryCellsFor: (indicatorId: string, months: { year: number; month: number }[], unitId?: string) => ArchiveCell[] | null;
  historyBusy: boolean;
  historyNote: string;
  recordIndex: RecordIndex;
  indOf: Map<string, IndicatorOpt>;
  unitNameOf: Map<string, string>;
  /** v1.88.19：該（月份、單位）有加審紀錄時回 true，成績旁標「加審」 */
  tempReviewOf?: (months: { year: number; month: number }[], unitId?: string) => boolean;
  /** CAPA 偵測用 spans（v1.88.18：一個排程區間算一次審查，加審月份已歸併原區間不切出；由舊到新）：連續未達標偵測只用已載入的 spans，不另外讀取 */
  capaSpans: RowSpan[];
}) {
  const ind = indOf.get(drill.indicatorId);
  const th = ind?.threshold ?? 0;
  const col = drill.column;
  // v1.73.0：L2 的期間月份——點歷史月份格子時只看該月，否則為選定的期間欄
  const l2Months = drill.l2Months ?? col.months;
  const l2Needs = drill.l2UnitId != null || drill.l2All === true;
  // 只有「再下探」（L2）或 L1 無摘要可用時，才補讀原始紀錄
  useEffect(() => {
    if (l2Needs) void onNeedMonths(drill.indicatorId, l2Months);
  }, [l2Needs, drill.indicatorId, l2Months, onNeedMonths]);
  const [showRecentResults, setShowRecentResults] = useState(false);
  const [recentResultCount, setRecentResultCount] = useState(3);
  // CAPA：該指標的案件（一次）與觸發規則設定（一次），僅 L1 單位列表使用
  const [capaCases, setCapaCases] = useState<CapaCase[] | null>(null);
  const [capaSettings, setCapaSettings] = useState<CapaSettings | null>(null);
  useEffect(() => {
    if (drill.l2UnitId != null || drill.l2All === true) return;
    let alive = true;
    loadCapaCasesByIndicator(drill.indicatorId)
      .then((rows) => { if (alive) setCapaCases(rows); })
      .catch(() => { if (alive) setCapaCases([]); });
    loadCapaSettings()
      .then((v) => { if (alive) setCapaSettings(v); })
      .catch(() => { if (alive) setCapaSettings(null); });
    return () => { alive = false; };
  }, [drill.indicatorId, drill.l2UnitId, drill.l2All]);
  const currentStartKey = useMemo(
    () => Math.min(...col.months.map(({ year, month }) => year * 100 + month)),
    [col.months],
  );
  // 勾選「顯示近 N 次」時，自動補讀尚未載入的歷史月份（見 ensureHistory）
  useEffect(() => {
    if (!showRecentResults) return;
    void onNeedHistory(drill.indicatorId, currentStartKey, recentResultCount);
  }, [showRecentResults, drill.indicatorId, currentStartKey, recentResultCount, onNeedHistory]);
  // 歷史月份：選定期間之前、有資料的前 N 個月，由舊到新排列（選定月在最右）
  const historyMonths = useMemo(() => {
    const byMonth = recordIndex.get(drill.indicatorId);
    if (!byMonth) return [] as { year: number; month: number; key: number; label: string }[];
    const currentStart = currentStartKey;
    return [...byMonth.keys()]
      .filter((key) => key < currentStart && (byMonth.get(key)?.length ?? 0) > 0)
      .sort((a, b) => b - a)
      .slice(0, recentResultCount)
      .reverse()
      .map((key) => {
        const year = Math.floor(key / 100);
        const month = key % 100;
        return { year, month, key, label: fmtYm(year, month) };
      });
  }, [recordIndex, drill.indicatorId, currentStartKey, recentResultCount]);
  // v1.50.0：分組／逐題／選項篩選——只顯示該分組／該題的個人結果
  const section = useMemo(() => {
    if (!drill.sectionKey || !ind) return null;
    const scopeRecs = recordsForIndex(
      recordIndex,
      drill.indicatorId,
      [...col.months, ...(drill.l2Months ?? [])],
      drill.scopeUnitId,
    );
    return resolveDrillSection(ind.questions, drill.sectionKey, scopeRecs);
  }, [recordIndex, drill.indicatorId, drill.sectionKey, drill.scopeUnitId, drill.l2Months, col, ind]);
  const filterIds = useMemo(() => {
    if (section) return section.ids;
    if (drill.questionId) return [drill.questionId];
    return null;
  }, [section, drill.questionId]);
  const filterKind = section?.kind ?? (drill.questionId ? "question" : null);
  const filterLabel = useMemo(() => {
    if (!ind) return "";
    if (drill.optionLabel && drill.questionId) {
      const q = ind.questions.find((x) => x.id === drill.questionId);
      return `${q ? q.itemText : "題目"}・答「${drill.optionLabel}」的人員`;
    }
    if (section) {
      if (section.kind === "group") {
        const gq = ind.questions.find((q) => section.ids.includes(q.id));
        return gq?.groupId ? gq.groupName || "未命名分組" : "未分組項目";
      }
      const q = ind.questions.find((x) => x.id === section.ids[0]);
      return q?.itemText ?? "歷史題目";
    }
    if (drill.questionId) {
      const q = ind.questions.find((x) => x.id === drill.questionId);
      return q?.itemText ?? "題目";
    }
    return "";
  }, [ind, section, drill.optionLabel, drill.questionId]);
  // L2 顯示的題目：篩選時只列該分組／該題；歷史題目以作答中的題目文字補齊
  const l2Questions = useMemo(() => {
    if (!ind) return [] as AuditQuestion[];
    if (!filterIds) return ind.questions;
    const known = new Map(ind.questions.map((q) => [q.id, q]));
    const scopeRecs = recordsForIndex(
      recordIndex,
      drill.indicatorId,
      l2Months,
      drill.scopeUnitId,
    );
    const list: AuditQuestion[] = [];
    for (const id of filterIds) {
      const q = known.get(id);
      if (q) {
        list.push(q);
        continue;
      }
      const ans = scopeRecs
        .flatMap((r) => r.answers)
        .find((a) => a.questionId === id);
      list.push({
        id,
        itemText: ans?.itemText ?? "歷史題目",
        optionSet: "yes-no-na",
        guidance: "",
        commonErrors: [],
        groupId: null,
        groupName: "",
        order: list.length,
      });
    }
    return list;
  }, [ind, filterIds, recordIndex, drill.indicatorId, drill.scopeUnitId, l2Months]);
  // L1：指標有封存摘要且未做分組／逐題篩選時，直接用摘要格（單位×月份）——不讀原始紀錄。
  // 有篩選（分組／逐題）或指標無摘要時，才用原始紀錄。
  const l1Summary = useMemo(
    () => (filterIds ? null : summaryCellsFor(drill.indicatorId, col.months, drill.scopeUnitId)),
    [filterIds, summaryCellsFor, drill.indicatorId, col.months, drill.scopeUnitId],
  );
  // 分組／逐題篩選下探 L1 摘要不足，才補讀原始紀錄（指標無摘要時原始紀錄本就已載入，no-op）
  useEffect(() => {
    if (filterIds) void onNeedMonths(drill.indicatorId, col.months);
  }, [filterIds, drill.indicatorId, col.months, onNeedMonths]);
  const l1Units = useMemo(() => {
    if (l1Summary) {
      const ids = new Set(l1Summary.filter((c) => c.total > 0).map((c) => c.unitId));
      return [...ids].sort((a, b) => a.localeCompare(b, "zh-Hant"));
    }
    const recs = recordsForIndex(recordIndex, drill.indicatorId, col.months, drill.scopeUnitId);
    return unitsForDrill(recs, col.months);
  }, [l1Summary, recordIndex, drill.indicatorId, drill.scopeUnitId, col]);
  const l1Cells = useMemo(() => {
    const map = new Map<string, CellValue>();
    for (const unitId of l1Units) {
      const pr = l1Summary
        ? passRateFromCells(l1Summary.filter((c) => c.unitId === unitId))
        : (() => {
            const recs = recordsForIndex(recordIndex, drill.indicatorId, col.months, unitId);
            return filterIds && filterKind
              ? drill.mode === "unit"
                ? sectionUnitPassRateOf(recs, filterIds, th)
                : sectionPassRateOf(recs, filterIds, filterKind, th)
              : passRateOf(recs, th);
          })();
      map.set(unitId, {
        ...pr,
        title: pr.total === 0 ? "無資料" : `達閾值 ${pr.pass}／${pr.total} 人次`,
      });
    }
    return map;
  }, [recordIndex, drill.indicatorId, drill.mode, l1Units, l1Summary, col, th, filterIds, filterKind]);
  // v1.88.19：L1「審查月份」欄已移除（B：單月多月都不要；多月單月下探改走
  // 矩陣成績格 → 選月彈窗，v1.88.17 Q5=C 路徑）。
  // 連續未達標偵測（v1.88.18）：一個排程區間（span）算一次審查，不按月算；
  // 不論區間或單月，連續 need 次未達標就觸發；沒有審查資料的期不列入；
  // 期數取 CAPA 設定（指標覆寫優先，否則全院預設，預設 2）。選定期本身須有資料且為最新一期。
  const capaTriggers = useMemo(() => {
    const map = new Map<string, CapaTrigger>();
    if (!capaSettings?.triggerEnabled || th <= 0 || filterIds) return map;
    const need = Math.max(1, capaSettings.indicatorOverrides[drill.indicatorId] ?? capaSettings.defaultTriggerPeriods);
    const rateOf = (months: { year: number; month: number }[], unitId: string): PassRate => {
      const cells = summaryCellsFor(drill.indicatorId, months, unitId);
      if (cells) return passRateFromCells(cells.filter((c) => c.unitId === unitId));
      return passRateOf(recordsForIndex(recordIndex, drill.indicatorId, months, unitId), th);
    };
    for (const unitId of l1Units) {
      const trig = detectCapaTrigger(
        capaSpans,
        (months) => rateOf(months, unitId),
        (m) => rateOf([m], unitId).total > 0,
        col.months,
        need,
        th,
      );
      if (trig) map.set(unitId, trig);
    }
    return map;
  }, [capaSettings, th, filterIds, drill.indicatorId, capaSpans, col, l1Units, summaryCellsFor, recordIndex]);
  const startCapa = (unitId: string) => {
    const trig = capaTriggers.get(unitId);
    if (!trig) return;
    const fmt = (r: number) => (Number.isInteger(r) ? String(r) : r.toFixed(1));
    const lastItem = trig.series[trig.series.length - 1];
    window.dispatchEvent(new CustomEvent("capa:open", { detail: {
      indicatorId: drill.indicatorId,
      indicatorCode: ind?.code ?? "",
      indicatorName: ind?.name ?? "",
      threshold: th,
      period: lastItem.ym,
      periodKeys: trig.series.map((x) => x.ym),
      unitCode: unitId,
      unitName: unitNameOf.get(unitId) ?? "",
      rate: lastItem.rate,
      summary: `${trig.series.map((x) => `${x.label} ${fmt(x.rate)}%`).join("、")}，連續${trig.need}次審查皆未達閾值`,
      snapshots: trig.series.map((x) => ({ period: x.ym.replace("-", "/").replace(/\/(\d)$/, "/0$1"), rate: x.rate })),
    } }));
  };
  // L2 列：該單位該期間被審人員在各選項的審查結果（l2All 時為全部單位）
  const l2Active = drill.l2UnitId != null || drill.l2All === true;
  const l2Rows = useMemo(() => {
    if (!l2Active) return [];
    const recs = recordsForIndex(
      recordIndex,
      drill.indicatorId,
      l2Months,
      drill.l2UnitId ?? drill.scopeUnitId,
    );
    const rows = personOptionRows(recs, th);
    // 選項篩選：只顯示答此選項的人員
    if (drill.optionLabel && drill.questionId) {
      return rows.filter(
        (row) => row.answers.get(drill.questionId as string) === drill.optionLabel,
      );
    }
    return rows;
  }, [recordIndex, drill.indicatorId, drill.l2UnitId, drill.scopeUnitId, l2Months, th, l2Active, drill.optionLabel, drill.questionId]);
  // L2 轉置（v1.27.1）：直向＝題目、橫向＝人員（職編/遮罩姓名，v1.40.2），中間＝審查結果
  const l2Matrix = useMemo(
    () =>
      ind
        ? transposePersonOptionRows(l2Rows, l2Questions)
        : { headers: [] as string[], bedNos: [] as string[], months: [] as string[], reviewDates: [] as string[], rows: [], rates: [] },
    [l2Rows, ind, l2Questions],
  );

  // L2 補充說明（v1.43.0）：每欄＝一筆紀錄，每筆彙整為一則（單則為備註
  // 原文、多則每則附題號），顯示於矩陣下方。
  const l2NoteGroups = useMemo(() => {
    if ((!drill.l2UnitId && !drill.l2All) || !ind) return [];
    return l2Rows
      .map((row, i) => {
        const text = mergeNoteParts(
          l2Questions.map((q, qi) => ({
            questionNo: qi + 1,
            note: row.notes.get(q.id) ?? "",
          })),
        );
        if (!text) return null;
        return {
          key: `${row.personEmpNo}-${row.year}-${row.month}-${i}`,
          label: l2Matrix.headers[i] ?? row.personEmpNo,
          monthLabel: fmtYm(row.year, row.month),
          reviewDate: fmtYmd(row.reviewDate ?? ""),
          bedNo: row.bedNo,
          text,
        };
      })
      .filter((g): g is NonNullable<typeof g> => g != null);
  }, [l2Rows, ind, drill.l2UnitId, drill.l2All, l2Matrix, l2Questions]);

  if (!ind) return null;
  const title = `${ind.code}・${ind.name}`;
  const l2UnitLabel = drill.l2UnitId
    ? `${drill.l2UnitId}・${unitNameOf.get(drill.l2UnitId) ?? ""}`
    : drill.scopeUnitId
      ? `${drill.scopeUnitId}・${unitNameOf.get(drill.scopeUnitId) ?? ""}`
      : "全部單位";
  return (
    <div
      className="reviewer-modal-backdrop"
      onClick={onClose}
    >
      <div
        className="reviewer-modal wide panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="reviewer-modal-head">
          <div>
            <h2>{title}</h2>
            <p>
              {l2Active
                ? `${drill.l2Months?.length === 1 ? fmtYm(drill.l2Months[0].year, drill.l2Months[0].month) : col.label}・${l2UnitLabel}・被審人員各選項結果${filterLabel ? `・${filterLabel}` : ""}`
                : `${col.label}・各單位審查結果（點選格子看被審人員）${filterLabel ? `・${filterLabel}` : ""}`}
            </p>
          </div>
          <button
            className="button button-ghost"
            onClick={onClose}
            aria-label="關閉"
          >
            <X size={16} />
          </button>
        </div>
        {!l2Active ? (
          <>
          <div className="drill-history-controls">
            <label className="check-row">
              <input type="checkbox" checked={showRecentResults} onChange={(event) => setShowRecentResults(event.target.checked)} />
              顯示近
              <select aria-label="顯示近幾次審查結果" value={recentResultCount} onChange={(event) => setRecentResultCount(Number(event.target.value))}>
                {Array.from({ length: 12 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}</option>)}
              </select>
              次的審查結果
            </label>
            {showRecentResults && (
              <span className="muted-text">
                {historyBusy ? "補讀歷史月份中…" : historyNote || "由舊到新排列，選定月份在最右；點格子可看該月被審人員。"}
              </span>
            )}
          </div>
          <div className="analysis-table-wrap">
            <table className="data-table analysis-matrix">
              <thead>
                <tr>
                  <th className="ind-col">單位</th>
                  {showRecentResults && historyMonths.map((month) => <th key={month.key} className="rate-col">{month.label}</th>)}
                  <th className="rate-col" style={showRecentResults ? { background: "#eef4ff" } : undefined}>{col.label}</th>
                  <th className="rate-col">操作</th>
                </tr>
              </thead>
              <tbody>
                {l1Units.length === 0 ? (
                  <tr>
                    <td colSpan={3 + (showRecentResults ? historyMonths.length : 0)}>{historyBusy ? "讀取中…" : historyNote || "無資料"}</td>
                  </tr>
                ) : (
                  l1Units.map((unitId) => {
                    const cell = l1Cells.get(unitId);
                    const clickable = cell != null && cell.rate != null;
                    return (
                      <tr key={unitId}>
                        <td className="ind-col">
                          {unitId === "" ? "NA" : `${unitId}・${unitNameOf.get(unitId) ?? ""}`}
                        </td>
                        {showRecentResults && historyMonths.map((month) => {
                          const recs = recordsForIndex(recordIndex, drill.indicatorId, [{ year: month.year, month: month.month }], unitId);
                          // 與選定月相同的內容：套用同一分組／題目篩選與閾值
                          const hp = filterIds && filterKind
                            ? drill.mode === "unit"
                              ? sectionUnitPassRateOf(recs, filterIds, th)
                              : sectionPassRateOf(recs, filterIds, filterKind, th)
                            : passRateOf(recs, th);
                          const hCell: CellValue = { ...hp, title: hp.total === 0 ? "無資料" : `達閾值 ${hp.pass}／${hp.total} 人次` };
                          const hClickable = hp.rate != null;
                          const pick = () => onSelectUnit(unitId, { year: month.year, month: month.month });
                          return (
                            <td
                              key={month.key}
                              className={`rate-cell${hClickable ? " clickable" : ""}${hp.rate != null && th > 0 && hp.rate < th ? " below" : ""}`}
                              title={hClickable ? `${hCell.title}（點選看被審人員）` : hCell.title}
                              onClick={hClickable ? pick : undefined}
                              role={hClickable ? "button" : undefined}
                              tabIndex={hClickable ? 0 : undefined}
                              onKeyDown={hClickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } } : undefined}
                            >
                              {hp.total === 0 ? "—" : <RateCellBody cell={hCell} extra={tempReviewOf?.([{ year: month.year, month: month.month }], unitId) ?? false} />}
                            </td>
                          );
                        })}
                        <td
                          className={`rate-cell${clickable ? " clickable" : ""}${cell?.rate != null && th > 0 && cell.rate < th ? " below" : ""}`}
                          title={
                            clickable
                              ? `${cell.title}（點選看被審人員）`
                              : (cell?.title ?? "無資料")
                          }
                          onClick={
                            clickable ? () => onSelectUnit(unitId) : undefined
                          }
                          role={clickable ? "button" : undefined}
                          tabIndex={clickable ? 0 : undefined}
                          onKeyDown={
                            clickable
                              ? (e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    onSelectUnit(unitId);
                                  }
                                }
                              : undefined
                          }
                        >
                          {cell ? (
                            <RateCellBody
                              cell={cell}
                              extra={tempReviewOf?.(col.months, unitId) ?? false}
                              capa={(capaCases ?? []).find((c) => c.unitCode === unitId && c.stage !== "已撤案" && capaInColumn(c, col.months))}
                            />
                          ) : "—"}
                        </td>
                        <td className="rate-cell">
                          {(() => {
                            if (!capaTriggers.has(unitId) || capaCases == null) return null;
                            const open = capaCases.some((c) => c.unitCode === unitId && c.stage !== "正式結案" && c.stage !== "已撤案");
                            return open ? (
                              <span className="muted-text">CAPA 進行中</span>
                            ) : (
                              <button type="button" className="text-button capa-start-link" onClick={() => startCapa(unitId)}>
                                啟動CAPA
                              </button>
                            );
                          })()}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          </>
        ) : (
          <>
            <div className="drill-back">
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={onBackToL1}
              >
                <ChevronLeft size={15} /> 返回單位列表
              </button>
            </div>
            {l2Rows.length === 0 ? (
              <EmptyState title={historyBusy ? "讀取原始紀錄中…" : "無資料"} description={historyBusy ? "正在讀取該單位被審人員的原始紀錄。" : historyNote || "該單位該期間尚無審查紀錄。"} />
            ) : (
              <>
                <div className="analysis-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>題目</th>
                      {l2Matrix.headers.map((h, i) => (
                        <th
                          key={`${l2Rows[i].personEmpNo}-${l2Rows[i].year}-${l2Rows[i].month}-${i}`}
                        >
                          <div>{h}</div>
                          <div>{l2Matrix.bedNos[i] ?? ""}</div>
                          <div>{l2Matrix.months[i] ?? ""}</div>
                          <div>審查日 {l2Matrix.reviewDates[i] ?? "—"}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {l2Matrix.rows.map((qr, qi) => (
                      <tr key={qr.questionId}>
                        <td>
                          {qi + 1}. {qr.itemText}
                        </td>
                        {qr.values.map((v, i) => (
                          <td
                            key={i}
                            className={v.trim() === "否" ? "drill-option-no" : undefined}
                          >
                            {v}
                          </td>
                        ))}
                      </tr>
                    ))}
                    <tr>
                      <td>正確率</td>
                      {l2Matrix.rates.map((r, i) => (
                        <td
                          key={i}
                          className={`drill-person-rate${r.rate != null && th > 0 && r.rate < th ? " below" : r.passing ? " pass" : ""}`}
                          title={r.passing ? "達閾值" : "未達閾值"}
                        >
                          {fmtRate(r.rate)}
                          {r.passing ? " ✓" : ""}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
              {l2NoteGroups.length > 0 && (
                <section className="supp-notes">
                  <SectionTitle
                    title="補充說明"
                    note="審查員備註未通過原因；每筆紀錄彙整為一則，只列有填寫備註的紀錄。"
                  />
                  {l2NoteGroups.map((g) => (
                    <div key={g.key} className="supp-notes-group">
                      <p className="supp-notes-person">
                        {g.label}・{g.monthLabel}・審查日 {g.reviewDate}
                        {g.bedNo ? `・床號 ${g.bedNo}` : ""}
                      </p>
                      <p className="supp-note-text">{g.text}</p>
                    </div>
                  ))}
                </section>
              )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
