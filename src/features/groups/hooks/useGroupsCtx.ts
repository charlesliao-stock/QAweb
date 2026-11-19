import { useGroupsState } from "./useGroupsState";
import { useGroupsDerived } from "./useGroupsDerived";
import { useGroupsLoaders } from "./useGroupsLoaders";
import { useGroupsOrgActions } from "./useGroupsOrgActions";
import { useGroupsUserActions } from "./useGroupsUserActions";
import { useGroupsMemberActions } from "./useGroupsMemberActions";
import { useGroupsImporters } from "./useGroupsImporters";
import { useGroupsPanels } from "./useGroupsPanels";
import { isReviewerRole, deriveRoles } from "../../../lib/roleIdentity";
import type { GroupsPageProps } from "../model/pageProps";

export function useGroupsCtx(props: GroupsPageProps) {
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

  return {
    memberPage,
    managingRole,
    managingTitle,
    groups,
    units,
    titleUnitSupervisor,
    titles,
    onOpenMemberPage,
    onBackToGroups,
    isAdmin,
    renderRoleMemberPanel,
    renderTitleMemberPanel,
    renderGroupUnitPanel,
    renderTitleUnitPanel,
    renderUnitMemberPanel,
    tab,
    groupView,
    openGroupCreate,
    setGroupView,
    unitView,
    openUnitCreate,
    setUnitView,
    titleView,
    openTitleCreate,
    setTitleView,
    roleCreateOpen,
    setRoleCreateOpen,
    setRoleCreateError,
    setNewRoleName,
    userView,
    openUserCreate,
    setUserView,
    setTab,
    users,
    roleOptions,
    userUnitFilter,
    userSearch,
    setUserUnitFilter,
    setUserSearch,
    setAppliedUserUnitFilter,
    setAppliedUserSearch,
    setUsersSearched,
    backfilling,
    handleBackfillReviewers,
    unitGroupFilter,
    unitSearch,
    setUnitGroupFilter,
    setUnitSearch,
    setAppliedUnitGroupFilter,
    setAppliedUnitSearch,
    setUnitsSearched,
    validateGroupRows,
    importGroupRows,
    loadMaster,
    onAction,
    validateUnitRows,
    importUnitRows,
    validateTitleRows,
    importTitleRows,
    loadTitles,
    validateUserRows,
    importUserRows,
    loadUsers,
    validateRoleRows,
    importRoleRows,
    loadRoles,
    masterLoading,
    masterLoadError,
    tableSort,
    toggleSort,
    sortedRows,
    listSortKey,
    openGroupEdit,
    handleGroupDelete,
    unitsSearched,
    appliedUnitGroupFilter,
    appliedUnitSearch,
    visibleUnits,
    openUnitEdit,
    handleUnitDelete,
    titlesLoading,
    levelsLoading,
    titlesLoadError,
    levelsLoadError,
    loadLevels,
    renderLevelCreate,
    titleSections,
    renderLevelHead,
    renderTitleTable,
    usersLoading,
    usersLoadError,
    usersSearched,
    visibleUsers,
    groupNameOf,
    openUserEdit,
    handleToggleStatus,
    roleCreateError,
    newRoleName,
    newRoleLevelId,
    setNewRoleLevelId,
    roleLevels,
    roleCreateSaving,
    handleRoleCreate,
    rolesLoading,
    rolesLoadError,
    roleRows,
    roleSections,
    renderRoleTable,
    isGroupEditing,
    groupError,
    groupForm,
    setGroupForm,
    groupSaving,
    handleGroupSave,
    isUnitEditing,
    unitForm,
    unitError,
    setUnitForm,
    unitSaving,
    handleUnitSave,
    isTitleEditing,
    titleError,
    titleForm,
    setTitleForm,
    titleLevels,
    titleSaving,
    handleTitleSave,
    isUserEditing,
    userForm,
    resetMembershipAddArea,
    userError,
    userErrorRef,
    setUserForm,
    reviewerRoleSelected,
    userTitleLevelId,
    setUserTitleLevelId,
    membershipAddLevelId,
    setMembershipAddLevelId,
    setMembershipAddRoleName,
    setMembershipAddGroupId,
    membershipAddIsCommittee,
    membershipAddIsUnit,
    membershipAddGroupId,
    setMembershipError,
    membershipAddRoleName,
    setMembershipAddRoles,
    membershipAddRoles,
    toggleMembershipAddRole,
    membershipEditingGroupId,
    membershipError,
    handleMembershipAddOrUpdate,
    cancelMembershipEdit,
    membershipRowGroupLabel,
    startMembershipEdit,
    removeMembershipByGroup,
    userSaving,
    handleUserSave,
    editingRole,
    setEditingRoleId,
    roleEditError,
    roleEditName,
    setRoleEditName,
    roleEditLevelId,
    setRoleEditLevelId,
    roleEditSaving,
    handleRoleRename,
  };
}

export type GroupsCtx = ReturnType<typeof useGroupsCtx>;
