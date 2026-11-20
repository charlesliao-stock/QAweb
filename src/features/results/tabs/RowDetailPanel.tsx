/**
 * v1.88.33 Q8：矩陣列點開的展開面板（組別／單位模式共用），現只呈現曲線圖。
 * 點曲線圖示即在矩陣下方展開該指標曲線圖；細項結果改走文件圖示的彈窗，
 * 不再與曲線同現於此面板。指標模式維持直接展開，不走這裡。
 */
import { useEffect, useState } from "react";
import { TrendChart } from "../../../components/TrendChart";
import { UnitBelowPanel } from "../components/small";
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
    periodDesc,
    groupUnit,
    unitUnit,
    selUnit,
    openDrill,
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
  const capaCases =
    scope === "unit"
      ? unitCapaCases.filter((c) => c.indicatorId === ind.id)
      : indCases;
  const title = panel.sectionKey
    ? `${ind.code}・${ind.name}・${panel.sectionLabel} 曲線圖`
    : `${ind.code}・${ind.name} 曲線圖`;
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
    </UnitBelowPanel>
  );
}
