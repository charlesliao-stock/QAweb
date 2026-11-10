#!/usr/bin/env node
/**
* 流量控管 — 監測執行檔（v1.41.0，方案 A）。
*
* GitHub Actions 每 10 分鐘執行一次（.github/workflows/quota-monitor.yml）：
* 1. 用 service account 查 Cloud Monitoring 當日累計讀／寫／刪
* （太平洋時間當日 00:00 起算；指標更新最多延遲約 4 分鐘）。
* 2. 讀 configs/quotaSettings（未設定用預設 80／95；門檻不在 workflow 寫死）。
* 3. 80% → LINE 提醒（當日一次）；95% → 寫 configs/system_status 開 maintenance
* 暫時關站＋LINE；隔日用量回到低水位 → 自動開站＋LINE。
*
* 環境變數（只從 GitHub Secrets 注入，絕不寫進檔案）：
* - GCP_SERVICE_ACCOUNT_JSON（必填）：service account JSON
* （角色：Monitoring Viewer＋Datastore User）
* - LINE_CHANNEL_ACCESS_TOKEN（選填，未設則只做開關、不發 LINE）
* - LINE_USER_ID（選填，未設則不發 LINE）
* - GCP_PROJECT_ID（選填，預設 nurseboard-492316）
*
* 本檔只用 Node 內建模組（node:crypto＋fetch），不需 npm install。
*/
import { createSign} from "node:crypto";
import {
DEFAULT_STATUS,
decodeFirestoreDoc,
encodeFirestoreFields,
evaluateUsage,
normalizeQuotaSettings,
pacificDateString,
pacificDayStart,
QUOTAS,
} from "./quota-lib.mjs";

const PROJECT = process.env.GCP_PROJECT_ID?? "nurseboard-492316";
const STATUS_PATH = "configs/system_status";
const SETTINGS_PATH = "configs/quotaSettings";
const READ_METRIC = "firestore.googleapis.com/document/read_count";
const WRITE_METRIC = "firestore.googleapis.com/document/write_count";
const DELETE_METRIC = "firestore.googleapis.com/document/delete_count";

function log(msg) {
console.log(`[quota-monitor] ${msg}`);
}

async function fetchJson(url, token, options = {}) {
const res = await fetch(url, {
...options,
headers: { Authorization: `Bearer ${token}`,...(options.headers?? {})},
signal: AbortSignal.timeout(30000),
});
if (!res.ok) {
const body = await res.text().catch(() => "");
throw new Error(`HTTP ${res.status} ${url.split("?")[0]}：${body.slice(0, 200)}`);
}
return res.json();
}

/** service account JWT → OAuth2 access token（monitoring.read＋datastore）。 */
async function getAccessToken(sa) {
const nowSec = Math.floor(Date.now() / 1000);
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const unsigned = `${enc({ alg: "RS256", typ: "JWT", kid: sa.private_key_id})}.${enc({
iss: sa.client_email,
scope: "https://www.googleapis.com/auth/monitoring.read https://www.googleapis.com/auth/datastore",
aud: "https://oauth2.googleapis.com/token",
exp: nowSec + 3600,
iat: nowSec,
})}`;
const sig = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
const res = await fetch("https://oauth2.googleapis.com/token", {
method: "POST",
headers: { "Content-Type": "application/x-www-form-urlencoded"},
body: new URLSearchParams({
grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
assertion: `${unsigned}.${sig}`,
}),
signal: AbortSignal.timeout(30000),
});
if (!res.ok) throw new Error(`取 OAuth token 失敗：HTTP ${res.status}`);
const data = await res.json();
if (!data.access_token) throw new Error("取 OAuth token 失敗：無 access_token");
return data.access_token;
}

/** 查某指標當日累計（DELTA 加總；CUMULATIVE 取區間內增量）。 */
async function getMetricTotal(metricType, start, end, token) {
const desc = await fetchJson(
`https://monitoring.googleapis.com/v3/projects/${PROJECT}/metricDescriptors/${metricType}`,
token,
);
const kind = desc?.kind?? "DELTA";
const params = new URLSearchParams({
filter: `metric.type="${metricType}"`,
"interval.startTime": start.toISOString(),
"interval.endTime": end.toISOString(),
"aggregation.alignmentPeriod": "3600s",
"aggregation.perSeriesAligner": "ALIGN_SUM",
"aggregation.crossSeriesReducer": "REDUCE_SUM",
});
const res = await fetchJson(
`https://monitoring.googleapis.com/v3/projects/${PROJECT}/timeSeries?${params}`,
token,
);
const points = res?.timeSeries?.[0]?.points?? [];
const val = (p) => Number(p.value?.int64Value?? p.value?.doubleValue?? 0);
if (kind === "CUMULATIVE") {
if (points.length < 2) return 0;
return Math.max(0, val(points[0]) - val(points[points.length - 1]));
}
return points.reduce((sum, p) => sum + val(p), 0);
}

const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

async function getFirestoreDoc(path, token) {
const res = await fetch(`${FS_BASE}/${path}`, {
headers: { Authorization: `Bearer ${token}`},
signal: AbortSignal.timeout(30000),
});
if (res.status === 404) return null;
if (!res.ok) throw new Error(`Firestore 讀取失敗 ${path}：HTTP ${res.status}`);
return decodeFirestoreDoc(await res.json());
}

