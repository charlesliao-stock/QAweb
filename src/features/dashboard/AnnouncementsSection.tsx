/**
 * 系統公告區（v1.88.35）：四群頂部都顯示有效期內的公告。
 * 資料來源：新集合 `announcements`（管理員在系統管理頁發布）。
 * 已讀：寫回 readBy（只加本人職編）；關閉：僅本機隱藏（localStorage）。
 */
import { useEffect, useState } from "react";
import { collection, doc, getDoc, getDocs, updateDoc } from "../../lib/db";
import { getFirebaseDb } from "../../lib/firebase";
import { useAuth } from "../../lib/auth";
import { SectionTitle } from "../../components/ui";
import {
  isAnnouncementVisible,
  parseAnnouncement,
  sortAnnouncements,
  type Announcement,
} from "../../lib/announcements";
import type { DashboardGroup } from "../../lib/dashboardGroups";

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dismissedKey(staffId: string): string {
  return `qi-announcements-dismissed:${staffId}`;
}

function loadDismissed(staffId: string): Set<string> {
  try {
    const raw = localStorage.getItem(dismissedKey(staffId));
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

export function AnnouncementsSection({ group }: { group: DashboardGroup }) {
  const { user } = useAuth();
  const staffId = user?.staffId ?? "";
  const [items, setItems] = useState<Announcement[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [marking, setMarking] = useState<string>("");

  useEffect(() => {
    setDismissed(loadDismissed(staffId));
  }, [staffId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snap = await getDocs(collection(getFirebaseDb(), "announcements"));
        if (cancelled) return;
        setItems(
          snap.docs.map((d) =>
            parseAnnouncement(d.id, d.data() as Record<string, unknown>),
          ),
        );
      } catch {
        if (!cancelled) setItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const today = todayStr();
  const visible = sortAnnouncements(items).filter(
    (a) => isAnnouncementVisible(a, group, today) && !dismissed.has(a.id),
  );
  if (visible.length === 0) return null;

  const dismiss = (id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      try {
        localStorage.setItem(dismissedKey(staffId), JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const markRead = async (a: Announcement) => {
    if (!staffId || a.readBy.includes(staffId) || marking) return;
    setMarking(a.id);
    try {
      const ref = doc(getFirebaseDb(), "announcements", a.id);
      const snap = await getDoc(ref);
      const current = snap.exists()
        ? parseAnnouncement(snap.id, snap.data() as Record<string, unknown>)
        : a;
      const readBy = [...new Set([...current.readBy, staffId])];
      await updateDoc(ref, { readBy });
      setItems((prev) =>
        prev.map((item) => (item.id === a.id ? { ...item, readBy } : item)),
      );
    } catch {
      /* 標示失敗不影響畫面 */
    } finally {
      setMarking("");
    }
  };

  return (
    <section className="panel" aria-label="系統公告">
      <SectionTitle title="系統公告" note={`共 ${visible.length} 則`} />
      {visible.map((a) => {
        const read = a.readBy.includes(staffId);
        return (
          <div
            key={a.id}
            style={{
              marginBottom: 12,
              paddingBottom: 12,
              borderBottom: "1px solid var(--hatch-widget-border, #e8edef)",
              opacity: read ? 0.65 : 1,
            }}
          >
            <p style={{ margin: "0 0 4px" }}>
              <b>{a.title}</b>
              {read && (
                <span className="muted-text" style={{ marginLeft: 8 }}>
                  已讀
                </span>
              )}
              {(a.startDate || a.endDate) && (
                <span className="muted-text" style={{ marginLeft: 8 }}>
                  {a.startDate || "—"}～{a.endDate || "—"}
                </span>
              )}
            </p>
            <p style={{ margin: "0 0 8px", whiteSpace: "pre-wrap" }}>{a.body}</p>
            <div style={{ display: "flex", gap: 8 }}>
              {!read && (
                <button
                  className="button button-outline"
                  type="button"
                  disabled={marking === a.id}
                  onClick={() => void markRead(a)}
                >
                  標示已讀
                </button>
              )}
              <button
                className="button button-outline"
                type="button"
                onClick={() => dismiss(a.id)}
              >
                關閉
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
