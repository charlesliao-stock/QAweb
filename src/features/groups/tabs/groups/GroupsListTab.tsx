import { LoadingState, ErrorState, EmptyState, ListPanelHead, SortableTh } from "../../../../components/ui";
import { Pencil, Trash2 } from "lucide-react";
import type { GroupsCtx } from "../../hooks/useGroupsCtx";

export function GroupsListTab({ ctx }: { ctx: GroupsCtx }) {
  const { masterLoading, masterLoadError, loadMaster, groups, tableSort, toggleSort, isAdmin, sortedRows, listSortKey, openGroupEdit, onOpenMemberPage, handleGroupDelete } = ctx;

  return (
    (
            masterLoading ? (
              <LoadingState label="品管組與單位資料載入中…" />
            ) : masterLoadError ? (
              <ErrorState title="品管組與單位資料載入失敗" description={masterLoadError} onRetry={loadMaster} />
            ) : groups.length === 0 ? (
              <EmptyState
                title="尚無品管組"
                description="使用右上角「新增品管組」或「批次上傳」建立品管組（例如：病房組、加護組）。"
              />
            ) : (
              <section className="panel data-panel list-panel">
                <ListPanelHead title="品管組清單" count={groups.length} />
                <div className="table-scroll">
                  <table className="permission-table">
                    <thead>
                      <tr>
                        <SortableTh label="品管組名稱" sortKey="group-name" sort={tableSort} onSort={toggleSort} />
                        <SortableTh label="所屬單位數" sortKey="group-count" sort={tableSort} onSort={toggleSort} />
                        {isAdmin && <th>操作</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedRows(groups, listSortKey, (row, key) => key === "group-count" ? row.unitCount : row.name).map((row) => (
                        <tr key={row.id}>
                          <td>
                            <b>{row.name}</b>
                          </td>
                          <td>{row.unitCount} 個</td>
                          {isAdmin && (
                            <td>
                              <button
                                className="text-button"
                                onClick={() => openGroupEdit(row.id)}
                              >
                                <Pencil size={13} /> 編輯
                              </button>{" "}
                              <button
                                className="text-button"
                                onClick={() =>
                                  onOpenMemberPage?.({ kind: "group", id: row.id })
                                }
                              >
                                單位管理
                              </button>{" "}
                              <button
                                className="text-button"
                                onClick={() => handleGroupDelete(row)}
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
