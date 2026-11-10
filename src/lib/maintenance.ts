/**
 * 流量控管 — 維護開關（v1.41.0，方案 A 最小更動）。
 *
 * 機制：監測 workflow（GitHub Actions）在用量達 95% 時把
 * `configs/system_status` 的 maintenance 寫成 true；前端在統一出口
 * `src/lib/db.ts` 執行讀寫前先檢查該開關，維護開啟且使用者非管理員時
 * 阻擋讀寫並拋出 MaintenanceModeError，UI 顯示維護中。
 *
 * 刻意不經 db.ts 讀取狀態文件（避免遞迴），直接用 Firebase SDK；
 * 展示模式不走本模組（db.ts 在 demo 模式下直接回記憶體實作）。
 *
 * 成本注意：狀態檢查帶 5 分鐘快取（記憶體＋localStorage 跨分頁共用），
 * 避免每次讀寫都多付一次狀態文件讀取。
 */
import {
  doc as fsDoc,
  getDoc as fsGetDoc,
  getFirestore as fsGetFirestore,
} from "firebase/firestore";

/** 維護開關文件路徑（監測 workflow 寫入、前端攔截讀取）。 */
export const SYSTEM_STATUS_PATH = "configs/system_status";
/** 流量控管設定文件路徑（系統管理頁由管理員維護，監測 workflow 每輪讀取）。 */
export const QUOTA_SETTINGS_PATH = "configs/quotaSettings";
/** 狀態檢查快取 TTL：5 分鐘。 */
export const MAINTENANCE_TTL_MS = 5 * 60 * 1000;
/** 阻擋時發出的瀏覽器事件（App.tsx 監聽後顯示維護中橫幅）。 */
export const MAINTENANCE_EVENT = "qi:maintenance";
const STATUS_CACHE_KEY = "qi:systemStatus";

export interface SystemStatus {
  maintenance: boolean;
  reason: string;
  updatedAt: string;
  alert80SentFor: string;
  shutdownSentFor: string;
}

export interface QuotaSettings {
  warnPercent: number;
  shutdownPercent: number;
  monitoringEnabled: boolean;
  lineEnabled: boolean;
  updatedAt?: unknown;
  updatedBy?: string;
}

export const DEFAULT_QUOTA_SETTINGS: QuotaSettings = {
  warnPercent: 80,
  shutdownPercent: 95,
  monitoringEnabled: true,
  lineEnabled: true,
};

export const DEFAULT_SYSTEM_STATUS: SystemStatus = {
  maintenance: false,
  reason: "",
  updatedAt: "",
  alert80SentFor: "",
  shutdownSentFor: "",
};

/**
 * 設定值正規化（前端設定頁與監測端共用同一規則）：
 * 提醒門檻 50–95、關站門檻 51–99，且提醒必須小於關站；
 * 不合法或缺值時退回預設 80／95（不擋系統運作）。
 */
export function normalizeQuotaSettings(raw: unknown): QuotaSettings {
  const d = DEFAULT_QUOTA_SETTINGS;
  const monitoringEnabled =
    !raw || typeof raw !== "object" || (raw as Record<string, unknown>).monitoringEnabled !== false;
  const lineEnabled =
    !raw || typeof raw !== "object" || (raw as Record<string, unknown>).lineEnabled !== false;
  if (!raw || typeof raw !== "object") {
    return { ...d, monitoringEnabled, lineEnabled };
  }
  const r = raw as Record<string, unknown>;
  const warnRaw = typeof r.warnPercent === "number" ? Math.floor(r.warnPercent) : d.warnPercent;
  const stopRaw =
    typeof r.shutdownPercent === "number" ? Math.floor(r.shutdownPercent) : d.shutdownPercent;
  const warn = Math.min(95, Math.max(50, Number.isFinite(warnRaw) ? warnRaw : d.warnPercent));
  const stop = Math.min(99, Math.max(51, Number.isFinite(stopRaw) ? stopRaw : d.shutdownPercent));
  if (warn >= stop) {
    return { ...d, monitoringEnabled, lineEnabled };
  }
  return { warnPercent: warn, shutdownPercent: stop, monitoringEnabled, lineEnabled };
}

/** 快取是否仍在 TTL 內（純函式，供測試）。 */
export function isCacheFresh(
  fetchedAtMs: number,
  nowMs: number = Date.now(),
  ttlMs: number = MAINTENANCE_TTL_MS,
): boolean {
  return Number.isFinite(fetchedAtMs) && nowMs - fetchedAtMs < ttlMs;
}

