import { useAuth } from "../../../lib/auth";
import { useState, useRef, useEffect } from "react";
import type { Tab, GroupRow, GroupForm, UnitRow, UnitForm, TitleRow, TitleForm, UserRow, UserForm, OptionItem } from "../model/types";
import { useSortState } from "../../../components/ui";
import { emptyGroupForm, emptyUnitForm, emptyTitleForm, emptyUserForm } from "../model/forms";
import type { OrgLevel } from "../../../lib/orgLevels";
import { COMMITTEE_GROUP_ID, UNGROUPED_GROUP_ID, type Membership, formatUnitMembershipLabel } from "../../../lib/roleIdentity";
import { deriveRoleScope } from "../../../lib/roleDerivation";
import type { GroupsPageProps } from "../model/pageProps";

export function useGroupsState(props: GroupsPageProps) {
  const { initialTab, memberPage } = props;

  const { user } = useAuth();
  // v1.56.0：組織與設定整區塊只限系統管理員（原管理員或品管執行幹事可維護已收掉）。
  const isAdmin = (user?.roles ?? []).includes("系統管理員");

  const [tab, setTab] = useState<Tab>(initialTab ?? "groups");
  const { sortKey: listSortKey, sortDir: listSortDir, toggleSort, tableSort } = useSortState<string>("");
  const [userUnitFilter, setUserUnitFilter] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [unitGroupFilter, setUnitGroupFilter] = useState("");
  const [unitSearch, setUnitSearch] = useState("");
  /** v1.57.0 A1／A2：清單只在按「搜尋」後顯示；輸入框改篩選條件不即時過濾，按搜尋才套用 */
  const [appliedUserUnitFilter, setAppliedUserUnitFilter] = useState("");
  const [appliedUserSearch, setAppliedUserSearch] = useState("");
  const [usersSearched, setUsersSearched] = useState(false);
  const [appliedUnitGroupFilter, setAppliedUnitGroupFilter] = useState("");
  const [appliedUnitSearch, setAppliedUnitSearch] = useState("");
  const [unitsSearched, setUnitsSearched] = useState(false);

  function sortedRows<T>(
    items: T[],
    key: string,
    valueOf: (row: T, key: string) => string | number,
  ) {
    return [...items].sort((a, b) => {
      const av = valueOf(a, key);
      const bv = valueOf(b, key);
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv), "zh-Hant", { numeric: true });
      return listSortDir * cmp;
    });
  }

  // ---- 群組 ----
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [masterLoading, setMasterLoading] = useState(true);
  const [masterLoadError, setMasterLoadError] = useState("");
  const [groupView, setGroupView] = useState<
    { kind: "list" } | { kind: "create" } | { kind: "edit"; id: string }
  >({ kind: "list" });
  const [groupForm, setGroupForm] = useState<GroupForm>(emptyGroupForm());
  const [groupError, setGroupError] = useState("");
  const [groupSaving, setGroupSaving] = useState(false);

  // ---- 單位 ----
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [unitView, setUnitView] = useState<
    { kind: "list" } | { kind: "create" } | { kind: "edit"; code: string }
  >({ kind: "list" });
  const [unitForm, setUnitForm] = useState<UnitForm>(emptyUnitForm());
  const [unitError, setUnitError] = useState("");
  const [unitSaving, setUnitSaving] = useState(false);

  // ---- 職稱 ----
  const [titles, setTitles] = useState<TitleRow[]>([]);
  const [titlesLoading, setTitlesLoading] = useState(true);
  const [titlesLoadError, setTitlesLoadError] = useState("");
  const [titleView, setTitleView] = useState<
    { kind: "list" } | { kind: "create" } | { kind: "edit"; id: string }
  >({ kind: "list" });
  const [titleForm, setTitleForm] = useState<TitleForm>(emptyTitleForm());
  const [titleError, setTitleError] = useState("");
  const [titleSaving, setTitleSaving] = useState(false);

  // ---- 層級（v1.55.0 方案 A：層級做成可管理資料） ----
  const [titleLevels, setTitleLevels] = useState<OrgLevel[]>([]);
  const [roleLevels, setRoleLevels] = useState<OrgLevel[]>([]);
  const [levelsLoading, setLevelsLoading] = useState(true);
  const [levelsLoadError, setLevelsLoadError] = useState("");
  const [levelEdit, setLevelEdit] = useState<{
    target: "title" | "role";
    id: string;
    name: string;
  } | null>(null);
  const [levelCreateTarget, setLevelCreateTarget] = useState<"title" | "role" | null>(null);
  const [newLevelName, setNewLevelName] = useState("");
  const [levelError, setLevelError] = useState("");
  const [levelBusy, setLevelBusy] = useState(false);
  const migrationRanRef = useRef(false);

  // ---- 人員 ----
  const [users, setUsers] = useState<UserRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersLoadError, setUsersLoadError] = useState("");
  const [userView, setUserView] = useState<
    { kind: "list" } | { kind: "create" } | { kind: "edit"; staffId: string }
  >({ kind: "list" });
  const [userForm, setUserForm] = useState<UserForm>(emptyUserForm());
  const [userError, setUserError] = useState("");
  const userErrorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (userError) userErrorRef.current?.focus();
  }, [userError]);
  /** 群組＋角色加入區（v1.52.0 分工表式）：群組下拉＋角色勾選＋加入／更新 */
  const [membershipAddGroupId, setMembershipAddGroupId] = useState("");
  const [membershipAddRoles, setMembershipAddRoles] = useState<string[]>([]);
  /** v1.57.0 A6：群組→層級→角色三層下拉（層級與角色為加入區的暫存選擇，選後進已選角色） */
  const [membershipAddLevelId, setMembershipAddLevelId] = useState("");
  const [membershipAddRoleName, setMembershipAddRoleName] = useState("");
  /** v1.57.0 A7：職稱改層級→職稱兩層下拉（""＝未選層級，"__ungrouped__"＝未分層級） */
  const [userTitleLevelId, setUserTitleLevelId] = useState("");
  /** 正在編輯的列（群組 id）；null＝加入模式 */
  const [membershipEditingGroupId, setMembershipEditingGroupId] = useState<string | null>(null);
  const [membershipError, setMembershipError] = useState("");

  const groupNameOf = (groupId: string): string =>
    // v1.87.0：委員會特殊值 "ALL" 顯示為「全院」
    // v1.88.6：單位級角色暫存值 "__ungrouped__" 顯示為「未歸屬品管組」
    groupId === COMMITTEE_GROUP_ID
      ? "全院"
      : groupId === UNGROUPED_GROUP_ID
        ? "未歸屬品管組"
        : (groups.find((g) => g.id === groupId)?.name ?? groupId);

  /** 該列是否全為單位級角色（角色主檔 levelId 為準，未載入時以名稱推導退路） */
  const isUnitLevelMembershipRow = (m: Membership): boolean =>
    m.roles.length > 0 &&
    m.roles.every((r) => {
      const opt = roleOptions.find((o) => o.name === r);
      if (opt?.levelId) {
        return (
          opt.levelId === "rl-unit" ||
          roleLevels.find((l) => l.id === opt.levelId)?.name === "單位"
        );
      }
      return deriveRoleScope({ name: r }) === "unit";
    });

  /** v1.88.6：人員編輯列表中，單位級角色列的群組欄顯示為
   * 「品管組/單位(9B)」——前面是品管組名（未歸屬為「未歸屬品管組」），
   * 後面是所屬單位；單位為空顯示「—」。角色欄另顯示角色名稱，
   * 整列合起來即「品管組/單位(9B)、角色(單位召集人)」。委員會與
   * 品管組層級列維持現狀，只顯示品管組名。 */
  const membershipRowGroupLabel = (m: Membership): string =>
    isUnitLevelMembershipRow(m)
      ? formatUnitMembershipLabel(groupNameOf(m.groupId), userForm.unitCode)
      : groupNameOf(m.groupId);
  const unitLabelOf = (unitCode: string): string => {
    const unit = units.find((item) => item.code === unitCode);
    return unit ? `${unit.code}${unit.name ? ` ${unit.name}` : ""}` : unitCode;
  };
  const [userSaving, setUserSaving] = useState(false);
  // v1.51.0：一次性補建審查員名單（管理員手動觸發）
  const [backfilling, setBackfilling] = useState(false);
  const [roleOptions, setRoleOptions] = useState<OptionItem[]>([]);

  // ---- 角色（v1.39.0：一名一檔，只寫名稱；建立後請至權限管理設定權限） ----
  const [rolesLoading, setRolesLoading] = useState(true);
  const [rolesLoadError, setRolesLoadError] = useState("");
  const [roleCreateOpen, setRoleCreateOpen] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
  /** v1.55.0：新角色所屬層級（空＝未分層級）；v1.57.0 A3：身分由名稱關鍵字、範圍由層級推導，不再選類別／範圍 */
  const [newRoleLevelId, setNewRoleLevelId] = useState("");
  const [roleCreateError, setRoleCreateError] = useState("");
  const [roleCreateSaving, setRoleCreateSaving] = useState(false);
  /** 正在管理成員的角色 id（""＝未開啟；v1.86.0：只在獨立頁由 memberPage 帶入） */
  const [managingRoleId, setManagingRoleId] = useState(
    memberPage?.kind === "role" ? memberPage.id : "",
  );
  /** v1.57.0 A4：正在編輯的角色 id（""＝彈窗未開啟；與成員管理面板分開） */
  const [editingRoleId, setEditingRoleId] = useState("");
  const [roleMemberChecked, setRoleMemberChecked] = useState<string[]>([]);
  const [roleAddSearch, setRoleAddSearch] = useState("");
  const [roleAddGroupId, setRoleAddGroupId] = useState("");
  /** v1.87.0：單位級角色先選單位再設定該單位角色的人員（""＝全部單位） */
  const [roleAddUnitCode, setRoleAddUnitCode] = useState("");
  const [roleAddChecked, setRoleAddChecked] = useState<string[]>([]);
  const [roleBusy, setRoleBusy] = useState(false);

  // ---- 單位成員管理（v1.21；v1.86.1：只在獨立頁由 memberPage 帶入）
  const [managingUnitCode] = useState(
    memberPage?.kind === "unit" ? memberPage.id : "",
  );
  const [unitMemberChecked, setUnitMemberChecked] = useState<string[]>([]);
  const [unitAddSearch, setUnitAddSearch] = useState("");
  const [unitBusy, setUnitBusy] = useState(false);

  // ---- 職稱成員管理（v1.21；v1.86.0：只在獨立頁由 memberPage 帶入） ----
  const [managingTitleId] = useState(
    memberPage?.kind === "title" ? memberPage.id : "",
  );
  const [titleMemberChecked, setTitleMemberChecked] = useState<string[]>([]);
  // v1.88.16：成員表上方搜尋方框（搜現有成員，職編／姓名關鍵字；與下方「加入人員」搜非成員的搜尋框分開）
  const [titleMemberSearch, setTitleMemberSearch] = useState("");
  /** v1.88.19：職稱成員單位篩選器——第一次按「搜尋」才生效，之後改選即時生效（比照「人員」頁籤 appliedUserUnitFilter） */
  const [titleUnitFilter, setTitleUnitFilter] = useState("");
  const [appliedTitleUnitFilter, setAppliedTitleUnitFilter] = useState("");
  const [titleUnitSearched, setTitleUnitSearched] = useState(false);
  const [titleAddSearch, setTitleAddSearch] = useState("");
  const [titleAddChecked, setTitleAddChecked] = useState<string[]>([]);
  const [titleBusy, setTitleBusy] = useState(false);

  // ---- 群組單位管理（v1.21；v1.86.0：只在獨立頁由 memberPage 帶入） ----
  const [managingGroupId] = useState(
    memberPage?.kind === "group" ? memberPage.id : "",
  );
  const [groupUnitChecked, setGroupUnitChecked] = useState<string[]>([]);
  const [groupUnitAddSearch, setGroupUnitAddSearch] = useState("");
  const [groupBusy, setGroupBusy] = useState(false);

  // ---- 督導負責單位管理（v1.87.0：職稱成員管理下層獨立頁，由 memberPage 帶入督導人員職編） ----
  const [managingTitleUnitStaffId] = useState(
    memberPage?.kind === "title-units" ? memberPage.id : "",
  );
  const [titleUnitChecked, setTitleUnitChecked] = useState<string[]>([]);
  const [titleUnitAddSearch, setTitleUnitAddSearch] = useState("");
  const [titleUnitAddChecked, setTitleUnitAddChecked] = useState<string[]>([]);
  const [titleUnitBusy, setTitleUnitBusy] = useState(false);

  return {
    sortedRows,
    units,
    appliedUnitSearch,
    appliedUnitGroupFilter,
    listSortKey,
    users,
    appliedUserSearch,
    appliedUserUnitFilter,
    groupNameOf,
    roleOptions,
    managingRoleId,
    editingRoleId,
    titles,
    managingTitleId,
    roleAddUnitCode,
    roleAddSearch,
    managingUnitCode,
    unitAddSearch,
    titleMemberSearch,
    appliedTitleUnitFilter,
    titleAddSearch,
    managingGroupId,
    groupUnitAddSearch,
    setRolesLoading,
    setRolesLoadError,
    setRoleOptions,
    setMasterLoading,
    setMasterLoadError,
    setGroups,
    setUnits,
    setLevelsLoading,
    setLevelsLoadError,
    setTitleLevels,
    setRoleLevels,
    setTitlesLoading,
    setTitlesLoadError,
    setTitles,
    setUsersLoading,
    setUsersLoadError,
    setUsers,
    isAdmin,
    user,
    migrationRanRef,
    tab,
    setGroupForm,
    setGroupError,
    setGroupView,
    groups,
    groupView,
    groupForm,
    setGroupSaving,
    setUnitForm,
    setUnitError,
    setUnitView,
    unitView,
    unitForm,
    setUnitSaving,
    setTitleForm,
    setTitleError,
    setTitleView,
    titleView,
    titleForm,
    setTitleSaving,
    levelCreateTarget,
    newLevelName,
    setLevelError,
    titleLevels,
    roleLevels,
    setLevelBusy,
    setNewLevelName,
    setLevelCreateTarget,
    levelEdit,
    setLevelEdit,
    setUserForm,
    setUserError,
    setUserTitleLevelId,
    setUserView,
    setMembershipAddGroupId,
    setMembershipAddRoles,
    setMembershipAddLevelId,
    setMembershipAddRoleName,
    setMembershipEditingGroupId,
    setMembershipError,
    userForm,
    membershipAddLevelId,
    membershipAddGroupId,
    membershipEditingGroupId,
    membershipAddRoles,
    userView,
    setUserSaving,
    setBackfilling,
    setEditingRoleId,
    roleMemberChecked,
    setRoleBusy,
    setRoleMemberChecked,
    roleAddChecked,
    roleAddGroupId,
    setRoleAddChecked,
    setRoleAddSearch,
    setManagingRoleId,
    newRoleName,
    setRoleCreateError,
    setRoleCreateSaving,
    newRoleLevelId,
    setNewRoleName,
    setNewRoleLevelId,
    setRoleCreateOpen,
    unitMemberChecked,
    setUnitBusy,
    setUnitMemberChecked,
    setUnitAddSearch,
    titleMemberChecked,
    setTitleBusy,
    setTitleMemberChecked,
    titleAddChecked,
    setTitleAddChecked,
    setTitleAddSearch,
    managingTitleUnitStaffId,
    titleUnitAddSearch,
    titleUnitAddChecked,
    setTitleUnitBusy,
    setTitleUnitAddChecked,
    setTitleUnitAddSearch,
    titleUnitChecked,
    setTitleUnitChecked,
    groupUnitChecked,
    setGroupBusy,
    setGroupUnitChecked,
    setGroupUnitAddSearch,
    levelBusy,
    levelError,
    tableSort,
    toggleSort,
    setRoleAddGroupId,
    setRoleAddUnitCode,
    roleBusy,
    unitLabelOf,
    setTitleMemberSearch,
    titleUnitFilter,
    setTitleUnitFilter,
    titleUnitSearched,
    setAppliedTitleUnitFilter,
    setTitleUnitSearched,
    titleBusy,
    groupBusy,
    unitBusy,
    titleUnitBusy,
    roleCreateOpen,
    setTab,
    userUnitFilter,
    userSearch,
    setUserUnitFilter,
    setUserSearch,
    setAppliedUserUnitFilter,
    setAppliedUserSearch,
    setUsersSearched,
    backfilling,
    unitGroupFilter,
    unitSearch,
    setUnitGroupFilter,
    setUnitSearch,
    setAppliedUnitGroupFilter,
    setAppliedUnitSearch,
    setUnitsSearched,
    masterLoading,
    masterLoadError,
    unitsSearched,
    titlesLoading,
    levelsLoading,
    titlesLoadError,
    levelsLoadError,
    usersLoading,
    usersLoadError,
    usersSearched,
    roleCreateError,
    roleCreateSaving,
    rolesLoading,
    rolesLoadError,
    groupError,
    groupSaving,
    unitError,
    unitSaving,
    titleError,
    titleSaving,
    userError,
    userErrorRef,
    userTitleLevelId,
    membershipAddRoleName,
    membershipError,
    membershipRowGroupLabel,
    userSaving,
  };
}
