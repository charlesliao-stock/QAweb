/**
 * 系統公告管理（v1.88.35）：僅系統管理員。
 * 集合 `announcements`：標題、內文、對象（全員／指定群）、起迄有效期、啟用。
 * 讀取：登入者皆可讀；寫入：僅管理員（firestore.rules 亦擋）。
 */
import { useCallback, useEffect, useState } from "react";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "../lib/db";
import { getFirebaseDb } from "../lib/firebase";
import { useAuth } from "../lib/auth";
import { SectionTitle } from "../components/ui";
import {
  ANNOUNCEMENT_GROUP_LABELS,
  parseAnnouncement,
  sortAnnouncements,
  type Announcement,
  type AnnouncementAudience,
} from "../lib/announcements";
import type { DashboardGroup } from "../lib/dashboardGroups";

const GROUP_IDS: DashboardGroup[] = ["g1", "g2", "g3", "g4"];

interface FormState {
  title: string;
  body: string;
  audienceAll: boolean;
  groups: DashboardGroup[];
  startDate: string;
  endDate: string;
  active: boolean;
}

const EMPTY_FORM: FormState = {
  title: "",
  body: "",
  audienceAll: true,
  groups: [],
  startDate: "",
  endDate: "",
  active: true,
};

export function AnnouncementAdminSection({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  const { user } = useAuth();
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(getFirebaseDb(), "announcements"));
      setItems(
        sortAnnouncements(
          snap.docs.map((d) =>
            parseAnnouncement(d.id, d.data() as Record<string, unknown>),
          ),
        ),
      );
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startEdit = (a: Announcement | null) => {
    setError("");
    if (!a) {
      setEditingId(null);
      setForm(EMPTY_FORM);
      return;
    }
    setEditingId(a.id);
    setForm({
      title: a.title,
      body: a.body,
      audienceAll: a.audience === "all",
      groups: a.audience === "all" ? [] : [...a.audience],
      startDate: a.startDate,
      endDate: a.endDate,
      active: a.active,
    });
  };

  const save = async () => {
    setError("");
    if (!form.title.trim()) {
      setError("請填寫公告標題。");
      return;
    }
    if (!form.body.trim()) {
      setError("請填寫公告內文。");
      return;
    }
    if (form.startDate && form.endDate && form.startDate > form.endDate) {
      setError("生效起日不可晚於迄日。");
      return;
    }
    if (!form.audienceAll && form.groups.length === 0) {
      setError("請至少指定一個群組，或改為全員。");
      return;
    }
    const audience: AnnouncementAudience = form.audienceAll
      ? "all"
      : [...form.groups];
    setBusy(true);
    try {
      const db = getFirebaseDb();
      if (editingId) {
        await updateDoc(doc(db, "announcements", editingId), {
          title: form.title.trim(),
          body: form.body.trim(),
          audience,
          startDate: form.startDate,
          endDate: form.endDate,
          active: form.active,
          updatedAt: serverTimestamp(),
        });
        onAction("公告已更新");
      } else {
        await setDoc(doc(collection(db, "announcements")), {
          title: form.title.trim(),
          body: form.body.trim(),
          audience,
          startDate: form.startDate,
          endDate: form.endDate,
          active: form.active,
          createdBy: user?.staffId ?? "",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          readBy: [],
        });
        onAction("公告已發布");
      }
      setEditingId(null);
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存失敗，請稍後再試。");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: Announcement) => {
    if (!window.confirm(`確定刪除公告「${a.title}」嗎？刪除後無法復原。`)) return;
    setBusy(true);
    try {
      await deleteDoc(doc(getFirebaseDb(), "announcements", a.id));
      onAction("公告已刪除");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "刪除失敗，請稍後再試。");
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (a: Announcement) => {
    setBusy(true);
    try {
      await updateDoc(doc(getFirebaseDb(), "announcements", a.id), {
        active: !a.active,
        updatedAt: serverTimestamp(),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新失敗，請稍後再試。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-settings-grid">
      <section className="panel settings-panel">
        <SectionTitle
          title={editingId ? "編輯公告" : "新增公告"}
          note="發布後顯示於各群儀表板頂部（依對象與有效期過濾）"
        />
        <div className="form-field">
          <label className="field-label">標題</label>
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="例如：12 月品質查核提醒"
          />
        </div>
        <div className="form-field">
          <label className="field-label">內文</label>
          <textarea
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            rows={4}
            placeholder="公告內容"
          />
        </div>
        <div className="form-field">
          <label className="field-label">對象</label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={form.audienceAll}
              onChange={(e) =>
                setForm({ ...form, audienceAll: e.target.checked })
              }
            />
            全員
          </label>
          {!form.audienceAll && (
            <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
              {GROUP_IDS.map((g) => (
                <label key={g} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={form.groups.includes(g)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        groups: e.target.checked
                          ? [...form.groups, g]
                          : form.groups.filter((x) => x !== g),
                      })
                    }
                  />
                  {ANNOUNCEMENT_GROUP_LABELS[g]}
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="form-field" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <label style={{ flex: 1, minWidth: 140 }}>
            <span className="field-label">生效起日（空白＝不限）</span>
            <input
              type="date"
              value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
            />
          </label>
          <label style={{ flex: 1, minWidth: 140 }}>
            <span className="field-label">迄日（空白＝不限）</span>
            <input
              type="date"
              value={form.endDate}
              onChange={(e) => setForm({ ...form, endDate: e.target.value })}
            />
          </label>
        </div>
        <label style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => setForm({ ...form, active: e.target.checked })}
          />
          啟用（關閉後不顯示於儀表板）
        </label>
        {error && (
          <p className="settings-note" style={{ color: "#b3372f", fontWeight: 600 }}>
            {error}
          </p>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="button button-primary" type="button" disabled={busy} onClick={() => void save()}>
            {editingId ? "儲存修改" : "發布公告"}
          </button>
          {editingId && (
            <button className="button button-outline" type="button" disabled={busy} onClick={() => startEdit(null)}>
              取消編輯
            </button>
          )}
        </div>
      </section>

      <section className="panel settings-panel">
        <SectionTitle title="公告清單" note={`共 ${items.length} 則`} />
        {loading ? (
          <p className="settings-note">讀取中…</p>
        ) : items.length === 0 ? (
          <p className="settings-note">尚無公告。</p>
        ) : (
          items.map((a) => (
            <div key={a.id} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: "1px solid #e8edef" }}>
              <p style={{ margin: "0 0 4px" }}>
                <b>{a.title}</b>
                {!a.active && (
                  <span className="status-pill" style={{ marginLeft: 8 }}>
                    已停用
                  </span>
                )}
                <span className="muted-text" style={{ marginLeft: 8 }}>
                  {a.audience === "all"
                    ? "全員"
                    : a.audience.map((g) => ANNOUNCEMENT_GROUP_LABELS[g]).join("、")}
                  {` · ${a.startDate || "—"}～${a.endDate || "—"}`}
                </span>
              </p>
              <p className="settings-note" style={{ margin: "0 0 8px", whiteSpace: "pre-wrap" }}>
                {a.body}
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="button button-outline" type="button" disabled={busy} onClick={() => startEdit(a)}>
                  編輯
                </button>
                <button className="button button-outline" type="button" disabled={busy} onClick={() => void toggleActive(a)}>
                  {a.active ? "停用" : "啟用"}
                </button>
                <button className="button button-outline" type="button" disabled={busy} onClick={() => void remove(a)}>
                  刪除
                </button>
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