/** 是否阻擋（純函式，供測試）：維護開啟且使用者非管理員。 */
export function shouldBlockMaintenance(status: SystemStatus | null, isAdmin: boolean): boolean {
  return status?.maintenance === true && !isAdmin;
}

export class MaintenanceModeError extends Error {
  code = "maintenance-mode";
  constructor(reason?: string) {
    super(
      reason && reason.length > 0
        ? `系統維護中：${reason}`
        : "系統維護中，暫時無法存取資料。",
    );
    this.name = "MaintenanceModeError";
  }
}

export function isMaintenanceError(err: unknown): boolean {
  return (
    err instanceof MaintenanceModeError ||
    (typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: unknown }).code === "maintenance-mode")
  );
}

/**
 * 目前登入者是否為系統管理員（由 auth.tsx 在 profile 載入／登出時設定；
 * 預設 false，寧可誤擋不可誤放）。
 */
let adminFlag = false;
export function setMaintenanceAdmin(v: boolean): void {
  adminFlag = v === true;
}
export function isMaintenanceAdmin(): boolean {
  return adminFlag;
}

interface CachedStatus {
  status: SystemStatus;
  fetchedAt: number;
}

let memCache: CachedStatus | null = null;

export function clearMaintenanceCache(): void {
  memCache = null;
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STATUS_CACHE_KEY);
  } catch {
    /* 忽略 */
  }
}

function readCachedStatus(): CachedStatus | null {
  if (memCache) return memCache;
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(STATUS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedStatus;
    if (!parsed || typeof parsed.fetchedAt !== "number" || !parsed.status) return null;
    memCache = parsed;
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedStatus(status: SystemStatus, fetchedAt: number): void {
  memCache = { status, fetchedAt };
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STATUS_CACHE_KEY, JSON.stringify({ status, fetchedAt }));
    }
  } catch {
    /* 忽略（私密模式等） */
  }
}

/**
 * 直接用 SDK 讀取狀態文件（不經 db.ts，避免遞迴）。
 * 讀不到（未登入／未初始化／網路異常）回 null，呼叫端視為不阻擋；
 * 文件不存在視為維護關閉。
 */
export async function fetchSystemStatus(): Promise<SystemStatus | null> {
  try {
    const snap = await fsGetDoc(fsDoc(fsGetFirestore(), "configs", "system_status"));
    if (!snap.exists()) return { ...DEFAULT_SYSTEM_STATUS };
    const v = snap.data() as Record<string, unknown>;
    return {
      maintenance: v.maintenance === true,
      reason: typeof v.reason === "string" ? v.reason : "",
      updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "",
      alert80SentFor: typeof v.alert80SentFor === "string" ? v.alert80SentFor : "",
      shutdownSentFor: typeof v.shutdownSentFor === "string" ? v.shutdownSentFor : "",
    };
  } catch {
    return null;
  }
}

/** 帶 5 分鐘快取的狀態讀取；讀取失敗時沿用過期快取，否則視為不阻擋。 */
export async function getSystemStatusCached(): Promise<SystemStatus | null> {
  const cached = readCachedStatus();
  if (cached && isCacheFresh(cached.fetchedAt)) return cached.status;
  const status = await fetchSystemStatus();
  if (status) {
    writeCachedStatus(status, Date.now());
    return status;
  }
  return cached ? cached.status : null;
}

/**
 * 讀取豁免路徑（登入流程需要）：
 * - 狀態文件本身（攔截邏輯自己要讀）；
 * - users/* 單文件讀取（登入時載入本人 profile；rules 本就只放行本人／管理員）。
 */
export function isExemptReadPath(path: string | undefined): boolean {
  if (!path) return false;
  return path === SYSTEM_STATUS_PATH || path.startsWith("users/");
}

/** 維護開啟且非管理員時拋出 MaintenanceModeError；其餘情況放行。 */
export async function assertFirestoreAllowed(opts: {
  path?: string;
  kind: "read" | "write";
}): Promise<void> {
  if (opts.kind === "read" && isExemptReadPath(opts.path)) return;
  const status = await getSystemStatusCached();
  if (shouldBlockMaintenance(status, adminFlag)) {
    notifyMaintenanceBlocked(status?.reason ?? "");
    throw new MaintenanceModeError(status?.reason ?? "");
  }
}

export function notifyMaintenanceBlocked(reason: string): void {
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(MAINTENANCE_EVENT, { detail: { reason } }),
      );
    }
  } catch {
    /* 忽略 */
  }
}
