import { groupedRolesLabel } from "../../../lib/roleIdentity";
import type { RoleRow } from "../model/types";
import { useMemo } from "react";
import type { useGroupsState } from "./useGroupsState";

export function useGroupsDerived(prev: ReturnType<typeof useGroupsState>) {
  const { sortedRows, units, appliedUnitSearch, appliedUnitGroupFilter, listSortKey, users, appliedUserSearch, appliedUserUnitFilter, groupNameOf, roleOptions, managingRoleId, editingRoleId, titles, managingTitleId, roleAddUnitCode, roleAddSearch, managingUnitCode, unitAddSearch, titleMemberSearch, appliedTitleUnitFilter, titleAddSearch, managingGroupId, groupUnitAddSearch } = prev;

  const visibleUnits = sortedRows(
    units.filter((row) => {
      const keyword = appliedUnitSearch.trim().toLocaleLowerCase();
      return (
        (!appliedUnitGroupFilter || row.groupId === appliedUnitGroupFilter) &&
        (!keyword ||
          row.code.toLocaleLowerCase().includes(keyword) ||
          row.name.toLocaleLowerCase().includes(keyword))
      );
    }),
    listSortKey,
    (row, key) =>
      key === "unit-name"
        ? row.name
        : key === "unit-group"
          ? row.groupName
          : key === "unit-count"
            ? (row.memberCount ?? -1)
            : row.code,
  );
  const visibleUsers = sortedRows(
    users.filter((row) => {
      const keyword = appliedUserSearch.trim().toLocaleLowerCase();
      return (
        (!appliedUserUnitFilter || row.unitCode === appliedUserUnitFilter) &&
        (!keyword ||
          row.staffId.toLocaleLowerCase().includes(keyword) ||
          row.name.toLocaleLowerCase().includes(keyword))
      );
    }),
    listSortKey,
    (row, key) =>
      key === "user-name"
        ? row.name
        : key === "user-unit"
          ? row.unitCode
          : key === "user-title"
            ? row.title
            : key === "user-role"
              ? groupedRolesLabel(row.memberships, groupNameOf)
              : key === "user-status"
                ? row.status
                : row.staffId,
  );

  /** 角色清單＋成員數（由 roleOptions 與人員清單衍生；一名一檔，成員＝roles 含該名或任一 membership 含該名） */
  const roleRows: RoleRow[] = useMemo(
    () =>
      roleOptions.map((r) => ({
        id: r.id,
        name: r.name,
        scope: r.scope ?? "group",
        levelId: r.levelId ?? "",
        order: r.order ?? Number.MAX_SAFE_INTEGER,
        memberCount:
          users.length > 0
            ? users.filter(
                (u) =>
                  u.roles.includes(r.name) ||
                  u.memberships.some((m) => m.roles.includes(r.name)),
              ).length
            : null,
      })),
    [roleOptions, users],
  );

  // ---- 各成員管理面板的衍生清單（v1.21） ----
  const managingRole = roleRows.find((r) => r.id === managingRoleId) ?? null;
  const editingRole = roleRows.find((r) => r.id === editingRoleId) ?? null;
  const managingTitle = titles.find((item) => item.id === managingTitleId) ?? null;
  const roleMembers = useMemo(
    () =>
      managingRole
        ? users.filter(
            (u) =>
              (u.roles.includes(managingRole.name) ||
                u.memberships.some((m) =>
                  m.roles.includes(managingRole.name),
                )) &&
              // v1.87.0：單位級角色選定單位時，只列該單位的成員
              (managingRole.scope !== "unit" ||
                !roleAddUnitCode ||
                u.unitCode === roleAddUnitCode),
          )
        : [],
    [users, managingRole, roleAddUnitCode],
  );
  const roleCandidates = useMemo(() => {
    if (!managingRole) return [];
    const kw = roleAddSearch.trim().toLowerCase();
    // v1.57.0 A5：比照職稱／單位成員面板，搜尋框為空不列候選、候選上限 20 筆
    if (kw === "") return [];
    return users
      .filter(
        (u) =>
          u.status === "在職" &&
          !u.roles.includes(managingRole.name) &&
          !u.memberships.some((m) => m.roles.includes(managingRole.name)) &&
          // v1.87.0：單位級角色選定單位時，只列該單位的候選人
          (managingRole.scope !== "unit" ||
            !roleAddUnitCode ||
            u.unitCode === roleAddUnitCode) &&
          (u.staffId.toLowerCase().includes(kw) ||
            u.name.toLowerCase().includes(kw)),
      )
      .slice(0, 20);
  }, [users, managingRole, roleAddSearch, roleAddUnitCode]);

  const unitMembers = useMemo(
    () =>
      managingUnitCode
        ? users.filter((u) => u.unitCode === managingUnitCode)
        : [],
    [users, managingUnitCode],
  );
  const unitCandidates = useMemo(() => {
    if (!managingUnitCode) return [];
    const kw = unitAddSearch.trim().toLowerCase();
    return users
      .filter(
        (u) =>
          u.status === "在職" &&
          u.unitCode !== managingUnitCode &&
          (kw === "" ||
            u.staffId.toLowerCase().includes(kw) ||
            u.name.toLowerCase().includes(kw)),
      )
      .slice(0, 20);
  }, [users, managingUnitCode, unitAddSearch]);

  const titleMembers = useMemo(
    () => {
      const title = titles.find((item) => item.id === managingTitleId);
      if (!title) return [];
      return users.filter((u) => u.titleId === title.id || (
        !u.titleId && u.title === title.name
      ));
    },
    [users, titles, managingTitleId],
  );
  // v1.88.16：成員表搜尋過濾（職編／姓名關鍵字；只影響顯示，不清除勾選）
  // v1.88.19：再加單位篩選（所屬單位；第一次按「搜尋」才生效，之後即時）
  const filteredTitleMembers = useMemo(() => {
    const kw = titleMemberSearch.trim().toLowerCase();
    return titleMembers.filter(
      (u) =>
        (appliedTitleUnitFilter === "" ||
          u.unitCode === appliedTitleUnitFilter) &&
        (kw === "" ||
          u.staffId.toLowerCase().includes(kw) ||
          u.name.toLowerCase().includes(kw)),
    );
  }, [titleMembers, titleMemberSearch, appliedTitleUnitFilter]);
  const titleCandidates = useMemo(() => {
    const title = titles.find((item) => item.id === managingTitleId);
    if (!title) return [];
    const kw = titleAddSearch.trim().toLowerCase();
    return users
      .filter(
        (u) =>
          u.status === "在職" &&
          u.titleId !== title.id &&
          !(u.titleId === "" && u.title === title.name) &&
          (kw === "" ||
            u.staffId.toLowerCase().includes(kw) ||
            u.name.toLowerCase().includes(kw)),
      )
      .slice(0, 20);
  }, [users, titles, managingTitleId, titleAddSearch]);

  const groupUnits = useMemo(
    () =>
      managingGroupId
        ? units.filter((u) => u.groupId === managingGroupId)
        : [],
    [units, managingGroupId],
  );

  /** v1.57.0 A5：群組加入單位改搜尋優先（搜尋框為空不列候選） */
  const groupUnitCandidates = useMemo(() => {
    if (!managingGroupId) return [];
    const kw = groupUnitAddSearch.trim().toLowerCase();
    if (kw === "") return [];
    return units.filter(
      (u) =>
        u.groupId !== managingGroupId &&
        (u.code.toLowerCase().includes(kw) ||
          u.name.toLowerCase().includes(kw)),
    );
  }, [units, managingGroupId, groupUnitAddSearch]);

  return {
    roleRows,
    managingRole,
    roleCandidates,
    roleMembers,
    managingTitle,
    filteredTitleMembers,
    titleCandidates,
    groupUnits,
    groupUnitCandidates,
    unitCandidates,
    unitMembers,
    visibleUnits,
    visibleUsers,
    editingRole,
  };
}
