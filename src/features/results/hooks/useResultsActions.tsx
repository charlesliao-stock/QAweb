import type { UnitMode, SectionRef } from "../model/types";
import type { RowSpan } from "../../../lib/analysisSpans";
import { useEffect, useMemo } from "react";
import type { AnalysisPeriodColumn } from "../../../lib/analysisPeriod";
import { canOpenDrill } from "../../../lib/drillScope";
import { recordsForIndex } from "../../../lib/resultsMatrix";
import { optionDetailRows } from "../../../lib/analysisRates";
import type { useResultsState } from "./useResultsState";
import type { useResultsScope } from "./useResultsScope";
import type { useResultsQuery } from "./useResultsQuery";
import type { useResultsCompute } from "./useResultsCompute";

export function useResultsActions(prev: ReturnType<typeof useResultsState> & ReturnType<typeof useResultsScope> & ReturnType<typeof useResultsQuery> & ReturnType<typeof useResultsCompute>) {
  const { requireRaw, setPendingChart, indOf, spansForIndicator, visibleColumns, sectionChartSeries, chartSeries, setChartModal, periodDesc, pendingChart, rawFull, loading, isNurseLeader, visibleUnitCodes, cellValue, setDrill, allMonths, recordIndex, sectionOptionRows, setDocModal } = prev;

  function openChart(
    indicatorId: string,
    unitId: string | undefined,
    mode: UnitMode,
    scopeLabel: string,
    section?: SectionRef,
    spans?: RowSpan[],
  ) {
    if (requireRaw(indicatorId)) {
      // v1.88.19：第一次點只觸發載入，記下待開的圖，原始紀錄載完自動彈出
      setPendingChart({ indicatorId, unitId, mode, scopeLabel, section, spans });
      return;
    }
    const ind = indOf.get(indicatorId);
    if (!ind) return;
    const chartSpans =
      spans ?? spansForIndicator(indicatorId, visibleColumns.flatMap((c) => c.months), unitId);
    const { values, labels, tips, cols, notes, thresholds } = section
      ? sectionChartSeries(indicatorId, unitId, mode, section.key, chartSpans)
      : chartSeries(indicatorId, unitId, mode, chartSpans);
    setChartModal({
      title: section
        ? `${ind.code}・${ind.name}・${section.label} 達閾值率曲線`
        : `${ind.code}・${ind.name} 達閾值率曲線`,
      subtitle: `${periodDesc}・${scopeLabel}・${
        mode === "unit" ? "單位（達閾值單位數／總單位數）" : "人次（合併）"
      }${section ? `・分組：${section.label}` : ""}`,
      values,
      labels,
      tips,
      notes,
      thresholds,
      threshold: ind.threshold > 0 ? ind.threshold : null,
      indicatorId,
      mode,
      cols,
      unitId,
      sectionKey: section?.key,
      sectionLabel: section?.label,
    });
  }

  // v1.88.19：待開曲線圖——第一次點已觸發原始紀錄載入（rawFull），載完
  // （loading 結束）自動彈出，不用再點第二次。載入失敗（rawFull 被重設）
  // 時放棄待開圖；使用者切頁籤／改查詢時 pendingChart 已隨之清空。
  useEffect(() => {
    if (!pendingChart || !rawFull || loading) return;
    const target = pendingChart;
    setPendingChart(null);
    openChart(
      target.indicatorId,
      target.unitId,
      target.mode,
      target.scopeLabel,
      target.section,
      target.spans,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingChart, rawFull, loading]);

  /**
   * 下探 L1：開啟單位矩陣（只有點選的那一個期間欄）。
   * v1.50.0：護理長不再一律不可下探——本人單位範圍（scopedRecords 已限本人
   * 單位）可下探；指定到其他單位時才擋下（見 lib/drillScope）。
   */
  function openDrill(
    indicatorId: string,
    col: AnalysisPeriodColumn,
    mode: UnitMode,
    scopeUnitId?: string,
    extra?: {
      sectionKey?: string;
      questionId?: string;
      optionLabel?: string;
      l2All?: boolean;
    },
  ) {
    if (!canOpenDrill({ isNurseLeader, scopeUnitId, visibleUnitCodes })) return;
    if (!extra?.l2All) {
      const cell = cellValue(indicatorId, col, scopeUnitId, mode);
      if (cell.rate == null) return;
    }
    setDrill({
      indicatorId,
      column: col,
      mode,
      scopeUnitId,
      l2UnitId: null,
      l2All: extra?.l2All ?? false,
      sectionKey: extra?.sectionKey,
      questionId: extra?.questionId,
      optionLabel: extra?.optionLabel,
      // v1.88.17 Q5=C：多月合併格先展開區間內各月明細（選月彈窗），再選單月進入 L1／L2。
      // 全期間欄（key "__all__"）與直接開 L2（l2All）不經選月。
      pickMonths:
        !extra?.l2All && col.key !== "__all__" && col.months.length > 1,
    });
  }

  /** v1.50.0：摘要卡／分組列下探用的全期間欄（全部已查期間欄合併）。 */
  const allPeriodColumn = useMemo(
    () => ({ key: "__all__", label: periodDesc, months: allMonths }),
    [periodDesc, allMonths],
  );

  function openDoc(
    indicatorId: string,
    unitId: string | undefined,
    scopeLabel: string,
    mode: UnitMode,
    section?: SectionRef,
  ) {
    if (requireRaw(indicatorId)) return;
    const ind = indOf.get(indicatorId);
    if (!ind) return;
    // A3：查表取該指標全部期間的紀錄（可再限單位）。
    const recs = recordsForIndex(recordIndex, indicatorId, allMonths, unitId);
    const rows = section
      ? sectionOptionRows(optionDetailRows(recs, ind.questions), ind.questions, section.key, recs)
      : optionDetailRows(recs, ind.questions);
    setDocModal({
      title: section
        ? `${ind.code}・${ind.name}・${section.label} 各選項得分狀況`
        : `${ind.code}・${ind.name} 各選項得分狀況`,
      subtitle: `${periodDesc}・${scopeLabel}・共 ${recs.length} 人次${section ? `・分組：${section.label}` : ""}`,
      rows,
      indicatorId,
      unitId,
      mode,
      sectionKey: section?.key,
      sectionLabel: section?.label,
    });
  }

  return {
    openDrill,
    openChart,
    openDoc,
    allPeriodColumn,
  };
}
