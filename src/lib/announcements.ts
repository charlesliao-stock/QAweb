/**
 * 系統公告（v1.88.35 儀表板設定；新集合 `announcements`）。
 * 純函式：公告解析與可見性判斷（對象／有效期／啟用狀態）。
 * 不碰 Firestore，可在 node 直接單元測試。
 */

import type { DashboardGroup } from "./dashboardGroups";

export type AnnouncementAudience = "all" | DashboardGroup[];

export interface Announcement {
  id: string;
  title: string;
  body: string;
  audience: AnnouncementAudience;
  /** 生效起日 "YYYY-MM-DD"（空＝不限）；迄日同。 */
  startDate: string;
  endDate: string;
  active: boolean;
  createdBy: string;
  createdAt: unknown;
  readBy: string[];
}

export const ANNOUNCEMENT_GROUP_LABELS: Record<DashboardGroup, string> = {
  g1: "第 1 群",
  g2: "第 2 群",
  g3: "第 3 群",
  g4: "第 4 群",
};

export function parseAnnouncement(
  id: string,
  data: Record<string, unknown>,
): Announcement {
  const rawAudience = data.audience;
  const audience: AnnouncementAudience =
    rawAudience === "all"
      ? "all"
      : Array.isArray(rawAudience)
        ? (rawAudience.filter(
            (g): g is DashboardGroup =>
              g === "g1" || g === "g2" || g === "g3" || g === "g4",
          ) as DashboardGroup[])
        : "all";
  const readBy = Array.isArray(data.readBy)
    ? (data.readBy as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  return {
    id,
    title: typeof data.title === "string" ? data.title : "",
    body: typeof data.body === "string" ? data.body : "",
    audience,
    startDate: typeof data.startDate === "string" ? data.startDate : "",
    endDate: typeof data.endDate === "string" ? data.endDate : "",
    active: data.active !== false,
    createdBy: typeof data.createdBy === "string" ? data.createdBy : "",
    createdAt: data.createdAt,
    readBy,
  };
}

function toDayString(value: unknown): string {
  try {
    const t = value as { toDate?: unknown };
    if (t && typeof t.toDate === "function") {
      const d = (t.toDate as () => Date)();
      if (d instanceof Date && !Number.isNaN(d.getTime())) {
        return d.toISOString().slice(0, 10);
      }
    }
  } catch {
    /* ignore */
  }
  return "";
}

/** 公告是否在今天有效（啟用中、起迄日期內、對象包含該群）。 */
export function isAnnouncementVisible(
  a: Announcement,
  group: DashboardGroup,
  today: string,
): boolean {
  if (!a.active) return false;
  if (a.title.trim() === "") return false;
  if (a.startDate && today < a.startDate) return false;
  if (a.endDate && today > a.endDate) return false;
  if (a.audience === "all") return true;
  return a.audience.includes(group);
}

/** 依建立時間新→舊排序（無時間戳者排最後）。 */
export function sortAnnouncements(items: Announcement[]): Announcement[] {
  return [...items].sort((a, b) => {
    const da = toDayString(a.createdAt);
    const db = toDayString(b.createdAt);
    if (da === db) return a.id.localeCompare(b.id);
    if (!da) return 1;
    if (!db) return -1;
    return db.localeCompare(da);
  });
}
