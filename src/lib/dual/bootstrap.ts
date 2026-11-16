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
import type { SupabaseUsage } from "./status";

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
let dualStoreRef: DualStore | null = null;
let supabaseRef: SupabaseAdapter | null = null;
let refreshedForRole = false;

/** 目前資料庫健康狀態（未啟用雙寫回 null；不發網路請求）。 */
export function dualHealth(): (DualHealth & { lastEvent: DualEvent | null }) | null {
  return dualStoreRef ? { ...dualStoreRef.health(), lastEvent } : null;
}

/** 立即補送同步佇列（管理頁按鈕用）。 */
export async function dualDrainNow(): Promise<{ done: number; left: number }> {
  if (!dualStoreRef) return { done: 0, left: 0 };
  return dualStoreRef.drain();
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
    onEvent: (e) => {
      lastEvent = e;
      if (e.type === "failover-write" || e.type === "dead-letter") console.warn("[dual]", e);
    },
  });
  dualStoreRef = store;
  installDualStore(store);
  // 上線／回到前景時補送佇列
  if (typeof window !== "undefined") {
    const kick = (): void => void store.drain().catch(() => {});
    window.addEventListener("online", kick);
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && kick());
    window.setInterval(kick, 60_000);
    kick();
  }
}
