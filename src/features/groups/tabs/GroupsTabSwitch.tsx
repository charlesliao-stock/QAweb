import { LoadingState, ErrorState, EmptyState, ListPanelHead, SortableTh, SectionTitle, FormSelect } from "../../../components/ui";
import { Pencil, Trash2 } from "lucide-react";
import { maskName } from "../../../lib/mask";
import { groupedRolesSegments } from "../../../lib/roleIdentity";
import type { GroupsCtx } from "../hooks/useGroupsCtx";

export function GroupsTabSwitch({ ctx }: { ctx: GroupsCtx }) {
  const { tab, isAdmin, masterLoading, masterLoadError, loadMaster, groups, tableSort, toggleSort, sortedRows, listSortKey, openGroupEdit, onOpenMemberPage, handleGroupDelete, unitsSearched, units, appliedUnitGroupFilter, appliedUnitSearch, visibleUnits, openUnitEdit, handleUnitDelete, titlesLoading, levelsLoading, titlesLoadError, levelsLoadError, loadTitles, loadLevels, titles, renderLevelCreate, titleSections, renderLevelHead, renderTitleTable, usersLoading, usersLoadError, loadUsers, usersSearched, users, visibleUsers, groupNameOf, openUserEdit, handleToggleStatus, roleCreateOpen, roleCreateError, newRoleName, setNewRoleName, newRoleLevelId, setNewRoleLevelId, roleLevels, roleCreateSaving, handleRoleCreate, setRoleCreateOpen, rolesLoading, rolesLoadError, loadRoles, roleRows, roleSections, renderRoleTable } = ctx;

  return (
    <>
      {tab === "groups" ? (
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
      ) : tab === "units" ? (
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
      ) : tab === "titles" ? (
            titlesLoading || levelsLoading ? (
              <LoadingState label="職稱與層級資料載入中…" />
            ) : titlesLoadError || levelsLoadError ? (
              <ErrorState
                title="職稱資料載入失敗"
                description={titlesLoadError || levelsLoadError}
                onRetry={() => { void Promise.all([loadTitles(), loadLevels()]); }}
              />
            ) : titles.length === 0 ? (
              <EmptyState
                title="尚無職稱"
                description="使用右上角「新增職稱」或「批次上傳」建立職稱。"
              />
            ) : (
              <section className="panel data-panel">
                {renderLevelCreate("title")}
                {titleSections.map((section) => (
                  <div className="level-section" key={section.level?.id ?? "ungrouped"}>
                    {renderLevelHead(
                      "title",
                      section.level,
                      section.items.reduce((n, r) => n + (r.userCount ?? 0), 0),
                    )}
                    {renderTitleTable(section.items)}
                  </div>
                ))}
                <div className="panel-inset">
                  <p className="settings-note">
                    職稱以名稱唯一；可在此新增職稱、管理成員或刪除職稱。職稱權限請到「組織與設定 → 權限管理」設定（按名稱共用）。
                  </p>
                </div>
              </section>
            )
      ) : tab === "users" && !isAdmin ? (
            <section className="panel">
              <div className="empty-state-block">
                <b>僅系統管理員可管理人員</b>
                <p>如需新增或異動人員資料，請聯絡系統管理員。</p>
              </div>
            </section>
      ) : tab === "users" ? (
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
      ) : tab === "roles" ? (
            !isAdmin ? (
              <section className="panel">
                <div className="empty-state-block">
                  <b>僅系統管理員可建立或管理角色</b>
                  <p>如需新增或異動角色成員，請聯絡系統管理員。</p>
                </div>
              </section>
            ) : roleCreateOpen ? (
              <section className="panel data-panel indicator-form">
                <SectionTitle title="新增角色" note="新角色預設無權限，建立後請至權限管理設定權限。角色以名稱唯一；跨品管組／跨單位設定請到權限管理。" />
                {roleCreateError && <div className="login-error">{roleCreateError}</div>}
                <div className="form-field" style={{ maxWidth: 420 }}>
                  <label className="field-label">角色名稱 *</label>
                  <input
                    className="text-input"
                    value={newRoleName}
                    placeholder="輸入角色名稱"
                    onChange={(event) => setNewRoleName(event.target.value)}
                  />
                  <p className="settings-note">身分（審查員／召集人／執行幹事）由名稱關鍵字推導，範圍由層級決定。</p>
                </div>
                <FormSelect label="層級" maxWidth={420} value={newRoleLevelId}
                      onChange={(event) => setNewRoleLevelId(event.target.value)}>
                      <option value="">— 未分層級 —</option>
                      {roleLevels.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </FormSelect>
                <div className="form-actions">
                  <button className="button button-primary" disabled={roleCreateSaving} onClick={handleRoleCreate}>
                    {roleCreateSaving ? "建立中…" : "建立角色"}
                  </button>
                  <button className="button button-outline" onClick={() => setRoleCreateOpen(false)}>
                    取消
                  </button>
                </div>
              </section>
            ) : rolesLoading || levelsLoading ? (
              <LoadingState label="角色與層級資料載入中…" />
            ) : rolesLoadError || levelsLoadError ? (
              <ErrorState
                title="角色資料載入失敗"
                description={rolesLoadError || levelsLoadError}
                onRetry={() => { void Promise.all([loadRoles(), loadLevels()]); }}
              />
            ) : roleRows.length === 0 ? (
              <EmptyState
                title="尚無角色"
                description="使用右上角「新增角色」或「批次上傳」建立角色。"
              />
            ) : (
              <section className="panel data-panel">
                {renderLevelCreate("role")}
                {roleSections.map((section) => (
                  <div className="level-section" key={section.level?.id ?? "ungrouped"}>
                    {renderLevelHead(
                      "role",
                      section.level,
                      section.items.reduce((n, r) => n + (r.memberCount ?? 0), 0),
                    )}
                    {renderRoleTable(section.items)}
                  </div>
                ))}
                <div className="panel-inset">
                  <p className="settings-note">
                    角色以名稱唯一；可在此新增角色、管理成員或刪除角色。成員管理與刪除限系統管理員。角色權限請到「組織與設定 → 權限管理」設定（按名稱共用）。
                  </p>
                </div>
              </section>
            )
      ) : null}
    </>
  );
}
