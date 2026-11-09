import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, RefreshCw } from "lucide-react";
import { collection, doc, getDoc, getDocs, query, serverTimestamp, writeBatch } from "../lib/db";
import { getFirebaseDb } from "../lib/firebase";
import { useAuth } from "../lib/auth";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { GROUP_CONVENER_ROLES, GROUP_OFFICER_ROLES, groupsForRoles, parseMemberships } from "../lib/roleIdentity";

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

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "讀寫失敗，請檢查網路連線後再試";
}

export function TaskHandoffPage({ onAction }: { onAction: (message: string) => void }) {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [groups, setGroups] = useState<OptionRow[]>([]);
  const [units, setUnits] = useState<OptionRow[]>([]);
  const [managerGroupIds, setManagerGroupIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [groupFilter, setGroupFilter] = useState("");
  const [unitFilter, setUnitFilter] = useState("");
  const [reviewerSearch, setReviewerSearch] = useState("");
  const [selectedReviewer, setSelectedReviewer] = useState("");
  const [selectedTasks, setSelectedTasks] = useState<string[]>([]);
  const [newReviewerId, setNewReviewerId] = useState("");
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const db = getFirebaseDb();
      const [meSnap, taskSnap, groupSnap, unitSnap, indicatorSnap] = await Promise.all([
        getDoc(doc(db, "users", user.staffId)),
        getDocs(query(collection(db, "reviewTasks"))),
        getDocs(query(collection(db, "groups"))),
        getDocs(query(collection(db, "units"))),
        getDocs(query(collection(db, "indicators"))),
      ]);
      const roleNames = user.roles ?? [];
      const admin = roleNames.includes("系統管理員");
      const me = (meSnap.data() ?? {}) as Record<string, unknown>;
      const memberships = parseMemberships(me.memberships, {
        roles: roleNames,
        groupIds: Array.isArray(me.groupIds) ? me.groupIds.map(String) : [],
      });
      const allowedGroups = admin
        ? []
        : groupsForRoles(memberships, [...GROUP_CONVENER_ROLES, ...GROUP_OFFICER_ROLES]);
      setManagerGroupIds(allowedGroups);
      const groupRows = groupSnap.docs.map((d) => ({ id: d.id, name: String(d.data().name ?? d.id) }));
      const unitRows = unitSnap.docs.map((d) => ({ id: d.id, name: String(d.data().name ?? d.id), groupId: String(d.data().groupId ?? "") }));
      const indicatorRows = indicatorSnap.docs.map((d) => ({ id: d.id, name: String(d.data().name ?? d.id), groupId: String(d.data().groupId ?? "") }));
      setGroups(groupRows);
      setUnits(unitRows);
      const groupName = new Map(groupRows.map((g) => [g.id, g.name]));
      const unitById = new Map(unitRows.map((u) => [u.id, u]));
      const indById = new Map(indicatorRows.map((i) => [i.id, i]));
      const allTasks: TaskRow[] = taskSnap.docs.flatMap((d) => {
        const v = d.data() as Record<string, unknown>;
        const indId = String(v.indicatorId ?? "");
        const ind = indById.get(indId);
        const unitId = String(v.unitId ?? "");
        const unit = unitById.get(unitId);
        const status = String(v.status ?? "pending");
        const groupId = ind?.groupId ?? "";
        if (!ind || status === "done") return [];
        if (!admin && !allowedGroups.includes(groupId)) return [];
        return [{
          id: d.id,
          indicatorId: indId,
          unitId,
          year: Number(v.year ?? 0),
          month: Number(v.month ?? 0),
          reviewerId: String(v.reviewerId ?? ""),
          status,
          deadline: String(v.deadline ?? ""),
          groupId,
          indicatorName: ind.name,
          unitName: unit?.name ?? unitId,
          groupName: groupName.get(groupId) ?? groupId,
        }];
      });
      allTasks.sort((a, b) => a.groupName.localeCompare(b.groupName, "zh-Hant") || a.unitName.localeCompare(b.unitName, "zh-Hant") || a.indicatorName.localeCompare(b.indicatorName, "zh-Hant") || a.month - b.month);
      setTasks(allTasks);
    } catch (error) {
      setTasks([]);
      onAction(`任務交接資料載入失敗：${toErrorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, [user, onAction]);

  useEffect(() => { void load(); }, [load]);

  const isAdmin = (user?.roles ?? []).includes("系統管理員");
  const canOpen = isAdmin || managerGroupIds.length > 0;
  const availableGroups = useMemo(() => isAdmin ? groups : groups.filter((g) => managerGroupIds.includes(g.id)), [groups, isAdmin, managerGroupIds]);
  const availableUnits = useMemo(() => units.filter((u) => (!groupFilter || u.groupId === groupFilter)), [units, groupFilter]);
  const eligible = useMemo(() => {
    const q = reviewerSearch.trim().toLowerCase();
    return tasks.filter((t) =>
      (!groupFilter || t.groupId === groupFilter) &&
      (!unitFilter || t.unitId === unitFilter) &&
      (!selectedReviewer || t.reviewerId === selectedReviewer) &&
      (!q || t.reviewerId.toLowerCase().includes(q) || t.indicatorName.toLowerCase().includes(q) || t.unitName.toLowerCase().includes(q))
    );
  }, [tasks, groupFilter, unitFilter, selectedReviewer, reviewerSearch]);
  const reviewerOptions = useMemo(() => [...new Set(tasks.filter((t) => !groupFilter || t.groupId === groupFilter).filter((t) => !unitFilter || t.unitId === unitFilter).map((t) => t.reviewerId).filter(Boolean))].sort(), [tasks, groupFilter, unitFilter]);
  const selected = eligible.filter((t) => selectedTasks.includes(t.id));

  function toggleTask(id: string) {
    setSelectedTasks((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }
  function toggleAll() {
    setSelectedTasks((prev) => eligible.length > 0 && eligible.every((t) => prev.includes(t.id))
      ? prev.filter((id) => !eligible.some((t) => t.id === id))
      : [...new Set([...prev, ...eligible.map((t) => t.id)])]);
  }
  function resetFilters() {
    setSelectedReviewer("");
    setReviewerSearch("");
    setSelectedTasks([]);
  }

  async function handleHandoff() {
    const to = newReviewerId.trim();
    if (!user || !to || selected.length === 0) {
      onAction("請選擇原審查員、至少一筆未完成任務，並輸入新審查員職編");
      return;
    }
    if (selected.some((t) => t.reviewerId === to)) {
      onAction("新審查員與原審查員相同，請重新輸入");
      return;
    }
    const ok = window.confirm(`確定將 ${selected.length} 筆未完成任務交接給職編 ${to}？交接立即生效。已完成任務不會被交接。`);
    if (!ok) return;
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
      setNewReviewerId("");
      setReason("");
      setSelectedTasks([]);
      setSelectedReviewer("");
      await load();
      onAction(`已完成 ${selected.length} 筆任務交接，立即生效`);
    } catch (error) {
      onAction(`交接失敗：${toErrorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  if (!canOpen && !loading) {
    return <EmptyState title="無交接權限" description="僅系統管理員，或隸屬原指標組別的召集人／執行幹事可進行未完成任務交接。" />;
  }

  return (
    <>
      <PageHeading page="handoff" />
      <SectionTitle title="任務交接" note="只列出你有權管理組別中尚未完成的任務；交接立即生效，已完成任務不會轉派。" action={<button type="button" className="button button-outline" onClick={() => void load()} disabled={loading || saving}><RefreshCw size={15} />重新整理</button>} />
      <section className="panel">
        <div className="org-filter-row" role="search">
          <label className="form-field"><span className="field-label">群組</span><select className="text-input" value={groupFilter} onChange={(e) => { setGroupFilter(e.target.value); setUnitFilter(""); setSelectedReviewer(""); setSelectedTasks([]); }}><option value="">全部可管理群組</option>{availableGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
          <label className="form-field"><span className="field-label">單位</span><select className="text-input" value={unitFilter} onChange={(e) => { setUnitFilter(e.target.value); setSelectedReviewer(""); setSelectedTasks([]); }}><option value="">全部單位</option>{availableUnits.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
          <label className="form-field"><span className="field-label">原審查員</span><select className="text-input" value={selectedReviewer} onChange={(e) => { setSelectedReviewer(e.target.value); setSelectedTasks([]); }}><option value="">全部審查員</option>{reviewerOptions.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
          <label className="form-field"><span className="field-label">搜尋審查員／指標／單位</span><input className="text-input" value={reviewerSearch} onChange={(e) => setReviewerSearch(e.target.value)} placeholder="輸入職編、指標或單位" /></label>
        </div>
        <div className="form-grid" style={{ marginTop: 16 }}>
          <label className="form-field"><span className="field-label">新審查員職編</span><input className="text-input" value={newReviewerId} onChange={(e) => setNewReviewerId(e.target.value)} placeholder="輸入新審查員職編" /></label>
          <label className="form-field"><span className="field-label">交接原因（選填）</span><input className="text-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：原審查員離職／請假" /></label>
        </div>
        <div className="form-actions" style={{ marginTop: 14 }}>
          <button type="button" className="button button-outline" onClick={toggleAll} disabled={eligible.length === 0}>{eligible.length > 0 && eligible.every((t) => selectedTasks.includes(t.id)) ? "取消全選" : "全選未完成任務"}</button>
          <button type="button" className="button button-ghost" onClick={resetFilters}>清除原審查員篩選</button>
          <button type="button" className="button button-primary" onClick={() => void handleHandoff()} disabled={saving || selected.length === 0 || !newReviewerId.trim()}><ArrowRightLeft size={15} />{saving ? "交接中…" : `交接已選任務（${selected.length}）`}</button>
        </div>
      </section>
      <section className="panel">
        {loading ? <p className="settings-note">載入未完成任務…</p> : eligible.length === 0 ? <EmptyState title="沒有符合條件的未完成任務" description="請調整群組、單位或原審查員篩選；已完成任務不會顯示。" /> : (
          <div className="table-scroll"><table className="data-table"><thead><tr><th>選取</th><th>原審查員</th><th>群組／單位</th><th>指標</th><th>審查期間</th><th>期限</th><th>狀態</th></tr></thead><tbody>{eligible.map((t) => <tr key={t.id}><td><input type="checkbox" checked={selectedTasks.includes(t.id)} onChange={() => toggleTask(t.id)} aria-label={`選取任務 ${t.id}`} /></td><td>{t.reviewerId}</td><td>{t.groupName}／{t.unitName}</td><td>{t.indicatorName}</td><td>{t.year} 年 {t.month} 月</td><td>{t.deadline || "—"}</td><td>{t.status === "locked" ? "逾期鎖定" : "未完成"}</td></tr>)}</tbody></table></div>
        )}
      </section>
      <p className="settings-note">交接僅變更未完成任務的派遣責任，不建立新任務或新審查紀錄；已提交／已完成結果維持原紀錄。</p>
    </>
  );
}
