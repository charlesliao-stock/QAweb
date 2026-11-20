import { EmptyState, SummaryCell, SectionTitle } from "../../../components/ui";
import { formatPassRate } from "../../../lib/analysisRates";
import { TrendingUp, FileText } from "lucide-react";
import { TrendChart } from "../../../components/TrendChart";
import { capaInColumn } from "../model/format";
import { OptionDetailTable, QuestionErrorTable, UnitModeToggle } from "../components/small";
import { staffLabel } from "../../../lib/mask";
import type { ResultsView } from "../hooks/useResultsAnalysis";

export function IndicatorTab({ ctx }: { ctx: ResultsView }) {
  const { section, tab, applied, loading, indSel, indSummary, isNurseLeader, openDrill, selIndicator, allPeriodColumn, indUnit, setUnitMode, indUnitCode, openChart, openDoc, periodDesc, indCapaCases, summaryPlan, setRawHint, setRawFull, errorUnit, errorAnalysisRows, indNotes } = ctx;

  return <>{section === "analysis" && tab === "indicator" && (
        <>
          {!applied ? (
            <EmptyState
              title="尚未搜尋"
              description="請先選擇期間，再按「搜尋」開始分析。只想匯入結果，可直接切換至「結果匯入」頁籤，不需查詢。"
            />
          ) : loading ? (
            <EmptyState title="載入中" description="正在讀取審查紀錄…" />
          ) : !indSel || !indSummary ? (
            <EmptyState
              title="無指標"
              description="請先選擇組別與指標。"
            />
          ) : (
            <>
              <div className="results-matrix-toggle">
                <UnitModeToggle mode={indUnit} onChange={setUnitMode} />
              </div>
              <div className="analysis-stats">
                <SummaryCell
                  label={isNurseLeader ? "本單位受審" : "受審單位數"}
                  value={String(indSummary.unitCount)}
                  note={isNurseLeader ? "僅顯示本人所屬單位；不列其他單位" : "所選期間內有紀錄的單位"}
                  onClick={
                    indSummary.total > 0
                      ? () => openDrill(selIndicator, allPeriodColumn, indUnit, indUnitCode)
                      : undefined
                  }
                />
                {isNurseLeader ? (
                  <>
                    <SummaryCell
                      label="本單位受審人次"
                      value={String(indSummary.ownTotal)}
                      note="所選期間內本單位總人次數"
                      onClick={
                        indSummary.total > 0
                          ? () => openDrill(selIndicator, allPeriodColumn, indUnit, indUnitCode, { l2All: true })
                          : undefined
                      }
                    />
                    <SummaryCell
                      label="單位正確率"
                      value={formatPassRate(indSummary.unitPr, true)}
                      note="達閾值單位數／審查單位數（unit-period 計）"
                      onClick={
                        indSummary.unitPr.rate != null
                          ? () => openDrill(selIndicator, allPeriodColumn, indUnit, indUnitCode)
                          : undefined
                      }
                    />
                    <SummaryCell
                      label="本單位人員正確率"
                      value={formatPassRate(indSummary.ownPersonPr, true)}
                      note="本單位達閾值人次／本單位總人次"
                      onClick={
                        indSummary.ownPersonPr.rate != null
                          ? () => openDrill(selIndicator, allPeriodColumn, indUnit, indUnitCode, { l2All: true })
                          : undefined
                      }
                    />
                    <SummaryCell
                      label="全院人員正確率"
                      value="—"
                      note="僅顯示本單位資料，不提供全院彙總比較"
                    />
                  </>
                ) : (
                  <>
                    <SummaryCell
                      label="受審總人次"
                      value={String(indSummary.total)}
                      note="所選期間內總人次數"
                      onClick={
                        indSummary.total > 0
                          ? () => openDrill(selIndicator, allPeriodColumn, indUnit, indUnitCode, { l2All: true })
                          : undefined
                      }
                    />
                    <SummaryCell
                      label="單位正確率"
                      value={formatPassRate(indSummary.unitPr, true)}
                      note="達閾值單位數／審查單位數（unit-period 計）"
                      onClick={
                        indSummary.unitPr.rate != null
                          ? () => openDrill(selIndicator, allPeriodColumn, indUnit, indUnitCode)
                          : undefined
                      }
                    />
                    <SummaryCell
                      label="人員正確率"
                      value={formatPassRate(indSummary.personPr, true)}
                      note="達閾值人次／總人次"
                      onClick={
                        indSummary.personPr.rate != null
                          ? () => openDrill(selIndicator, allPeriodColumn, indUnit, indUnitCode, { l2All: true })
                          : undefined
                      }
                    />
                  </>
                )}
              </div>
              {indSummary.total > 0 && (
                <p className="settings-note" role="status">
                  {isNurseLeader ? "目前僅顯示本單位資料，無法提供全院彙總。" : "明細中的閾值快照優先於指標現行閾值。"}錯題排行依完全相同題目文字跨版本彙總，僅作排行、不代表版本等價或趨勢合併。
                </p>
              )}
              {indSummary.scoringRows.length > 0 && (
                <section className="panel score-breakdown-panel" aria-label="指標計分明細">
                  <div className="score-breakdown">
                    {indSummary.scoringRows.map((row) => {
                      const clickable = row.rate != null;
                      return (
                        <div
                          key={row.key}
                          className={`score-breakdown-row${row.isTotal ? " score-breakdown-total" : " score-breakdown-detail"}${clickable ? " clickable" : ""}`}
                          title={clickable ? "點選下探到個人審查結果" : undefined}
                          onClick={
                            clickable
                              ? () =>
                                  openDrill(selIndicator, allPeriodColumn, indUnit, indUnitCode, {
                                    sectionKey: row.isTotal ? undefined : row.key,
                                  })
                              : undefined
                          }
                          role={clickable ? "button" : undefined}
                          tabIndex={clickable ? 0 : undefined}
                          onKeyDown={
                            clickable
                              ? (e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    openDrill(selIndicator, allPeriodColumn, indUnit, indUnitCode, {
                                      sectionKey: row.isTotal ? undefined : row.key,
                                    });
                                  }
                                }
                              : undefined
                          }
                        >
                          <span>{row.isTotal ? indSel.name : row.label}</span>
                          {!row.isTotal && (
                            <span className="analysis-indicator-actions">
                              <button
                                type="button"
                                className="icon-button"
                                title="曲線圖"
                                aria-label={`${row.label} 曲線圖`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openChart(selIndicator, indUnitCode, indUnit, indUnitCode !== undefined ? `單位 ${indUnitCode}` : isNurseLeader ? "本單位" : "全部單位", {
                                    key: row.key,
                                    label: row.label,
                                  });
                                }}
                              >
                                <TrendingUp size={16} />
                              </button>
                              {/* v1.53.0：歷史分組無現行題目，選項明細為空列，故不顯示文件圖示 */}
                              {!row.key.startsWith("historical-") && (
                                <button
                                  type="button"
                                  className="icon-button"
                                  title="各選項得分狀況"
                                  aria-label={`${row.label} 各選項得分狀況`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openDoc(selIndicator, indUnitCode, indUnitCode !== undefined ? `單位 ${indUnitCode}` : isNurseLeader ? "本單位" : "全部單位", indUnit, {
                                      key: row.key,
                                      label: row.label,
                                    });
                                  }}
                                >
                                  <FileText size={16} />
                                </button>
                              )}
                            </span>
                          )}
                          <strong>
                            {formatPassRate({ pass: row.yes, total: row.valid, rate: row.rate })}
                          </strong>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}
              <section className="panel">
                <SectionTitle
                  title="通過率"
                  note={`${indSel.code}・${indSel.name}・${periodDesc}・單元：${indUnit === "unit" ? "單位（達閾值單位數／總單位數）" : "人次（合併）"}${isNurseLeader && indUnit !== "unit" ? "・僅顯示本單位資料" : ""}`}
                />
                {indSummary.chartValues.length === 0 ? (
                  <div className="chart-empty">尚無資料</div>
                ) : (
                  <TrendChart
                    values={indSummary.chartValues}
                    labels={indSummary.chartLabels}
                    tooltips={indSummary.chartTips}
                    notes={indSummary.chartNotes}
                    threshold={indSel.threshold > 0 ? indSel.threshold : null}
                    thresholds={indSummary.chartThresholds}
                    legend="正確率"
                    capaMarks={indSummary.chartCols.map((col) => {
                      const hit = indCapaCases.find((c) => c.stage !== "已撤案" && capaInColumn(c, col.months));
                      return hit ? { id: hit.id, label: hit.caseNumber, actions: hit.actions.map((a) => a.title) } : null;
                    })}
                    onCapaClick={(i) => {
                      const hit = indCapaCases.find((c) => c.stage !== "已撤案" && capaInColumn(c, indSummary.chartCols[i].months));
                      if (hit) window.dispatchEvent(new CustomEvent("capa:open", { detail: { caseId: hit.id } }));
                    }}
                    onPointClick={(i) =>
                      openDrill(selIndicator, indSummary.chartCols[i], indUnit, indUnitCode)
                    }
                  />
                )}
              </section>
              <section className="panel">
                <SectionTitle
                  title="指標選項審查明細"
                  note={`${indSel.code}・${indSel.name}・${periodDesc}・共 ${indSummary.total} 人次`}
                />
                {summaryPlan ? (
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
                    後可顯示各選項明細、補充說明並下探。
                  </p>
                ) : (
                <OptionDetailTable
                  rows={indSummary.optionRows}
                  threshold={indSel.threshold}
                  onQuestionClick={(questionId) =>
                    openDrill(selIndicator, allPeriodColumn, indUnit, indUnitCode, {
                      questionId,
                      l2All: true,
                    })
                  }
                />
                )}
              </section>
              <section className="panel">
                <SectionTitle
                  title="指標錯誤分析・題目排行"
                  note={`${indSel.code}・${indSel.name}・${periodDesc}・${errorUnit === "all" ? "全部單位" : `單位 ${errorUnit}`}；「否」為錯誤，「不適用」不列入錯誤率分母`}
                />
                <QuestionErrorTable
                  rows={errorAnalysisRows}
                  onQuestionClick={(questionId) =>
                    openDrill(
                      selIndicator,
                      allPeriodColumn,
                      indUnit,
                      indUnitCode,
                      { questionId, optionLabel: "否", l2All: true },
                    )
                  }
                />
              </section>
              {indNotes.length > 0 && (
                <section className="panel">
                  <SectionTitle
                    title="補充說明"
                    note={`${indSel.code}・${indSel.name}・${periodDesc}・審查員備註未通過原因；每筆紀錄彙整為一則，只列有填寫備註的紀錄。`}
                  />
                  <div className="analysis-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>被審人員</th>
                          <th>補充說明</th>
                        </tr>
                      </thead>
                      <tbody>
                        {indNotes.map((entry, i) => (
                          <tr
                            key={`${entry.personEmpNo}-${entry.year}-${entry.month}-${i}`}
                          >
                            <td>
                              {staffLabel(entry.personEmpNo, entry.personName)}
                            </td>
                            <td className="supp-note-cell">{entry.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </>
          )}
        </>
      )}</>;
}
