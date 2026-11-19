import { SpanMonthPicker } from "../components/small";
import { fmtYm } from "../../../lib/ym";
import type { ResultsView } from "../hooks/useResultsAnalysis";

export function DrillPickMonthsBlock({ ctx }: { ctx: ResultsView }) {
  const { drill, indOf, cellValue, hasTempReview, setDrill } = ctx;

  return <>{drill?.pickMonths && (
        <SpanMonthPicker
          title={`${indOf.get(drill.indicatorId)?.code ?? ""}・${indOf.get(drill.indicatorId)?.name ?? drill.indicatorId}`}
          subtitle={`${drill.column.label}・各月明細（點選月份看該月各單位審查結果）`}
          months={drill.column.months}
          cellOf={(m) =>
            cellValue(
              drill.indicatorId,
              { key: `${m.year}-${m.month}`, label: fmtYm(m.year, m.month), months: [m] },
              drill.scopeUnitId,
              drill.mode,
            )
          }
          extraOf={(m) =>
            hasTempReview(
              drill.indicatorId,
              { key: `${m.year}-${m.month}`, label: fmtYm(m.year, m.month), months: [m] },
              drill.scopeUnitId,
            )
          }
          onPick={(m) =>
            setDrill((d) =>
              d
                ? {
                    ...d,
                    column: {
                      key: `${m.year}-${m.month}`,
                      label: fmtYm(m.year, m.month),
                      months: [m],
                    },
                    pickMonths: false,
                  }
                : d,
            )
          }
          onClose={() => setDrill(null)}
        />
      )}</>;
}
