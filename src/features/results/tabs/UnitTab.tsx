import { EmptyState, SectionTitle } from "../../../components/ui";
import { RateMatrix, UnitBelowPanel, OptionDetailTable } from "../components/small";
import { capaInColumn } from "../model/format";
import { TrendChart } from "../../../components/TrendChart";
import { recordsForIndex } from "../../../lib/resultsMatrix";
import { optionDetailRows } from "../../../lib/analysisRates";
import type { ResultsView } from "../hooks/useResultsAnalysis";

export function UnitTab({ ctx }: { ctx: ResultsView }) {
  const { tab, applied, loading, unitIndicators, selUnit, unitNameOf, periodDesc, unitUnit, matrixRows, visibleColumns, cellValue, rowIndOf, selUnitCode, hasTempReview, indOf, unitCapaCases, openDrill, setUnitPanel, requireRaw, unitPanel, rowSpansOf, spansForIndicator, sectionChartSeries, chartSeries, recordIndex, allMonths, sectionOptionRows, allPeriodColumn } = ctx;

  return <>{tab === "unit" && (
        <>
          {!applied ? (
            <EmptyState
              title="尚未搜尋"
              description="請先選擇期間，再按「搜尋」開始分析。只想匯入結果，可直接切換至「結果匯入」頁籤，不需查詢。"
            />
          ) : loading ? (
            <EmptyState title="載入中" description="正在讀取審查紀錄…" />
          ) : unitIndicators.length === 0 ? (
            <EmptyState
              title="無資料"
              description="該單位在所選期間尚無審查紀錄。"
            />
          ) : (
            <section className="panel">
              <SectionTitle
                title={`${selUnit}・${unitNameOf.get(selUnit) ?? ""} 達閾值率`}
                note={`${periodDesc}・單元：${unitUnit === "unit" ? "單位（達閾值單位數／總單位數）" : "人次（合併）"}`}
              />
              <RateMatrix
                rows={matrixRows}
                columns={visibleColumns}
                cellOf={(rowId, col) =>
                  cellValue(rowIndOf(rowId), col, selUnitCode, unitUnit)
                }
                hasExtraReview={(rowId, col) => hasTempReview(rowIndOf(rowId), col, selUnitCode)}
                thresholdOf={(rowId) => indOf.get(rowIndOf(rowId))?.threshold ?? 0}
                capaMarkOf={(rowId, col) =>
                  unitCapaCases.find((c) => c.indicatorId === rowIndOf(rowId) && c.stage !== "已撤案" && capaInColumn(c, col.months))
                }
                onCell={(rowId, col) =>
                  openDrill(rowIndOf(rowId), col, unitUnit, selUnitCode)
                }
                onDetailCell={(rowId, detailKey, col) =>
                  openDrill(rowIndOf(rowId), col, unitUnit, selUnitCode, { sectionKey: detailKey })
                }
                onChart={(rowId) =>
                  setUnitPanel((p) =>
                    p?.kind === "chart" && p.rowId === rowId
                      ? null
                      : { kind: "chart", indicatorId: rowIndOf(rowId), rowId },
                  )
                }
                onDoc={(rowId) =>
                  requireRaw(rowIndOf(rowId)) ||
                  setUnitPanel((p) =>
                    p?.kind === "doc" && p.rowId === rowId
                      ? null
                      : { kind: "doc", indicatorId: rowIndOf(rowId), rowId },
                  )
                }
                onDetailChart={(rowId, detailKey, detailLabel) =>
                  setUnitPanel((p) =>
                    p?.kind === "chart" &&
                    p.rowId === rowId &&
                    p.sectionKey === detailKey
                      ? null
                      : {
                          kind: "chart",
                          indicatorId: rowIndOf(rowId),
                          rowId,
                          sectionKey: detailKey,
                          sectionLabel: detailLabel,
                        },
                  )
                }
                onDetailDoc={(rowId, detailKey, detailLabel) =>
                  requireRaw(rowIndOf(rowId)) ||
                  setUnitPanel((p) =>
                    p?.kind === "doc" &&
                    p.rowId === rowId &&
                    p.sectionKey === detailKey
                      ? null
                      : {
                          kind: "doc",
                          indicatorId: rowIndOf(rowId),
                          rowId,
                          sectionKey: detailKey,
                          sectionLabel: detailLabel,
                        },
                  )
                }
              />
              {unitPanel &&
                (() => {
                  const ind = indOf.get(unitPanel.indicatorId);
                  if (!ind) return null;
                  if (unitPanel.kind === "chart") {
                    // v1.88.17：曲線圖一點一合併格，取開啟面板那一列的 spans；找不到列時退回該指標聯集 spans。
                    const panelSpans = unitPanel.rowId ? rowSpansOf(unitPanel.rowId) : [];
                    const chartSpans =
                      panelSpans.length > 0
                        ? panelSpans
                        : spansForIndicator(ind.id, visibleColumns.flatMap((c) => c.months), selUnitCode);
                    const s = unitPanel.sectionKey
                      ? sectionChartSeries(
                          ind.id,
                          selUnitCode,
                          unitUnit,
                          unitPanel.sectionKey,
                          chartSpans,
                        )
                      : chartSeries(ind.id, selUnitCode, unitUnit, chartSpans);
                    return (
                      <UnitBelowPanel
                        title={
                          unitPanel.sectionKey
                            ? `${ind.code}・${ind.name}・${unitPanel.sectionLabel} 達閾值率曲線`
                            : `${ind.code}・${ind.name} 達閾值率曲線`
                        }
                        subtitle={`${periodDesc}・單位：${selUnit}・${unitUnit === "unit" ? "單位（達閾值單位數／總單位數）" : "人次（合併）"}${unitPanel.sectionKey ? `・分組：${unitPanel.sectionLabel}` : ""}`}
                        onClose={() => setUnitPanel(null)}
                      >
                        {s.values.length === 0 ? (
                          <div className="chart-empty">尚無資料</div>
                        ) : (
                          <TrendChart
                            values={s.values}
                            labels={s.labels}
                            tooltips={s.tips}
                            notes={s.notes}
                            threshold={
                              ind.threshold > 0 ? ind.threshold : null
                            }
                            thresholds={s.thresholds}
                            legend="達閾值率"
                            capaMarks={s.cols.map((col) => {
                              const hit = unitCapaCases.find((c) => c.indicatorId === ind.id && c.stage !== "已撤案" && capaInColumn(c, col.months));
                              return hit ? { id: hit.id, label: hit.caseNumber, actions: hit.actions.map((a) => a.title) } : null;
                            })}
                            onCapaClick={(i) => {
                              const hit = unitCapaCases.find((c) => c.indicatorId === ind.id && c.stage !== "已撤案" && capaInColumn(c, s.cols[i].months));
                              if (hit) window.dispatchEvent(new CustomEvent("capa:open", { detail: { caseId: hit.id } }));
                            }}
                            onPointClick={(i) =>
                              openDrill(ind.id, s.cols[i], unitUnit, selUnitCode, unitPanel.sectionKey
                                ? { sectionKey: unitPanel.sectionKey }
                                : undefined)
                            }
                          />
                        )}
                      </UnitBelowPanel>
                    );
                  }
                  // A3：查表取該指標該單位全部期間的紀錄（取代 JSX 內即時 IIFE 過濾）。
                  const recs = recordsForIndex(
                    recordIndex,
                    ind.id,
                    allMonths,
                    selUnitCode,
                  );
                  return (
                    <UnitBelowPanel
                      title={
                        unitPanel.sectionKey
                          ? `${ind.code}・${ind.name}・${unitPanel.sectionLabel} 各選項得分狀況`
                          : `${ind.code}・${ind.name} 各選項得分狀況`
                      }
                      subtitle={`${periodDesc}・單位：${selUnit}・共 ${recs.length} 人次${unitPanel.sectionKey ? `・分組：${unitPanel.sectionLabel}` : ""}`}
                      onClose={() => setUnitPanel(null)}
                    >
                      <OptionDetailTable
                        rows={
                          unitPanel.sectionKey
                            ? sectionOptionRows(
                                optionDetailRows(recs, ind.questions),
                                ind.questions,
                                unitPanel.sectionKey,
                                recs,
                              )
                            : optionDetailRows(recs, ind.questions)
                        }
                        threshold={ind.threshold}
                        onQuestionClick={(questionId) =>
                          openDrill(ind.id, allPeriodColumn, unitUnit, selUnitCode, {
                            questionId,
                            l2All: true,
                          })
                        }
                      />
                    </UnitBelowPanel>
                  );
                })()}
            </section>
          )}
        </>
      )}</>;
}
