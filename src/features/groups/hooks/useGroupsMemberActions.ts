import { commitInBatches, auditFields } from "../model/forms";
import { getFirebaseDb } from "../../../lib/firebase";
import { syncReviewerDoc } from "../../../lib/reviewerSync";
import { deriveStoredRoles, UNGROUPED_GROUP_ID, COMMITTEE_GROUP_ID, mergeMembership } from "../../../lib/roleIdentity";
import { toErrorMessage } from "../../../lib/errors";
import type { UserRow, RoleRow, TitleRow, UnitRow } from "../model/types";
import { type WriteBatch, writeBatch, doc, collection, serverTimestamp, getDoc, updateDoc, setDoc } from "../../../lib/db";
import { templateDocId } from "../../../lib/permissions";
import { nextOrderInLevel, nextInLevel } from "../../../lib/orgLevels";
import { useState, useMemo } from "react";
import { deriveRoleScope } from "../../../lib/roleDerivation";
import { maskName } from "../../../lib/mask";
import type { GroupsPageProps } from "../model/pageProps";
import type { useGroupsState } from "./useGroupsState";
import type { useGroupsDerived } from "./useGroupsDerived";
import type { useGroupsLoaders } from "./useGroupsLoaders";
import type { useGroupsOrgActions } from "./useGroupsOrgActions";
import type { useGroupsUserActions } from "./useGroupsUserActions";

