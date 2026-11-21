/**
 * 組別模式（v1.88.33）：品管組＋起迄列出該組全部指標、依各指標排程區間
 * 呈現審查結果（v1.88.45：單表月欄，每列依自己的排程區間合併）。
 * 複合篩選（Q3）：指標／單位可再過濾（指標優先於單位優先於品管組）。
 * 主列：左邊無三角形；點曲線圖示在矩陣下方展開曲線圖面板（只開不關，
 * 收合按面板右上 X；一次一列），點文件圖示開啟細項結果彈窗。
 * 分組子列：曲線／文件圖示各自開曲線／細項彈窗。
 */
import { EmptyState, SectionTitle } from "../../../components/ui";
import { RateMatrix, UnitModeToggle } from "../components/small";
import { RowDetailPanel } from "./RowDetailPanel";
import type { ResultsView } from "../hooks/useResultsAnalysis";

export function GroupTab({ ctx }: { ctx: ResultsView }) {
  const { section, tab, applied, loading, ownUnitUngrouped, groupIndicators, groupUnitCode, groupNameOf, selGroup, periodDesc, groupUnit, setUnitMode, matrixRows, visibleColumns, cellValue, rowIndOf, hasTempReview, openDrill, openChart, rowSpansOf, openDoc, rowPanel, setRowPanel, requireRaw } = ctx;

  // 曲線圖示：只開不關（已展開同一列時不再收合，收合按面板右上 X）。
  const openRowChart = (rowId: string) => {
    const indicatorId = rowIndOf(rowId);
    if (rowPanel?.scope === "group" && rowPanel.rowId === rowId) return;
    requireRaw(indicatorId);
    setRowPanel({
      scope: "group",
      indicatorId,
      rowId,
      unitId: groupUnitCode,
    });
  };

  return <>{section === "analysis" && tab === "group" && (
        <>
          {!applied ? (
            <EmptyState
              title="尚未搜尋"
              description="請先選擇期間，再按「搜尋」開始分析。"
            />
          ) : loading ? (
            <EmptyState title="載入中" description="正在讀取審查紀錄…" />
          ) : ownUnitUngrouped ? (
            <EmptyState
              title="所屬單位尚未歸屬品管組"
              description="所屬單位尚未歸屬品管組，請先至「品管組與人員」→「品管組」頁籤設定，再查詢結果分析。"
            />
          ) : groupIndicators.length === 0 ? (
            <EmptyState
              title="無指標"
              description="該組別尚無指標。"
            />
          ) : (
            <section className="panel">
              <SectionTitle
                title={`${groupNameOf.get(selGroup) ?? selGroup}・達閾值率`}
                note={`${periodDesc}・單元：${groupUnit === "unit" ? "單位（達閾值單位數／總單位數）" : "人次（合併）"}・點曲線圖示展開曲線圖，點文件圖示開啟細項結果彈窗`}
              />
              <div className="results-matrix-toggle">
                <UnitModeToggle mode={groupUnit} onChange={setUnitMode} />
              </div>
              <RateMatrix
                rows={matrixRows}
                columns={visibleColumns}
                cellOf={(rowId, col) =>
                  cellValue(rowIndOf(rowId), col, groupUnitCode, groupUnit)
                }
                hasExtraReview={(rowId, col) => hasTempReview(rowIndOf(rowId), col, groupUnitCode)}
                onCell={(rowId, col) => openDrill(rowIndOf(rowId), col, groupUnit, groupUnitCode)}
                onDetailCell={(rowId, detailKey, col) =>
                  openDrill(rowIndOf(rowId), col, groupUnit, groupUnitCode, { sectionKey: detailKey })
                }
                onChart={openRowChart}
                onDoc={(rowId) =>
                  openDoc(rowIndOf(rowId), groupUnitCode, "全部單位", groupUnit)
                }
                onDetailChart={(rowId, detailKey, detailLabel) =>
                  openChart(rowIndOf(rowId), groupUnitCode, groupUnit, "全部單位", {
                    key: detailKey,
                    label: detailLabel,
                  }, rowSpansOf(rowId))
                }
                onDetailDoc={(rowId, detailKey, detailLabel) =>
                  openDoc(rowIndOf(rowId), groupUnitCode, "全部單位", groupUnit, {
                    key: detailKey,
                    label: detailLabel,
                  })
                }
              />
              <RowDetailPanel ctx={ctx} scope="group" />
            </section>
          )}
        </>
      )}</>;
}
