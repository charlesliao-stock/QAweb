import { LoadingState, ErrorState, EmptyState, ListPanelHead, SortableTh } from "../../../../components/ui";
import { Pencil, Trash2 } from "lucide-react";
import type { GroupsCtx } from "../../hooks/useGroupsCtx";

export function UnitsListTab({ ctx }: { ctx: GroupsCtx }) {
  const { masterLoading, masterLoadError, loadMaster, unitsSearched, units, appliedUnitGroupFilter, appliedUnitSearch, visibleUnits, tableSort, toggleSort, isAdmin, openUnitEdit, onOpenMemberPage, handleUnitDelete } = ctx;

  return (
    (
            masterLoading ? (
              <LoadingState label="單位資料載入中…" />
            ) : masterLoadError ? (
              <ErrorState title="單位資料載入失敗" description={masterLoadError} onRetry={loadMaster} />
            ) : !unitsSearched ? (
              <EmptyState
                title="尚未搜尋"
                description="請設定篩選條件後按「搜尋」，即可列出符合條件的單位。"
              />
            ) : units.length === 0 ? (
              <EmptyState
                title={appliedUnitGroupFilter || appliedUnitSearch ? "沒有符合篩選條件的單位" : "尚無單位"}
                description={appliedUnitGroupFilter || appliedUnitSearch ? "請調整品管組或單位關鍵字後重新搜尋。" : "使用右上角「新增單位」或「批次上傳」建立單位（例如：9A病房，歸屬病房組）。"}
              />
            ) : (
              <section className="panel data-panel list-panel">
                <ListPanelHead title="單位清單" count={visibleUnits.length} />
                <div className="table-scroll">
                  <table className="permission-table">
                    <thead>
                      <tr>
                        <SortableTh label="單位代號" sortKey="unit-code" sort={tableSort} onSort={toggleSort} />
                        <SortableTh label="單位名稱" sortKey="unit-name" sort={tableSort} onSort={toggleSort} />
                        <SortableTh label="所屬品管組" sortKey="unit-group" sort={tableSort} onSort={toggleSort} />
                        <SortableTh label="所屬人員數" sortKey="unit-count" sort={tableSort} onSort={toggleSort} />
                        {isAdmin && <th>操作</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleUnits.length === 0 ? (
                        <tr><td colSpan={isAdmin ? 5 : 4} className="muted-text">沒有符合篩選條件的單位</td></tr>
                      ) : visibleUnits.map((row) => (
                        <tr key={row.code}>
                          <td>
                            <b>{row.code}</b>
                          </td>
                          <td>{row.name}</td>
                          <td>{row.groupName}</td>
                          <td>
                            {row.memberCount === null ? "—" : `${row.memberCount} 人`}
                          </td>
                          {isAdmin && (
                            <td>
                              <button
                                className="text-button"
                                onClick={() => openUnitEdit(row.code)}
                              >
                                <Pencil size={13} /> 編輯
                              </button>{" "}
                              {isAdmin && (
                                <button
                                  className="text-button"
                                  onClick={() =>
                                    onOpenMemberPage?.({
                                      kind: "unit",
                                      id: row.code,
                                    })
                                  }
                                >
                                  成員管理
                                </button>
                              )}{" "}
                              <button
                                className="text-button"
                                onClick={() => handleUnitDelete(row.code)}
                              >
                                <Trash2 size={13} /> 刪除
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
    
              </section>
            )
          )
  );
}
