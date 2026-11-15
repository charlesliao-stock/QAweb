/**
 * 資料清理（v1.73.0，僅系統管理員）：建構／測試期用，一次清掉選定集合的資料。
 * 安全設計：
 * - 預設全不勾；先「預覽數量」（伺服器計數，低讀取量）再執行；
 * - 執行需輸入「清除」確認；永久刪除、無法復原；
 * - 保護：目前登入者、具「系統管理員」角色的人員、「系統管理員」角色本身不會被刪；
 * - 可限定單一指標（只清該指標的審查／排程資料）；
 * - 只刪 Firestore 文件；Firebase 驗證帳號（登入帳密）無法從瀏覽器刪除，會保留；
 * - 每次執行寫一筆稽核軌跡（只記集合與筆數）。
 * 注意：刪除計入每日寫入額度（Spark 為 2 萬次），大量清理請分日。
 */
import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { SectionTitle } from "../components/ui";
import { useAuth } from "../lib/auth";
import { getFirebaseDb } from "../lib/firebase";
import { writeAuditLog } from "../lib/audit";
import {
  collection,
  doc,
  getCount,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
  writeBatch,
} from "../lib/db";

type Group = "review" | "schedule" | "org" | "capa";

interface Target {
  id: string;
  label: string;
  group: Group;
  /** 可用 indicatorId 限縮 */
  scoped?: boolean;
  /** 保護規則：回傳 true＝不刪 */
  protect?: (docId: string, data: Record<string, unknown>, me: { staffId: string }) => boolean;
  note?: string;
}

const GROUP_LABEL: Record<Group, string> = {
  review: "審查資料",
  schedule: "排程與指派",
  org: "組織與人員",
  capa: "CAPA",
};

const TARGETS: Target[] = [
  { id: "reviewRecords", label: "審查紀錄", group: "review", scoped: true },
  { id: "reviewDrafts", label: "審查暫存", group: "review", scoped: true },
  { id: "reviewReservations", label: "受審人員名額占用", group: "review", scoped: true },
  { id: "reviewArchives", label: "封存摘要", group: "review", scoped: true },
  { id: "reviewTasks", label: "審查任務", group: "review", scoped: true },
  { id: "reviewQuotaGroups", label: "週期配額名額", group: "review", scoped: true },
  { id: "unlockRequests", label: "解鎖申請", group: "review", scoped: true },
  { id: "reviewEditRequests", label: "紀錄修正申請", group: "review", scoped: true },
  { id: "indicatorSchedules", label: "審查排程", group: "schedule", scoped: true },
  { id: "indicatorAssignments", label: "分工指派", group: "schedule", scoped: true },
  {
    id: "users",
    label: "人員（僅人員資料文件）",
    group: "org",
    protect: (id, data, me) =>
      id === me.staffId ||
      (Array.isArray(data.roles) && (data.roles as unknown[]).includes("系統管理員")),
    note: "保留你自己與所有系統管理員；登入帳號（Firebase 驗證）不會被刪",
  },
  {
    id: "roles",
    label: "角色",
    group: "org",
    protect: (id, data) => data.name === "系統管理員" || id === "系統管理員",
    note: "保留「系統管理員」角色",
  },
  { id: "titles", label: "職稱", group: "org" },
  { id: "units", label: "單位", group: "org" },
  { id: "groups", label: "群組／次群組", group: "org" },
  { id: "capa", label: "CAPA 案件", group: "capa" },
];

const PAGE = 400;

