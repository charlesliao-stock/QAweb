import { ChevronDown, ChevronLeft, Pencil, Plus, Trash2, X } from "lucide-react";
import { EmptyState, ErrorState, FilterPanel, FilterSearchField, ListPanelHead, LoadingState, MaskedNameInput, Modal, PageHeading, SectionTitle, FormSelect, SortableTh } from "../components/ui";
import { maskName } from "../lib/mask";
import { deriveRoles, groupedRolesSegments, isReviewerRole } from "../lib/roleIdentity";
import type { PageId } from "../types";
import { GROUP_SAMPLE, GROUP_HEADER, UNIT_SAMPLE, UNIT_HEADER, TITLE_SAMPLE, TITLE_HEADER, ROLE_SAMPLE, ROLE_HEADER, USER_SAMPLE, USER_HEADER } from "./groups/importers/samples";
import { BatchImporter } from "./groups/components/BatchImporter";
import { useGroupsState } from "./groups/hooks/useGroupsState";
import { useGroupsDerived } from "./groups/hooks/useGroupsDerived";
import { useGroupsLoaders } from "./groups/hooks/useGroupsLoaders";
import { useGroupsOrgActions } from "./groups/hooks/useGroupsOrgActions";
import { useGroupsUserActions } from "./groups/hooks/useGroupsUserActions";
import { useGroupsMemberActions } from "./groups/hooks/useGroupsMemberActions";
import { useGroupsImporters } from "./groups/hooks/useGroupsImporters";
import { useGroupsPanels } from "./groups/hooks/useGroupsPanels";
import type { GroupsPageProps } from "./groups/model/pageProps";
export { type GroupsTab, type OrgMemberTarget } from "./groups/model/types";

// ================= 主頁 =================

/**
 * v1.28 階段 4：users 全量讀取走參考資料共用快取（getCachedRefCollection）。
 * v1.27.2 的 usersInflight（只去重、不留快取）由它取代：進行中去重＋命中後
 * 跨頁共用；自己寫入後由 db.ts 統一出口自動失效，存檔後的 loadUsers 會重查。
 */

