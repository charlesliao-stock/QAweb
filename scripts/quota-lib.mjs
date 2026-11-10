/**
 * 流量控管 — 監測端純邏輯（v1.41.0，方案 A）。
 *
 * 被 `scripts/quota-monitor.mjs`（GitHub Actions 每 10 分鐘執行）與
 * `scripts/test-v1.41.0.mjs` 共用。本檔不碰網路、不讀環境變數，方便測試。
 *
 * 注意：normalizeQuotaSettings 與前端 `src/lib/maintenance.ts` 是同一規則
 * 的兩份實作（前端 TS、監測端 Node ESM 無法共用檔案），改規則時兩邊要同步。
 */

/** Spark 免費額度（／天；Blaze 升上去後免費額度不變）。 */
export const QUOTAS = { reads: 50000, writes: 20000, deletes: 20000 };

/** 未設定時的預設門檻 %（與系統管理頁預設值一致）。 */
export const DEFAULT_WARN_PERCENT = 80;
export const DEFAULT_SHUTDOWN_PERCENT = 95;

export const DEFAULT_STATUS = {
  maintenance: false,
  reason: "",
  updatedAt: "",
  alert80SentFor: "",
  shutdownSentFor: "",
};

/**
 * 設定值正規化：提醒門檻 50–95、關站門檻 51–99，且提醒必須小於關站；
 * 不合法或缺值時退回預設 80／95。開關缺值視為開啟。
 */
export function normalizeQuotaSettings(raw) {
  const monitoringEnabled = !raw || typeof raw !== "object" || raw.monitoringEnabled !== false;
  const lineEnabled = !raw || typeof raw !== "object" || raw.lineEnabled !== false;
  if (!raw || typeof raw !== "object") {
    return {
      warnPercent: DEFAULT_WARN_PERCENT,
      shutdownPercent: DEFAULT_SHUTDOWN_PERCENT,
      monitoringEnabled,
      lineEnabled,
    };
  }
  const warnRaw = typeof raw.warnPercent === "number" ? Math.floor(raw.warnPercent) : DEFAULT_WARN_PERCENT;
  const stopRaw =
    typeof raw.shutdownPercent === "number" ? Math.floor(raw.shutdownPercent) : DEFAULT_SHUTDOWN_PERCENT;
  const warn = Math.min(95, Math.max(50, Number.isFinite(warnRaw) ? warnRaw : DEFAULT_WARN_PERCENT));
  const stop = Math.min(99, Math.max(51, Number.isFinite(stopRaw) ? stopRaw : DEFAULT_SHUTDOWN_PERCENT));
  if (warn >= stop) {
    return {
      warnPercent: DEFAULT_WARN_PERCENT,
      shutdownPercent: DEFAULT_SHUTDOWN_PERCENT,
      monitoringEnabled,
      lineEnabled,
    };
  }
  return { warnPercent: warn, shutdownPercent: stop, monitoringEnabled, lineEnabled };
}

/** 門檻 % 換算成次數（無條件捨去）。 */
export function thresholdFor(quota, percent) {
  return Math.floor((quota * percent) / 100);
}

/** 設定換算成提醒／關站次數表。 */
export function computeThresholds(settings) {
  const s = normalizeQuotaSettings(settings);
  const at = (p) => ({
    reads: thresholdFor(QUOTAS.reads, p),
    writes: thresholdFor(QUOTAS.writes, p),
    deletes: thresholdFor(QUOTAS.deletes, p),
  });
  return { warn: at(s.warnPercent), shutdown: at(s.shutdownPercent) };
}