export function AdminCleanupSection({ onAction }: { onAction: (message: string) => void }) {
  const { user } = useAuth();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [indicatorId, setIndicatorId] = useState("");
  const [counts, setCounts] = useState<Record<string, number | "err">>({});
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const scopeId = indicatorId.trim();
  const isAdmin = (user?.roles ?? []).includes("系統管理員");
  const me = useMemo(() => ({ staffId: user?.staffId ?? "" }), [user?.staffId]);

  const available = (t: Target) => !scopeId || t.scoped;
  const selected = TARGETS.filter((t) => picked.has(t.id) && available(t));
  const total = selected.reduce((s, t) => {
    const c = counts[t.id];
    return s + (typeof c === "number" ? c : 0);
  }, 0);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const baseQuery = (t: Target) => {
    const db = getFirebaseDb();
    return scopeId && t.scoped
      ? query(collection(db, t.id), where("indicatorId", "==", scopeId))
      : collection(db, t.id);
  };

  async function preview() {
    if (busy) return;
    setBusy(true);
    const next: Record<string, number | "err"> = {};
    for (const t of selected) {
      try {
        next[t.id] = await getCount(baseQuery(t));
      } catch {
        next[t.id] = "err";
      }
    }
    setCounts(next);
    setBusy(false);
  }

  async function run() {
    if (busy || !user || !isAdmin) return;
    if (confirmText.trim() !== "清除") return;
    if (selected.length === 0) return;
    if (!window.confirm(`即將永久刪除所選資料（預估 ${total} 筆），無法復原。確定執行？`)) return;
    setBusy(true);
    setLog([]);
    const db = getFirebaseDb();
    const summary: string[] = [];
    try {
      for (const t of selected) {
        let deleted = 0;
        let kept = 0;
        let cursor: unknown = null;
        for (;;) {
          const base = baseQuery(t);
          const q = cursor
            ? query(base, orderBy("__name__"), startAfter(cursor), limit(PAGE))
            : query(base, orderBy("__name__"), limit(PAGE));
          const snap = await getDocs(q);
          if (snap.docs.length === 0) break;
          const batch = writeBatch(db);
          let ops = 0;
          snap.docs.forEach((d: { id: string; data: () => unknown; ref: unknown }) => {
            const data = (d.data() ?? {}) as Record<string, unknown>;
            if (t.protect?.(d.id, data, me)) {
              kept += 1;
              return;
            }
            batch.delete(doc(db, t.id, d.id));
            ops += 1;
          });
          if (ops > 0) await batch.commit();
          deleted += ops;
          cursor = snap.docs[snap.docs.length - 1];
          setLog((prev) => [...prev.filter((l) => !l.startsWith(`${t.label}：`)), `${t.label}：已刪 ${deleted} 筆${kept ? `（保留 ${kept}）` : ""}…`]);
          if (snap.docs.length < PAGE) break;
        }
        summary.push(`${t.id} ${deleted}${kept ? `（保留 ${kept}）` : ""}`);
        setLog((prev) => [...prev.filter((l) => !l.startsWith(`${t.label}：`)), `${t.label}：完成，刪除 ${deleted} 筆${kept ? `，保留 ${kept} 筆` : ""}`]);
      }
      await writeAuditLog(db, {
        actor: user.staffId,
        actorName: user.name,
        action: "資料清理",
        targetType: "cleanup",
        targetId: scopeId ? `指標 ${scopeId}` : "全部",
        detail: summary.join("；"),
      }).catch(() => undefined);
      onAction(`資料清理完成：${summary.join("；")}`);
      setCounts({});
      setConfirmText("");
    } catch (error) {
      onAction(`資料清理中斷：${error instanceof Error ? error.message : String(error)}（已完成的部分不會復原，可重新預覽後再執行）`);
    } finally {
      setBusy(false);
    }
  }

  if (!isAdmin) return <p className="settings-note">此功能僅供系統管理員使用。</p>;

  return (
    <section className="panel" id="admin-cleanup">
      <SectionTitle title="資料清理" note="建構／測試期使用：永久刪除所選集合的資料，無法復原" />
      <p className="settings-note" style={{ color: "#b3372f", fontWeight: 600 }}>
        請先確認都是測試資料。刪除計入每日寫入額度（免費 2 萬次），大量清理請分日進行。
      </p>
      <div className="form-field" style={{ maxWidth: 360 }}>
        <label className="field-label">限定指標（選填，例如 3-0001；填了只能清審查與排程類）</label>
        <input
          className="text-input"
          value={indicatorId}
          onChange={(e) => {
            setIndicatorId(e.target.value);
            setCounts({});
          }}
          placeholder="留空＝整個集合"
        />
      </div>
      {(Object.keys(GROUP_LABEL) as Group[]).map((g) => (
        <fieldset key={g} style={{ margin: "12px 0", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 12px" }}>
          <legend><b>{GROUP_LABEL[g]}</b></legend>
          {TARGETS.filter((t) => t.group === g).map((t) => {
            const c = counts[t.id];
            const ok = available(t);
            return (
              <label key={t.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", opacity: ok ? 1 : 0.4 }}>
                <input type="checkbox" disabled={!ok || busy} checked={picked.has(t.id) && ok} onChange={() => toggle(t.id)} />
                <span>{t.label}</span>
                {t.note && <small className="settings-note">　{t.note}</small>}
                {picked.has(t.id) && ok && c !== undefined && (
                  <b style={{ marginLeft: "auto" }}>{c === "err" ? "計數失敗" : `${c.toLocaleString()} 筆`}</b>
                )}
              </label>
            );
          })}
        </fieldset>
      ))}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button className="button button-outline" type="button" disabled={busy || selected.length === 0} onClick={() => void preview()}>
          預覽數量
        </button>
        <input
          className="text-input"
          style={{ maxWidth: 200 }}
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="輸入「清除」確認"
          disabled={busy}
        />
        <button
          className="button"
          type="button"
          style={{ background: "#b3372f", color: "#fff" }}
          disabled={busy || selected.length === 0 || confirmText.trim() !== "清除" || Object.keys(counts).length === 0}
          onClick={() => void run()}
        >
          <Trash2 size={15} /> 執行清理
        </button>
      </div>
      <p className="settings-note">需先「預覽數量」才能執行。{total > 15000 ? "預估筆數很多，可能超過當日寫入額度，建議分日。" : ""}</p>
      {log.length > 0 && (
        <ul className="settings-note">
          {log.map((l) => <li key={l}>{l}</li>)}
        </ul>
      )}
    </section>
  );
}
