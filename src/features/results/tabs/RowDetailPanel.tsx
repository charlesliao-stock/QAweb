/**
 * v1.88.33 Q8：矩陣列點開的展開面板（組別／單位模式共用）。
 * 點指標列即在矩陣下方展開，同時呈現該指標曲線圖＋細項結果（各選項得分狀況）；
 * 取代組別模式的曲線／文件彈窗與單位模式的曲線／文件分開面板。
 * 指標模式維持直接展開，不走這裡。
 */
import { useEffect, useState } from "react";
import { TrendChart } from "../../../components/TrendChart";
import { UnitBelowPanel, OptionDetailTable } from "../components/small";
import { recordsForIndex } from "../../../lib/resultsMatrix";
import { optionDetailRows } from "../../../lib/analysisRates";
import { capaInColumn } from "../model/format";
import { loadCapaCasesByIndicator } from "../../capa/store";
import type { CapaCase } from "../../capa/model";
import type { ResultsView } from "../hooks/useResultsAnalysis";

export function RowDetailPanel({
  ctx,
  scope,
}: {
  ctx: ResultsView;
  scope: "group" | "unit";
}) {
  const {
    rowPanel,
    setRowPanel,
    indOf,
    rowSpansOf,
    spansForIndicator,
    visibleColumns,
    chartSeries,
    sectionChartSeries,
    sectionOptionRows,
    recordIndex,
    allMonths,
    periodDesc,
    groupUnit,
    unitUnit,
    selUnit,
    openDrill,
    perIndMode,
    summaryPlans,
    rawFull,
    setRawHint,
    setRawFull,
    loading,
    unitCapaCases,
  } = ctx;
  const panel = rowPanel?.scope === scope ? rowPanel : null;
  const indicatorId = panel?.indicatorId ?? "";
  // 組別模式的 CAPA 標記依指標一次查詢（單位模式沿用已載入的該單位案件）。
  const [indCases, setIndCases] = useState<CapaCase[]>([]);
  useEffect(() => {
    if (!panel || scope !== "group" || !indicatorId) {
      setIndCases([]);
      return;
    }
    let alive = true;
    loadCapaCasesByIndicator(indicatorId)
      .then((rows) => {
        if (alive) setIndCases(rows);
      })
      .catch(() => {
        if (alive) setIndCases([]);
      });
    return () => {
      alive = false;
    };
  }, [panel, scope, indicatorId]);
  if (!panel) return null;
  const ind = indOf.get(panel.indicatorId);
  if (!ind) return null;
  const mode = scope === "group" ? groupUnit : unitUnit;
  const unitId = panel.unitId;
  const unitLabel =
    scope === "unit"
      ? `單位：${selUnit}`
      : unitId
        ? `單位：${unitId}`
        : "全部單位";
  const panelSpans = panel.rowId ? rowSpansOf(panel.rowId) : [];
  const chartSpans =
    panelSpans.length > 0
      ? panelSpans
      : spansForIndicator(
          ind.id,
          visibleColumns.flatMap((c) => c.months),
          unitId,
        );
  const s = panel.sectionKey
    ? sectionChartSeries(ind.id, unitId, mode, panel.sectionKey, chartSpans)
    : chartSeries(ind.id, unitId, mode, chartSpans);
  const recs = recordsForIndex(recordIndex, ind.id, allMonths, unitId);
  const optionRows = panel.sectionKey
    ? sectionOptionRows(
        optionDetailRows(recs, ind.questions),
        ind.questions,
        panel.sectionKey,
        recs,
      )
    : optionDetailRows(recs, ind.questions);
  const capaCases =
    scope === "unit"
      ? unitCapaCases.filter((c) => c.indicatorId === ind.id)
      : indCases;
  const needsRaw = perIndMode && summaryPlans.has(ind.id) && !rawFull;
  const title = panel.sectionKey
    ? `${ind.code}・${ind.name}・${panel.sectionLabel} 曲線圖與細項結果`
    : `${ind.code}・${ind.name} 曲線圖與細項結果`;
  return (
    <UnitBelowPanel
      title={title}
      subtitle={`${periodDesc}・${unitLabel}・單元：${mode === "unit" ? "單位（達閾值單位數／總單位數）" : "人次（合併）"}${panel.sectionKey ? `・分組：${panel.sectionLabel}` : ""}`}
      onClose={() => setRowPanel(null)}
    >
      {s.values.length === 0 ? (
        <div className="chart-empty">尚無資料</div>
      ) : (
        <TrendChart
          values={s.values}
          labels={s.labels}
          tooltips={s.tips}
          notes={s.notes}
          threshold={ind.threshold > 0 ? ind.threshold : null}
          thresholds={s.thresholds}
          legend="達閾值率"
          capaMarks={s.cols.map((col) => {
            const hit = capaCases.find(
              (c) => c.stage !== "已撤案" && capaInColumn(c, col.months),
            );
            return hit
              ? { id: hit.id, label: hit.caseNumber, actions: hit.actions.map((a) => a.title) }
              : null;
          })}
          onCapaClick={(i) => {
            const hit = capaCases.find(
              (c) => c.stage !== "已撤案" && capaInColumn(c, s.cols[i].months),
            );
            if (hit)
              window.dispatchEvent(
                new CustomEvent("capa:open", { detail: { caseId: hit.id } }),
              );
          }}
          onPointClick={(i) =>
            openDrill(
              ind.id,
              s.cols[i],
              mode,
              unitId,
              panel.sectionKey ? { sectionKey: panel.sectionKey } : undefined,
            )
          }
        />
      )}
      {needsRaw ? (
        <p className="settings-note">
          已封存月份只保留彙總數字。
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setRawHint("已載入原始紀錄。");
              setRawFull(true);
            }}
          >
            載入原始紀錄
          </button>
          後可顯示各選項明細並下探。
        </p>
      ) : loading ? (
        <p className="settings-note">原始紀錄載入中…</p>
      ) : (
        <OptionDetailTable
          rows={optionRows}
          threshold={ind.threshold}
          onQuestionClick={(questionId) =>
            openDrill(ind.id, ctx.allPeriodColumn, mode, unitId, {
              questionId,
              l2All: true,
            })
          }
        />
      )}
    </UnitBelowPanel>
  );
}
