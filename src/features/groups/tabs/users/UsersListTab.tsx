import { LoadingState, ErrorState, EmptyState, ListPanelHead, SortableTh } from "../../../../components/ui";
import { maskName } from "../../../../lib/mask";
import { groupedRolesSegments } from "../../../../lib/roleIdentity";
import { Pencil } from "lucide-react";
import type { GroupsCtx } from "../../hooks/useGroupsCtx";

export function UsersListTab({ ctx }: { ctx: GroupsCtx }) {
  const { usersLoading, usersLoadError, loadUsers, usersSearched, users, visibleUsers, tableSort, toggleSort, groupNameOf, openUserEdit, handleToggleStatus } = ctx;

  return (
    (
            usersLoading ? (
              <LoadingState label="人員資料載入中…" />
            ) : usersLoadError ? (
              <ErrorState title="人員資料載入失敗" description={usersLoadError} onRetry={loadUsers} />
            ) : !usersSearched ? (
              <EmptyState
                title="尚未搜尋"
                description="請設定篩選條件後按「搜尋」，即可列出符合條件的人員。"
              />
            ) : users.length === 0 ? (
              <EmptyState
                title="尚無人員"
                description="使用右上角「新增人員」或「批次上傳」建立人員資料，職編即為登入帳號。"
              />
            ) : visibleUsers.length === 0 ? (
              <EmptyState
                title="沒有符合篩選條件的人員"
                description="請調整單位或職編／姓名關鍵字，再按「搜尋」。"
              />
            ) : (
              <section className="panel data-panel list-panel">
                <ListPanelHead title="人員清單" count={visibleUsers.length} />
                <div className="table-scroll">
                  <table className="permission-table">
                    <thead>
                      <tr>
                        <SortableTh label="職編" sortKey="user-id" sort={tableSort} onSort={toggleSort} />
                        <SortableTh label="姓名" sortKey="user-name" sort={tableSort} onSort={toggleSort} />
                        <SortableTh label="單位" sortKey="user-unit" sort={tableSort} onSort={toggleSort} />
                        <SortableTh label="職稱" sortKey="user-title" sort={tableSort} onSort={toggleSort} />
                        <SortableTh label="角色" sortKey="user-role" sort={tableSort} onSort={toggleSort} />
                        <SortableTh label="狀態" sortKey="user-status" sort={tableSort} onSort={toggleSort} />
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleUsers.map((row) => (
                        <tr key={row.staffId}>
                          <td>
                            <b>{row.staffId}</b>
                          </td>
                          <td>{maskName(row.name)}</td>
                          <td>{row.unitCode || "—"}</td>
                          <td>{row.title || "—"}</td>
                          <td>
                            {(() => {
                              // v1.52.0：角色欄按群組分組顯示，例如「病房組：品管組審查員、召集人」
                              const segments = groupedRolesSegments(
                                row.memberships,
                                groupNameOf,
                              );
                              return segments.length > 0
                                ? segments.map((s) => (
                                    <div key={s.label || "other"}>
                                      {s.label ? <b>{s.label}：</b> : null}
                                      {s.roles.join("、")}
                                    </div>
                                  ))
                                : "—";
                            })()}
                          </td>
                          <td>
                            <span
                              className={`status-pill ${row.status === "停用" ? "danger" : "success"}`}
                            >
                              {row.status}
                            </span>
                          </td>
                          <td>
                            <button
                              className="text-button"
                              onClick={() => openUserEdit(row.staffId)}
                            >
                              <Pencil size={13} /> 編輯
                            </button>{" "}
                            <button
                              className="text-button"
                              onClick={() => handleToggleStatus(row)}
                            >
                              {row.status === "停用" ? "啟用" : "停用"}
                            </button>
                          </td>
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
