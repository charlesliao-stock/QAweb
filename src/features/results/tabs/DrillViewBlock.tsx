import { DrillModal } from "../components/DrillModal";
import type { ResultsView } from "../hooks/useResultsAnalysis";

export function DrillViewBlock({ ctx }: { ctx: ResultsView }) {
  const { drill, setDrill, ensureHistory, ensureMonths, cellsOfInd, historyBusy, historyNote, recordIndex, indOf, unitNameOf, drillCapaSpans, hasTempReview, hideEmptyMonths, setHideEmptyMonths } = ctx;

  return <>{drill && !drill.pickMonths && (
        <DrillModal
          drill={drill}
          onClose={() => setDrill(null)}
          onBackToL1={() =>
            setDrill({
              ...drill,
              l2UnitId: null,
              l2Months: undefined,
              l2All: false,
              l2PersonEmpNo: undefined,
              sectionKey: undefined,
              questionId: undefined,
              optionLabel: undefined,
            })
          }
          onSelectUnit={(unitId, month) =>
            setDrill({ ...drill, l2UnitId: unitId, l2Months: month ? [month] : undefined })
          }
          onSelectPerson={(unitId, empNo, month) =>
            setDrill({ ...drill, l2UnitId: unitId, l2Months: [month], l2PersonEmpNo: empNo })
          }
          hideEmptyMonths={hideEmptyMonths}
          onToggleHideEmptyMonths={setHideEmptyMonths}
          onNeedHistory={ensureHistory}
          onNeedMonths={ensureMonths}
          summaryCellsFor={cellsOfInd}
          historyBusy={historyBusy}
          historyNote={historyNote}
          recordIndex={recordIndex}
          indOf={indOf}
          unitNameOf={unitNameOf}
          capaSpans={drillCapaSpans}
          tempReviewOf={(months, unitId) =>
            hasTempReview(
              drill.indicatorId,
              { key: "", label: "", months },
              unitId,
            )
          }
        />
      )}</>;
}
