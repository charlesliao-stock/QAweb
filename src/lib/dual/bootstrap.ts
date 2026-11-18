/**
 * 雙寫模式開關與初始化。
 *   VITE_DB_MODE=dual  且  VITE_SUPABASE_URL／VITE_SUPABASE_PUBLISHABLE_KEY 皆有值 → 雙寫（Supabase 主、Firebase 備）
 *   其他情況（預設）→ 與改版前完全相同：只用 Firebase。
 * 由 firebase.ts 的 getFirebaseDb() 在建立 Firestore 後呼叫 initDual()。
 */
import {
  collection, doc, getDoc, getDocs, limit, orderBy, query, startAfter, Timestamp, where, writeBatch,
} from "firebase/firestore";
import type { Auth } from "firebase/auth";
import { installDualStore, isDualInstalled } from "./dualDb";
import { DualStore, type DualEvent, type DualHealth } from "./dualStore";
import { firestoreDocs } from "./firestoreDocs";
import { supabaseDocs, type SupabaseAdapter } from "./supabaseDocs";
import { dbLabel, type SupabaseUsage } from "./status";

const env = import.meta.env as Record<string, string | undefined>;
const SUPABASE_URL = env.VITE_SUPABASE_URL ?? "";
const SUPABASE_KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";

/** 設定齊全且選了 dual 才啟用。 */
export const dualRequested: boolean =
  env.VITE_DB_MODE === "dual" && SUPABASE_URL !== "" && SUPABASE_KEY !== "";

export function isDualMode(): boolean {
  return dualRequested && isDualInstalled();
}

let lastEvent: DualEvent | null = null;

/** 最近事件記錄（保留最近 50 筆，存在本機瀏覽器；只記狀態切換與錯誤，不含資料內容）。 */
export interface EventLogItem { ts: number; level: "info" | "warn" | "bad"; text: string }
const EVENT_KEY = "dualstore:events:v1";
const EVENT_MAX = 50;
let eventLog: EventLogItem[] = [];
try {
  if (typeof localStorage !== "undefined") {
    const raw = JSON.parse(localStorage.getItem(EVENT_KEY) ?? "[]") as EventLogItem[];
    if (Array.isArray(raw)) eventLog = raw.slice(-EVENT_MAX);
  }
} catch { /* 記錄壞掉就從空的開始 */ }

function logEvent(level: EventLogItem["level"], text: string): void {
  const last = eventLog[eventLog.length - 1];
  // 同一訊息 30 秒內重複只記一次，避免洗版
  if (last && last.text === text && Date.now() - last.ts < 30_000) return;
  eventLog = [...eventLog, { ts: Date.now(), level, text }].slice(-EVENT_MAX);
  try { localStorage.setItem(EVENT_KEY, JSON.stringify(eventLog)); } catch { /* 空間不足就略過 */ }
}

export function dualEvents(): EventLogItem[] { return [...eventLog].reverse(); }
export function dualClearEvents(): void {
  eventLog = [];
  try { localStorage.removeItem(EVENT_KEY); } catch { /* ignore */ }
}
let dualStoreRef: DualStore | null = null;
let supabaseRef: SupabaseAdapter | null = null;
let refreshedForRole = false;

/** 目前資料庫健康狀態（未啟用雙寫回 null；不發網路請求）。 */
export function dualHealth(): (DualHealth & { lastEvent: DualEvent | null }) | null {
  return dualStoreRef ? { ...dualStoreRef.health(), lastEvent } : null;
}

/**
 * 訂閱健康狀態輪詢（全站共用一個計時器）。
 * - 只在分頁可見時輪詢；分頁切回前景會立刻檢查一次。
 * - 有訂閱者才有計時器；最後一個取消訂閱時計時器隨之清除。
 * - 輪詢只讀記憶體內的斷路器狀態，不發任何網路請求。
 * 回傳取消訂閱函式（React effect 的 cleanup 直接回傳即可）。
 */
const HEALTH_POLL_MS = 5000;
const healthListeners = new Set<() => void>();
let healthTimer: number | undefined;

function notifyHealth(): void {
  for (const fn of [...healthListeners]) {
    try { fn(); } catch { /* 單一訂閱者出錯不影響其他人 */ }
  }
}
function onHealthVisibility(): void {
  if (document.visibilityState === "visible") notifyHealth();
}
function startHealthTimer(): void {
  if (healthTimer !== undefined || typeof window === "undefined") return;
  healthTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") notifyHealth();
  }, HEALTH_POLL_MS);
  document.addEventListener("visibilitychange", onHealthVisibility);
}
function stopHealthTimer(): void {
  if (healthTimer === undefined) return;
  window.clearInterval(healthTimer);
  healthTimer = undefined;
  document.removeEventListener("visibilitychange", onHealthVisibility);
}

