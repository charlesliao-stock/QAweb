import { EmptyState, SectionTitle } from "../../../components/ui";
import { RateMatrix } from "../components/small";
import type { ResultsView } from "../hooks/useResultsAnalysis";

export function GroupTab({ ctx }: { ctx: ResultsView }) {
  const { tab, applied, loading, ownUnitUngrouped, groupIndicators, groupNameOf, selGroup, periodDesc, groupUnit, matrixRows, visibleColumns, cellValue, rowIndOf, hasTempReview, openDrill, openChart, rowSpansOf, openDoc } = ctx;

  return <>{tab === "group" && (
        <>
          {!applied ? (
            <EmptyState
              title="尚未搜尋"
              description="請先選擇期間，再按「搜尋」開始分析。只想匯入結果，可直接切換至「結果匯入」頁籤，不需查詢。"
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
                note={`${periodDesc}・單元：${groupUnit === "unit" ? "單位（達閾值單位數／總單位數）" : "人次（合併）"}`}
              />
              <RateMatrix
                rows={matrixRows}
                columns={visibleColumns}
                cellOf={(rowId, col) =>
                  cellValue(rowIndOf(rowId), col, undefined, groupUnit)
                }
                hasExtraReview={(rowId, col) => hasTempReview(rowIndOf(rowId), col)}
                onCell={(rowId, col) => openDrill(rowIndOf(rowId), col, groupUnit)}
                onDetailCell={(rowId, detailKey, col) =>
                  openDrill(rowIndOf(rowId), col, groupUnit, undefined, { sectionKey: detailKey })
                }
                onChart={(rowId) =>
                  openChart(rowIndOf(rowId), undefined, groupUnit, "全部單位", undefined, rowSpansOf(rowId))
                }
                onDoc={(rowId) => openDoc(rowIndOf(rowId), undefined, "全部單位", groupUnit)}
                onDetailChart={(rowId, detailKey, detailLabel) =>
                  openChart(rowIndOf(rowId), undefined, groupUnit, "全部單位", {
                    key: detailKey,
                    label: detailLabel,
                  }, rowSpansOf(rowId))
                }
                onDetailDoc={(rowId, detailKey, detailLabel) =>
                  openDoc(rowIndOf(rowId), undefined, "全部單位", groupUnit, {
                    key: detailKey,
                    label: detailLabel,
                  })
                }
              />
            </section>
          )}
        </>
      )}</>;
}
