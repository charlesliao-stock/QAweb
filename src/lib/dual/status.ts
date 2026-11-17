/**
 * 「資料庫狀態」的純函式（不碰網路／React，方便測試）。
 * 上限數字是各服務免費方案的公開額度；升級方案後請同步調整。
 */
import type { DualHealth } from "./dualStore";

/** Supabase 免費方案：資料庫 500 MB、每月傳輸 5 GB、閒置一週暫停。 */
export const SUPABASE_LIMITS = { dbBytes: 500 * 1024 * 1024, egressGb: 5 } as const;

export interface SupabaseUsage {
  dbBytes: number;
  docCount: number;
  byCol: Record<string, number>;
  at: number;
}

export type Level = "ok" | "warn" | "stop";

/** 用量百分比（上限 0 或非數字時回 0）。 */
export function pct(used: number, quota: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(quota) || quota <= 0) return 0;
  return (used / quota) * 100;
}

/** 與 Firebase 流量控管同一組門檻：達 warn 黃、達 stop 紅。 */
export function level(percent: number, warn = 80, stop = 95): Level {
  return percent >= stop ? "stop" : percent >= warn ? "warn" : "ok";
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const DB_LABEL: Record<string, string> = { supabase: "Supabase", firebase: "Firebase" };
export const dbLabel = (name: string): string => DB_LABEL[name] ?? name;

export interface StatusLine {
  tone: "ok" | "warn" | "bad";
  text: string;
}

/** 一句話說明目前是誰在服務、有沒有資料欠同步。 */
export function describeHealth(h: DualHealth): StatusLine {
  const p = dbLabel(h.primary.name);
  const s = dbLabel(h.secondary.name);
  if (h.mode === "failover") {
    return {
      tone: "bad",
      text: `${p} 目前無法使用，系統改由備援 ${s} 服務；${p} 恢復後會自動補同步（尚有 ${h.pendingToPrimary} 筆待補回）。`,
    };
  }
  if (h.deadLetters > 0) {
    return { tone: "bad", text: `有 ${h.deadLetters} 筆資料同步失敗被放棄，請聯絡管理員對帳。` };
  }
  if (h.secondary.breaker !== "closed") {
    return { tone: "warn", text: `主資料庫 ${p} 正常；備援 ${s} 暫時連不上，待同步 ${h.pendingToSecondary} 筆，恢復後自動補送。` };
  }
  if (h.pendingToSecondary > 0 || h.pendingToPrimary > 0) {
    return { tone: "warn", text: `主資料庫 ${p} 正常；正在同步到備援 ${s}（待同步 ${h.pendingToSecondary + h.pendingToPrimary} 筆）。` };
  }
  return { tone: "ok", text: `主資料庫 ${p} 與備援 ${s} 皆正常，資料已同步。` };
}