export function watchDualHealth(listener: () => void): () => void {
  healthListeners.add(listener);
  startHealthTimer();
  return () => {
    healthListeners.delete(listener);
    if (healthListeners.size === 0) stopHealthTimer();
  };
}

/** 立即補送同步佇列（管理頁按鈕用）。 */
export async function dualDrainNow(): Promise<{ done: number; left: number }> {
  if (!dualStoreRef) return { done: 0, left: 0 };
  return dualStoreRef.drain();
}

/** 修正拒絕原因後，人工解除死信並立即重試。 */
export async function dualRetryDeadLetters(): Promise<{ retried: number; done: number; left: number }> {
  if (!dualStoreRef) return { retried: 0, done: 0, left: 0 };
  const retried = dualStoreRef.retryDeadLetters();
  const result = retried ? await dualStoreRef.drain() : { done: 0, left: 0 };
  return { retried, ...result };
}

/** Supabase 資料庫大小與文件數（僅系統管理員；需先執行 supabase/04-status.sql）。 */
export async function fetchSupabaseUsage(): Promise<SupabaseUsage> {
  if (!supabaseRef) throw new Error("雙寫模式未啟用");
  return supabaseRef.rpc<SupabaseUsage>("db_status");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function initDual(firestoreDb: any, getAuth: () => Auth): void {
  if (!dualRequested || isDualInstalled()) return;
  const supabase = supabaseDocs({
      url: SUPABASE_URL,
      apiKey: SUPABASE_KEY,
      // 登入者的 Firebase ID token（Supabase 以第三方驗證信任 Firebase）；未登入則為 null
      getToken: async () => {
        const user = getAuth().currentUser;
        if (!user) return null;
        let r = await user.getIdTokenResult();
        // 剛替帳號加上 role 標記時，舊登入的憑證還沒有它：每次載入頁面最多強制換發一次
        if (r.claims.role !== "authenticated" && !refreshedForRole) {
          refreshedForRole = true;
          r = await user.getIdTokenResult(true);
        }
        return r.token;
      },
  });
  supabaseRef = supabase;
  const store = new DualStore({
    primary: supabase,
    secondary: firestoreDocs({
      db: firestoreDb, collection, doc, getDoc, getDocs, query, where, orderBy, limit, startAfter, writeBatch, Timestamp,
    }),
    storage: typeof localStorage !== "undefined" ? localStorage : undefined,
    requirePersistentQueue: true,
    onEvent: (e) => {
      lastEvent = e;
      if (e.type === "failover-write" || e.type === "dead-letter") console.warn("[dual]", e);
      if (e.type === "failover-write") logEvent("bad", `主資料庫無法寫入，${e.ops} 筆改寫到備援，待恢復後補回`);
      else if (e.type === "dead-letter") logEvent("bad", `多次同步失敗，資料已保留待人工重試：${e.col}/${e.id}（目標 ${dbLabel(e.target)}）`);
      else if (e.type === "queue-error") logEvent("bad", `雙庫同步佇列異常：${e.error.slice(0, 160)}`);
      else if (e.type === "error") logEvent(e.breaker === "open" ? "bad" : "warn", `${dbLabel(e.db)} 連線錯誤（${e.breaker === "open" ? "已判定無法使用" : "將重試"}）：${e.error.slice(0, 120)}`);
    },
  });
  dualStoreRef = store;
  installDualStore(store);
  logEvent("info", `雙寫模式啟動：主資料庫 ${dbLabel("supabase")}，備援 ${dbLabel("firebase")}`);
  if (typeof window !== "undefined") {
    let prev = store.mode();
    // 斷路器的 open → half-open 是依時間推進，沒有事件可訂閱，所以仍需輪詢；
    // 但與橫幅、管理頁共用同一個計時器（見 watchDualHealth），背景分頁不再輪詢。
    watchDualHealth(() => {
      const m = store.mode();
      if (m === prev) return;
      logEvent(m === "failover" ? "bad" : "info", m === "failover" ? "切換到備援：主資料庫暫時無法使用" : "主資料庫已恢復，切回主資料庫");
      prev = m;
    });
  }
  // 上線／回到前景時補送佇列
  if (typeof window !== "undefined") {
    const kick = (): void => void store.drain().catch(() => {});
    window.addEventListener("online", kick);
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && kick());
    window.setInterval(kick, 60_000);
    kick();
  }
}
