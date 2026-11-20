/**
 * 單位模式（v1.88.33）：單位＋起迄列出該單位被審的全部指標、每月審查結果。
 * 複合篩選（Q3）：品管組／指標可再過濾。Q11：有排程即列——該單位有排程但
 * 尚未審查的指標也列出，格子顯示 —。
 * 點指標列即在矩陣下方展開該指標曲線圖＋細項結果（Q8，曲線與細項同現，
 * 不再分曲線／文件兩種面板）。
 */
import { EmptyState, SectionTitle } from "../../../components/ui";
import { RateMatrix } from "../components/small";
import { RowDetailPanel } from "./RowDetailPanel";
import { capaInColumn } from "../model/format";
import type { ResultsView } from "../hooks/useResultsAnalysis";

export function UnitTab({ ctx }: { ctx: ResultsView }) {
  const { section, tab, applied, loading, unitIndicators, selUnit, unitNameOf, periodDesc, unitUnit, matrixRows, visibleColumns, cellValue, rowIndOf, selUnitCode, hasTempReview, indOf, unitCapaCases, openDrill, requireRaw, rowPanel, setRowPanel } = ctx;

  const toggleRow = (
    rowId: string,
    sectionKey?: string,
    sectionLabel?: string,
  ) => {
    const indicatorId = rowIndOf(rowId);
    if (
      rowPanel?.scope === "unit" &&
      rowPanel.rowId === rowId &&
      (rowPanel.sectionKey ?? undefined) === sectionKey
    ) {
      setRowPanel(null);
      return;
    }
    requireRaw(indicatorId);
    setRowPanel({
      scope: "unit",
      indicatorId,
      rowId,
      unitId: selUnitCode,
      sectionKey,
      sectionLabel,
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
                note={`${periodDesc}・單元：${unitUnit === "unit" ? "單位（達閾值單位數／總單位數）" : "人次（合併）"}・點指標列展開曲線圖與細項結果`}
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
                onChart={(rowId) => toggleRow(rowId)}
                onDoc={(rowId) => toggleRow(rowId)}
                onDetailChart={(rowId, detailKey, detailLabel) =>
                  toggleRow(rowId, detailKey, detailLabel)
                }
                onDetailDoc={(rowId, detailKey, detailLabel) =>
                  toggleRow(rowId, detailKey, detailLabel)
                }
                expandedId={rowPanel?.scope === "unit" ? rowPanel.rowId ?? null : null}
                onToggleExpand={(rowId) => toggleRow(rowId)}
              />
              <RowDetailPanel ctx={ctx} scope="unit" />
            </section>
          )}
        </>
      )}</>;
}
