import { emptyUserForm, auditFields } from "../model/forms";
import { UNGROUPED_GROUP_ID, COMMITTEE_GROUP_ID, mergeMembership, applyMembershipEdit, removeMembership, deriveStoredRoles, isReviewerRole, resolveUngroupedMemberships, deriveGroupIds } from "../../../lib/roleIdentity";
import { getDoc, doc, writeBatch, collection, serverTimestamp, type WriteBatch } from "../../../lib/db";
import { getFirebaseDb } from "../../../lib/firebase";
import { isSupervisorTitleName } from "../../../lib/orgLevels";
import { syncReviewerDoc, backfillReviewerDocs } from "../../../lib/reviewerSync";
import { toErrorMessage } from "../../../lib/errors";
import type { UserRow } from "../model/types";
import { maskName } from "../../../lib/mask";
import type { GroupsPageProps } from "../model/pageProps";
import type { useGroupsState } from "./useGroupsState";
import type { useGroupsDerived } from "./useGroupsDerived";
import type { useGroupsLoaders } from "./useGroupsLoaders";
import type { useGroupsOrgActions } from "./useGroupsOrgActions";

export function useGroupsUserActions(props: GroupsPageProps, prev: ReturnType<typeof useGroupsState> & ReturnType<typeof useGroupsDerived> & ReturnType<typeof useGroupsLoaders> & ReturnType<typeof useGroupsOrgActions>) {
  const { onAction } = props;
  const { setUserForm, setUserError, setUserTitleLevelId, setUserView, users, titles, units, setMembershipAddGroupId, setMembershipAddRoles, setMembershipAddLevelId, setMembershipAddRoleName, setMembershipEditingGroupId, setMembershipError, userForm, roleLevels, roleOptions, membershipAddLevelId, membershipAddGroupId, membershipEditingGroupId, membershipAddRoles, groupNameOf, userView, user, roleMeta, setUserSaving, loadUsers, setBackfilling } = prev;

  // ================= 人員 =================

  function openUserCreate() {
    setUserForm(emptyUserForm());
    setUserError("");
    resetMembershipAddArea();
    setUserTitleLevelId("");
    setUserView({ kind: "create" });
  }

  function openUserEdit(staffId: string) {
    const row = users.find((u) => u.staffId === staffId);
    if (!row) return;
    const resolvedTitleId =
      row.titleId ||
      (() => {
        const matches = titles.filter((title) => title.name === row.title);
        return matches.length === 1 ? matches[0].id : "";
      })();
    const resolvedTitle = titles.find((item) => item.id === resolvedTitleId);
    setUserForm({
      staffId: row.staffId,
      name: row.name,
      unitCode: row.unitCode,
      title: row.title,
      titleId: resolvedTitleId,
      hireDate: "",
      email: "",
      phone: "",
      // v1.21：群組角色走 memberships 配對列
      // v1.52.0：無角色的列不載入表單（列表不呈現；儲存後跟著消失，
      // 群組歸屬可依單位設定。見 VERIFICATION_1.52.0.md 的 Q6 檢查）
      // v1.58.0：「其他角色」已刪除，roles 聯集一律由分工表衍生
      memberships: row.memberships
        .filter((m) => m.roles.length > 0)
        .map((m) => ({
          groupId: m.groupId,
          roles: [...m.roles],
        })),
      mustChangePassword: false,
      titleUnitCodes: [],
      reviewerAccessExpiresAt: row.reviewerAccessExpiresAt,
    });
    setUserError("");
    resetMembershipAddArea();
    // v1.57.0 A7：編輯時職稱層級由現職稱帶入（未分層級職稱帶入 "__ungrouped__"）
    setUserTitleLevelId(
      resolvedTitle ? resolvedTitle.levelId || "__ungrouped__" : "",
    );
    // v1.57.0 A6：人員已歸類群組時，群組自動帶入（先取已有角色的第一個群組，否則取所屬單位的群組）
    // v1.88.6：暫存值 "__ungrouped__" 不是真實群組，自動帶入時跳過
    const autoGroupId =
      row.memberships.find(
        (m) => m.roles.length > 0 && m.groupId !== UNGROUPED_GROUP_ID,
      )?.groupId ||
      units.find((u) => u.code === row.unitCode)?.groupId ||
      "";
    if (autoGroupId) setMembershipAddGroupId(autoGroupId);
    void (async () => {
      try {
        const snap = await getDoc(doc(getFirebaseDb(), "users", staffId));
        if (snap.exists()) {
          const data = snap.data();
          setUserForm((prev) => ({
            ...prev,
            hireDate: typeof data.hireDate === "string" ? data.hireDate : "",
            email: typeof data.email === "string" ? data.email : "",
            phone: typeof data.phone === "string" ? data.phone : "",
            titleUnitCodes: Array.isArray(data.titleUnitCodes)
              ? data.titleUnitCodes.map(String)
              : [],
            reviewerAccessExpiresAt: typeof data.reviewerAccessExpiresAt === "string"
              ? data.reviewerAccessExpiresAt
              : "",
          }));
        }
      } catch {
        // 讀不到細節欄位不阻擋編輯
      }
    })();
    setUserView({ kind: "edit", staffId });
  }

  /** 群組＋角色加入區（v1.52.0 分工表式）：清空加入區、回到加入模式 */
  function resetMembershipAddArea() {
    setMembershipAddGroupId("");
    setMembershipAddRoles([]);
    setMembershipAddLevelId("");
    setMembershipAddRoleName("");
    setMembershipEditingGroupId(null);
    setMembershipError("");
  }

  function toggleMembershipAddRole(roleName: string) {
    setMembershipAddRoles((prev) =>
      prev.includes(roleName)
        ? prev.filter((r) => r !== roleName)
        : [...prev, roleName],
    );
  }

  /** 點[編輯]：該列群組＋角色帶回上方加入區改 */
  function startMembershipEdit(groupId: string) {
    const row = userForm.memberships.find((m) => m.groupId === groupId);
    if (!row) return;
    setMembershipAddGroupId(row.groupId);
    // v1.88.1：編輯委員會列（groupId "ALL"）時把層級帶回委員會，加入區不顯示品管組下拉
    if (groupId === COMMITTEE_GROUP_ID) {
      const committeeLevel = roleLevels.find(
        (l) => l.id === "rl-committee" || l.name === "委員會",
      );
      if (committeeLevel) setMembershipAddLevelId(committeeLevel.id);
    }
    // v1.88.2：編輯單位角色列時把層級帶回單位（僅當該列角色皆為單位層級；
    // 混層級列維持原行為，避免改動其他層級角色的歸屬）
    if (groupId !== COMMITTEE_GROUP_ID && row.roles.length > 0) {
      const unitLevel = roleLevels.find(
        (l) => l.id === "rl-unit" || l.name === "單位",
      );
      const allUnitLevel = row.roles.every((r) => {
        const opt = roleOptions.find((o) => o.name === r);
        if (!opt?.levelId) return false;
        return (
          opt.levelId === "rl-unit" ||
          roleLevels.find((l) => l.id === opt.levelId)?.name === "單位"
        );
      });
      if (unitLevel && allUnitLevel) setMembershipAddLevelId(unitLevel.id);
    }
    setMembershipAddRoles([...row.roles]);
    setMembershipEditingGroupId(groupId);
    setMembershipError("");
  }

  function cancelMembershipEdit() {
    resetMembershipAddArea();
  }

  /** v1.88.1：委員會在品管組之上（層級 id rl-committee 或層級名「委員會」），選委員會層級不選品管組 */
  const membershipAddIsCommittee =
    membershipAddLevelId === "rl-committee" ||
    roleLevels.find((l) => l.id === membershipAddLevelId)?.name === "委員會";

  /** v1.88.2：單位層級（層級 id rl-unit 或層級名「單位」），選單位層級不選品管組，
   * 範圍以人員基本資料的所屬單位為準（見 handleMembershipAddOrUpdate 的推導） */
  const membershipAddIsUnit =
    membershipAddLevelId === "rl-unit" ||
    roleLevels.find((l) => l.id === membershipAddLevelId)?.name === "單位";

  /** [加入]／[更新]：加入時同群組合併、零勾選擋下；編輯到零角色刪列 */
  function handleMembershipAddOrUpdate() {
    // v1.88.1：委員會層級以 groupId "ALL" 登記一列，不要求選品管組（與 v1.87.0 角色成員管理頁一致）
    // v1.88.2：單位層級不選品管組，範圍以人員基本資料的所屬單位為準，
    // 以該單位所屬品管組（品管組頁籤設定，unit.groupId）登記一列；
    // can() 的單位角色不跨單位判斷即認此群組（permissions.ts unitRoleTemplateAllows：
    // 以本人 unitCode 查所屬群組，要求該群組的 membership 持有此角色），故推導結果與權限一致，
    // 與 v1.87.0 角色成員管理頁的單位級加入（unitGroupOf）同一作法，不需新欄位。
    // v1.88.6：單位尚未歸屬品管組時不再擋下加入（見下方 UNGROUPED_GROUP_ID），
    // 角色綁定與單位歸組分開；單位日後歸組後儲存時補回、權限即時推導。
    let gid = membershipAddIsCommittee ? COMMITTEE_GROUP_ID : membershipAddGroupId;
    if (membershipAddIsUnit) {
      if (!userForm.unitCode.trim()) {
        setMembershipError("請先填寫基本資料的單位");
        return;
      }
      // v1.88.6：選角色／加入角色與單位歸屬品管組分開綁定——單位尚未歸屬
      // 品管組時不再擋下加入，改以 UNGROUPED_GROUP_ID 暫存登記；單位日後
      // 歸組後，儲存時補回真實群組（handleUserSave），權限則即時推導
      // （permissions.ts unitRoleTemplateAllows）。列表顯示為「未歸屬品管組」。
      gid =
        units.find((u) => u.code === userForm.unitCode.trim())?.groupId ||
        UNGROUPED_GROUP_ID;
    }
    if (!gid) {
      setMembershipError("請先選擇品管組");
      return;
    }
    if (membershipEditingGroupId === null && membershipAddRoles.length === 0) {
      setMembershipError("請至少選擇一個角色");
      return;
    }
    setUserForm((prev) => ({
      ...prev,
      memberships:
        membershipEditingGroupId === null
          ? mergeMembership(prev.memberships, gid, membershipAddRoles)
          : applyMembershipEdit(
              prev.memberships,
              membershipEditingGroupId,
              gid,
              membershipAddRoles,
            ),
    }));
    // v1.88.6：單位尚未歸屬品管組時仍可加入（暫存登記），明確回饋而非靜默；
    // 列表該列顯示為「未歸屬品管組」。
    if (membershipAddIsUnit && gid === UNGROUPED_GROUP_ID) {
      onAction(
        `已加入角色（所屬單位尚未歸屬品管組，暫以「未歸屬品管組」登記；單位歸組後儲存時自動對應）`,
      );
    }
    resetMembershipAddArea();
  }

  /** 點[刪除]：先確認；只改表單 state，按「儲存修改」才生效（v1.88.19 補確認） */
  function removeMembershipByGroup(groupId: string) {
    if (
      !window.confirm(
        `確定刪除「${groupNameOf(groupId)}」的品管組與角色？按「儲存修改」後才真正刪除。`,
      )
    )
      return;
    setUserForm((prev) => ({
      ...prev,
      memberships: removeMembership(prev.memberships, groupId),
    }));
    if (membershipEditingGroupId === groupId) resetMembershipAddArea();
  }

  async function handleUserSave() {
    const view = userView;
    if (view.kind === "create" && !userForm.staffId.trim()) {
      setUserError("請填寫職編");
      return;
    }
    if (!userForm.name.trim()) {
      setUserError("請填寫姓名");
      return;
    }
    if (!user) {
      setUserError("請先登入");
      return;
    }
    // v1.55.0：新帳號預設為一般使用者，職稱可留白、之後再賦予。
    const selectedTitle = userForm.titleId
      ? titles.find((title) => title.id === userForm.titleId)
      : undefined;
    // v1.58.0：roles 聯集一律由分工表衍生，不再併其他角色；
    // 僅保留「系統管理員」與「一般人員」兩個例外（見 deriveStoredRoles）。
    // 編輯時以前次 roles 為準保留例外；新建時無前次 roles。
    const previousRoles =
      view.kind === "edit"
        ? (users.find((u) => u.staffId === view.staffId)?.roles ?? [])
        : [];
    const roles = deriveStoredRoles(
      userForm.memberships.filter((m) => m.groupId),
      previousRoles,
    );
    // v1.58.0：負責單位只在督導職稱時設定，其餘情況清空，避免舊值殘留。
    // v1.88.8：層級已併回部級／單位，督導以職稱名稱認定（「護理部督導」變體亦認）。
    const isSupervisorLevelTitle =
      isSupervisorTitleName(selectedTitle?.name ?? "") ||
      selectedTitle?.levelId === "tl-supervisor";
    const isDistrictHeadTitle =
      isSupervisorLevelTitle && selectedTitle?.isDistrictHead === true;
    const titleUnitCodes = isDistrictHeadTitle
      ? [...new Set(userForm.titleUnitCodes)]
      : [];
    const reviewerAccessExpiresAt = isReviewerRole(roles, roleMeta)
      ? userForm.reviewerAccessExpiresAt.trim()
      : "";
    if (reviewerAccessExpiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(reviewerAccessExpiresAt)) {
      setUserError("審查員效期請選擇有效日期；留白代表永久有效");
      return;
    }
    setUserError("");
    setUserSaving(true);
    try {
      const db = getFirebaseDb();
      // v1.21：memberships 為主；同步更新 groupIds（衍生）與 roles（聯集一律由分工表衍生，v1.58.0）
      // v1.88.6：儲存時把暫存列補回真實群組（所屬單位已歸組時，暫存列併入
      // 該群組列；仍未歸組則維持暫存列，角色照樣存下來）
      const healedMemberships = resolveUngroupedMemberships(
        userForm.memberships,
        units.find((u) => u.code === userForm.unitCode.trim())?.groupId ?? "",
      );
      const memberships = healedMemberships.filter((m) => m.groupId);
      const payload = {
        name: userForm.name.trim(),
        unitCode: userForm.unitCode,
        title: selectedTitle?.name ?? userForm.title,
        titleId: selectedTitle?.id ?? "",
        hireDate: userForm.hireDate,
        email: userForm.email.trim(),
        phone: userForm.phone.trim(),
        memberships,
        groupIds: deriveGroupIds(memberships),
        roles,
        reviewerAccessExpiresAt: reviewerAccessExpiresAt || null,
        titleUnitCodes,
        ...auditFields(user.staffId, false),
      };
      if (view.kind === "create") {
        const staffId = userForm.staffId.trim();
        const ref = doc(db, "users", staffId);
        const exists = await getDoc(ref);
        if (exists.exists()) {
          setUserError(`職編 ${staffId} 已存在`);
          setUserSaving(false);
          return;
        }
        const userPayload = {
          ...payload,
          mustChangePassword: userForm.mustChangePassword,
          ...auditFields(user.staffId, true),
        };
        const batch = writeBatch(db);
        batch.set(ref, userPayload);
        if (roles.length > 0 || memberships.length > 0) {
          batch.set(doc(collection(db, "auditLogs")), {
            actor: user.staffId,
            actorName: user.name,
            action: "建立人員權限",
            targetType: "user",
            targetId: staffId,
            detail: `建立職編 ${staffId} 並設定角色／品管組權限`,
            before: { roles: [], memberships: [] },
            after: {
              roles,
              memberships,
              reviewerAccessExpiresAt: reviewerAccessExpiresAt || null,
              unitCode: userForm.unitCode,
              titleId: selectedTitle?.id ?? "",
              title: selectedTitle?.name ?? userForm.title,
            },
            createdAt: serverTimestamp(),
          });
        }
        await batch.commit();
        onAction(
          `已新增人員 ${staffId}。登入帳號會由 GitHub Actions 每小時對帳自動建立；該員請在登入頁按「開通帳號」，到院內信箱（職編去掉開頭的 0＋@kmuh.org.tw）收認證連結並設定密碼`,
        );
      } else if (view.kind === "edit") {
        const userRef = doc(db, "users", view.staffId);
        const previousSnap = await getDoc(userRef);
        const previous = previousSnap.exists()
          ? (previousSnap.data() as Record<string, unknown>)
          : {};
        const beforePermissions = {
          roles: Array.isArray(previous.roles) ? previous.roles : [],
          memberships: Array.isArray(previous.memberships) ? previous.memberships : [],
          titleUnitCodes: Array.isArray(previous.titleUnitCodes) ? previous.titleUnitCodes : [],
          reviewerAccessExpiresAt: typeof previous.reviewerAccessExpiresAt === "string"
            ? previous.reviewerAccessExpiresAt
            : null,
          unitCode: typeof previous.unitCode === "string" ? previous.unitCode : "",
          titleId: typeof previous.titleId === "string" ? previous.titleId : "",
          title: typeof previous.title === "string" ? previous.title : "",
        };
        const afterPermissions = {
          roles,
          memberships,
          titleUnitCodes,
          reviewerAccessExpiresAt: reviewerAccessExpiresAt || null,
          unitCode: userForm.unitCode,
          titleId: selectedTitle?.id ?? "",
          title: selectedTitle?.name ?? userForm.title,
        };
        const permissionChanged = JSON.stringify(beforePermissions) !== JSON.stringify(afterPermissions);
        const batch = writeBatch(db);
        batch.update(userRef, payload);
        if (permissionChanged) {
          batch.set(doc(collection(db, "auditLogs")), {
            actor: user.staffId,
            actorName: user.name,
            action: "人員權限異動",
            targetType: "user",
            targetId: view.staffId,
            detail: `更新職編 ${view.staffId} 的角色／品管組權限`,
            before: beforePermissions,
            after: afterPermissions,
            createdAt: serverTimestamp(),
          });
        }
        await batch.commit();
        onAction(`人員 ${view.staffId} 已更新`);
      }
      setUserView({ kind: "list" });
      resetMembershipAddArea();
      await loadUsers();
      // 審查員連動（v1.12.0；v1.51.0 改由 reviewerSync 統一處理）
      const savedStaffId =
        view.kind === "edit" ? view.staffId : userForm.staffId.trim();
      try {
        const result = await syncReviewerDoc(db, savedStaffId, roles, roleMeta);
        if (result === "linked") {
          onAction(`已將 ${savedStaffId} 自動加入審查員名單（未分類）`);
        }
      } catch {
        onAction("審查員名單連動失敗，請聯絡系統管理員手動調整");
      }
    } catch (error) {
      setUserError(`儲存失敗：${toErrorMessage(error)}`);
    } finally {
      setUserSaving(false);
    }
  }

  /** v1.51.0：一次性補建審查員名單（管理員手動觸發；具審查員角色且效期有效、但無名單文件者補建未分類文件） */
  async function handleBackfillReviewers() {
    if (!user) return;
    setBackfilling(true);
    try {
      const db = getFirebaseDb();
      const n = await backfillReviewerDocs(db, roleMeta);
      onAction(
        n > 0
          ? `已補建 ${n} 位審查員名單`
          : "審查員名單已是最新，無需補建",
      );
      await loadUsers();
    } catch (error) {
      onAction(`補建審查員名單失敗：${toErrorMessage(error)}`);
    } finally {
      setBackfilling(false);
    }
  }

  async function handleToggleStatus(row: UserRow) {
    if (!user) return;
    const next = row.status === "停用" ? "在職" : "停用";
    if (row.staffId === user.staffId && next === "停用") {
      onAction("不能停用自己的帳號");
      return;
    }
    const ok = window.confirm(
      `確定將 ${row.staffId}（${maskName(row.name)}）設為「${next}」？` +
        (next === "停用" ? "停用後該人員將無法登入。" : ""),
    );
    if (!ok) return;
    try {
      const db = getFirebaseDb();
      const userRef = doc(db, "users", row.staffId);
      const batch = writeBatch(db);
      batch.update(userRef, {
        status: next,
        ...auditFields(user.staffId, false),
      });
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user.staffId,
        actorName: user.name,
        action: "人員帳號狀態異動",
        targetType: "user",
        targetId: row.staffId,
        detail: `職編 ${row.staffId} 帳號狀態由「${row.status}」改為「${next}」`,
        before: { status: row.status },
        after: { status: next },
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      onAction(`人員 ${row.staffId} 已設為${next}`);
      await loadUsers();
    } catch (error) {
      onAction(`狀態變更失敗：${toErrorMessage(error)}`);
    }
  }

  // ================= 角色成員（v1.21） =================

  /** 從人員的 roles／memberships 移除指定角色（角色刪除／成員移除共用；一名一檔，全群組一起移除） */
  function removeRoleFromUser(row: UserRow, roleName: string) {
    return (b: WriteBatch) => {
      const memberships = row.memberships
        .map((m) => ({
          ...m,
          roles: m.roles.filter((r) => r !== roleName),
        }))
        .filter((m) => m.roles.length > 0);
      // v1.58.0：roles 一律由分工表重算（僅保留系統管理員／一般人員例外）
      const roles = deriveStoredRoles(memberships, row.roles);
      b.update(doc(getFirebaseDb(), "users", row.staffId), {
        roles,
        memberships,
        groupIds: deriveGroupIds(memberships),
        ...auditFields(user?.staffId ?? "", false),
      });
      b.set(doc(collection(getFirebaseDb(), "auditLogs")), {
        actor: user?.staffId ?? "",
        actorName: user?.name ?? "",
        action: "移除人員角色",
        targetType: "user",
        targetId: row.staffId,
        detail: `移除職編 ${row.staffId} 的角色「${roleName}」`,
        before: { roles: row.roles, memberships: row.memberships },
        after: { roles, memberships },
        createdAt: serverTimestamp(),
      });
    };
  }

  /** 將角色加入人員（指定群組 → 寫入該群組 membership；單位級以其單位所屬群組計）
   * v1.58.0：roles 一律由分工表重算，不再有無群組的全域指派。 */
  function addRoleToUser(row: UserRow, roleName: string, groupId: string) {
    return (b: WriteBatch) => {
      let memberships = row.memberships;
      if (groupId) {
        const existing = memberships.find((m) => m.groupId === groupId);
        if (existing) {
          memberships = memberships.map((m) =>
            m.groupId === groupId
              ? { ...m, roles: [...new Set([...m.roles, roleName])] }
              : m,
          );
        } else {
          memberships = [...memberships, { groupId, roles: [roleName] }];
        }
      }
      const roles = deriveStoredRoles(memberships, row.roles);
      b.set(doc(collection(getFirebaseDb(), "auditLogs")), {
        actor: user?.staffId ?? "",
        actorName: user?.name ?? "",
        action: "新增人員角色",
        targetType: "user",
        targetId: row.staffId,
        detail: `為職編 ${row.staffId} 新增角色「${roleName}」${
          groupId === COMMITTEE_GROUP_ID
            ? "（全院）"
            : groupId === UNGROUPED_GROUP_ID
              ? "（尚未歸屬品管組）"
              : groupId
                ? `（品管組 ${groupId}）`
                : ""
        }`,
        before: { roles: row.roles, memberships: row.memberships },
        after: { roles, memberships },
        createdAt: serverTimestamp(),
      });
      b.update(doc(getFirebaseDb(), "users", row.staffId), {
        roles,
        memberships,
        groupIds: deriveGroupIds(memberships),
        ...auditFields(user?.staffId ?? "", false),
      });
    };
  }

  return {
    removeRoleFromUser,
    addRoleToUser,
    openUserCreate,
    handleBackfillReviewers,
    openUserEdit,
    handleToggleStatus,
    resetMembershipAddArea,
    membershipAddIsCommittee,
    membershipAddIsUnit,
    toggleMembershipAddRole,
    handleMembershipAddOrUpdate,
    cancelMembershipEdit,
    startMembershipEdit,
    removeMembershipByGroup,
    handleUserSave,
  };
}
