import type { PreviewRow, UserRow } from "../model/types";
import { commitInBatches, auditFields } from "../model/forms";
import { type WriteBatch, doc, collection, serverTimestamp, updateDoc, setDoc } from "../../../lib/db";
import { getFirebaseDb } from "../../../lib/firebase";
import { levelIdByName } from "../../../lib/orgLevels";
import { parseUnitSheet, validateUnitRows as validateUnitRowsLib, parseUserSheet, validateUserRows as validateUserRowsLib } from "../../../lib/orgImport";
import { UNIT_HEADER, USER_HEADER } from "../importers/samples";
import { maskName } from "../../../lib/mask";
import { UNGROUPED_GROUP_ID, COMMITTEE_GROUP_ID, deriveStoredRoles, mergeMembership, deriveGroupIds, deriveRoles } from "../../../lib/roleIdentity";
import { syncReviewerDoc } from "../../../lib/reviewerSync";
import type { GroupsPageProps } from "../model/pageProps";
import type { useGroupsState } from "./useGroupsState";
import type { useGroupsDerived } from "./useGroupsDerived";
import type { useGroupsLoaders } from "./useGroupsLoaders";
import type { useGroupsOrgActions } from "./useGroupsOrgActions";
import type { useGroupsUserActions } from "./useGroupsUserActions";
import type { useGroupsMemberActions } from "./useGroupsMemberActions";

