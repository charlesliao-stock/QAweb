import { useMemo } from "react";
import { recordsForIndex } from "../../../lib/resultsMatrix";
import { firstMonthLabel, type RowSpan } from "../../../lib/analysisSpans";
import { unitPeriodPassRateFromCells, passRateFromCells, cellsInMonths, unitPassRateFromCells, columnThresholdFromCells, unitScoringRowsFromCells, personScoringRowsFromCells, questionSummariesFromCells } from "../../../lib/reviewSummary";
import { columnTempNote } from "../../../lib/tempChartNote";
import { formatPassRate, optionDetailRows, unitPeriodPassRate, passRateOf, unitPassRate, recordsInMonths, type PassRate, columnThresholdOf, unitScoringBreakdownRows, personScoringBreakdownRows, questionErrorRowsFromSummaries, questionErrorRows, collectConsolidatedRecordNotes } from "../../../lib/analysisRates";
import type { ResultsCtx } from "./useResultsCtx";

export function useResultsAnalysis(prev: ResultsCtx) {
  const { selIndicator, selUnitI, recordIndex, allMonths, indOf, hybridByInd, spansForIndicator, visibleColumns, archiveCtx, appliedColumns, tempTaskIds, tempTaskKeys, drill, capaSpansForIndicator, indUnit, errorUnit, errorUnitCode } = prev;

  /** v1.88.33 Q3：指標模式選了單位時，摘要／曲線／細項皆只看該單位（"all"＝全部）。 */
  const indUnitCode = selUnitI === "all" ? undefined : selUnitI === "NA" ? "" : selUnitI;
  // 指標分析：所選期間內有使用該指標審查的人員、單位皆列入
  const indRecs = useMemo(() => {
    if (!selIndicator) return [];
    // A3：查表取該指標全部期間的紀錄。
    const recs = recordsForIndex(recordIndex, selIndicator, allMonths);
    return indUnitCode === undefined
      ? recs
      : recs.filter((r) => r.unitId === indUnitCode);
  }, [recordIndex, selIndicator, allMonths, indUnitCode]);
  const indSel = indOf.get(selIndicator);
  const hybridCellsRaw = (selIndicator ? hybridByInd.get(selIndicator) : undefined) ?? null;
  const hybridCells =
    hybridCellsRaw && indUnitCode !== undefined
      ? hybridCellsRaw.filter((c) => c.unitId === indUnitCode)
      : hybridCellsRaw;
  /** 指標分析頁籤該指標的合併格（曲線圖一點一格、unit-period 計分用；與矩陣列同 spans）。 */
  const indSpans = useMemo<RowSpan[]>(
    () =>
      selIndicator
        ? spansForIndicator(
            selIndicator,
            visibleColumns.flatMap((c) => c.months),
            undefined,
          )
        : [],
    // spansForIndicator 為當次 render 的閉包；deps 列其全部反應式輸入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      selIndicator,
      visibleColumns,
      archiveCtx,
      appliedColumns,
      recordIndex,
      tempTaskIds,
      tempTaskKeys,
      hybridByInd,
    ],
  );
  /** 下探 CAPA 偵測用 spans（v1.88.18）：一個區間算一次審查，加審歸併原區間。 */
  const drillCapaSpans = useMemo<RowSpan[]>(
    () =>
      drill
        ? capaSpansForIndicator(
            drill.indicatorId,
            visibleColumns.flatMap((c) => c.months),
          )
        : [],
    // capaSpansForIndicator 為當次 render 的閉包；deps 列其全部反應式輸入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      drill,
      visibleColumns,
      archiveCtx,
      appliedColumns,
      recordIndex,
      tempTaskIds,
      tempTaskKeys,
      hybridByInd,
    ],
  );
  const indSummary = useMemo(() => {
    if (!indSel) return null;
    const th = indSel.threshold;
    if (hybridCells) {
      const cells = hybridCells;
      const unitPr = unitPeriodPassRateFromCells(cells, indSpans, th);
      const merged = passRateFromCells(cells);
      const perColumn = indSpans.map((column) => {
        const cs = cellsInMonths(cells, column.months);
        return {
          column,
          cs,
          pr: indUnit === "unit" ? unitPassRateFromCells(cs, th) : passRateFromCells(cs),
        };
      });
      const pts = perColumn.filter((point) => point.pr.rate != null);
      const chartNotes = pts.map((point) =>
        columnTempNote(
          point.cs.map((c) => ({ indicatorId: indSel.id, year: c.year, month: c.month, unitId: c.unitId })),
          tempTaskKeys,
          point.column.months.length,
        ),
      );
      return {
        unitCount: new Set(cells.map((c) => c.unitId)).size,
        total: merged.total,
        unitPr,
        personPr: merged,
        ownPersonPr: merged,
        ownTotal: merged.total,
        chartValues: pts.map((point) => point.pr.rate as number),
        // v1.88.45：曲線一個區間一個點，X 軸標籤為區間第一個月。
        chartLabels: pts.map((point) => firstMonthLabel(point.column)),
        chartTips: pts.map((point, i) => `${point.column.label}${chartNotes[i] ?? ""}：${formatPassRate(point.pr, true)}`),
        chartNotes,
        chartThresholds: pts.map((point) =>
          indUnit === "person" ? columnThresholdFromCells(point.cs, th) : th > 0 ? th : null,
        ),
        chartCols: pts.map((point) => point.column),
        optionRows: [] as ReturnType<typeof optionDetailRows>,
        scoringRows: !indSel.groupScoring
          ? []
          : indUnit === "unit"
            ? unitScoringRowsFromCells(cells, indSel.questions, indSpans, th)
            : personScoringRowsFromCells(cells, indSel.questions),
      };
    }
    const unitIds = new Set(indRecs.map((record) => record.unitId));
    const unitPr = unitPeriodPassRate(indRecs, indSpans, th);
    const merged = passRateOf(indRecs, th);
    const perColumn =
      indUnit === "unit"
        ? indSpans.map((column) => ({ column, pr: unitPassRate(recordsInMonths(indRecs, column.months), th) }))
        : indSpans.map((column) => ({ column, pr: passRateOf(recordsInMonths(indRecs, column.months), th) }));
    const pts = perColumn.filter(
      (point): point is { column: RowSpan; pr: PassRate } & { pr: { rate: number } } => point.pr.rate != null,
    );
    const optionRows = optionDetailRows(indRecs, indSel.questions);
    // v1.59.0：曲線圖加審標註（與 chartSeries 同一判別：該欄紀錄對上加審任務月鍵）
    const chartNotes = pts.map((point) =>
      columnTempNote(
        recordsInMonths(indRecs, point.column.months),
        tempTaskKeys,
        point.column.months.length,
      ),
    );
    return {
      unitCount: unitIds.size, total: indRecs.length, unitPr, personPr: merged,
      // v1.44.0：結果分析不再讀預存摘要；明細只含本人單位範圍，不提供全院彙總。
      ownPersonPr: merged, ownTotal: indRecs.length,
      chartValues: pts.map((point) => point.pr.rate as number),
      // v1.88.45：曲線一個區間一個點，X 軸標籤為區間第一個月。
      chartLabels: pts.map((point) => firstMonthLabel(point.column)),
      chartTips: pts.map((point, i) => `${point.column.label}${chartNotes[i] ?? ""}：${formatPassRate(point.pr, true)}`),
      chartNotes,
      chartThresholds: pts.map((point) =>
        indUnit === "person"
          ? columnThresholdOf(recordsInMonths(indRecs, point.column.months), th)
          : th > 0 ? th : null,
      ),
      chartCols: pts.map((point) => point.column),
      optionRows,
      // 分組計分只在指標開啟 groupScoring 時顯示（v1.44.0）。
      scoringRows: !indSel.groupScoring
        ? []
        : indUnit === "unit"
          ? unitScoringBreakdownRows(indRecs, indSel.questions, indSpans, th)
          : personScoringBreakdownRows(indRecs, indSel.questions, th),
    };
  }, [indRecs, indSel, indUnit, indSpans, tempTaskKeys, hybridCells]);

  const errorAnalysisRows = hybridCells
    ? questionErrorRowsFromSummaries(
        questionSummariesFromCells(
          errorUnit === "all" ? hybridCells : hybridCells.filter((c) => c.unitId === errorUnitCode),
        ),
      )
    : questionErrorRows(
        errorUnit === "all"
          ? indRecs
          : indRecs.filter((record) => record.unitId === errorUnitCode),
      );

  /**
   * 指標分析補充說明（v1.43.0）：取即時明細（indRecs）中有備註的紀錄，
   * 每筆彙整為一則（單則為備註原文、多則每則附題號）。只收有備註者。
   */
  const indNotes = useMemo(() => {
    if (!indSel || hybridCells) return [];
    const source =
      errorUnit === "all"
        ? indRecs
        : indRecs.filter((record) => record.unitId === errorUnitCode);
    return collectConsolidatedRecordNotes(source, indSel.questions);
  }, [indRecs, indSel, errorUnit, errorUnitCode, hybridCells]);

  return {
    indSel,
    indSummary,
    errorAnalysisRows,
    indNotes,
    drillCapaSpans,
    indUnitCode,
  };
}

export type ResultsView = ResultsCtx & ReturnType<typeof useResultsAnalysis>;
