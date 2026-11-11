import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, Search, X } from "lucide-react";
import { collection, doc, getDoc, getDocs, query, serverTimestamp, where, writeBatch } from "../lib/db";
import { getFirebaseDb } from "../lib/firebase";
import { useAuth } from "../lib/auth";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { groupsForRoles, parseMemberships } from "../lib/roleIdentity";
import { useOrgMeta } from "../lib/useOrgMeta";
import { displayUnitCode, staffLabel } from "../lib/mask";
import { useStaffNameMap } from "../lib/useStaffNames";
import {
  LEGACY_GROUP_CONVENER_ROLE_NAMES,
  LEGACY_GROUP_OFFICER_ROLE_NAMES,
  scheduleScopeRoleNames,
} from "../lib/orgMeta";
import {
  filterHandoffTasks,
  isHandoffEligible,
  selectHandoffTasks,
  sortHandoffTasks,
  validateHandoff,
} from "../lib/handoff";

interface TaskRow {
  id: string;
  indicatorId: string;
  unitId: string;
  year: number;
  month: number;
  reviewerId: string;
  status: string;
  deadline: string;
  groupId: string;
  indicatorName: string;
  unitName: string;
  groupName: string;
}

interface OptionRow {
  id: string;
  name: string;
  groupId?: string;
}

interface PersonRow {
  staffId: string;
  name: string;
  title: string;
  unitCode: string;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "讀寫失敗，請檢查網路連線後再試";
}

