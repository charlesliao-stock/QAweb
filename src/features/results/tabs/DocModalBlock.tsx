import { X } from "lucide-react";
import { OptionDetailTable } from "../components/small";
import type { ResultsView } from "../hooks/useResultsAnalysis";

export function DocModalBlock({ ctx }: { ctx: ResultsView }) {
  const { docModal, setDocModal, indOf, openDrill, allPeriodColumn } = ctx;

  return <>{docModal && (
        <div
          className="reviewer-modal-backdrop"
          onClick={() => setDocModal(null)}
        >
          <div
            className="reviewer-modal wide panel"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={docModal.title}
          >
            <div className="reviewer-modal-head">
              <div>
                <h2>{docModal.title}</h2>
                <p>{docModal.subtitle}</p>
              </div>
              <button
                className="button button-ghost"
                onClick={() => setDocModal(null)}
                aria-label="關閉"
              >
                <X size={16} />
              </button>
            </div>
            <OptionDetailTable
              rows={docModal.rows}
              threshold={indOf.get(docModal.indicatorId)?.threshold}
              onQuestionClick={(questionId) => {
                const dm = docModal;
                setDocModal(null);
                openDrill(dm.indicatorId, allPeriodColumn, dm.mode, dm.unitId, {
                  questionId,
                  l2All: true,
                });
              }}
            />
          </div>
        </div>
      )}</>;
}