export function useGroupsImporters(props: GroupsPageProps, prev: ReturnType<typeof useGroupsState> & ReturnType<typeof useGroupsDerived> & ReturnType<typeof useGroupsLoaders> & ReturnType<typeof useGroupsOrgActions> & ReturnType<typeof useGroupsUserActions> & ReturnType<typeof useGroupsMemberActions>) {
  const { onAction } = props;
  const { groups, user, roleRows, roleLevels, units, titles, titleLevels, users, managingRole, addRoleToUser, loadUsers, roleMeta, managingGroupId, loadMaster, managingTitleId, loadTitles, titleUnitSupervisor, roleOptions } = prev;

  // ================= 批次上傳驗證與匯入 =================

  function validateGroupRows(rows: string[][]): Promise<PreviewRow[]> {
    const existing = new Set(groups.map((g) => g.name));
    const seen = new Set<string>();
    return Promise.resolve(
      rows.map((r, i) => {
        const index = i + 1;
        const name = (r[0] ?? "").trim();
        if (!name) return { index, values: r, ok: false, error: "品管組名稱不可空白" };
        if (existing.has(name))
          return { index, values: r, ok: false, error: `「${name}」已存在` };
        if (seen.has(name))
          return { index, values: r, ok: false, error: `檔案內重複：${name}` };
        seen.add(name);
        return { index, values: r, ok: true, error: "" };
      }),
    );
  }

  async function importGroupRows(rows: PreviewRow[]): Promise<void> {
    const me = user?.staffId ?? "";
    await commitInBatches(
      rows.map(
        (r) => (b: WriteBatch) =>
          b.set(doc(collection(getFirebaseDb(), "groups")), {
            name: r.values[0].trim(),
            ...auditFields(me, true),
          }),
      ),
    );
  }

  function validateRoleRows(rows: string[][]): Promise<PreviewRow[]> {
    const seen = new Set<string>();
    return Promise.resolve(
      rows.map((row, i) => {
        const name = (row[0] ?? "").trim();
        let error = "";
        if (!name) error = "角色名稱不可空白";
        else if (roleRows.some((role) => role.name === name) || seen.has(name))
          error = `角色「${name}」已存在`;
        else {
          const levelName = (row[1] ?? "").trim();
          if (levelName && !levelIdByName(roleLevels, levelName))
            error = `層級「${levelName}」不存在，請先建立層級`;
        }
        seen.add(name);
        return { index: i + 1, values: row, ok: !error, error };
      }),
    );
  }

  async function importRoleRows(rows: PreviewRow[]): Promise<void> {
    const me = user?.staffId ?? "";
    await commitInBatches(
      rows.map((row) => {
        const name = row.values[0].trim();
        const levelId = levelIdByName(roleLevels, (row.values[1] ?? "").trim());
        const roleRef = doc(collection(getFirebaseDb(), "roles"));
        return (batch: WriteBatch) => {
          batch.set(roleRef, {
            name,
            description: "",
            levelId,
            ...auditFields(me, true),
          });
          batch.set(doc(collection(getFirebaseDb(), "auditLogs")), {
            actor: me,
            actorName: user?.name ?? "",
            action: "角色建立",
            targetType: "role",
            targetId: roleRef.id,
            detail: `批次建立角色「${name}」`,
            before: null,
            after: { name },
            createdAt: serverTimestamp(),
          });
        };
      }),
    );
  }

  /** 單位匯入驗證（v1.21：舊資料匯入，未填忽略；代號已存在→更新） */
  function validateUnitRows(rows: string[][]): Promise<PreviewRow[]> {
    const groupByName = new Map(groups.map((g) => [g.name, g.id]));
    const { headerErrors, data } = parseUnitSheet([UNIT_HEADER, ...rows]);
    if (headerErrors.length > 0) {
      return Promise.resolve(
        rows.map((r, i) => ({
          index: i + 1,
          values: r,
          ok: false,
          error: headerErrors.join("；"),
        })),
      );
    }
    const results = validateUnitRowsLib(data, {
      existingCodes: new Set(units.map((u) => u.code)),
      groupByName,
    });
    return Promise.resolve(
      results.map((r, j) => ({
        index: j + 1,
        values: rows[j] ?? [],
        ok: r.ok,
        error: r.ok ? "" : r.errors.join("；"),
      })),
    );
  }

  async function importUnitRows(rows: PreviewRow[]): Promise<string> {
    const me = user?.staffId ?? "";
    const groupByName = new Map(groups.map((g) => [g.name, g.id]));
    const { data } = parseUnitSheet([
      UNIT_HEADER,
      ...rows.map((r) => r.values),
    ]);
    const results = validateUnitRowsLib(data, {
      existingCodes: new Set(units.map((u) => u.code)),
      groupByName,
    });
    let created = 0;
    let updated = 0;
    const ops = results
      .filter((r) => r.ok && r.values)
      .map((r) => {
        const v = r.values!;
        if (r.action === "update") updated += 1;
        else created += 1;
        const ref = doc(getFirebaseDb(), "units", v.code);
        if (r.action === "update") {
          const patch: Record<string, any> = {
            ...auditFields(me, false),
          };
          if (v.name !== null) patch.name = v.name;
          if (v.groupId !== null) patch.groupId = v.groupId;
          return (b: WriteBatch) => b.update(ref, patch);
        }
        return (b: WriteBatch) =>
          b.set(ref, {
            name: v.name ?? "",
            groupId: v.groupId ?? "",
            ...auditFields(me, true),
          });
      });
    await commitInBatches(ops);
    return `單位匯入完成：新增 ${created} 筆、更新 ${updated} 筆`;
  }

  function validateTitleRows(rows: string[][]): Promise<PreviewRow[]> {
    const existing = new Set(titles.map((title) => title.name));
    const seen = new Set<string>();
    return Promise.resolve(
      rows.map((r, i) => {
        const index = i + 1;
        const name = (r[0] ?? "").trim();
        if (!name) return { index, values: r, ok: false, error: "職稱名稱不可空白" };
        if (existing.has(name) || seen.has(name))
          return { index, values: r, ok: false, error: `職稱「${name}」已存在` };
        const levelName = (r[1] ?? "").trim();
        if (levelName && !levelIdByName(titleLevels, levelName))
          return { index, values: r, ok: false, error: `層級「${levelName}」不存在，請先建立層級` };
        seen.add(name);
        return { index, values: r, ok: true, error: "" };
      }),
    );
  }

  async function importTitleRows(rows: PreviewRow[]): Promise<void> {
    const me = user?.staffId ?? "";
    await commitInBatches(
      rows.map((r) => {
        const name = r.values[0].trim();
        const levelId = levelIdByName(titleLevels, (r.values[1] ?? "").trim());
        const titleRef = doc(collection(getFirebaseDb(), "titles"));
        return (b: WriteBatch) => {
          b.set(titleRef, {
            name,
            levelId,
            ...auditFields(me, true),
          });
          b.set(doc(collection(getFirebaseDb(), "auditLogs")), {
            actor: me,
            actorName: user?.name ?? "",
            action: "職稱建立",
            targetType: "title",
            targetId: titleRef.id,
            detail: `批次建立職稱「${name}」`,
            before: null,
            after: { name },
            createdAt: serverTimestamp(),
          });
        };
      }),
    );
  }

  // ================= 批次上傳驗證與匯入（v1.87.0：成員／單位管理獨立頁） =================

  /** v1.87.0：成員匯入共用——職編須已存在於人員資料，姓名須與人員資料相符 */
  function validateMemberRow(
    row: string[],
    seen: Set<string>,
  ): { ok: boolean; error: string; person?: UserRow } {
    const staffId = (row[0] ?? "").trim();
    if (!staffId) return { ok: false, error: "職編不可空白" };
    if (seen.has(staffId)) return { ok: false, error: `檔案內重複：${staffId}` };
    seen.add(staffId);
    const person = users.find((u) => u.staffId === staffId);
    if (!person) return { ok: false, error: `職編 ${staffId} 不在人員資料中` };
    const name = (row[1] ?? "").trim();
    if (!name) return { ok: false, error: "姓名不可空白" };
    if (name !== person.name)
      return { ok: false, error: `姓名與人員資料不符（應為 ${maskName(person.name)}）` };
    return { ok: true, error: "", person };
  }

  /** v1.87.0：角色成員匯入（範本：職編、姓名、適用品管組；單位級角色：職編、姓名、單位、角色） */
  const ROLE_MEMBER_HEADER = ["職編", "姓名", "適用品管組"];
  const ROLE_MEMBER_UNIT_HEADER = ["職編", "姓名", "單位", "角色"];
  function validateRoleMemberRows(rows: string[][]): Promise<PreviewRow[]> {
    const role = managingRole;
    if (!role)
      return Promise.resolve(
        rows.map((r, i) => ({ index: i + 1, values: r, ok: false, error: "角色未指定" })),
      );
    const seen = new Set<string>();
    const unitLevel = role.scope === "unit";
    const roleLevel = roleLevels.find((l) => l.id === role.levelId);
    const committeeLevel =
      role.levelId === "rl-committee" || roleLevel?.name === "委員會";
    return Promise.resolve(
      rows.map((r, i) => {
        const index = i + 1;
        const base = validateMemberRow(r, seen);
        if (!base.ok) return { index, values: r, ok: false, error: base.error };
        const person = base.person!;
        if (unitLevel) {
          const unitText = (r[2] ?? "").trim();
          if (!unitText)
            return { index, values: r, ok: false, error: "單位不可空白" };
          const unitRow =
            units.find((u) => u.code === unitText) ??
            units.find((u) => u.name === unitText);
          if (!unitRow)
            return { index, values: r, ok: false, error: `單位「${unitText}」不存在` };
          // v1.88.6：單位尚未歸屬品管組時仍可匯入，改以 UNGROUPED_GROUP_ID
          // 暫存登記（與人員編輯加入區同一作法），預覽不再擋下
          const expectedGid = unitRow.groupId || UNGROUPED_GROUP_ID;
          const roleText = (r[3] ?? "").trim();
          if (roleText !== role.name)
            return {
              index,
              values: r,
              ok: false,
              error: `角色須為「${role.name}」`,
            };
          if (
            person.memberships.some(
              (m) => m.groupId === expectedGid && m.roles.includes(role.name),
            )
          )
            return { index, values: r, ok: false, error: "已是該角色成員" };
        } else if (committeeLevel) {
          // v1.87.0：委員會角色不選品管組，適用品管組欄位忽略，以 "ALL" 登記
          if (
            person.memberships.some(
              (m) =>
                m.groupId === COMMITTEE_GROUP_ID && m.roles.includes(role.name),
            )
          )
            return { index, values: r, ok: false, error: "已是該角色成員" };
        } else {
          const groupText = (r[2] ?? "").trim();
          if (!groupText)
            return { index, values: r, ok: false, error: "適用品管組不可空白" };
          const group = groups.find((g) => g.name === groupText);
          if (!group)
            return { index, values: r, ok: false, error: `品管組「${groupText}」不存在` };
          if (
            person.memberships.some(
              (m) => m.groupId === group.id && m.roles.includes(role.name),
            )
          )
            return { index, values: r, ok: false, error: "已是該角色成員" };
        }
        return { index, values: r, ok: true, error: "" };
      }),
    );
  }

  async function importRoleMemberRows(rows: PreviewRow[]): Promise<string> {
    const role = managingRole;
    if (!role) throw new Error("角色未指定");
    const unitLevel = role.scope === "unit";
    const roleLevel = roleLevels.find((l) => l.id === role.levelId);
    const committeeLevel =
      role.levelId === "rl-committee" || roleLevel?.name === "委員會";
    const ops: Array<(b: WriteBatch) => void> = [];
    const finalRoles: { staffId: string; roles: string[] }[] = [];
    let count = 0;
    for (const r of rows) {
      const staffId = (r.values[0] ?? "").trim();
      const person = users.find((u) => u.staffId === staffId);
      if (!person) continue;
      let gid = "";
      if (committeeLevel) gid = COMMITTEE_GROUP_ID;
      else if (unitLevel) {
        const unitText = (r.values[2] ?? "").trim();
        const unitRow =
          units.find((u) => u.code === unitText) ??
          units.find((u) => u.name === unitText);
        if (!unitRow) continue;
        // v1.88.6：單位尚未歸屬品管組時以 UNGROUPED_GROUP_ID 暫存登記，不跳過
        gid = unitRow.groupId || UNGROUPED_GROUP_ID;
      } else {
        const group = groups.find((g) => g.name === (r.values[2] ?? "").trim());
        if (!group) continue;
        gid = group.id;
      }
      ops.push(addRoleToUser(person, role.name, gid));
      // v1.88.3：以匯入後的最終角色同步審查員名單（比照直接加入成員的做法）
      finalRoles.push({
        staffId,
        roles: deriveStoredRoles(
          gid ? mergeMembership(person.memberships, gid, [role.name]) : person.memberships,
          person.roles,
        ),
      });
      count += 1;
    }
    await commitInBatches(ops);
    await loadUsers();
    // v1.88.3：角色成員匯入後同步審查員名單（v1.87.0 新增此匯入路徑時漏接）
    try {
      const db = getFirebaseDb();
      let linked = 0;
      for (const { staffId, roles } of finalRoles) {
        const result = await syncReviewerDoc(db, staffId, roles, roleMeta);
        if (result === "linked") linked += 1;
      }
      if (linked > 0) {
        onAction(`已將 ${linked} 位自動加入審查員名單（未分類）`);
      }
    } catch {
      onAction("審查員名單連動失敗，請聯絡系統管理員手動調整");
    }
    return `角色成員匯入完成：成功 ${count} 筆`;
  }

  /** v1.87.0：品管組單位匯入（範本：單位代號、單位名稱、所屬品管組；品管組固定為該頁品管組） */
  const GROUP_UNIT_HEADER = ["單位代號", "單位名稱", "所屬品管組"];
  function validateGroupUnitRows(rows: string[][]): Promise<PreviewRow[]> {
    const group = groups.find((g) => g.id === managingGroupId);
    if (!group)
      return Promise.resolve(
        rows.map((r, i) => ({ index: i + 1, values: r, ok: false, error: "品管組未指定" })),
      );
    const seen = new Set<string>();
    return Promise.resolve(
      rows.map((r, i) => {
        const index = i + 1;
        const code = (r[0] ?? "").trim();
        if (!code) return { index, values: r, ok: false, error: "單位代號不可空白" };
        if (seen.has(code))
          return { index, values: r, ok: false, error: `檔案內重複：${code}` };
        seen.add(code);
        const unitRow = units.find((u) => u.code === code);
        if (!unitRow)
          return { index, values: r, ok: false, error: `單位代號 ${code} 不存在` };
        const name = (r[1] ?? "").trim();
        if (name && name !== unitRow.name)
          return {
            index,
            values: r,
            ok: false,
            error: `單位名稱與單位資料不符（應為 ${unitRow.name}）`,
          };
        const groupText = (r[2] ?? "").trim();
        if (groupText !== group.name)
          return {
            index,
            values: r,
            ok: false,
            error: `所屬品管組須為「${group.name}」`,
          };
        if (unitRow.groupId === managingGroupId)
          return { index, values: r, ok: false, error: "該單位已在此品管組" };
        return { index, values: r, ok: true, error: "" };
      }),
    );
  }

  async function importGroupUnitRows(rows: PreviewRow[]): Promise<string> {
    const me = user?.staffId ?? "";
    const group = groups.find((g) => g.id === managingGroupId);
    if (!group) throw new Error("品管組未指定");
    const ops = rows.map((r) => {
      const code = (r.values[0] ?? "").trim();
      return (b: WriteBatch) =>
        b.update(doc(getFirebaseDb(), "units", code), {
          groupId: managingGroupId,
          ...auditFields(me, false),
        });
    });
    await commitInBatches(ops);
    await loadMaster();
    return `品管組單位匯入完成：成功 ${rows.length} 筆`;
  }

  /** v1.87.0：職稱成員匯入（範本：職編、姓名；職稱固定為該頁職稱；下層頁同此函式） */
  const TITLE_MEMBER_HEADER = ["職編", "姓名"];
  function validateTitleMemberRows(rows: string[][]): Promise<PreviewRow[]> {
    const title = titles.find((t) => t.id === managingTitleId);
    if (!title)
      return Promise.resolve(
        rows.map((r, i) => ({ index: i + 1, values: r, ok: false, error: "職稱未指定" })),
      );
    const seen = new Set<string>();
    return Promise.resolve(
      rows.map((r, i) => {
        const index = i + 1;
        const base = validateMemberRow(r, seen);
        if (!base.ok) return { index, values: r, ok: false, error: base.error };
        if (base.person!.titleId === title.id)
          return { index, values: r, ok: false, error: "已是該職稱" };
        return { index, values: r, ok: true, error: "" };
      }),
    );
  }

  async function importTitleMemberRows(rows: PreviewRow[]): Promise<string> {
    const title = titles.find((t) => t.id === managingTitleId);
    if (!title) throw new Error("職稱未指定");
    const me = user?.staffId ?? "";
    const ops = rows.map((r) => {
      const staffId = (r.values[0] ?? "").trim();
      const target = users.find((u) => u.staffId === staffId)!;
      return (b: WriteBatch) => {
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
      };
    });
    await commitInBatches(ops);
    await loadUsers();
    await loadTitles();
    return `職稱成員匯入完成：成功 ${rows.length} 筆`;
  }

  /** v1.87.0：督導負責單位匯入（範本：單位代號、單位名稱） */
  const TITLE_UNIT_HEADER = ["單位代號", "單位名稱"];
  function validateTitleUnitRows(rows: string[][]): Promise<PreviewRow[]> {
    const sup = titleUnitSupervisor;
    if (!sup)
      return Promise.resolve(
        rows.map((r, i) => ({ index: i + 1, values: r, ok: false, error: "督導未指定" })),
      );
    const seen = new Set<string>();
    const owned = new Set(sup.titleUnitCodes ?? []);
    return Promise.resolve(
      rows.map((r, i) => {
        const index = i + 1;
        const code = (r[0] ?? "").trim();
        if (!code) return { index, values: r, ok: false, error: "單位代號不可空白" };
        if (seen.has(code))
          return { index, values: r, ok: false, error: `檔案內重複：${code}` };
        seen.add(code);
        const unitRow = units.find((u) => u.code === code);
        if (!unitRow)
          return { index, values: r, ok: false, error: `單位代號 ${code} 不存在` };
        const name = (r[1] ?? "").trim();
        if (name && name !== unitRow.name)
          return {
            index,
            values: r,
            ok: false,
            error: `單位名稱與單位資料不符（應為 ${unitRow.name}）`,
          };
        if (owned.has(code))
          return { index, values: r, ok: false, error: "已是負責單位" };
        return { index, values: r, ok: true, error: "" };
      }),
    );
  }

  async function importTitleUnitRows(rows: PreviewRow[]): Promise<string> {
    const sup = titleUnitSupervisor;
    if (!sup) throw new Error("督導未指定");
    const me = user?.staffId ?? "";
    const codes = rows.map((r) => (r.values[0] ?? "").trim()).filter(Boolean);
    const next = [...(sup.titleUnitCodes ?? []), ...codes];
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
      detail: `職編 ${sup.staffId}（${maskName(sup.name)}）批次新增負責單位 ${codes.join("、")}`,
      before: { titleUnitCodes: sup.titleUnitCodes ?? [] },
      after: { titleUnitCodes: next },
      createdAt: serverTimestamp(),
    });
    await loadUsers();
    return `負責單位匯入完成：成功 ${codes.length} 筆`;
  }

  function validateUserImportData(data: ReturnType<typeof parseUserSheet>["data"]) {
    const base = validateUserRowsLib(data, {
      existingStaffIds: new Set(users.map((u) => u.staffId)),
      groupByName: new Map(groups.map((g) => [g.name, g.id])),
      roleNames: new Set(roleOptions.map((r) => r.name)),
      roleMetaByName: roleMeta,
      titleNames: new Set(titles.map((t) => t.name)),
      unitCodes: new Set(units.map((u) => u.code)),
    });
    return base.map((result) => {
      if (!result.ok || !result.values) return result;
      const existing = users.find((item) => item.staffId === result.values?.staffId);
      const titleName = result.values.title ?? existing?.title ?? "";
      // v1.55.0：新帳號預設為一般使用者，職稱可留白、之後再賦予；
      // 更新時未填則沿用既有職稱。（舊 v1.36.0 擋下已移除。）
      if (!titleName) return result;
      // v1.39.0：職稱一名一檔，只認名稱存在與否，不再比對適用單位
      if (titles.some((title) => title.name === titleName)) return result;
      return {
        ...result,
        ok: false,
        errors: [...result.errors, `職稱「${titleName}」不存在，請先建立職稱`],
        values: null,
      };
    });
  }

  /** 人員匯入驗證（v1.21：舊資料匯入，未填忽略；職編已存在→更新） */
  function validateUserRows(rows: string[][]): Promise<PreviewRow[]> {
    const { headerErrors, data } = parseUserSheet([USER_HEADER, ...rows]);
    if (headerErrors.length > 0) {
      return Promise.resolve(
        rows.map((r, i) => ({
          index: i + 1,
          values: r,
          ok: false,
          error: headerErrors.join("；"),
        })),
      );
    }
    return Promise.resolve(
      validateUserImportData(data).map((r, j) => ({
        index: j + 1,
        values: rows[j] ?? [],
        ok: r.ok,
        error: r.ok ? "" : r.errors.join("；"),
      })),
    );
  }

  async function importUserRows(rows: PreviewRow[]): Promise<string> {
    const me = user?.staffId ?? "";
    const { data } = parseUserSheet([
      USER_HEADER,
      ...rows.map((r) => r.values),
    ]);
    const results = validateUserImportData(data);
    let created = 0;
    let updated = 0;
    // v1.51.0：批次匯入後同步審查員名單（收集每人匯入後的最終角色）
    const finalRoles: { staffId: string; roles: string[] }[] = [];
    const ops = results
      .filter((r) => r.ok && r.values)
      .map((r) => {
        const v = r.values!;
        const existing = users.find((item) => item.staffId === v.staffId);
        const nextUnitCode = v.unitCode ?? existing?.unitCode ?? "";
        const nextTitleName = v.title ?? existing?.title ?? "";
        const matchedTitle = nextTitleName
          ? titles.filter((title) => title.name === nextTitleName)
          : [];
        const assignedTitle = matchedTitle.length === 1 ? matchedTitle[0] : undefined;
        if (r.action === "update") updated += 1;
        else created += 1;
        const ref = doc(getFirebaseDb(), "users", v.staffId);
        if (r.action === "update") {
          const patch: Record<string, any> = {
            ...auditFields(me, false),
          };
          if (v.name !== null) patch.name = v.name;
          if (v.unitCode !== null) patch.unitCode = v.unitCode;
          if (v.title !== null || v.unitCode !== null) {
            patch.title = assignedTitle?.name ?? "";
            patch.titleId = assignedTitle?.id ?? "";
          }
          if (v.memberships !== null) {
            // v1.58.0：roles 一律由分工表重算，不再保留既有全域角色
            patch.memberships = v.memberships;
            patch.groupIds = deriveGroupIds(v.memberships);
            patch.roles = deriveStoredRoles(v.memberships, existing?.roles ?? []);
          }
          const nextRoles = patch.roles ?? existing?.roles ?? [];
          const nextMemberships = patch.memberships ?? existing?.memberships ?? [];
          finalRoles.push({ staffId: v.staffId, roles: nextRoles });
          const before = existing ? {
            name: existing.name, unitCode: existing.unitCode, titleId: existing.titleId,
            title: existing.title, roles: existing.roles, memberships: existing.memberships,
          } : null;
          const after = {
            name: v.name ?? existing?.name ?? "",
            unitCode: nextUnitCode,
            titleId: v.title !== null || v.unitCode !== null ? assignedTitle?.id ?? "" : existing?.titleId ?? "",
            title: v.title !== null || v.unitCode !== null ? assignedTitle?.name ?? "" : existing?.title ?? "",
            roles: nextRoles,
            memberships: nextMemberships,
          };
          return (b: WriteBatch) => {
            b.update(ref, patch);
            b.set(doc(collection(getFirebaseDb(), "auditLogs")), {
              actor: me,
              actorName: user?.name ?? "",
              action: "批次人員權限異動",
              targetType: "user",
              targetId: v.staffId,
              detail: `批次更新職編 ${v.staffId} 的單位、職稱或品管組角色`,
              before,
              after,
              createdAt: serverTimestamp(),
            });
          };
        }
        finalRoles.push({
          staffId: v.staffId,
          roles:
            v.memberships && v.memberships.length > 0
              ? deriveRoles(v.memberships)
              : ["一般人員"],
        });
        return (b: WriteBatch) => {
          b.set(ref, {
            name: v.name ?? "",
            unitCode: v.unitCode ?? "",
            title: assignedTitle?.name ?? "",
            titleId: assignedTitle?.id ?? "",
            hireDate: "",
            email: "",
            phone: "",
            memberships: v.memberships ?? [],
            groupIds: deriveGroupIds(v.memberships ?? []),
            roles:
              v.memberships && v.memberships.length > 0
                ? deriveRoles(v.memberships)
                : ["一般人員"],
            titleUnitCodes: [],
            mustChangePassword: false,
            status: "在職",
            ...auditFields(me, true),
          });
          b.set(doc(collection(getFirebaseDb(), "auditLogs")), {
            actor: me,
            actorName: user?.name ?? "",
            action: "批次人員權限異動",
            targetType: "user",
            targetId: v.staffId,
            detail: `批次建立職編 ${v.staffId} 人員與初始品管組角色`,
            before: null,
            after: {
              name: v.name ?? "", unitCode: v.unitCode ?? "", titleId: assignedTitle?.id ?? "",
              title: assignedTitle?.name ?? "", roles: v.memberships?.length ? deriveRoles(v.memberships) : ["一般人員"],
              memberships: v.memberships ?? [],
            },
            createdAt: serverTimestamp(),
          });
        };
      });
    await commitInBatches(ops);
    // v1.51.0：批次匯入後同步審查員名單
    try {
      const db = getFirebaseDb();
      let linked = 0;
      for (const { staffId, roles } of finalRoles) {
        const result = await syncReviewerDoc(db, staffId, roles, roleMeta);
        if (result === "linked") linked += 1;
      }
      if (linked > 0) {
        onAction(`已將 ${linked} 位匯入人員自動加入審查員名單（未分類）`);
      }
    } catch {
      onAction("審查員名單連動失敗，請聯絡系統管理員手動調整");
    }
    return `人員匯入完成：新增 ${created} 筆、更新 ${updated} 筆`;
  }

  return {
    ROLE_MEMBER_UNIT_HEADER,
    ROLE_MEMBER_HEADER,
    validateRoleMemberRows,
    importRoleMemberRows,
    TITLE_MEMBER_HEADER,
    validateTitleMemberRows,
    importTitleMemberRows,
    GROUP_UNIT_HEADER,
    validateGroupUnitRows,
    importGroupUnitRows,
    TITLE_UNIT_HEADER,
    validateTitleUnitRows,
    importTitleUnitRows,
    validateGroupRows,
    importGroupRows,
    validateUnitRows,
    importUnitRows,
    validateTitleRows,
    importTitleRows,
    validateUserRows,
    importUserRows,
    validateRoleRows,
    importRoleRows,
  };
}