export function TaskHandoffPage({ onAction }: { onAction: (message: string) => void }) {
  const { user } = useAuth();
  // v1.40.5：管理範圍改以角色類別＋範圍判斷，不再比對角色名稱
  const orgMeta = useOrgMeta();
  /** v1.50.0：原審查員顯示職編/遮罩姓名（users 走共用快取） */
  const staffNames = useStaffNameMap();
  const [groups, setGroups] = useState<OptionRow[]>([]);
  const [units, setUnits] = useState<OptionRow[]>([]);
  const [managerGroupIds, setManagerGroupIds] = useState<string[]>([]);
  const [refLoading, setRefLoading] = useState(true);

  // 原審查員：被動查詢（進頁不載入任務，按「查詢」才搜尋）
  const [groupFilter, setGroupFilter] = useState("");
  const [unitFilter, setUnitFilter] = useState("");
  const [staffSearch, setStaffSearch] = useState("");
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [selectedTasks, setSelectedTasks] = useState<string[]>([]);

  // 新審查員：輸入職編搜尋，點選確認
  const [newReviewerSearch, setNewReviewerSearch] = useState("");
  const [newReviewerSearching, setNewReviewerSearching] = useState(false);
  const [newReviewerCandidate, setNewReviewerCandidate] = useState<PersonRow | null>(null);
  const [newReviewerNotFound, setNewReviewerNotFound] = useState(false);
  const [newReviewer, setNewReviewer] = useState<PersonRow | null>(null);

  // 交接原因：空白欄自由輸入，不強制必填
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const isAdmin = (user?.roles ?? []).includes("系統管理員");
  const scope = useMemo(
    () => ({ isAdmin, allowedGroupIds: managerGroupIds }),
    [isAdmin, managerGroupIds],
  );

  // 進頁只載入最小參考資料（本人權限判斷＋群組／單位下拉選項），不載入任何任務。
  const loadReference = useCallback(async () => {
    if (!user) return;
    setRefLoading(true);
    try {
      const db = getFirebaseDb();
      const [meSnap, groupSnap, unitSnap] = await Promise.all([
        getDoc(doc(db, "users", user.staffId)),
        getDocs(query(collection(db, "groups"))),
        getDocs(query(collection(db, "units"))),
      ]);
      const roleNames = user.roles ?? [];
      const admin = roleNames.includes("系統管理員");
      const me = (meSnap.data() ?? {}) as Record<string, unknown>;
      const memberships = parseMemberships(me.memberships, {
        roles: roleNames,
        groupIds: Array.isArray(me.groupIds) ? me.groupIds.map(String) : [],
      });
      setManagerGroupIds(
        admin
          ? []
          : groupsForRoles(
              memberships,
              // 角色主檔尚未載入時（空表）以舊名稱退路，載入後改以類別＋範圍為準
              orgMeta.roleMeta.size === 0
                ? [...LEGACY_GROUP_CONVENER_ROLE_NAMES, ...LEGACY_GROUP_OFFICER_ROLE_NAMES]
                : scheduleScopeRoleNames(orgMeta.roleMeta),
              undefined,
              orgMeta.roleMeta,
            ),
      );
      setGroups(groupSnap.docs.map((d) => ({ id: d.id, name: String(d.data().name ?? d.id) })));
      setUnits(unitSnap.docs.map((d) => ({ id: d.id, name: String(d.data().name ?? d.id), groupId: String(d.data().groupId ?? "") })));
    } catch (error) {
      onAction(`任務交接參考資料載入失敗：${toErrorMessage(error)}`);
    } finally {
      setRefLoading(false);
    }
  }, [user, onAction, orgMeta.roleMeta]);

  useEffect(() => { void loadReference(); }, [loadReference]);

  const canOpen = isAdmin || managerGroupIds.length > 0;
  const availableGroups = useMemo(() => isAdmin ? groups : groups.filter((g) => managerGroupIds.includes(g.id)), [groups, isAdmin, managerGroupIds]);
  const availableUnits = useMemo(() => units.filter((u) => (!groupFilter || u.groupId === groupFilter)), [units, groupFilter]);
  const selected = useMemo(() => selectHandoffTasks(tasks, selectedTasks), [tasks, selectedTasks]);

  // 按「查詢」才搜尋：職編與群組／單位下拉擇一使用，有填職編時以職編精確比對為準。
  const runSearch = useCallback(async () => {
    if (!user) return;
    setSearching(true);
    try {
      const db = getFirebaseDb();
      const staffId = staffSearch.trim();
      const [taskSnap, indicatorSnap] = staffId
        ? await Promise.all([
            getDocs(query(collection(db, "reviewTasks"), where("reviewerId", "==", staffId))),
            getDocs(query(collection(db, "indicators"))),
          ])
        : await Promise.all([
            getDocs(query(collection(db, "reviewTasks"))),
            getDocs(query(collection(db, "indicators"))),
          ]);
      const unitById = new Map(units.map((u) => [u.id, u]));
      const groupName = new Map(groups.map((g) => [g.id, g.name]));
      const indById = new Map(
        indicatorSnap.docs.map((d) => ({ id: d.id, name: String(d.data().name ?? d.id), groupId: String(d.data().groupId ?? "") })).map((i) => [i.id, i]),
      );
      const rows: TaskRow[] = taskSnap.docs.flatMap((d) => {
        const v = d.data() as Record<string, unknown>;
        const indId = String(v.indicatorId ?? "");
        const ind = indById.get(indId);
        const unitId = String(v.unitId ?? "");
        const unit = unitById.get(unitId);
        if (!ind) return [];
        return [{
          id: d.id,
          indicatorId: indId,
          unitId,
          year: Number(v.year ?? 0),
          month: Number(v.month ?? 0),
          reviewerId: String(v.reviewerId ?? ""),
          status: String(v.status ?? "pending"),
          deadline: String(v.deadline ?? ""),
          groupId: ind.groupId,
          indicatorName: ind.name,
          unitName: unit?.name ?? displayUnitCode(unitId),
          groupName: groupName.get(ind.groupId) ?? ind.groupId,
        }];
      });
      const eligible = rows.filter((t) => isHandoffEligible(t, scope));
      const filtered = staffId ? eligible : filterHandoffTasks(eligible, { groupId: groupFilter, unitId: unitFilter });
      setTasks(sortHandoffTasks(filtered));
      setSelectedTasks([]);
      setSearched(true);
    } catch (error) {
      setTasks([]);
      setSearched(true);
      onAction(`任務交接查詢失敗：${toErrorMessage(error)}`);
    } finally {
      setSearching(false);
    }
  }, [user, staffSearch, groupFilter, unitFilter, groups, units, scope, onAction]);

  function toggleTask(id: string) {
    setSelectedTasks((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }
  function toggleAll() {
    setSelectedTasks((prev) => tasks.length > 0 && tasks.every((t) => prev.includes(t.id))
      ? prev.filter((id) => !tasks.some((t) => t.id === id))
      : [...new Set([...prev, ...tasks.map((t) => t.id)])]);
  }

  async function searchNewReviewer() {
    const staffId = newReviewerSearch.trim();
    if (!staffId) {
      onAction("請先輸入新審查員職編");
      return;
    }
    setNewReviewerSearching(true);
    setNewReviewerCandidate(null);
    setNewReviewerNotFound(false);
    try {
      const db = getFirebaseDb();
      const snap = await getDoc(doc(db, "users", staffId));
      const v = snap.data() as Record<string, unknown> | undefined;
      if (!v) {
        setNewReviewerNotFound(true);
        return;
      }
      setNewReviewerCandidate({
        staffId,
        name: String(v.name ?? staffId),
        title: String(v.title ?? ""),
        unitCode: String(v.unitCode ?? ""),
      });
    } catch (error) {
      onAction(`新審查員查詢失敗：${toErrorMessage(error)}`);
    } finally {
      setNewReviewerSearching(false);
    }
  }

  function unitNameOf(unitCode: string): string {
    return units.find((u) => u.id === unitCode)?.name ?? displayUnitCode(unitCode);
  }

  function handleCancel() {
    setSelectedTasks([]);
    setNewReviewer(null);
    setNewReviewerCandidate(null);
    setNewReviewerNotFound(false);
    setNewReviewerSearch("");
    setReason("");
    onAction("已取消交接，本次勾選、新審查員與原因皆已清除");
  }

  async function handleHandoff() {
    const error = validateHandoff(selected, newReviewer?.staffId ?? "");
    if (!user || error) {
      onAction(error ?? "交接資料不完整，請重新確認");
      return;
    }
    const to = (newReviewer as PersonRow).staffId;
    setSaving(true);
    try {
      const db = getFirebaseDb();
      for (let start = 0; start < selected.length; start += 200) {
        const group = selected.slice(start, start + 200);
        const batch = writeBatch(db);
        for (const task of group) {
          const taskRef = doc(db, "reviewTasks", task.id);
          batch.update(taskRef, {
            reviewerId: to,
            assignmentStatus: "active",
            reassignedAt: serverTimestamp(),
            reassignedBy: user.staffId,
          });
          const auditRef = doc(collection(db, "auditLogs"));
          batch.set(auditRef, {
            actor: user.staffId,
            actorName: user.name,
            action: "審查任務交接",
            targetType: "reviewTask",
            targetId: task.id,
            detail: `指標「${task.indicatorName}」／單位「${task.unitName}」／${task.year}年${task.month}月；${task.reviewerId} → ${to}${reason.trim() ? `；原因：${reason.trim()}` : ""}`,
            before: { reviewerId: task.reviewerId, status: task.status },
            after: { reviewerId: to, status: task.status },
            createdAt: serverTimestamp(),
          });
        }
        await batch.commit();
      }
      const count = selected.length;
      setNewReviewer(null);
      setNewReviewerCandidate(null);
      setNewReviewerNotFound(false);
      setNewReviewerSearch("");
      setReason("");
      setSelectedTasks([]);
      await runSearch();
      onAction(`已完成 ${count} 筆任務交接，立即生效`);
    } catch (error) {
      onAction(`交接失敗：${toErrorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  if (!canOpen && !refLoading) {
    return <EmptyState title="無交接權限" description="僅系統管理員，或隸屬原指標組別的召集人／執行幹事可進行未完成任務交接。" />;
  }

  return (
    <>
      <PageHeading page="handoff" />
      <SectionTitle title="任務交接" note="進頁不自動載入資料；請先查詢未完成任務。只交接已分配未完成的部分，交接立即生效，已完成任務不會轉派。" />
      <section className="panel">
        <h3>原審查員</h3>
        <div className="org-filter-row" role="search">
          <label className="form-field"><span className="field-label">群組</span><select className="text-input" value={groupFilter} onChange={(e) => { setGroupFilter(e.target.value); setUnitFilter(""); }}><option value="">全部可管理群組</option>{availableGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
          <label className="form-field"><span className="field-label">單位</span><select className="text-input" value={unitFilter} onChange={(e) => setUnitFilter(e.target.value)}><option value="">全部單位</option>{availableUnits.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
          <label className="form-field"><span className="field-label">職編搜尋</span><input className="text-input" value={staffSearch} onChange={(e) => setStaffSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }} placeholder="輸入原審查員職編" /></label>
          <div className="form-field"><span className="field-label">&nbsp;</span><button type="button" className="button button-primary" onClick={() => void runSearch()} disabled={searching || refLoading}><Search size={15} />{searching ? "查詢中…" : "查詢"}</button></div>
        </div>
        <p className="settings-note">群組／單位下拉與職編搜尋擇一使用；有填職編時以職編精確比對為準，群組／單位篩選不套用。</p>
        <div style={{ marginTop: 12 }}>
          {!searched ? (
            <EmptyState title="尚未查詢" description="請選擇群組／單位，或輸入原審查員職編，再按「查詢」。" />
          ) : tasks.length === 0 ? (
            <EmptyState title="沒有符合條件的未完成任務" description="請調整群組、單位或原審查員職編後再查詢；已完成任務不會顯示。" />
          ) : (
            <>
              <div className="form-actions" style={{ marginBottom: 10 }}>
                <button type="button" className="button button-outline" onClick={toggleAll}>{tasks.length > 0 && tasks.every((t) => selectedTasks.includes(t.id)) ? "取消全選" : "全選查詢結果"}</button>
                <span className="settings-note">已勾選 {selected.length}／{tasks.length} 筆</span>
              </div>
              <div className="table-scroll"><table className="data-table"><thead><tr><th>選取</th><th>原審查員</th><th>群組／單位</th><th>指標</th><th>審查期間</th><th>期限</th><th>狀態</th></tr></thead><tbody>{tasks.map((t) => <tr key={t.id}><td><input type="checkbox" checked={selectedTasks.includes(t.id)} onChange={() => toggleTask(t.id)} aria-label={`選取任務 ${t.id}`} /></td><td>{staffLabel(t.reviewerId, staffNames.get(t.reviewerId) ?? "")}</td><td>{t.groupName}／{t.unitName}</td><td>{t.indicatorName}</td><td>{t.year} 年 {t.month} 月</td><td>{t.deadline || "—"}</td><td>{t.status === "locked" ? "逾期鎖定" : "未完成"}</td></tr>)}</tbody></table></div>
            </>
          )}
        </div>
      </section>
      <section className="panel">
        <h3>新審查員</h3>
        <div className="org-filter-row" role="search">
          <label className="form-field"><span className="field-label">職編</span><input className="text-input" value={newReviewerSearch} onChange={(e) => { setNewReviewerSearch(e.target.value); setNewReviewerNotFound(false); }} onKeyDown={(e) => { if (e.key === "Enter") void searchNewReviewer(); }} placeholder="輸入新審查員職編" disabled={newReviewer !== null} /></label>
          <div className="form-field"><span className="field-label">&nbsp;</span><button type="button" className="button button-primary" onClick={() => void searchNewReviewer()} disabled={newReviewerSearching || newReviewer !== null || !newReviewerSearch.trim()}><Search size={15} />{newReviewerSearching ? "搜尋中…" : "搜尋"}</button></div>
        </div>
        {newReviewerNotFound && <p className="settings-note" style={{ color: "var(--danger, #c0392b)" }}>查無此人：職編 {newReviewerSearch.trim()} 不存在，請重新輸入。</p>}
        {newReviewerCandidate && !newReviewer && (
          <div className="table-scroll" style={{ marginTop: 12 }}><table className="data-table"><thead><tr><th>職編</th><th>姓名</th><th>職稱</th><th>單位</th><th>選取</th></tr></thead><tbody><tr><td>{newReviewerCandidate.staffId}</td><td>{newReviewerCandidate.name}</td><td>{newReviewerCandidate.title || "—"}</td><td>{unitNameOf(newReviewerCandidate.unitCode) || "—"}</td><td><button type="button" className="button button-outline" onClick={() => setNewReviewer(newReviewerCandidate)}>選取</button></td></tr></tbody></table></div>
        )}
        {newReviewer && (
          <p className="settings-note" style={{ marginTop: 12 }}>已選新審查員：{newReviewer.staffId} {newReviewer.name}{newReviewer.title ? `（${newReviewer.title}）` : ""}{newReviewer.unitCode ? `／${unitNameOf(newReviewer.unitCode)}` : ""} <button type="button" className="button button-ghost" onClick={() => { setNewReviewer(null); setNewReviewerCandidate(null); }}><X size={14} />更換</button></p>
        )}
      </section>
      <section className="panel">
        <h3>交接原因</h3>
        <label className="form-field"><span className="field-label">交接原因（選填）</span><input className="text-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="自由輸入，例如：原審查員離職／請假" /></label>
        <div className="form-actions" style={{ marginTop: 14 }}>
          <button type="button" className="button button-primary" onClick={() => void handleHandoff()} disabled={saving || selected.length === 0 || !newReviewer}><ArrowRightLeft size={15} />{saving ? "交接中…" : `確認交接（${selected.length}）`}</button>
          <button type="button" className="button button-ghost" onClick={handleCancel} disabled={saving}>取消</button>
        </div>
      </section>
      <p className="settings-note">交接僅變更未完成任務的派遣責任，不建立新任務或新審查紀錄；已提交／已完成結果維持原紀錄。取消只清除本次勾選、新審查員與原因，不寫入任何資料。</p>
    </>
  );
}
