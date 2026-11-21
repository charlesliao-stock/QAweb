/**
 * 單位模式（v1.88.33）：單位＋起迄列出該單位被審的全部指標、依各指標排程
 * 區間呈現審查結果（v1.88.45：單表月欄，每列依自己的排程區間合併）。
 * 複合篩選（Q3）：品管組／指標可再過濾。Q11：有排程即列——該單位有排程但
 * 尚未審查的指標也列出，格子顯示 —。
 * 主列：左邊無三角形；點曲線圖示在矩陣下方展開曲線圖面板（只開不關，
 * 收合按面板右上 X；一次一列），點文件圖示開啟細項結果彈窗。
 * 分組子列：曲線／文件圖示各自開曲線／細項彈窗（與品管組一致，不再開下方展開面板）。
 */
import { EmptyState, SectionTitle } from "../../../components/ui";
import { RateMatrix, UnitModeToggle } from "../components/small";
import { RowDetailPanel } from "./RowDetailPanel";
import { capaInColumn } from "../model/format";
import type { ResultsView } from "../hooks/useResultsAnalysis";

export function UnitTab({ ctx }: { ctx: ResultsView }) {
  const { section, tab, applied, loading, unitIndicators, selUnit, unitNameOf, periodDesc, unitUnit, setUnitMode, matrixRows, visibleColumns, cellValue, rowIndOf, selUnitCode, hasTempReview, indOf, unitCapaCases, openDrill, openChart, openDoc, rowSpansOf, requireRaw, rowPanel, setRowPanel } = ctx;

  // 曲線圖示：只開不關（已展開同一列時不再收合，收合按面板右上 X）。
  const openRowChart = (rowId: string) => {
    const indicatorId = rowIndOf(rowId);
    if (rowPanel?.scope === "unit" && rowPanel.rowId === rowId) return;
    requireRaw(indicatorId);
    setRowPanel({
      scope: "unit",
      indicatorId,
      rowId,
      unitId: selUnitCode,
    });
  };

  return <>{section === "analysis" && tab === "unit" && (
        <>
          {!applied ? (
            <EmptyState
              title="尚未搜尋"
              description="請先選擇期間，再按「搜尋」開始分析。"
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
                note={`${periodDesc}・單元：${unitUnit === "unit" ? "單位（達閾值單位數／總單位數）" : "人次（合併）"}・點曲線圖示展開曲線圖，點文件圖示開啟細項結果彈窗`}
              />
              <div className="results-matrix-toggle">
                <UnitModeToggle mode={unitUnit} onChange={setUnitMode} />
              </div>
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
                onChart={openRowChart}
                onDoc={(rowId) =>
                  openDoc(rowIndOf(rowId), selUnitCode, `單位 ${selUnitCode}`, unitUnit)
                }
                onDetailChart={(rowId, detailKey, detailLabel) =>
                  openChart(rowIndOf(rowId), selUnitCode, unitUnit, `單位 ${selUnitCode}`, {
                    key: detailKey,
                    label: detailLabel,
                  }, rowSpansOf(rowId))
                }
                onDetailDoc={(rowId, detailKey, detailLabel) =>
                  openDoc(rowIndOf(rowId), selUnitCode, `單位 ${selUnitCode}`, unitUnit, {
                    key: detailKey,
                    label: detailLabel,
                  })
                }
              />
              <RowDetailPanel ctx={ctx} scope="unit" />
            </section>
          )}
        </>
      )}</>;
}
