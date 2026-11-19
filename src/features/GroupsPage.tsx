import { ChevronLeft, Plus, X } from "lucide-react";
import { EmptyState, PageHeading } from "../components/ui";
import type { PageId } from "../types";
import type { GroupsPageProps } from "./groups/model/pageProps";
import { useGroupsCtx } from "./groups/hooks/useGroupsCtx";
import { UserFilterBar } from "./groups/tabs/users/UserFilterBar";
import { UnitFilterBar } from "./groups/tabs/units/UnitFilterBar";
import { GroupImportBar } from "./groups/tabs/groups/GroupImportBar";
import { UnitImportBar } from "./groups/tabs/units/UnitImportBar";
import { TitleImportBar } from "./groups/tabs/titles/TitleImportBar";
import { UserImportBar } from "./groups/tabs/users/UserImportBar";
import { RoleImportBar } from "./groups/tabs/roles/RoleImportBar";
import { GroupsListTab } from "./groups/tabs/groups/GroupsListTab";
import { UnitsListTab } from "./groups/tabs/units/UnitsListTab";
import { TitlesListTab } from "./groups/tabs/titles/TitlesListTab";
import { UsersNoAccessTab } from "./groups/tabs/users/UsersNoAccessTab";
import { UsersListTab } from "./groups/tabs/users/UsersListTab";
import { RolesListTab } from "./groups/tabs/roles/RolesListTab";
import { GroupFormTab } from "./groups/tabs/groups/GroupFormTab";
import { UnitFormTab } from "./groups/tabs/units/UnitFormTab";
import { TitleFormTab } from "./groups/tabs/titles/TitleFormTab";
import { UserFormTab } from "./groups/tabs/users/UserFormTab";
import { RoleEditDialog } from "./groups/tabs/roles/RoleEditDialog";
export { type GroupsTab, type OrgMemberTarget } from "./groups/model/types";

// ================= 主頁 =================

/**
 * v1.28 階段 4：users 全量讀取走參考資料共用快取（getCachedRefCollection）。
 * v1.27.2 的 usersInflight（只去重、不留快取）由它取代：進行中去重＋命中後
 * 跨頁共用；自己寫入後由 db.ts 統一出口自動失效，存檔後的 loadUsers 會重查。
 */

export function GroupsPage(props: GroupsPageProps) {
  const ctx = useGroupsCtx(props);
  const { memberPage, managingRole, managingTitle, groups, units, titleUnitSupervisor, titles, onOpenMemberPage, onBackToGroups, isAdmin, renderRoleMemberPanel, renderTitleMemberPanel, renderGroupUnitPanel, renderTitleUnitPanel, renderUnitMemberPanel, tab, groupView, openGroupCreate, setGroupView, unitView, openUnitCreate, setUnitView, titleView, openTitleCreate, setTitleView, roleCreateOpen, setRoleCreateOpen, setRoleCreateError, setNewRoleName, userView, openUserCreate, setUserView, setTab, users, roleOptions } = ctx;

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

      <UserFilterBar ctx={ctx} />
      <UnitFilterBar ctx={ctx} />

      {/* 批次上傳工具列（僅清單檢視） */}
      <GroupImportBar ctx={ctx} />
      <UnitImportBar ctx={ctx} />
      <TitleImportBar ctx={ctx} />
      <UserImportBar ctx={ctx} />
      <RoleImportBar ctx={ctx} />

      {tab === "groups" ? <GroupsListTab ctx={ctx} /> : tab === "units" ? <UnitsListTab ctx={ctx} /> : tab === "titles" ? <TitlesListTab ctx={ctx} /> : tab === "users" && !isAdmin ? <UsersNoAccessTab  /> : tab === "users" ? <UsersListTab ctx={ctx} /> : tab === "roles" ? <RolesListTab ctx={ctx} /> : null}

      <GroupFormTab ctx={ctx} />
      <UnitFormTab ctx={ctx} />
      <TitleFormTab ctx={ctx} />
      <UserFormTab ctx={ctx} />
      <RoleEditDialog ctx={ctx} />
    </>
  );
}