export function GroupsPage(props: GroupsPageProps) {
  const { memberPage, onOpenMemberPage, onBackToGroups, onAction } = props;
  const s0 = useGroupsState(props);
  const { sortedRows, units, appliedUnitSearch, appliedUnitGroupFilter, listSortKey, users, groupNameOf, roleOptions, titles, isAdmin, tab, setGroupForm, setGroupView, groups, groupView, groupForm, setUnitForm, setUnitView, unitView, unitForm, setTitleForm, setTitleView, titleView, titleForm, titleLevels, roleLevels, setUserForm, setUserTitleLevelId, setUserView, setMembershipAddGroupId, setMembershipAddRoles, setMembershipAddLevelId, setMembershipAddRoleName, setMembershipError, userForm, membershipAddLevelId, membershipAddGroupId, membershipEditingGroupId, membershipAddRoles, userView, setEditingRoleId, newRoleName, setRoleCreateError, newRoleLevelId, setNewRoleName, setNewRoleLevelId, setRoleCreateOpen, tableSort, toggleSort, roleCreateOpen, setTab, userUnitFilter, userSearch, setUserUnitFilter, setUserSearch, setAppliedUserUnitFilter, setAppliedUserSearch, setUsersSearched, backfilling, unitGroupFilter, unitSearch, setUnitGroupFilter, setUnitSearch, setAppliedUnitGroupFilter, setAppliedUnitSearch, setUnitsSearched, masterLoading, masterLoadError, unitsSearched, titlesLoading, levelsLoading, titlesLoadError, levelsLoadError, usersLoading, usersLoadError, usersSearched, roleCreateError, roleCreateSaving, rolesLoading, rolesLoadError, groupError, groupSaving, unitError, unitSaving, titleError, titleSaving, userError, userErrorRef, userTitleLevelId, membershipAddRoleName, membershipError, membershipRowGroupLabel, userSaving } = s0;
  const s1 = useGroupsDerived(s0);
  const { roleRows, managingRole, managingTitle, visibleUnits, visibleUsers, editingRole } = s1;
  const s2 = useGroupsLoaders(props, { ...s0, ...s1 });
  const { loadMaster, loadUsers, loadTitles, loadLevels, loadRoles, roleMeta } = s2;
  const s3 = useGroupsOrgActions(props, { ...s0, ...s1, ...s2 });
  const { openGroupCreate, openUnitCreate, openTitleCreate, openGroupEdit, handleGroupDelete, openUnitEdit, handleUnitDelete, handleGroupSave, handleUnitSave, handleTitleSave } = s3;
  const s4 = useGroupsUserActions(props, { ...s0, ...s1, ...s2, ...s3 });
  const { openUserCreate, handleBackfillReviewers, openUserEdit, handleToggleStatus, resetMembershipAddArea, membershipAddIsCommittee, membershipAddIsUnit, toggleMembershipAddRole, handleMembershipAddOrUpdate, cancelMembershipEdit, startMembershipEdit, removeMembershipByGroup, handleUserSave } = s4;
  const s5 = useGroupsMemberActions(props, { ...s0, ...s1, ...s2, ...s3, ...s4 });
  const { titleUnitSupervisor, handleRoleCreate, roleEditError, roleEditName, setRoleEditName, roleEditLevelId, setRoleEditLevelId, roleEditSaving, handleRoleRename } = s5;
  const s6 = useGroupsImporters(props, { ...s0, ...s1, ...s2, ...s3, ...s4, ...s5 });
  const { validateGroupRows, importGroupRows, validateUnitRows, importUnitRows, validateTitleRows, importTitleRows, validateUserRows, importUserRows, validateRoleRows, importRoleRows } = s6;
  const s7 = useGroupsPanels(props, { ...s0, ...s1, ...s2, ...s3, ...s4, ...s5, ...s6 });
  const { renderRoleMemberPanel, renderTitleMemberPanel, renderGroupUnitPanel, renderTitleUnitPanel, renderUnitMemberPanel, renderLevelCreate, titleSections, renderLevelHead, renderTitleTable, roleSections, renderRoleTable } = s7;

  // ================= 版面 =================

  const isGroupEditing = groupView.kind === "edit";
  const isUnitEditing = unitView.kind === "edit";
  const isTitleEditing = titleView.kind === "edit";
  const isUserEditing = userView.kind === "edit";
  const reviewerRoleSelected = isReviewerRole(
    deriveRoles(userForm.memberships.filter((membership) => membership.groupId)),
    roleMeta,
  );

  // v1.86.0：成員／單位管理獨立頁（App 以 PageId 切頁進入；只顯示該管理面板，不顯示頁籤與清單）
  if (memberPage) {
    const memberPageId: PageId =
      memberPage.kind === "role"
        ? "role-members"
        : memberPage.kind === "title"
          ? "title-members"
          : memberPage.kind === "group"
            ? "group-units"
            : memberPage.kind === "title-units"
              ? "title-units"
              : "unit-members";
    const targetMissing =
      (memberPage.kind === "role" && !managingRole) ||
      (memberPage.kind === "title" && !managingTitle) ||
      (memberPage.kind === "group" &&
        !groups.some((g) => g.id === memberPage.id)) ||
      (memberPage.kind === "unit" &&
        !units.some((u) => u.code === memberPage.id)) ||
      (memberPage.kind === "title-units" && !titleUnitSupervisor);
    // v1.87.0：下層頁返回上層頁（主任頁←副主任頁←督導頁←負責單位頁）
    const parentLabel = memberPage.parent
      ? memberPage.parent.kind === "title"
        ? titles.find((t) => t.id === memberPage.parent!.id)?.name ?? ""
        : ""
      : "";
    return (
      <>
        <button
          type="button"
          className="button button-ghost button-sm"
          onClick={() =>
            memberPage.parent
              ? onOpenMemberPage?.(memberPage.parent)
              : onBackToGroups?.()
          }
        >
          <ChevronLeft size={15} />
          {memberPage.parent && parentLabel
            ? `返回「${parentLabel}」成員管理`
            : "返回人員管理"}
        </button>
        <PageHeading page={memberPageId} />
        {!isAdmin ? (
          <section className="panel">
            <div className="empty-state-block">
              <b>僅系統管理員可管理</b>
              <p>如需新增或異動，請聯絡系統管理員。</p>
            </div>
          </section>
        ) : targetMissing ? (
          <EmptyState
            title="找不到此項目"
            description="該角色／職稱／品管組／單位可能已被刪除，請返回人員管理重新選擇。"
          />
        ) : memberPage.kind === "role" ? (
          renderRoleMemberPanel()
        ) : memberPage.kind === "title" ? (
          renderTitleMemberPanel()
        ) : memberPage.kind === "group" ? (
          renderGroupUnitPanel()
        ) : memberPage.kind === "title-units" ? (
          renderTitleUnitPanel()
        ) : (
          renderUnitMemberPanel()
        )}
      </>
    );
  }

  const headingAction = (() => {
    const back = (reset: () => void) => (
      <button className="button button-outline" onClick={reset}>
        <X size={15} />
        返回清單
      </button>
    );
    if (tab === "groups") {
      if (groupView.kind === "list")
        return isAdmin ? (
          <button className="button button-primary" onClick={openGroupCreate}>
            <Plus size={16} />
            新增品管組
          </button>
        ) : undefined;
      return back(() => setGroupView({ kind: "list" }));
    }
    if (tab === "units") {
      if (unitView.kind === "list")
        return isAdmin ? (
          <button className="button button-primary" onClick={openUnitCreate}>
            <Plus size={16} />
            新增單位
          </button>
        ) : undefined;
      return back(() => setUnitView({ kind: "list" }));
    }
    if (tab === "titles") {
      if (titleView.kind === "list")
        return isAdmin ? (
          <button className="button button-primary" onClick={openTitleCreate}>
            <Plus size={16} />
            新增職稱
          </button>
        ) : undefined;
      return back(() => setTitleView({ kind: "list" }));
    }
    if (tab === "roles") {
      if (roleCreateOpen)
        return back(() => {
          setRoleCreateOpen(false);
          setRoleCreateError("");
        });
      return isAdmin ? (
        <button
          className="button button-primary"
          onClick={() => {
            setNewRoleName("");
            setRoleCreateError("");
            setRoleCreateOpen(true);
          }}
        >
          <Plus size={16} /> 新增角色
        </button>
      ) : undefined;
    }
    if (tab === "users") {
      if (userView.kind === "list")
        return isAdmin ? (
          <button className="button button-primary" onClick={openUserCreate}>
            <Plus size={16} />
            新增人員
          </button>
        ) : undefined;
      return back(() => setUserView({ kind: "list" }));
    }
    return undefined;
  })();

  return (
    <>
      <PageHeading page="groups" action={headingAction} />

      <div className="admin-tabs" role="tablist" aria-label="品管組與人員分類">
        <button
          role="tab"
          aria-selected={tab === "groups"}
          className={tab === "groups" ? "active" : ""}
          onClick={() => setTab("groups")}
        >
          品管組<span>{groups.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === "units"}
          className={tab === "units" ? "active" : ""}
          onClick={() => setTab("units")}
        >
          單位<span>{units.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === "users"}
          className={tab === "users" ? "active" : ""}
          onClick={() => setTab("users")}
        >
          人員{isAdmin && <span>{users.length}</span>}
        </button>
        <button
          role="tab"
          aria-selected={tab === "roles"}
          className={tab === "roles" ? "active" : ""}
          onClick={() => setTab("roles")}
        >
          角色<span>{roleOptions.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === "titles"}
          className={tab === "titles" ? "active" : ""}
          onClick={() => setTab("titles")}
        >
          職稱<span>{titles.length}</span>
        </button>
      </div>

      {tab === "users" && userView.kind === "list" && isAdmin && (
        <FilterPanel
          actions={
            (userUnitFilter || userSearch) && (
              <button
                type="button"
                className="button button-outline button-sm"
                onClick={() => {
                  setUserUnitFilter("");
                  setUserSearch("");
                  setAppliedUserUnitFilter("");
                  setAppliedUserSearch("");
                }}
              >
                清除篩選
              </button>
            )
          }
        >
          <FormSelect label="單位" value={userUnitFilter}
                aria-label="依單位篩選人員"
                onChange={(e) => setUserUnitFilter(e.target.value)}>
                <option value="">全部單位</option>
                {units.map((unit) => (
                  <option key={unit.code} value={unit.code}>
                    {unit.name}（{unit.code}）
                  </option>
                ))}
              </FormSelect>
          <FilterSearchField
            label="人員關鍵字"
            placeholder="搜尋職編／姓名"
            value={userSearch}
            onChange={setUserSearch}
            onSearch={() => {
              setAppliedUserUnitFilter(userUnitFilter);
              setAppliedUserSearch(userSearch);
              setUsersSearched(true);
            }}
          />
          <button
            className="button button-outline button-sm"
            disabled={backfilling}
            onClick={handleBackfillReviewers}
            title="為現有具審查員角色但不在審查員名單內的人員補建名單文件（未分類）"
          >
            {backfilling ? "補建中…" : "補建審查員名單"}
          </button>
        </FilterPanel>
      )}
      {tab === "units" && unitView.kind === "list" && (
        <FilterPanel
          actions={
            (unitGroupFilter || unitSearch) && (
              <button
                type="button"
                className="button button-outline button-sm"
                onClick={() => {
                  setUnitGroupFilter("");
                  setUnitSearch("");
                  setAppliedUnitGroupFilter("");
                  setAppliedUnitSearch("");
                }}
              >
                清除篩選
              </button>
            )
          }
        >
          <FormSelect label="組別" value={unitGroupFilter}
                aria-label="依組別篩選單位"
                onChange={(e) => setUnitGroupFilter(e.target.value)}>
                <option value="">全部組別</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </FormSelect>
          <FilterSearchField
            label="單位關鍵字"
            placeholder="搜尋單位代號／名稱"
            value={unitSearch}
            onChange={setUnitSearch}
            onSearch={() => {
              setAppliedUnitGroupFilter(unitGroupFilter);
              setAppliedUnitSearch(unitSearch);
              setUnitsSearched(true);
            }}
          />
        </FilterPanel>
      )}

      {/* 批次上傳工具列（僅清單檢視） */}
      {tab === "groups" && groupView.kind !== "edit" && isAdmin && (
        <div className="batch-toolbar">
          <BatchImporter
            sampleBaseName="品管組範例"
            sampleRows={GROUP_SAMPLE}
            header={GROUP_HEADER}
            validateRows={validateGroupRows}
            importRows={importGroupRows}
            onDone={loadMaster}
            onAction={onAction}
          />
        </div>
      )}
      {tab === "units" && unitView.kind !== "edit" && isAdmin && (
        <div className="batch-toolbar">
          <BatchImporter
            sampleBaseName="單位範例"
            sampleRows={UNIT_SAMPLE}
            header={UNIT_HEADER}
            validateRows={validateUnitRows}
            importRows={importUnitRows}
            onDone={loadMaster}
            onAction={onAction}
          />
        </div>
      )}
      {tab === "titles" && titleView.kind !== "edit" && isAdmin && (
        <div className="batch-toolbar">
          <BatchImporter
            sampleBaseName="職稱範例"
            sampleRows={TITLE_SAMPLE}
            header={TITLE_HEADER}
            validateRows={validateTitleRows}
            importRows={importTitleRows}
            onDone={loadTitles}
            onAction={onAction}
          />
        </div>
      )}
      {tab === "users" && userView.kind !== "edit" && isAdmin && (
        <div className="batch-toolbar">
          <BatchImporter
            sampleBaseName="人員範例"
            sampleRows={USER_SAMPLE}
            header={USER_HEADER}
            validateRows={validateUserRows}
            importRows={importUserRows}
            sampleNote="範例：單位代號填入單位主檔的代號；職稱填現有職稱名稱；品管組與角色須按欄位成對填寫，可填兩組。"
            postImportNote="提醒：登入帳號由「Provision auth accounts」每小時自動對帳建立（也可到 GitHub Actions 手動執行）；人員從名單刪除或停用時，帳號也會一併刪除或停用。人員再於登入頁按「開通帳號」，到院內信箱（職編去掉開頭的 0＋@kmuh.org.tw）收認證連結設定密碼。"
            onDone={loadUsers}
            onAction={onAction}
          />
        </div>
      )}
      {tab === "roles" && !managingRole && isAdmin && (
        <div className="batch-toolbar">
          <BatchImporter
            sampleBaseName="角色範例"
            sampleRows={ROLE_SAMPLE}
            header={ROLE_HEADER}
            validateRows={validateRoleRows}
            importRows={importRoleRows}
            onDone={loadRoles}
            onAction={onAction}
          />
        </div>
      )}

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

      {tab === "groups" && groupView.kind !== "list" && (
        <Modal
          title={isGroupEditing ? "編輯品管組" : "新增品管組"}
          note="品管組名稱不可重複（例如：病房組）"
          onClose={() => setGroupView({ kind: "list" })}
        >
          {groupError && <div className="login-error">{groupError}</div>}
          <div className="form-grid">
            <div className="form-field">
              <label className="field-label">品管組名稱 *</label>
              <input
                className="text-input"
                value={groupForm.name}
                placeholder="例如 病房組"
                onChange={(e) =>
                  setGroupForm({ name: e.target.value })
                }
              />
            </div>
          </div>
          <div className="form-actions">
            <button
              className="button button-primary"
              disabled={groupSaving}
              onClick={handleGroupSave}
            >
              {groupSaving ? "儲存中…" : isGroupEditing ? "儲存修改" : "建立品管組"}
            </button>
            <button
              className="button button-outline"
              onClick={() => setGroupView({ kind: "list" })}
            >
              取消
            </button>
          </div>
        </Modal>
      )}
      {tab === "units" && unitView.kind !== "list" && (
        <Modal
          title={isUnitEditing ? `編輯單位 ${unitForm.code}` : "新增單位"}
          note={isUnitEditing ? "單位代號不可變更（更名時代號不變）" : undefined}
          onClose={() => setUnitView({ kind: "list" })}
        >
          {unitError && <div className="login-error">{unitError}</div>}
          <div className="form-grid">
            <div className="form-field">
              <label className="field-label">單位代號 *</label>
              <input
                className="text-input"
                value={unitForm.code}
                disabled={isUnitEditing}
                placeholder="例如 9A"
                onChange={(e) =>
                  setUnitForm((prev) => ({ ...prev, code: e.target.value }))
                }
              />
            </div>
            <div className="form-field">
              <label className="field-label">單位名稱 *</label>
              <input
                className="text-input"
                value={unitForm.name}
                placeholder="例如 9A病房"
                onChange={(e) =>
                  setUnitForm((prev) => ({ ...prev, name: e.target.value }))
                }
              />
            </div>
            <FormSelect label="所屬品管組" value={unitForm.groupId}
                  onChange={(e) =>
                    setUnitForm((prev) => ({ ...prev, groupId: e.target.value }))
                  }>
                  <option value="">— 未分類 —</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </FormSelect>
            <div className="form-field">
              <label className="field-label" htmlFor="merged-from-units">合併自舊單位（可複選）</label>
              <select
                id="merged-from-units"
                className="text-input"
                multiple
                size={Math.min(5, Math.max(3, units.length))}
                value={unitForm.mergedFromUnitCodes}
                onChange={(event) => setUnitForm((prev) => ({
                  ...prev,
                  mergedFromUnitCodes: Array.from(event.target.selectedOptions, (option) => option.value),
                }))}
              >
                {units.filter((candidate) => candidate.code !== unitForm.code && (
                  unitForm.mergedFromUnitCodes.includes(candidate.code) ||
                  !units.some((other) => other.code !== unitForm.code && other.mergedFromUnitCodes.includes(candidate.code))
                )).map((candidate) => (
                  <option key={candidate.code} value={candidate.code}>{candidate.name}（{candidate.code}）</option>
                ))}
              </select>
              <p className="settings-note">選取後，新單位護理長可在分析中查看合併前歷史資料；不會授予個人明細下鑽權限。</p>
            </div>
          </div>
          <div className="form-actions">
            <button
              className="button button-primary"
              disabled={unitSaving}
              onClick={handleUnitSave}
            >
              {unitSaving ? "儲存中…" : isUnitEditing ? "儲存修改" : "建立單位"}
            </button>
            <button
              className="button button-outline"
              onClick={() => setUnitView({ kind: "list" })}
            >
              取消
            </button>
          </div>
        </Modal>
      )}
      {tab === "titles" && titleView.kind !== "list" && (
        <Modal
          title={isTitleEditing ? "編輯職稱" : "新增職稱"}
          note="職稱以名稱唯一；跨單位設定請到權限管理。"
          onClose={() => setTitleView({ kind: "list" })}
        >
          {titleError && <div className="login-error">{titleError}</div>}
          <div className="form-grid">
            <div className="form-field">
              <label className="field-label">職稱名稱 *</label>
              <input
                className="text-input"
                value={titleForm.name}
                placeholder="例如 護理長"
                onChange={(e) =>
                  setTitleForm((prev) => ({ ...prev, name: e.target.value }))
                }
              />
            </div>
            <FormSelect label="層級" value={titleForm.levelId}
                  onChange={(e) =>
                    setTitleForm((prev) => ({ ...prev, levelId: e.target.value }))
                  }>
                  <option value="">— 未分層級 —</option>
                  {titleLevels.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </FormSelect>
            <div className="form-field">
              <label className="field-label">主管層級（決定儀表板與結果範圍；不以名稱判斷）</label>
              <div className="form-grid">
                {(
                  [
                    ["isUnitHead", "單位主管"],
                    ["isDistrictHead", "轄區主管"],
                    ["isHospitalHead", "院級主管"],
                    ["isOfficer", "執行幹事"],
                    ["isConvener", "召集人"],
                  ] as const
                ).map(([key, label]) => (
                  <label className="check-row" key={key}>
                    <input
                      type="checkbox"
                      checked={titleForm[key]}
                      onChange={(e) =>
                        setTitleForm((prev) => ({
                          ...prev,
                          [key]: e.target.checked,
                        }))
                      }
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="form-actions">
            <button
              className="button button-primary"
              disabled={titleSaving}
              onClick={handleTitleSave}
            >
              {titleSaving ? "儲存中…" : isTitleEditing ? "儲存修改" : "建立職稱"}
            </button>
            <button
              className="button button-outline"
              onClick={() => setTitleView({ kind: "list" })}
            >
              取消
            </button>
          </div>
        </Modal>
      )}
      {tab === "users" && userView.kind !== "list" && (
        <Modal
          title={isUserEditing ? `編輯人員 ${userForm.staffId}` : "新增人員"}
          note={isUserEditing ? "職編不可變更" : "儲存後請再到 Firebase Console → Authentication 建立登入帳號"}
          onClose={() => {
            resetMembershipAddArea();
            setUserView({ kind: "list" });
          }}
          wide
        >
        <div className="user-long-form">
          {userError && (
            <div ref={userErrorRef} className="login-error form-error-summary" role="alert" tabIndex={-1}>
              <b>請修正以下問題</b>
              <span>{userError}</span>
            </div>
          )}
          {/* v1.88.2：三區塊編號導覽列（1. 基本資料／2. 職稱／3. 品管組與角色）已拿掉 */}
          {(masterLoadError || titlesLoadError || rolesLoadError || levelsLoadError) && (
            <ErrorState
              title="人員表單參考資料載入失敗"
              description={[masterLoadError, titlesLoadError, rolesLoadError, levelsLoadError].filter(Boolean).join("；")}
              onRetry={() => { void Promise.all([loadMaster(), loadTitles(), loadRoles(), loadLevels()]); }}
            />
          )}
          <section id="user-form-basic" className="user-form-step" tabIndex={-1}>
            <SectionTitle title="基本資料" note="* 為必填欄位。" />
            <div className="user-form-fields">
          <div className="form-field">
            <label className="field-label">職編 *</label>
            <input
              className="text-input"
              aria-required="true"
              value={userForm.staffId}
              disabled={isUserEditing}
              placeholder="例如 A12345（即登入帳號）"
              onChange={(e) =>
                setUserForm((prev) => ({ ...prev, staffId: e.target.value }))
              }
            />
          </div>
          <FormSelect label="單位" value={userForm.unitCode}
                onChange={(e) => {
                  const nextUnitCode = e.target.value;
                  setUserForm((prev) => ({ ...prev, unitCode: nextUnitCode }));
                }}>
                <option value="">— 未指定 —</option>
                {units.map((u) => (
                  <option key={u.code} value={u.code}>
                    {u.name ? `${u.code}｜${u.name}` : u.code}
                  </option>
                ))}
              </FormSelect>
          <div className="form-field">
            <label className="field-label">姓名 *</label>
            <MaskedNameInput
              className="text-input"
              aria-required="true"
              value={userForm.name}
              placeholder="例如 王O明"
              onChange={(next) =>
                setUserForm((prev) => ({ ...prev, name: next }))
              }
            />
          </div>
          <div className="form-field">
            <label className="field-label">Email</label>
            <input
              className="text-input"
              type="email"
              value={userForm.email}
              placeholder="例如 name@example.com（供通知與重設密碼）"
              onChange={(e) =>
                setUserForm((prev) => ({ ...prev, email: e.target.value }))
              }
            />
          </div>
          <div className="form-field">
            <label className="field-label">到職日</label>
            <input
              className="text-input"
              type="date"
              value={userForm.hireDate}
              onChange={(e) =>
                setUserForm((prev) => ({ ...prev, hireDate: e.target.value }))
              }
            />
          </div>
          <div className="form-field">
            <label className="field-label">電話</label>
            <input
              className="text-input"
              value={userForm.phone}
              placeholder="例如 0912-345-678"
              onChange={(e) =>
                setUserForm((prev) => ({ ...prev, phone: e.target.value }))
              }
            />
          </div>
          {reviewerRoleSelected && (
            <div className="form-field">
              <label className="field-label" htmlFor="reviewer-access-expiry">審查員授權效期</label>
              <input
                id="reviewer-access-expiry"
                className="text-input"
                type="date"
                value={userForm.reviewerAccessExpiresAt}
                onChange={(event) => setUserForm((prev) => ({
                  ...prev,
                  reviewerAccessExpiresAt: event.target.value,
                }))}
              />
              <p className="settings-note">留白為永久有效（預設）；設定日期後，審查員權限於該日結束後失效。</p>
            </div>
          )}
          {!isUserEditing && (
            <div className="form-field user-form-note">
              <p className="settings-note">登入帳號為職編，認證信寄到「職編去掉開頭的 0＋@kmuh.org.tw」；新增後由每小時對帳建立登入帳號，該員在登入頁按「開通帳號」自行設定密碼；刪除或停用人員時，登入帳號也會一併刪除或停用。</p>
            </div>
          )}
            </div>
          </section>

          <section id="user-form-title" className="user-form-step" tabIndex={-1}>
            <SectionTitle title="職稱" note="先選層級，再選該層級的職稱。" />
            {/* v1.87.0：督導負責單位已搬到職稱成員管理頁的督導頁設定，人員編輯不再設 */}
            <div className="user-form-fields">
          <FormSelect label="層級" value={userTitleLevelId}
                onChange={(e) => {
                  setUserTitleLevelId(e.target.value);
                  setUserForm((prev) => ({ ...prev, titleId: "", title: "", titleUnitCodes: [] }));
                }}>
                <option value="">請選擇層級</option>
                {titleLevels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
                <option value="__ungrouped__">未分層級</option>
              </FormSelect>
          <div className="form-field">
            <label className="field-label">職稱</label>
            <div className="select-wrap">
              <select
                value={userForm.titleId}
                disabled={!userTitleLevelId}
                onChange={(e) => {
                  const title = titles.find((item) => item.id === e.target.value);
                  setUserForm((prev) => ({
                    ...prev,
                    titleId: title?.id ?? "",
                    title: title?.name ?? "",
                    // v1.58.0：換職稱時清空負責單位，改由新職稱的條件決定
                    titleUnitCodes: [],
                  }));
                }}
              >
                <option value="">
                  {userTitleLevelId ? "請選擇職稱" : "請先選擇層級"}
                </option>
                {titles
                  .filter((t) =>
                    userTitleLevelId === "__ungrouped__"
                      ? !t.levelId
                      : t.levelId === userTitleLevelId,
                  )
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
              <ChevronDown size={15} />
            </div>
            {userForm.titleId ? (
              <p className="settings-note">
                已選：{userForm.title}{" "}
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    setUserForm((prev) => ({ ...prev, titleId: "", title: "", titleUnitCodes: [] }))
                  }
                >
                  移除重選
                </button>
              </p>
            ) : (
              <p className="settings-note">可留白：新帳號預設為一般使用者，職稱與角色之後再賦予。</p>
            )}
          </div>
            </div>
          </section>

          <section id="user-form-roles" className="user-form-step" tabIndex={-1}>
        <SectionTitle
          title="品管組與角色"
          note="上方加入、下方列表；每個品管組的角色與權限各自隔離，加入後即顯示於列表，按「儲存修改」才生效。"
        />
        {/* v1.52.0：分工表式——上方加入區＋下方角色列表（每群組一列，可編輯／刪除） */}
        <div className="panel" style={{ padding: 12, marginBottom: 8 }}>
          {/* v1.57.0 A6：群組→層級→角色三層下拉；選角色後進下方已選列，可多重 */}
          <div className="user-form-fields">
            <FormSelect label="層級" value={membershipAddLevelId}
                  onChange={(e) => {
                    const next = e.target.value;
                    setMembershipAddLevelId(next);
                    setMembershipAddRoleName("");
                    // v1.88.1：切到委員會層級不選品管組，清掉殘留的品管組選擇
                    // v1.88.2：切到單位層級亦不選品管組，比照清除
                    if (
                      next === "rl-committee" ||
                      next === "rl-unit" ||
                      roleLevels.find((l) => l.id === next)?.name === "委員會" ||
                      roleLevels.find((l) => l.id === next)?.name === "單位"
                    ) {
                      setMembershipAddGroupId("");
                    }
                  }}>
                  <option value="">請選擇層級</option>
                  {roleLevels.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                  <option value="__ungrouped__">未分層級</option>
                </FormSelect>
            {/* v1.88.1：委員會在品管組之上，選委員會層級不顯示品管組下拉、不要求選擇
                v1.88.2：單位層級亦不顯示，範圍以基本資料的所屬單位為準 */}
            {!membershipAddIsCommittee && !membershipAddIsUnit && (
            <FormSelect label="品管組" value={membershipAddGroupId}
                  onChange={(e) => {
                    // v1.51.0：切換群組不得清空已勾角色（加入區群組與角色為獨立 state）
                    setMembershipAddGroupId(e.target.value);
                    setMembershipError("");
                  }}>
                  <option value="">請選擇品管組</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </FormSelect>
            )}
            <FormSelect label="角色" value={membershipAddRoleName}
                  disabled={!membershipAddLevelId}
                  onChange={(e) => {
                    const name = e.target.value;
                    if (name) {
                      setMembershipAddRoles((prev) =>
                        prev.includes(name) ? prev : [...prev, name],
                      );
                      setMembershipAddRoleName("");
                    }
                  }}>
                  <option value="">
                    {membershipAddLevelId ? "請選擇角色" : "請先選擇層級"}
                  </option>
                  {roleOptions
                    .filter(
                      (r) =>
                        (membershipAddLevelId === "__ungrouped__"
                          ? !r.levelId
                          : r.levelId === membershipAddLevelId) &&
                        !membershipAddRoles.includes(r.name),
                    )
                    .map((r) => (
                      <option key={r.id} value={r.name}>
                        {r.name}
                      </option>
                    ))}
                </FormSelect>
          </div>
          {membershipAddRoles.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                alignItems: "center",
                margin: "4px 0",
              }}
            >
              <span className="settings-note">已選：</span>
              {membershipAddRoles.map((r) => (
                <span key={r} className="status-pill muted">
                  {r}{" "}
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`移除 ${r}`}
                    onClick={() => toggleMembershipAddRole(r)}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {membershipEditingGroupId !== null && (
            <p className="settings-note">
              正在編輯：{groupNameOf(membershipEditingGroupId)}
              （按「更新」寫回原列；角色全取消會刪除該品管組）
            </p>
          )}
          {membershipError && <div className="login-error">{membershipError}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              className="button button-primary button-sm"
              onClick={handleMembershipAddOrUpdate}
            >
              {membershipEditingGroupId === null ? (
                <>
                  <Plus size={14} /> 加入
                </>
              ) : (
                "更新"
              )}
            </button>
            {membershipEditingGroupId !== null && (
              <button
                className="button button-outline button-sm"
                onClick={cancelMembershipEdit}
              >
                取消編輯
              </button>
            )}
          </div>
        </div>
        <div className="panel" style={{ padding: 12 }}>
          <p className="settings-note" style={{ marginTop: 0 }}>
            {userForm.memberships.length} 個品管組・
            {userForm.memberships.reduce((n, m) => n + m.roles.length, 0)} 個角色
          </p>
          {userForm.memberships.length === 0 ? (
            <p className="settings-note">尚無品管組＋角色，請由上方加入。</p>
          ) : (
            <div className="table-scroll">
              <table className="permission-table">
                <thead>
                  <tr>
                    <th>群組</th>
                    <th>角色</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {userForm.memberships.map((m) => (
                    <tr key={m.groupId}>
                      <td>
                        <b>{membershipRowGroupLabel(m)}</b>
                      </td>
                      <td>
                        {m.roles.map((r) => (
                          <span
                            key={r}
                            className="status-pill muted"
                            style={{ marginRight: 4 }}
                          >
                            {r}
                          </span>
                        ))}
                      </td>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => startMembershipEdit(m.groupId)}
                        >
                          <Pencil size={13} /> 編輯
                        </button>{" "}
                        <button
                          className="text-button"
                          onClick={() => removeMembershipByGroup(m.groupId)}
                        >
                          <Trash2 size={13} /> 刪除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="form-actions">
          <button
            className="button button-primary"
            disabled={userSaving}
            onClick={handleUserSave}
          >
            {userSaving ? "儲存中…" : isUserEditing ? "儲存修改" : "建立人員"}
          </button>
          <button
            className="button button-outline"
            onClick={() => {
              resetMembershipAddArea();
              setUserView({ kind: "list" });
            }}
          >
            取消
          </button>
        </div>
          </section>
        </div>
        </Modal>
      )}
      {editingRole && (
        <Modal
          title={`編輯角色「${editingRole.name}」`}
          note="角色以名稱唯一；改名會同步更新所有持有此角色的人員與權限範本。改層級影響範圍時權限範本一併遷移。身分由名稱關鍵字推導。跨設定請到權限管理。"
          onClose={() => setEditingRoleId("")}
        >
          {roleEditError && <div className="login-error">{roleEditError}</div>}
          <div className="form-field" style={{ maxWidth: 320 }}>
            <label className="field-label">角色名稱 *</label>
            <input
              className="text-input"
              value={roleEditName}
              placeholder="輸入角色名稱"
              onChange={(event) => setRoleEditName(event.target.value)}
            />
          </div>
          <FormSelect label="層級" maxWidth={320} value={roleEditLevelId}
                onChange={(event) => setRoleEditLevelId(event.target.value)}>
                <option value="">— 未分層級 —</option>
                {roleLevels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </FormSelect>
          <div className="form-actions">
            <button
              className="button button-primary"
              disabled={roleEditSaving}
              onClick={handleRoleRename}
            >
              {roleEditSaving ? "儲存中…" : "儲存修改"}
            </button>
            <button
              className="button button-outline"
              onClick={() => setEditingRoleId("")}
            >
              取消
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