export function useGroupsMemberActions(props: GroupsPageProps, prev: ReturnType<typeof useGroupsState> & ReturnType<typeof useGroupsDerived> & ReturnType<typeof useGroupsLoaders> & ReturnType<typeof useGroupsOrgActions> & ReturnType<typeof useGroupsUserActions>) {
  const { onOpenMemberPage, onAction } = props;
  const { roleRows, setEditingRoleId, managingRoleId, roleMemberChecked, setRoleBusy, users, removeRoleFromUser, setRoleMemberChecked, loadUsers, roleMeta, roleAddChecked, roleLevels, units, roleAddUnitCode, roleAddGroupId, addRoleToUser, setRoleAddChecked, setRoleAddSearch, user, setManagingRoleId, loadRoles, newRoleName, setRoleCreateError, setRoleCreateSaving, newRoleLevelId, setNewRoleName, setNewRoleLevelId, setRoleCreateOpen, editingRoleId, managingUnitCode, unitMemberChecked, setUnitBusy, setUnitMemberChecked, loadMaster, titles, setUnitAddSearch, managingTitleId, titleMemberChecked, setTitleBusy, setTitleMemberChecked, loadTitles, titleAddChecked, setTitleAddChecked, setTitleAddSearch, managingTitleUnitStaffId, titleUnitAddSearch, titleUnitAddChecked, setTitleUnitBusy, setTitleUnitAddChecked, setTitleUnitAddSearch, titleUnitChecked, setTitleUnitChecked, managingGroupId, groupUnitChecked, groups, setGroupBusy, setGroupUnitChecked, setGroupUnitAddSearch } = prev;

  /** v1.57.0 A4：角色編輯改彈窗（名稱＋層級；成員管理維持內嵌面板） */
  function openRoleEdit(roleId: string) {
    const role = roleRows.find((item) => item.id === roleId);
    if (!role) return;
    setEditingRoleId(roleId);
    setRoleEditName(role.name);
    setRoleEditLevelId(role.levelId ?? "");
    setRoleEditError("");
  }

  /** v1.86.0：角色成員管理改跳獨立頁（原內嵌面板已移入 renderRoleMemberPanel） */
  function openRoleMembers(roleId: string) {
    onOpenMemberPage?.({ kind: "role", id: roleId });
  }

  async function handleRoleMembersRemove() {
    const role = roleRows.find((r) => r.id === managingRoleId);
    if (!role || roleMemberChecked.length === 0) return;
    const ok = window.confirm(
      `確定將 ${roleMemberChecked.length} 位人員移出角色「${role.name}」？`,
    );
    if (!ok) return;
    setRoleBusy(true);
    try {
      const targets = users.filter((u) =>
        roleMemberChecked.includes(u.staffId),
      );
      await commitInBatches(
        targets.map((u) => removeRoleFromUser(u, role.name)),
      );
      onAction(`已將 ${targets.length} 位人員移出角色「${role.name}」`);
      setRoleMemberChecked([]);
      await loadUsers();
      // v1.51.0：移出成員後同步審查員名單（不再具審查員身分者移除未分類文件）
      try {
        const db = getFirebaseDb();
        for (const u of targets) {
          // v1.58.0：roles 一律由移除後的分工表重算
          await syncReviewerDoc(
            db,
            u.staffId,
            deriveStoredRoles(
              u.memberships
                .map((m) => ({
                  ...m,
                  roles: m.roles.filter((r) => r !== role.name),
                }))
                .filter((m) => m.roles.length > 0),
              u.roles,
            ),
            roleMeta,
          );
        }
      } catch {
        onAction("審查員名單連動失敗，請聯絡系統管理員手動調整");
      }
    } catch (error) {
      onAction(`移除失敗：${toErrorMessage(error)}`);
    } finally {
      setRoleBusy(false);
    }
  }

  async function handleRoleMembersAdd() {
    const role = roleRows.find((r) => r.id === managingRoleId);
    if (!role || roleAddChecked.length === 0) return;
    const unitLevel = role.scope === "unit";
    // v1.87.0：委員會層級（層級 id rl-committee 或層級名「委員會」）不選品管組
    const roleLevel = roleLevels.find((l) => l.id === role.levelId);
    const committeeLevel =
      role.levelId === "rl-committee" || roleLevel?.name === "委員會";
    const unitGroupOf = (unitCode: string) =>
      // v1.88.6：單位尚未歸屬品管組時以 UNGROUPED_GROUP_ID 暫存登記，
      // 不擋加入、不跳過人員（與人員編輯加入區同一作法）
      units.find((u) => u.code === unitCode)?.groupId || UNGROUPED_GROUP_ID;
    const targets = users.filter((u) => roleAddChecked.includes(u.staffId));
    const ungrouped: string[] = [];
    const added: UserRow[] = [];
    const ops: Array<(b: WriteBatch) => void> = [];
    for (const u of targets) {
      let gid = "";
      if (committeeLevel) {
        // v1.87.0：委員會角色不選品管組，memberships 以 "ALL" 登記一列
        gid = COMMITTEE_GROUP_ID;
      } else if (unitLevel) {
        // v1.87.0：單位級角色先選單位（已選時以該單位的群組計；未選時沿用各人所屬單位）
        gid = roleAddUnitCode ? unitGroupOf(roleAddUnitCode) : unitGroupOf(u.unitCode);
        if (gid === UNGROUPED_GROUP_ID) ungrouped.push(u.staffId);
      } else {
        // v1.40.3：非單位級角色一律指定群組加入（角色分類建立的角色皆可按群組指派）
        gid = roleAddGroupId;
        if (!gid) {
          onAction("請先選擇此角色適用的品管組");
          return;
        }
      }
      ops.push(addRoleToUser(u, role.name, gid));
      added.push(u);
    }
    if (ops.length === 0) return;
    setRoleBusy(true);
    try {
      await commitInBatches(ops);
      onAction(`已將 ${ops.length} 位人員加入角色「${role.name}」`);
      // v1.88.6：未歸組者已暫存登記，明確告知而非靜默
      if (ungrouped.length > 0) {
        onAction(
          `其中 ${ungrouped.length} 位所屬單位尚未歸屬品管組，已先以「未歸屬品管組」登記；單位歸組後儲存時自動對應`,
        );
      }
      setRoleAddChecked([]);
      setRoleAddSearch("");
      await loadUsers();
      // v1.51.0：加入成員後同步審查員名單
      try {
        const db = getFirebaseDb();
        let linked = 0;
        for (const u of added) {
          // v1.58.0：roles 一律由加入後的分工表重算
          const gid = unitLevel ? unitGroupOf(u.unitCode) : roleAddGroupId;
          const result = await syncReviewerDoc(
            db,
            u.staffId,
            deriveStoredRoles(
              gid ? mergeMembership(u.memberships, gid, [role.name]) : u.memberships,
              u.roles,
            ),
            roleMeta,
          );
          if (result === "linked") linked += 1;
        }
        if (linked > 0) {
          onAction(`已將 ${linked} 位自動加入審查員名單（未分類）`);
        }
      } catch {
        onAction("審查員名單連動失敗，請聯絡系統管理員手動調整");
      }
    } catch (error) {
      onAction(`加入失敗：${toErrorMessage(error)}`);
    } finally {
      setRoleBusy(false);
    }
  }

  async function handleRoleDelete(row: RoleRow) {
    if (!user) return;
    const ok = window.confirm(
      `確定刪除角色「${row.name}」？將同時從所有人員的角色中移除此角色，此動作無法復原。`,
    );
    if (!ok) return;
    setRoleBusy(true);
    try {
      const targets = users.filter(
        (u) =>
          u.roles.includes(row.name) ||
          u.memberships.some((m) => m.roles.includes(row.name)),
      );
      await commitInBatches(
        targets.map((u) => removeRoleFromUser(u, row.name)),
      );
      const db = getFirebaseDb();
      const batch = writeBatch(db);
      batch.delete(doc(db, "roles", row.id));
      // v1.39.2：刪除角色一併刪除其權限範本；新文件無 kind、分類由名稱決定，
      // 群組／單位角色兩類都刪（與更名搬移兩類的做法一致，刪不存在的文件無作用）
      for (const category of ["group", "unitRole"] as const) {
        batch.delete(
          doc(db, "permissionTemplates", templateDocId(category, row.name)),
        );
      }
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user.staffId,
        actorName: user.name,
        action: "角色刪除",
        targetType: "role",
        targetId: row.id,
        detail: `刪除角色「${row.name}」`,
        before: { name: row.name, memberCount: targets.length },
        after: null,
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      onAction(
        `角色「${row.name}」已刪除（已從 ${targets.length} 位人員移除）`,
      );
      setManagingRoleId("");
      await loadRoles();
      await loadUsers();
      // v1.51.0：刪除角色後同步審查員名單
      try {
        for (const u of targets) {
          // v1.58.0：roles 一律由移除後的分工表重算
          await syncReviewerDoc(
            db,
            u.staffId,
            deriveStoredRoles(
              u.memberships
                .map((m) => ({
                  ...m,
                  roles: m.roles.filter((r) => r !== row.name),
                }))
                .filter((m) => m.roles.length > 0),
              u.roles,
            ),
            roleMeta,
          );
        }
      } catch {
        onAction("審查員名單連動失敗，請聯絡系統管理員手動調整");
      }
    } catch (error) {
      onAction(`刪除失敗：${toErrorMessage(error)}`);
    } finally {
      setRoleBusy(false);
    }
  }

  async function handleRoleCreate() {
    const name = newRoleName.trim();
    if (!name) {
      setRoleCreateError("請輸入角色名稱");
      return;
    }
    // v1.39.0：一名一檔，同名已有文件時擋下
    if (roleRows.some((role) => role.name === name)) {
      setRoleCreateError(`角色「${name}」已存在`);
      return;
    }
    setRoleCreateSaving(true);
    setRoleCreateError("");
    try {
      const db = getFirebaseDb();
      const roleRef = doc(collection(db, "roles"));
      const batch = writeBatch(db);
      batch.set(roleRef, {
        name,
        description: "",
        // v1.57.0 A3：不再寫入 category／kind；身分由名稱關鍵字、範圍由層級推導
        levelId: newRoleLevelId,
        // v1.88.8 補項：層級內順序（新角色排在該層最後）
        order: nextOrderInLevel(roleRows, newRoleLevelId),
        ...auditFields(user?.staffId ?? "", true),
      });
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user?.staffId ?? "",
        actorName: user?.name ?? "",
        action: "角色建立",
        targetType: "role",
        targetId: roleRef.id,
        detail: `建立角色「${name}」`,
        before: null,
        after: {
          name,
          levelId: newRoleLevelId,
        },
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      setNewRoleName("");
      setNewRoleLevelId("");
      setRoleCreateOpen(false);
      await loadRoles();
      onAction(`已新增角色「${name}」；請至權限管理設定權限`);
    } catch (error) {
      setRoleCreateError(`新增失敗：${toErrorMessage(error)}`);
    } finally {
      setRoleCreateSaving(false);
    }
  }

  /** 既有角色更名／改層級（v1.39.0 更名；v1.57.0 A3：類別／範圍改由名稱關鍵字／層級推導，不再手動設定）：
   * 只改名稱時同步更新持有此角色的人員與權限範本；改層級致範圍變動時遷移範本
   * group↔unitRole（範本文件 id 含類別）；更名後對應不斷（以文件 id 計）。
   * 舊文件上的 category／kind 欄位留著不動、不刪除、不遷移。 */
  const [roleEditName, setRoleEditName] = useState("");
  const [roleEditLevelId, setRoleEditLevelId] = useState("");
  const [roleEditError, setRoleEditError] = useState("");
  const [roleEditSaving, setRoleEditSaving] = useState(false);
  async function handleRoleRename() {
    const role = roleRows.find((r) => r.id === editingRoleId);
    if (!role || !user) return;
    const name = roleEditName.trim();
    if (!name) {
      setRoleEditError("請輸入角色名稱");
      return;
    }
    const nameChanged = name !== role.name;
    // 新範圍由改名後名稱＋新層級推導；範圍變動才遷移權限範本
    const newScope = deriveRoleScope({ levelId: roleEditLevelId, name });
    const scopeChanged = newScope !== role.scope;
    const levelChanged = (role.levelId ?? "") !== roleEditLevelId;
    if (!nameChanged && !scopeChanged && !levelChanged) {
      setRoleEditError("");
      setEditingRoleId("");
      return;
    }
    if (nameChanged && roleRows.some((r) => r.id !== role.id && r.name === name)) {
      setRoleEditError(`角色「${name}」已存在`);
      return;
    }
    setRoleEditError("");
    setRoleEditSaving(true);
    try {
      const db = getFirebaseDb();
      const oldName = role.name;
      const oldCategory = role.scope === "unit" ? "unitRole" : "group";
      const newCategory = newScope === "unit" ? "unitRole" : "group";
      if (nameChanged) {
        // 新名稱已有權限範本時擋下，避免覆蓋別的範本
        const [groupTpl, unitRoleTpl] = await Promise.all([
          getDoc(doc(db, "permissionTemplates", templateDocId("group", name))),
          getDoc(doc(db, "permissionTemplates", templateDocId("unitRole", name))),
        ]);
        if (groupTpl.exists() || unitRoleTpl.exists()) {
          setRoleEditError(`新名稱「${name}」已有權限範本，請先處理該範本再更名`);
          return;
        }
      }
      if (nameChanged) {
        const targets = users.filter(
          (u) =>
            u.roles.includes(oldName) ||
            u.memberships.some((m) => m.roles.includes(oldName)),
        );
        await commitInBatches(
          targets.map((u) => (b: WriteBatch) => {
            const roles = u.roles.map((r) => (r === oldName ? name : r));
            const memberships = u.memberships.map((m) => ({
              ...m,
              roles: m.roles.map((r) => (r === oldName ? name : r)),
            }));
            b.update(doc(db, "users", u.staffId), {
              roles,
              memberships,
              ...auditFields(user.staffId, false),
            });
            b.set(doc(collection(db, "auditLogs")), {
              actor: user.staffId,
              actorName: user.name,
              action: "人員角色異動",
              targetType: "user",
              targetId: u.staffId,
              detail: `角色更名：職編 ${u.staffId} 角色「${oldName}」→「${name}」`,
              before: { roles: u.roles, memberships: u.memberships },
              after: { roles, memberships },
              createdAt: serverTimestamp(),
            });
          }),
        );
      }
      const batch = writeBatch(db);
      batch.update(doc(db, "roles", role.id), {
        name,
        levelId: roleEditLevelId,
        ...auditFields(user.staffId, false),
      });
      // 權限範本遷移：舊（類別，舊名）→ 新（類別，新名）；類別或名稱其一變動皆遷移
      {
        const oldRef = doc(db, "permissionTemplates", templateDocId(oldCategory, oldName));
        const snap = await getDoc(oldRef);
        if (snap.exists()) {
          batch.set(doc(db, "permissionTemplates", templateDocId(newCategory, name)), {
            ...snap.data(),
            name,
            category: newCategory,
          });
          if (oldCategory !== newCategory || oldName !== name) batch.delete(oldRef);
        }
      }
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user.staffId,
        actorName: user.name,
        action: "角色更名",
        targetType: "role",
        targetId: role.id,
        detail: `角色「${oldName}」更新為「${name}」`,
        before: {
          name: oldName,
          scope: role.scope,
          levelId: role.levelId ?? "",
        },
        after: {
          name,
          scope: newScope,
          levelId: roleEditLevelId,
        },
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      await loadRoles();
      await loadUsers();
      setEditingRoleId("");
      onAction(`角色已更新為「${name}」`);
    } catch (error) {
      setRoleEditError(`儲存失敗：${toErrorMessage(error)}`);
    } finally {
      setRoleEditSaving(false);
    }
  }

  // ================= 單位成員（v1.21） =================

  async function handleUnitMembersRemove() {
    if (!managingUnitCode || unitMemberChecked.length === 0) return;
    const ok = window.confirm(
      `確定將 ${unitMemberChecked.length} 位人員移出單位 ${managingUnitCode}？`,
    );
    if (!ok) return;
    setUnitBusy(true);
    try {
      const me = user?.staffId ?? "";
      const targets = users.filter((item) => unitMemberChecked.includes(item.staffId));
      await commitInBatches(
        targets.map(
          (target) => (b: WriteBatch) => {
            b.update(doc(getFirebaseDb(), "users", target.staffId), {
              unitCode: "",
              title: "",
              titleId: "",
              ...auditFields(me, false),
            });
            b.set(doc(collection(getFirebaseDb(), "auditLogs")), {
              actor: me,
              actorName: user?.name ?? "",
              action: "人員單位異動",
              targetType: "user",
              targetId: target.staffId,
              detail: `職編 ${target.staffId} 移出單位 ${managingUnitCode}`,
              before: { unitCode: target.unitCode, titleId: target.titleId, title: target.title },
              after: { unitCode: "", titleId: "", title: "" },
              createdAt: serverTimestamp(),
            });
          },
        ),
      );
      onAction(
        `已將 ${unitMemberChecked.length} 位人員移出單位 ${managingUnitCode}`,
      );
      setUnitMemberChecked([]);
      await loadUsers();
      await loadMaster();
    } catch (error) {
      onAction(`移除失敗：${toErrorMessage(error)}`);
    } finally {
      setUnitBusy(false);
    }
  }

  async function handleUnitMemberAdd(staffId: string) {
    if (!managingUnitCode) return;
    const target = users.find((item) => item.staffId === staffId);
    if (!target) return;
    // v1.39.0：職稱只剩名稱，調單位時職稱一律保留
    const retainedTitle = target.titleId
      ? titles.find((title) => title.id === target.titleId)
      : titles.find((title) => title.name === target.title);
    setUnitBusy(true);
    try {
      const db = getFirebaseDb();
      const batch = writeBatch(db);
      batch.update(doc(db, "users", staffId), {
        unitCode: managingUnitCode,
        title: retainedTitle?.name ?? "",
        titleId: retainedTitle?.id ?? "",
        ...auditFields(user?.staffId ?? "", false),
      });
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user?.staffId ?? "",
        actorName: user?.name ?? "",
        action: "人員單位異動",
        targetType: "user",
        targetId: staffId,
        detail: `職編 ${staffId} 單位 ${target.unitCode} → ${managingUnitCode}`,
        before: { unitCode: target.unitCode, titleId: target.titleId, title: target.title },
        after: { unitCode: managingUnitCode, titleId: retainedTitle?.id ?? "", title: retainedTitle?.name ?? "" },
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      onAction(`已將 ${staffId} 加入單位 ${managingUnitCode}`);
      setUnitAddSearch("");
      await loadUsers();
      await loadMaster();
    } catch (error) {
      onAction(`加入失敗：${toErrorMessage(error)}`);
    } finally {
      setUnitBusy(false);
    }
  }

  // ================= 職稱成員（v1.21） =================

  async function handleTitleMembersRemove() {
    const title = titles.find((item) => item.id === managingTitleId);
    if (!title || titleMemberChecked.length === 0) return;
    const ok = window.confirm(
      `確定將 ${titleMemberChecked.length} 位人員移出職稱「${title.name}」？`,
    );
    if (!ok) return;
    setTitleBusy(true);
    try {
      const me = user?.staffId ?? "";
      const targets = users.filter((item) => titleMemberChecked.includes(item.staffId));
      await commitInBatches(
        targets.map(
          (target) => (b: WriteBatch) => {
            b.update(doc(getFirebaseDb(), "users", target.staffId), {
              title: "",
              titleId: "",
              ...auditFields(me, false),
            });
            b.set(doc(collection(getFirebaseDb(), "auditLogs")), {
              actor: me,
              actorName: user?.name ?? "",
              action: "人員職稱異動",
              targetType: "user",
              targetId: target.staffId,
              detail: `移除職編 ${target.staffId} 的職稱「${target.title}」`,
              before: { titleId: target.titleId, title: target.title, unitCode: target.unitCode },
              after: { titleId: "", title: "", unitCode: target.unitCode },
              createdAt: serverTimestamp(),
            });
          },
        ),
      );
      onAction(
        `已將 ${titleMemberChecked.length} 位人員移出職稱「${title.name}」`,
      );
      setTitleMemberChecked([]);
      await loadUsers();
      await loadTitles();
    } catch (error) {
      onAction(`移除失敗：${toErrorMessage(error)}`);
    } finally {
      setTitleBusy(false);
    }
  }

  /** v1.56.0：職稱加入成員改勾選批次加入，與角色頁同一流程（每人寫入內容與單筆加入相同）。 */
  async function handleTitleMembersAdd() {
    const title = titles.find((item) => item.id === managingTitleId);
    if (!title || titleAddChecked.length === 0) return;
    const targets = users.filter((item) => titleAddChecked.includes(item.staffId));
    setTitleBusy(true);
    try {
      const me = user?.staffId ?? "";
      await commitInBatches(
        targets.map(
          (target) => (b: WriteBatch) => {
            b.update(doc(getFirebaseDb(), "users", target.staffId), {
              title: title.name,
              titleId: title.id,
              ...auditFields(me, false),
            });
            b.set(doc(collection(getFirebaseDb(), "auditLogs")), {
              actor: me,
              actorName: user?.name ?? "",
              action: "人員職稱異動",
              targetType: "user",
              targetId: target.staffId,
              detail: `職編 ${target.staffId} 職稱「${target.title}」→「${title.name}」`,
              before: { titleId: target.titleId, title: target.title, unitCode: target.unitCode },
              after: { titleId: title.id, title: title.name, unitCode: target.unitCode },
              createdAt: serverTimestamp(),
            });
          },
        ),
      );
      onAction(`已將 ${targets.length} 位人員轉任「${title.name}」`);
      setTitleAddChecked([]);
      setTitleAddSearch("");
      await loadUsers();
      await loadTitles();
    } catch (error) {
      onAction(`加入失敗：${toErrorMessage(error)}`);
    } finally {
      setTitleBusy(false);
    }
  }

  // ================= 職稱下層／督導負責單位（v1.87.0） =================

  /** v1.88.8 補項：職稱下層＝同層級內 order 緊鄰的下一個（讀 order，不寫死職稱名）。
   * 部級最末（督導）無人員下層，其下屬為單位清單；護理長/副護理長→護理師、護理師→護士。 */
  function childTitlesFor(title: TitleRow): TitleRow[] {
    const next = nextInLevel(titles, title);
    return next ? [next] : [];
  }

  /** v1.88.8 補項：角色下層＝同層級內 order 緊鄰的下一個（與職稱同規則）。 */
  function childRolesFor(role: RoleRow): RoleRow[] {
    const next = nextInLevel(roleRows, role);
    return next ? [next] : [];
  }

  /** v1.87.0：督導負責單位（titleUnitCodes 對應的單位清單） */
  const titleUnitSupervisor = useMemo(
    () =>
      managingTitleUnitStaffId
        ? users.find((u) => u.staffId === managingTitleUnitStaffId)
        : undefined,
    [users, managingTitleUnitStaffId],
  );
  const titleUnits = useMemo(() => {
    if (!titleUnitSupervisor) return [];
    const codes = titleUnitSupervisor.titleUnitCodes ?? [];
    return codes
      .map((code) => units.find((u) => u.code === code))
      .filter((u): u is UnitRow => Boolean(u));
  }, [titleUnitSupervisor, units]);
  const titleUnitCandidates = useMemo(() => {
    if (!titleUnitSupervisor) return [];
    const kw = titleUnitAddSearch.trim().toLowerCase();
    if (kw === "") return [];
    const owned = new Set(titleUnitSupervisor.titleUnitCodes ?? []);
    return units
      .filter(
        (u) =>
          !owned.has(u.code) &&
          (u.code.toLowerCase().includes(kw) ||
            u.name.toLowerCase().includes(kw)),
      )
      .slice(0, 20);
  }, [units, titleUnitSupervisor, titleUnitAddSearch]);

  /** v1.87.0：督導負責單位加入（勾選單位＝寫入該督導的 titleUnitCodes） */
  async function handleTitleUnitsAdd() {
    const sup = titleUnitSupervisor;
    if (!sup || titleUnitAddChecked.length === 0) return;
    const targets = units.filter((u) => titleUnitAddChecked.includes(u.code));
    setTitleUnitBusy(true);
    try {
      const me = user?.staffId ?? "";
      const next = [...(sup.titleUnitCodes ?? []), ...targets.map((u) => u.code)];
      await updateDoc(doc(getFirebaseDb(), "users", sup.staffId), {
        titleUnitCodes: next,
        ...auditFields(me, false),
      });
      await setDoc(doc(collection(getFirebaseDb(), "auditLogs")), {
        actor: me,
        actorName: user?.name ?? "",
        action: "督導負責單位異動",
        targetType: "user",
        targetId: sup.staffId,
        detail: `職編 ${sup.staffId}（${maskName(sup.name)}）新增負責單位 ${targets
          .map((u) => `${u.code} ${u.name}`)
          .join("、")}`,
        before: { titleUnitCodes: sup.titleUnitCodes ?? [] },
        after: { titleUnitCodes: next },
        createdAt: serverTimestamp(),
      });
      onAction(`已為 ${maskName(sup.name)} 新增負責單位 ${targets.length} 個`);
      setTitleUnitAddChecked([]);
      setTitleUnitAddSearch("");
      await loadUsers();
    } catch (error) {
      onAction(`加入失敗：${toErrorMessage(error)}`);
    } finally {
      setTitleUnitBusy(false);
    }
  }

  /** v1.87.0：督導負責單位移除 */
  async function handleTitleUnitsRemove() {
    const sup = titleUnitSupervisor;
    if (!sup || titleUnitChecked.length === 0) return;
    const ok = window.confirm(
      `確定將 ${titleUnitChecked.length} 個單位移出 ${maskName(sup.name)} 的負責單位？`,
    );
    if (!ok) return;
    setTitleUnitBusy(true);
    try {
      const me = user?.staffId ?? "";
      const next = (sup.titleUnitCodes ?? []).filter(
        (code) => !titleUnitChecked.includes(code),
      );
      await updateDoc(doc(getFirebaseDb(), "users", sup.staffId), {
        titleUnitCodes: next,
        ...auditFields(me, false),
      });
      await setDoc(doc(collection(getFirebaseDb(), "auditLogs")), {
        actor: me,
        actorName: user?.name ?? "",
        action: "督導負責單位異動",
        targetType: "user",
        targetId: sup.staffId,
        detail: `職編 ${sup.staffId}（${maskName(sup.name)}）移除負責單位 ${titleUnitChecked.join("、")}`,
        before: { titleUnitCodes: sup.titleUnitCodes ?? [] },
        after: { titleUnitCodes: next },
        createdAt: serverTimestamp(),
      });
      onAction(`已移出 ${titleUnitChecked.length} 個負責單位`);
      setTitleUnitChecked([]);
      await loadUsers();
    } catch (error) {
      onAction(`移除失敗：${toErrorMessage(error)}`);
    } finally {
      setTitleUnitBusy(false);
    }
  }

  // ================= 群組單位（v1.21） =================

  async function handleGroupUnitsRemove() {
    if (!managingGroupId || groupUnitChecked.length === 0) return;
    const group = groups.find((g) => g.id === managingGroupId);
    const ok = window.confirm(
      `確定將 ${groupUnitChecked.length} 個單位移出品管組「${group?.name ?? ""}」？`,
    );
    if (!ok) return;
    setGroupBusy(true);
    try {
      const me = user?.staffId ?? "";
      await commitInBatches(
        groupUnitChecked.map(
          (code) => (b: WriteBatch) =>
            b.update(doc(getFirebaseDb(), "units", code), {
              groupId: "",
              ...auditFields(me, false),
            }),
        ),
      );
      onAction(
        `已將 ${groupUnitChecked.length} 個單位移出品管組「${group?.name ?? ""}」`,
      );
      setGroupUnitChecked([]);
      await loadMaster();
    } catch (error) {
      onAction(`移除失敗：${toErrorMessage(error)}`);
    } finally {
      setGroupBusy(false);
    }
  }

  async function handleGroupUnitAdd(code: string) {
    if (!managingGroupId) return;
    setGroupBusy(true);
    try {
      await updateDoc(doc(getFirebaseDb(), "units", code), {
        groupId: managingGroupId,
        ...auditFields(user?.staffId ?? "", false),
      });
      onAction(`已將單位 ${code} 加入品管組`);
      setGroupUnitAddSearch("");
      await loadMaster();
    } catch (error) {
      onAction(`加入失敗：${toErrorMessage(error)}`);
    } finally {
      setGroupBusy(false);
    }
  }

  return {
    titleUnitSupervisor,
    openRoleEdit,
    openRoleMembers,
    handleRoleDelete,
    childRolesFor,
    handleRoleMembersAdd,
    handleRoleMembersRemove,
    childTitlesFor,
    handleTitleMembersRemove,
    handleTitleMembersAdd,
    handleGroupUnitsRemove,
    handleGroupUnitAdd,
    handleUnitMemberAdd,
    handleUnitMembersRemove,
    titleUnitCandidates,
    handleTitleUnitsAdd,
    titleUnits,
    handleTitleUnitsRemove,
    handleRoleCreate,
    roleEditError,
    roleEditName,
    setRoleEditName,
    roleEditLevelId,
    setRoleEditLevelId,
    roleEditSaving,
    handleRoleRename,
  };
}