async function patchFirestoreDoc(path, values, token) {
const body = encodeFirestoreFields(values);
const mask = Object.keys(values)
.map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
.join("&");
let res = await fetch(`${FS_BASE}/${path}?${mask}`, {
method: "PATCH",
headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
body: JSON.stringify(body),
signal: AbortSignal.timeout(30000),
});
if (res.status === 404) {
// 文件尚未建立：改用建立（監測首次執行時）
const [collection, docId] = path.split("/");
res = await fetch(`${FS_BASE}/${collection}?documentId=${encodeURIComponent(docId)}`, {
method: "POST",
headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
body: JSON.stringify(body),
signal: AbortSignal.timeout(30000),
});
}
if (!res.ok) throw new Error(`Firestore 寫入失敗 ${path}：HTTP ${res.status}`);
}

/** LINE 推播（失敗只記錄、不讓整輪監測失敗，開關動作優先）。 */
async function sendLine(text, token, to) {
if (!token ||!to) {
log("LINE secret 未設定，跳過推播。");
return false;
}
try {
const res = await fetch("https://api.line.me/v2/bot/message/push", {
method: "POST",
headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
body: JSON.stringify({ to, messages: [{ type: "text", text}]}),
signal: AbortSignal.timeout(30000),
});
if (!res.ok) {
log(`LINE 推播失敗：HTTP ${res.status}`);
return false;
}
return true;
} catch (err) {
log(`LINE 推播失敗：${err.message}`);
return false;
}
}

function usageText(usage) {
return `讀取 ${usage.reads.toLocaleString()}/${QUOTAS.reads.toLocaleString()}、寫入 ${usage.writes.toLocaleString()}/${QUOTAS.writes.toLocaleString()}、刪除 ${usage.deletes.toLocaleString()}/${QUOTAS.deletes.toLocaleString()}`;
}

async function main() {
const saJson = process.env.GCP_SERVICE_ACCOUNT_JSON;
if (!saJson) {
console.error(
"缺少 GCP_SERVICE_ACCOUNT_JSON：請在 GitHub Secrets 加入 service account JSON（見回報的 Secret 清單）。",
);
process.exit(1);
}
let sa;
try {
sa = JSON.parse(saJson);
} catch {
console.error("GCP_SERVICE_ACCOUNT_JSON 不是合法 JSON。");
process.exit(1);
}
if (!sa.client_email ||!sa.private_key) {
console.error("service account JSON 缺少 client_email 或 private_key。");
process.exit(1);
}
const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN?? "";
const lineTo = process.env.LINE_USER_ID?? "";
if (!lineToken ||!lineTo) {
log("提醒：LINE secret 未設定，本輪不發 LINE 推播（開關動作不受影響）。");
}

const token = await getAccessToken(sa);
const now = new Date();
const today = pacificDateString(now);
const dayStart = pacificDayStart(now);

const statusRaw = await getFirestoreDoc(STATUS_PATH, token);
const status = {...DEFAULT_STATUS,...(statusRaw?? {})};
const settings = normalizeQuotaSettings(await getFirestoreDoc(SETTINGS_PATH, token));

const usage = {
reads: await getMetricTotal(READ_METRIC, dayStart, now, token),
writes: await getMetricTotal(WRITE_METRIC, dayStart, now, token),
deletes: await getMetricTotal(DELETE_METRIC, dayStart, now, token),
};
const decision = evaluateUsage({ usage, settings, status, today});
log(
`太平洋日 ${today}｜用量 ${usageText(usage)}｜門檻 提醒 ${settings.warnPercent}%／關站 ${settings.shutdownPercent}%｜動作 ${decision.action}（${decision.reason}）`,
);

if (decision.action === "alert80") {
if (settings.lineEnabled) {
await sendLine(
`今日 Firestore 用量已達免費額度 ${settings.warnPercent}%（${usageText(usage)}）。達 ${settings.shutdownPercent}% 將自動暫時關站。`,
lineToken,
lineTo,
);
}
await patchFirestoreDoc(STATUS_PATH, { alert80SentFor: today, updatedAt: now}, token);
log(`已標記本日提醒 ${today}。`);
} else if (decision.action === "shutdown") {
const reason = `流量達關站門檻 ${settings.shutdownPercent}%（${usageText(usage)}），已暫時關站`;
await patchFirestoreDoc(
STATUS_PATH,
{ maintenance: true, reason, shutdownSentFor: today, updatedAt: now},
token,
);
if (settings.lineEnabled) {
await sendLine(
`今日 Firestore 用量已達免費額度 ${settings.shutdownPercent}%（${usageText(usage)}）。系統已暫時關站，管理員仍可登入；隔日額度重置後自動恢復。`,
lineToken,
lineTo,
);
}
log("已開啟維護開關。");
} else if (decision.action === "recover") {
await patchFirestoreDoc(
STATUS_PATH,
{ maintenance: false, reason: "", alert80SentFor: "", shutdownSentFor: "", updatedAt: now},
token,
);
if (settings.lineEnabled) {
await sendLine(
"今日用量已回到免費額度內，系統已恢復正常運作。",
lineToken,
lineTo,
);
}
log("用量回到低水位，已自動開站。");
} else {
log(`無動作（${decision.reason}）。`);
}
}

main().catch((err) => {
console.error(`[quota-monitor] 監測失敗：${err.message}`);
process.exit(1);
});
