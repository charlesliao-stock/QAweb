import { emptyGroupForm, auditFields, emptyUnitForm, emptyTitleForm, commitInBatches } from "../model/forms";
import { getFirebaseDb } from "../../../lib/firebase";
import { setDoc, doc, collection, updateDoc, getDocs, query, where, limit, deleteDoc, getDoc, writeBatch, serverTimestamp, type WriteBatch, getDocsFromServer } from "../../../lib/db";
import { toErrorMessage } from "../../../lib/errors";
import type { GroupRow, TitleRow } from "../model/types";
import { wouldCreateUnitHistoryCycle } from "../../../lib/unitHistory";
import { nextOrderInLevel, nextLevelOrder, type OrgLevel, canDeleteLevel, sortedLevels, sortByOrder } from "../../../lib/orgLevels";
import { templateDocId } from "../../../lib/permissions";
import type { GroupsPageProps } from "../model/pageProps";
import type { useGroupsState } from "./useGroupsState";
import type { useGroupsDerived } from "./useGroupsDerived";
import type { useGroupsLoaders } from "./useGroupsLoaders";

export function useGroupsOrgActions(props: GroupsPageProps, prev: ReturnType<typeof useGroupsState> & ReturnType<typeof useGroupsDerived> & ReturnType<typeof useGroupsLoaders>) {
  const { onAction } = props;
  const { setGroupForm, setGroupError, setGroupView, groups, groupView, groupForm, user, setGroupSaving, loadMaster, setUnitForm, setUnitError, setUnitView, units, unitView, unitForm, setUnitSaving, setTitleForm, setTitleError, setTitleView, titles, titleView, titleForm, setTitleSaving, users, loadUsers, loadTitles, levelCreateTarget, newLevelName, setLevelError, titleLevels, roleLevels, setLevelBusy, setNewLevelName, setLevelCreateTarget, loadLevels, levelEdit, setLevelEdit, roleRows, loadRoles } = prev;

  // ================= 群組 =================

  function openGroupCreate() {
    setGroupForm(emptyGroupForm());
    setGroupError("");
    setGroupView({ kind: "create" });
  }

  function openGroupEdit(id: string) {
    const row = groups.find((g) => g.id === id);
    if (!row) return;
    setGroupForm({ name: row.name });
    setGroupError("");
    setGroupView({ kind: "edit", id });
  }

  async function handleGroupSave() {
    const view = groupView;
    const name = groupForm.name.trim();
    if (!name) {
      setGroupError("請填寫品管組名稱");
      return;
    }
    if (!user) {
      setGroupError("請先登入");
      return;
    }
    if (
      groups.some(
        (g) => g.name === name && (view.kind !== "edit" || g.id !== view.id),
      )
    ) {
      setGroupError(`品管組「${name}」已存在`);
      return;
    }
    setGroupError("");
    setGroupSaving(true);
    try {
      const db = getFirebaseDb();
      if (view.kind === "create") {
        await setDoc(doc(collection(db, "groups")), {
          name,
          ...auditFields(user.staffId, true),
        });
        onAction(`已新增品管組 ${name}`);
      } else if (view.kind === "edit") {
        await updateDoc(doc(db, "groups", view.id), {
          name,
          ...auditFields(user.staffId, false),
        });
        onAction(`品管組已更新為 ${name}`);
      }
      setGroupView({ kind: "list" });
      await loadMaster();
    } catch (error) {
      setGroupError(`儲存失敗：${toErrorMessage(error)}`);
    } finally {
      setGroupSaving(false);
    }
  }

  async function handleGroupDelete(row: GroupRow) {
    if (!user) return;
    try {
      const db = getFirebaseDb();
      const unitSnap = await getDocs(
        query(collection(db, "units"), where("groupId", "==", row.id), limit(1)),
      );
      if (!unitSnap.empty) {
        onAction(`品管組「${row.name}」尚有單位歸屬，無法刪除（請先將單位移出）`);
        return;
      }
    } catch {
      onAction("刪除前檢查單位歸屬失敗，請確認權限後再試");
      return;
    }
    const ok = window.confirm(`確定刪除品管組「${row.name}」？此動作無法復原。`);
    if (!ok) return;
    try {
      await deleteDoc(doc(getFirebaseDb(), "groups", row.id));
      onAction(`品管組「${row.name}」已刪除`);
      await loadMaster();
    } catch (error) {
      onAction(`刪除失敗：${toErrorMessage(error)}`);
    }
  }

  // ================= 單位 =================

  function openUnitCreate() {
    setUnitForm(emptyUnitForm());
    setUnitError("");
    setUnitView({ kind: "create" });
  }

  function openUnitEdit(code: string) {
    const row = units.find((u) => u.code === code);
    if (!row) return;
    setUnitForm({
      code: row.code,
      name: row.name,
      groupId: row.groupId,
      mergedFromUnitCodes: [...row.mergedFromUnitCodes],
    });
    setUnitError("");
    setUnitView({ kind: "edit", code });
  }

  async function handleUnitSave() {
    const view = unitView;
    if (view.kind === "list") return;
    if (view.kind === "create" && !unitForm.code.trim()) {
      setUnitError("請填寫單位代號");
      return;
    }
    if (!unitForm.name.trim()) {
      setUnitError("請填寫單位名稱");
      return;
    }
    if (!user) {
      setUnitError("請先登入");
      return;
    }
    const code = view.kind === "create" ? unitForm.code.trim() : view.code;
    const mergedFromUnitCodes = [...new Set(unitForm.mergedFromUnitCodes)]
      .filter((source) => source && source !== code);
    if (wouldCreateUnitHistoryCycle(units, code, mergedFromUnitCodes)) {
      setUnitError("合併來源會形成單位沿革循環，請重新選擇");
      return;
    }
    setUnitError("");
    setUnitSaving(true);
    try {
      const db = getFirebaseDb();
      const payload = {
        name: unitForm.name.trim(),
        groupId: unitForm.groupId,
        mergedFromUnitCodes,
        ...auditFields(user.staffId, false),
      };
      if (view.kind === "create") {
        const ref = doc(db, "units", code);
        const exists = await getDoc(ref);
        if (exists.exists()) {
          setUnitError(`單位代號 ${code} 已存在`);
          setUnitSaving(false);
          return;
        }
        const batch = writeBatch(db);
        batch.set(ref, { ...payload, ...auditFields(user.staffId, true) });
        if (mergedFromUnitCodes.length > 0) {
          batch.set(doc(collection(db, "auditLogs")), {
            actor: user.staffId,
            actorName: user.name,
            action: "單位合併沿革權限建立",
            targetType: "unit",
            targetId: code,
            detail: `新增單位 ${code}，設定可存取的合併前單位資料`,
            before: { mergedFromUnitCodes: [] },
            after: { mergedFromUnitCodes },
            createdAt: serverTimestamp(),
          });
        }
        await batch.commit();
        onAction(`已新增單位 ${code}`);
      } else if (view.kind === "edit") {
        const ref = doc(db, "units", view.code);
        const previous = (await getDoc(ref)).data() ?? {};
        const beforeCodes = Array.isArray(previous.mergedFromUnitCodes)
          ? previous.mergedFromUnitCodes.map(String).filter(Boolean)
          : [];
        const changed = JSON.stringify(beforeCodes) !== JSON.stringify(mergedFromUnitCodes);
        const batch = writeBatch(db);
        batch.update(ref, payload);
        if (changed) {
          batch.set(doc(collection(db, "auditLogs")), {
            actor: user.staffId,
            actorName: user.name,
            action: "單位合併沿革權限異動",
            targetType: "unit",
            targetId: view.code,
            detail: `更新單位 ${view.code} 的合併歷史資料可見範圍`,
            before: { mergedFromUnitCodes: beforeCodes },
            after: { mergedFromUnitCodes },
            createdAt: serverTimestamp(),
          });
        }
        await batch.commit();
        onAction(`單位 ${view.code} 已更新`);
      }
      setUnitView({ kind: "list" });
      await loadMaster();
    } catch (error) {
      setUnitError(`儲存失敗：${toErrorMessage(error)}`);
    } finally {
      setUnitSaving(false);
    }
  }

  async function handleUnitDelete(code: string) {
    if (!user) return;
    const historicalReference = units.find(
      (unit) => unit.code !== code && unit.mergedFromUnitCodes.includes(code),
    );
    if (historicalReference) {
      onAction(`單位 ${code} 是 ${historicalReference.code} 的合併歷史來源，請先調整沿革設定，不能刪除`);
      return;
    }
    try {
      const db = getFirebaseDb();
      const memberSnap = await getDocs(
        query(collection(db, "users"), where("unitCode", "==", code), limit(1)),
      );
      if (!memberSnap.empty) {
        onAction(`單位 ${code} 尚有人員歸屬，無法刪除（請先將人員移出或改派）`);
        return;
      }
    } catch {
      onAction("刪除前檢查人員歸屬失敗，請確認權限後再試");
      return;
    }
    const ok = window.confirm(`確定刪除單位 ${code}？此動作無法復原。`);
    if (!ok) return;
    try {
      await deleteDoc(doc(getFirebaseDb(), "units", code));
      onAction(`單位 ${code} 已刪除`);
      await loadMaster();
    } catch (error) {
      onAction(`刪除失敗：${toErrorMessage(error)}`);
    }
  }

  // ================= 職稱 =================

  function openTitleCreate() {
    setTitleForm(emptyTitleForm());
    setTitleError("");
    setTitleView({ kind: "create" });
  }

  function openTitleEdit(id: string) {
    const row = titles.find((t) => t.id === id);
    if (!row) return;
    setTitleForm({
      name: row.name,
      levelId: row.levelId ?? "",
      isUnitHead: row.isUnitHead,
      isDistrictHead: row.isDistrictHead,
      isHospitalHead: row.isHospitalHead,
      isOfficer: row.isOfficer,
      isConvener: row.isConvener,
    });
    setTitleError("");
    setTitleView({ kind: "edit", id });
  }

  async function handleTitleSave() {
    const view = titleView;
    const name = titleForm.name.trim();
    if (!name) {
      setTitleError("請填寫職稱名稱");
      return;
    }
    if (!user) {
      setTitleError("請先登入");
      return;
    }
    // v1.39.0：一名一檔，同名已有文件時擋下
    if (
      titles.some(
        (t) => t.name === name && (view.kind !== "edit" || t.id !== view.id),
      )
    ) {
      setTitleError(`職稱「${name}」已存在`);
      return;
    }
    setTitleError("");
    setTitleSaving(true);
    try {
      const db = getFirebaseDb();
      if (view.kind === "create") {
        const titleRef = doc(collection(db, "titles"));
        const batch = writeBatch(db);
        batch.set(titleRef, {
          name,
          levelId: titleForm.levelId,
          // v1.88.8 補項：層級內順序（新職稱排在該層最後）
          order: nextOrderInLevel(titles, titleForm.levelId),
          // v1.40.5：職稱建立即寫入主管層級旗標，身分判斷不再比對名稱
          isUnitHead: titleForm.isUnitHead,
          isDistrictHead: titleForm.isDistrictHead,
          isHospitalHead: titleForm.isHospitalHead,
          isOfficer: titleForm.isOfficer,
          isConvener: titleForm.isConvener,
          ...auditFields(user.staffId, true),
        });
        batch.set(doc(collection(db, "auditLogs")), {
          actor: user.staffId,
          actorName: user.name,
          action: "職稱建立",
          targetType: "title",
          targetId: titleRef.id,
          detail: `新增職稱「${name}」`,
          before: null,
          after: { name },
          createdAt: serverTimestamp(),
        });
        await batch.commit();
        onAction(`已新增職稱 ${name}；請至權限管理設定權限`);
      } else if (view.kind === "edit") {
        const old = titles.find((title) => title.id === view.id);
        const oldName = old?.name ?? "";
        const nameChanged = oldName !== name;
        // v1.40.5：即使名稱不變，主管層級旗標變動也要能儲存
        const flagsChanged =
          old?.isUnitHead !== titleForm.isUnitHead ||
          old?.isDistrictHead !== titleForm.isDistrictHead ||
          old?.isHospitalHead !== titleForm.isHospitalHead ||
          old?.isOfficer !== titleForm.isOfficer ||
          old?.isConvener !== titleForm.isConvener;
        // v1.55.0：層級變動也要能儲存
        const levelChanged = (old?.levelId ?? "") !== titleForm.levelId;
        if (!nameChanged && !flagsChanged && !levelChanged) {
          setTitleView({ kind: "list" });
          return;
        }
        // 更名同步：持有此職稱的人員 title 字串＋權限範本一併改名
        const templateRef = doc(db, "permissionTemplates", templateDocId("unit", oldName));
        const [templateSnap, newTemplateSnap] = await Promise.all([
          getDoc(templateRef),
          nameChanged
            ? getDoc(doc(db, "permissionTemplates", templateDocId("unit", name)))
            : Promise.resolve(null),
        ]);
        if (newTemplateSnap?.exists()) {
          setTitleError(`新名稱「${name}」已有權限範本，請先處理該範本再更名`);
          return;
        }
        if (nameChanged) {
          const ops: Array<(b: WriteBatch) => void> = [];
          users.forEach((u) => {
            if (u.titleId === view.id || (!u.titleId && u.title === oldName)) {
              ops.push((b) => {
                b.update(doc(db, "users", u.staffId), {
                  title: name,
                  ...auditFields(user.staffId, false),
                });
                b.set(doc(collection(db, "auditLogs")), {
                  actor: user.staffId,
                  actorName: user.name,
                  action: "人員職稱異動",
                  targetType: "user",
                  targetId: u.staffId,
                  detail: `職稱更名：職編 ${u.staffId} 職稱「${oldName}」→「${name}」`,
                  before: { titleId: u.titleId, title: u.title },
                  after: { titleId: u.titleId, title: name },
                  createdAt: serverTimestamp(),
                });
              });
            }
          });
          await commitInBatches(ops);
        }
        const batch = writeBatch(db);
        batch.update(doc(db, "titles", view.id), {
          name,
          levelId: titleForm.levelId,
          isUnitHead: titleForm.isUnitHead,
          isDistrictHead: titleForm.isDistrictHead,
          isHospitalHead: titleForm.isHospitalHead,
          isOfficer: titleForm.isOfficer,
          isConvener: titleForm.isConvener,
          ...auditFields(user.staffId, false),
        });
        if (nameChanged && templateSnap.exists()) {
          batch.set(doc(db, "permissionTemplates", templateDocId("unit", name)), {
            ...templateSnap.data(),
            name,
          });
          batch.delete(templateRef);
        }
        batch.set(doc(collection(db, "auditLogs")), {
          actor: user.staffId,
          actorName: user.name,
          action: "職稱更名",
          targetType: "title",
          targetId: view.id,
          detail: nameChanged
            ? `職稱「${oldName}」更名為「${name}」`
            : `職稱「${name}」主管層級更新`,
          before: old ? { name: old.name } : null,
          after: { name },
          createdAt: serverTimestamp(),
        });
        await batch.commit();
        onAction(nameChanged ? `職稱已更名為 ${name}` : `職稱「${name}」已更新`);
        await loadUsers();
      }
      setTitleView({ kind: "list" });
      await loadTitles();
    } catch (error) {
      setTitleError(`儲存失敗：${toErrorMessage(error)}`);
    } finally {
      setTitleSaving(false);
    }
  }

  async function handleTitleDelete(row: TitleRow) {
    if (!user) return;
    try {
      const db = getFirebaseDb();
      const usedSnap = await getDocsFromServer(collection(db, "users"));
      const hasUsers = usedSnap.docs.some((document) => {
        const data = document.data();
        if (data.titleId === row.id) return true;
        const titleName = typeof data.title === "string" ? data.title : "";
        return !data.titleId && titleName === row.name;
      });
      if (hasUsers) {
        onAction(`職稱「${row.name}」尚有人員使用，無法刪除`);
        return;
      }
    } catch {
      onAction("無權限檢查人員使用情形，請聯絡系統管理員刪除");
      return;
    }
    const ok = window.confirm(
      `確定刪除職稱「${row.name}」？此動作無法復原。`,
    );
    if (!ok) return;
    try {
      const db = getFirebaseDb();
      const batch = writeBatch(db);
      batch.delete(doc(db, "titles", row.id));
      // v1.39.2：刪除職稱一併刪除其權限範本（單位類同名文件）
      batch.delete(doc(db, "permissionTemplates", templateDocId("unit", row.name)));
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user.staffId,
        actorName: user.name,
        action: "職稱刪除",
        targetType: "title",
        targetId: row.id,
        detail: `刪除職稱「${row.name}」`,
        before: { name: row.name },
        after: null,
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      onAction(`職稱「${row.name}」已刪除`);
      await loadTitles();
    } catch (error) {
      onAction(`刪除失敗：${toErrorMessage(error)}`);
    }
  }


  // ================= 層級（v1.55.0） =================

  async function handleLevelCreate() {
    const target = levelCreateTarget;
    if (!target || !user) return;
    const name = newLevelName.trim();
    if (!name) {
      setLevelError("請輸入層級名稱");
      return;
    }
    const levels = target === "title" ? titleLevels : roleLevels;
    if (levels.some((l) => l.name === name)) {
      setLevelError(`層級「${name}」已存在`);
      return;
    }
    setLevelError("");
    setLevelBusy(true);
    try {
      const db = getFirebaseDb();
      const coll = target === "title" ? "titleLevels" : "roleLevels";
      const ref = doc(collection(db, coll));
      const batch = writeBatch(db);
      batch.set(ref, {
        name,
        order: nextLevelOrder(levels),
        ...auditFields(user.staffId, true),
      });
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user.staffId,
        actorName: user.name,
        action: "層級建立",
        targetType: "level",
        targetId: ref.id,
        detail: `新增${target === "title" ? "職稱" : "角色"}層級「${name}」`,
        before: null,
        after: { name },
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      setNewLevelName("");
      setLevelCreateTarget(null);
      await loadLevels();
      onAction(`已新增層級「${name}」`);
    } catch (error) {
      setLevelError(`新增失敗：${toErrorMessage(error)}`);
    } finally {
      setLevelBusy(false);
    }
  }

  /** 層級更名只改層級文件（項目以 levelId 參照，人員與權限不動） */
  async function handleLevelRename() {
    if (!levelEdit || !user) return;
    const name = levelEdit.name.trim();
    if (!name) {
      setLevelError("請輸入層級名稱");
      return;
    }
    const levels = levelEdit.target === "title" ? titleLevels : roleLevels;
    if (levels.some((l) => l.name === name && l.id !== levelEdit.id)) {
      setLevelError(`層級「${name}」已存在`);
      return;
    }
    setLevelError("");
    setLevelBusy(true);
    try {
      const db = getFirebaseDb();
      const coll = levelEdit.target === "title" ? "titleLevels" : "roleLevels";
      await updateDoc(doc(db, coll, levelEdit.id), {
        name,
        ...auditFields(user.staffId, false),
      });
      setLevelEdit(null);
      await loadLevels();
      onAction(`層級已更名為「${name}」`);
    } catch (error) {
      setLevelError(`更名失敗：${toErrorMessage(error)}`);
    } finally {
      setLevelBusy(false);
    }
  }

  /** 層級刪除：底下還有項目就擋下 */
  async function handleLevelDelete(target: "title" | "role", level: OrgLevel) {
    if (!user) return;
    const items = target === "title" ? titles : roleRows;
    if (!canDeleteLevel(items, level.id)) {
      onAction(
        `層級「${level.name}」底下還有項目，請先移出或刪除項目再刪除層級`,
      );
      return;
    }
    const ok = window.confirm(
      `確定刪除層級「${level.name}」？此動作無法復原。`,
    );
    if (!ok) return;
    try {
      const db = getFirebaseDb();
      const coll = target === "title" ? "titleLevels" : "roleLevels";
      const batch = writeBatch(db);
      batch.delete(doc(db, coll, level.id));
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user.staffId,
        actorName: user.name,
        action: "層級刪除",
        targetType: "level",
        targetId: level.id,
        detail: `刪除${target === "title" ? "職稱" : "角色"}層級「${level.name}」`,
        before: { name: level.name },
        after: null,
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      onAction(`層級「${level.name}」已刪除`);
      await loadLevels();
    } catch (error) {
      onAction(`刪除失敗：${toErrorMessage(error)}`);
    }
  }

  /** 層級排序：與相鄰層級交換 order */
  async function handleLevelMove(
    target: "title" | "role",
    levelId: string,
    dir: 1 | -1,
  ) {
    if (!user) return;
    const levels = target === "title" ? titleLevels : roleLevels;
    const sorted = sortedLevels(levels);
    const idx = sorted.findIndex((l) => l.id === levelId);
    const swapIdx = idx + dir;
    if (idx < 0 || swapIdx < 0 || swapIdx >= sorted.length) return;
    try {
      const db = getFirebaseDb();
      const coll = target === "title" ? "titleLevels" : "roleLevels";
      const batch = writeBatch(db);
      batch.update(doc(db, coll, sorted[idx].id), {
        order: sorted[swapIdx].order,
        ...auditFields(user.staffId, false),
      });
      batch.update(doc(db, coll, sorted[swapIdx].id), {
        order: sorted[idx].order,
        ...auditFields(user.staffId, false),
      });
      await batch.commit();
      await loadLevels();
    } catch (error) {
      onAction(`排序失敗：${toErrorMessage(error)}`);
    }
  }

  /** v1.88.8 補項：職稱／角色層級內排序（上移／下移）：同一層級內按
   * (order, 名稱) 排好後交換位置，再把整層重編為 0..n-1 寫回
   * （順便正規化重複／缺失的 order；上下順序即階層）。 */
  async function handleItemMove(
    target: "title" | "role",
    id: string,
    dir: 1 | -1,
  ) {
    if (!user) return;
    const items = target === "title" ? titles : roleRows;
    const current = items.find((t) => t.id === id);
    if (!current) return;
    const levelItems = sortByOrder(
      items.filter((t) => (t.levelId ?? "") === (current.levelId ?? "")),
    );
    const idx = levelItems.findIndex((t) => t.id === id);
    const swapIdx = idx + dir;
    if (idx < 0 || swapIdx < 0 || swapIdx >= levelItems.length) return;
    const next = [...levelItems];
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    try {
      const db = getFirebaseDb();
      const coll = target === "title" ? "titles" : "roles";
      const batch = writeBatch(db);
      next.forEach((item, i) => {
        batch.update(doc(db, coll, item.id), {
          order: i,
          ...auditFields(user.staffId, false),
        });
      });
      await batch.commit();
      if (target === "title") await loadTitles();
      else await loadRoles();
    } catch (error) {
      onAction(`排序失敗：${toErrorMessage(error)}`);
    }
  }

  return {
    handleLevelRename,
    handleLevelMove,
    handleLevelDelete,
    handleLevelCreate,
    handleItemMove,
    openTitleEdit,
    handleTitleDelete,
    openGroupCreate,
    openUnitCreate,
    openTitleCreate,
    openGroupEdit,
    handleGroupDelete,
    openUnitEdit,
    handleUnitDelete,
    handleGroupSave,
    handleUnitSave,
    handleTitleSave,
  };
}
