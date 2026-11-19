import { X } from "lucide-react";
import { TrendChart } from "../../../components/TrendChart";
import { capaInColumn } from "../model/format";
import type { ResultsView } from "../hooks/useResultsAnalysis";

export function ChartModalBlock({ ctx }: { ctx: ResultsView }) {
  const { chartModal, setChartModal, chartModalCapaCases, openDrill } = ctx;

  return <>{chartModal && (
        <div
          className="reviewer-modal-backdrop"
          onClick={() => setChartModal(null)}
        >
          <div
            className="reviewer-modal wide panel"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={chartModal.title}
          >
            <div className="reviewer-modal-head">
              <div>
                <h2>{chartModal.title}</h2>
                <p>{chartModal.subtitle}</p>
              </div>
              <button
                className="button button-ghost"
                onClick={() => setChartModal(null)}
                aria-label="關閉"
              >
                <X size={16} />
              </button>
            </div>
            {chartModal.values.length === 0 ? (
              <div className="chart-empty">尚無資料</div>
            ) : (
              <TrendChart
                values={chartModal.values}
                labels={chartModal.labels}
                tooltips={chartModal.tips}
                notes={chartModal.notes}
                threshold={chartModal.threshold}
                thresholds={chartModal.thresholds}
                legend="達閾值率"
                capaMarks={chartModal.cols.map((col) => {
                  const hit = chartModalCapaCases.find((c) => c.stage !== "已撤案" && (!chartModal.unitId || c.unitCode === chartModal.unitId) && capaInColumn(c, col.months));
                  return hit ? { id: hit.id, label: hit.caseNumber, actions: hit.actions.map((a) => a.title) } : null;
                })}
                onCapaClick={(i) => {
                  const hit = chartModalCapaCases.find((c) => c.stage !== "已撤案" && (!chartModal.unitId || c.unitCode === chartModal.unitId) && capaInColumn(c, chartModal.cols[i].months));
                  if (hit) window.dispatchEvent(new CustomEvent("capa:open", { detail: { caseId: hit.id } }));
                }}
                onPointClick={(i) => {
                  const cm = chartModal;
                  setChartModal(null);
                  openDrill(cm.indicatorId, cm.cols[i], cm.mode, cm.unitId, cm.sectionKey
                    ? { sectionKey: cm.sectionKey }
                    : undefined);
                }}
              />
            )}
          </div>
        </div>
      )}</>;
}