/** 太平洋時間當日日期字串 YYYY-MM-DD（額度日以太平洋時間午夜重置）。 */
export function pacificDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** 太平洋時區在該時刻的 UTC 偏移（分鐘；PST -480、PDT -420）。 */
export function pacificOffsetMinutes(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(tz);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * 太平洋時間當日 00:00 的 UTC 時刻（Monitoring 查詢區間起點）。
 * 日光節約切換日當天午夜與稍後的偏移不同，故以起點偏移再校正一次。
 */
export function pacificDayStart(now = new Date()) {
  const dateStr = pacificDateString(now);
  const [y, mo, d] = dateStr.split("-").map(Number);
  const offset = pacificOffsetMinutes(now);
  let start = new Date(Date.UTC(y, mo - 1, d) - offset * 60000);
  const offsetAtStart = pacificOffsetMinutes(start);
  if (offsetAtStart !== offset) {
    start = new Date(Date.UTC(y, mo - 1, d) - offsetAtStart * 60000);
  }
  return start;
}

/** 列出用量超過某次數表的項目（讀／寫／刪任一先到即觸發）。 */
export function triggeredMetrics(usage, limits) {
  const out = [];
  if (usage.reads >= limits.reads) out.push({ kind: "reads", used: usage.reads, limit: limits.reads });
  if (usage.writes >= limits.writes) out.push({ kind: "writes", used: usage.writes, limit: limits.writes });
  if (usage.deletes >= limits.deletes) out.push({ kind: "deletes", used: usage.deletes, limit: limits.deletes });
  return out;
}

/**
 * 依用量、設定、目前開關狀態決定本輪動作。
 * @returns {{action: "none"|"alert80"|"shutdown"|"recover", reason: string, triggered: Array}}
 * - none：無事可做（或監測已停用、今日已提醒、已關站）
 * - alert80：達提醒門檻，發 LINE、標記 alert80SentFor
 * - shutdown：達關站門檻，開 maintenance、發 LINE、標記 shutdownSentFor
 * - recover：已關站且當日用量回到提醒門檻以下（新的一天），關 maintenance
 */
export function evaluateUsage({ usage, settings, status, today }) {
  const s = normalizeQuotaSettings(settings);
  const st = { ...DEFAULT_STATUS, ...(status ?? {}) };
  if (!s.monitoringEnabled) return { action: "none", reason: "monitoring-disabled", triggered: [] };
  const t = computeThresholds(s);
  const overWarn = triggeredMetrics(usage, t.warn);
  const overStop = triggeredMetrics(usage, t.shutdown);
  if (st.maintenance) {
    if (overWarn.length === 0) {
      return { action: "recover", reason: "usage-below-warn", triggered: [] };
    }
    if (overStop.length > 0 && st.shutdownSentFor !== today) {
      return { action: "shutdown", reason: "still-over-shutdown", triggered: overStop };
    }
    return { action: "none", reason: "already-closed", triggered: overStop };
  }
  if (overStop.length > 0) {
    return { action: "shutdown", reason: "over-shutdown", triggered: overStop };
  }
  if (overWarn.length > 0 && st.alert80SentFor !== today) {
    return { action: "alert80", reason: "over-warn", triggered: overWarn };
  }
  return { action: "none", reason: "below-threshold", triggered: [] };
}

/** Firestore REST 文件 JSON → 平面物件（讀取狀態／設定文件用）。 */
export function decodeFirestoreDoc(json) {
  if (!json || typeof json !== "object" || !json.fields || typeof json.fields !== "object") {
    return null;
  }
  const out = {};
  for (const [k, v] of Object.entries(json.fields)) {
    if (!v || typeof v !== "object") continue;
    if ("stringValue" in v) out[k] = v.stringValue;
    else if ("booleanValue" in v) out[k] = v.booleanValue;
    else if ("integerValue" in v) out[k] = Number(v.integerValue);
    else if ("doubleValue" in v) out[k] = v.doubleValue;
    else if ("timestampValue" in v) out[k] = v.timestampValue;
    else if ("nullValue" in v) out[k] = null;
  }
  return out;
}

/** 平面物件 → Firestore REST 寫入 body（只含支援的純量型別）。 */
export function encodeFirestoreFields(values) {
  const fields = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "boolean") fields[k] = { booleanValue: v };
    else if (typeof v === "number") fields[k] = { integerValue: String(Math.trunc(v)) };
    else if (typeof v === "string") fields[k] = { stringValue: v };
    else if (v instanceof Date) fields[k] = { timestampValue: v.toISOString() };
    else if (v === null) fields[k] = { nullValue: null };
  }
  return { fields };
}
