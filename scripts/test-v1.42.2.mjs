/**
 * v1.42.2 斷言測試：手動同步改為「按下即送出同步請求、排程 5 分鐘內執行」（函式驗證＋靜態守衛，無需 emulator）。
 *
 * 1. 請求狀態中文 requestStatusLabel：pending／running／done／failed。
 * 2. 去重 findActiveSyncRequest（前端 TS 與同步端 Node 同一規則）：
 *    同一對照的 pending／running 視為進行中（取最早一筆），done／failed
 *    與其他對照不算進行中，可再送新請求。
 * 3. 輪詢選擇 selectPendingRequests：只取 pending，依請求時間由舊到新；
 *    running／done／failed 不重取。
 * 4. 定時排程不受影響：selectSyncTargets 仍只跑已確認且啟用的對照。
 * 5. 靜態守衛：ResultsPage 含新版手動同步 UI（請求寫入、狀態顯示、5 分鐘文案，
 *    不含「立即執行」與舊版 Actions 頁面連結）；sheet-sync.mjs 含請求模式
 *    （SYNC_REQUESTS_ONLY、runRequestMode、updateMask 標記 running、runId 回寫）；
 *    sheet-sync-poll.yml 每 5 分鐘＋請求模式；rules 有 sheetSyncRequests；
 *    版號 1.42.2。
 */
import { createRequire } from "node:module";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  findActiveSyncRequest as syncFindActiveSyncRequest,
  selectPendingRequests,
  selectSyncTargets,
} from "./sheet-sync-lib.mjs";

const ROOT = "/home/hatch/workspace/repos/QAweb";
const versionTs = readFileSync(`${ROOT}/src/version.ts`, "utf8");
const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));
const rules = readFileSync(`${ROOT}/firestore.rules`, "utf8");
const resultsPage = readFileSync(`${ROOT}/src/features/ResultsPage.tsx`, "utf8");
const sheetSyncTs = readFileSync(`${ROOT}/src/lib/sheetSync.ts`, "utf8");
const sheetSyncScript = readFileSync(`${ROOT}/scripts/sheet-sync.mjs`, "utf8");
const sheetSyncYml = readFileSync(`${ROOT}/.github/workflows/sheet-sync.yml`, "utf8");
const sheetSyncPollYml = readFileSync(`${ROOT}/.github/workflows/sheet-sync-poll.yml`, "utf8");

let pass = 0;
function check(name, fn) {
  fn();
  pass++;
  console.log(`ok - ${name}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const esbuildPackage = readdirSync(resolve(ROOT, "node_modules/.pnpm")).find(
  (entry) => entry.startsWith("esbuild@"),
);
if (!esbuildPackage) throw new Error("pnpm esbuild package not found");
const { build } = await import(
  pathToFileURL(
    resolve(ROOT, "node_modules/.pnpm", esbuildPackage, "node_modules/esbuild/lib/main.js"),
  ).href,
);
writeFileSync(
  "/tmp/v1-42-2-test.ts",
  `export { requestStatusLabel, findActiveSyncRequest, requestTimestampString } from "${ROOT}/src/lib/sheetSync";`,
);
await build({
  entryPoints: ["/tmp/v1-42-2-test.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "/tmp/v1-42-2-test.mjs",
  logLevel: "silent",
});
const lib = await import("/tmp/v1-42-2-test.mjs");

// --- 1. 請求狀態中文 ---
check("請求狀態中文：pending／running／done／failed", () => {
  if (lib.requestStatusLabel("pending") !== "等待執行中") throw new Error("pending 應為等待執行中");
  if (lib.requestStatusLabel("running") !== "執行中") throw new Error("running 應為執行中");
  if (lib.requestStatusLabel("done") !== "已完成") throw new Error("done 應為已完成");
  if (lib.requestStatusLabel("failed") !== "失敗") throw new Error("failed 應為失敗");
});
check("請求時間轉字串：字串原樣、Timestamp 轉 ISO、seconds 轉 ISO、空值為空字串", () => {
  if (lib.requestTimestampString("2026-11-10T07:00:00.000Z") !== "2026-11-10T07:00:00.000Z")
    throw new Error("字串應原樣回傳");
  if (lib.requestTimestampString({ toDate: () => new Date("2026-11-10T07:00:00.000Z") }) !== "2026-11-10T07:00:00.000Z")
    throw new Error("Timestamp 應轉 ISO");
  if (lib.requestTimestampString({ seconds: 1762732800 }) !== new Date(1762732800 * 1000).toISOString())
    throw new Error("seconds 應轉 ISO");
  if (lib.requestTimestampString(null) !== "" || lib.requestTimestampString(undefined) !== "")
    throw new Error("空值應為空字串");
});

// --- 2. 去重：進行中的請求不重複建立 ---
const reqPendingOld = { id: "r1", mappingId: "m1", status: "pending", requestedAt: "2026-11-10T07:00:00.000Z" };
const reqRunning = { id: "r2", mappingId: "m1", status: "running", requestedAt: "2026-11-10T07:05:00.000Z" };
const reqDone = { id: "r3", mappingId: "m1", status: "done", requestedAt: "2026-11-10T06:00:00.000Z" };
const reqFailed = { id: "r4", mappingId: "m1", status: "failed", requestedAt: "2026-11-10T06:30:00.000Z" };
const reqOtherMapping = { id: "r5", mappingId: "m2", status: "pending", requestedAt: "2026-11-10T06:00:00.000Z" };

check("去重（前端）：同一對照有 pending／running 時回傳最早一筆，不重建", () => {
  const found = lib.findActiveSyncRequest([reqRunning, reqPendingOld, reqDone], "m1");
  if (!found || found.id !== "r1") throw new Error(`應取最早的 pending r1，實為 ${found?.id}`);
});
check("去重（前端）：只有 done／failed 時可再送新請求；其他對照不影響", () => {
  if (lib.findActiveSyncRequest([reqDone, reqFailed], "m1") !== null)
    throw new Error("done／failed 不應視為進行中");
  if (lib.findActiveSyncRequest([reqOtherMapping], "m1") !== null)
    throw new Error("其他對照的請求不應擋下");
  if (lib.findActiveSyncRequest([], "m1") !== null) throw new Error("空清單應為 null");
});
check("去重（同步端 Node）：與前端同一規則", () => {
  const found = syncFindActiveSyncRequest([reqRunning, reqPendingOld, reqDone], "m1");
  if (!found || found.id !== "r1") throw new Error(`同步端應取 r1，實為 ${found?.id}`);
  if (syncFindActiveSyncRequest([reqDone, reqFailed], "m1") !== null)
    throw new Error("同步端 done／failed 不應視為進行中");
});

// --- 3. 輪詢選擇：只取 pending，由舊到新 ---
check("輪詢選擇：只取 pending，依請求時間由舊到新；running／done／failed 不重取", () => {
  const picked = selectPendingRequests([reqRunning, reqDone, reqFailed, reqPendingOld, reqOtherMapping]);
  if (!eq(picked.map((r) => r.id), ["r5", "r1"]))
    throw new Error(`應取 r5、r1（由舊到新），實為 ${JSON.stringify(picked.map((r) => r.id))}`);
});
check("輪詢選擇：無 pending 時為空陣列；空清單亦為空", () => {
  if (selectPendingRequests([reqRunning, reqDone]).length !== 0)
    throw new Error("無 pending 應為空");
  if (selectPendingRequests([]).length !== 0) throw new Error("空清單應為空");
});

// --- 4. 定時排程不受影響 ---
check("定時排程不受影響：仍只跑已確認且啟用的對照（草稿跳過）", () => {
  const all = [
    { id: "m1", status: "confirmed", enabled: true },
    { id: "m2", status: "draft", enabled: true },
    { id: "m3", status: "confirmed", enabled: false },
  ];
  const { targets, skipped } = selectSyncTargets(all, { manual: false, mappingId: "" });
  if (!eq(targets.map((m) => m.id), ["m1"])) throw new Error("定時目標應只有 m1");
  if (!eq(skipped.map((s) => s.mapping.id), ["m2"])) throw new Error("定時應跳過草稿 m2");
});

// --- 5. 靜態守衛 ---
check("靜態守衛：ResultsPage 含新版手動同步 UI（請求寫入、狀態顯示、5 分鐘文案）", () => {
  for (const needle of [
    "手動同步一次",
    "sheetSyncRequests",
    "手動同步請求",
    "排程將於 5 分鐘內執行",
    "requestStatusLabel",
    "findActiveSyncRequest",
    'status: "pending"',
    "loadRequests",
  ]) {
    if (!resultsPage.includes(needle)) throw new Error(`ResultsPage 缺少：${needle}`);
  }
  if (!sheetSyncTs.includes("等待執行中")) throw new Error("sheetSync.ts 缺少「等待執行中」");
});
check("靜態守衛：ResultsPage 不含「立即執行」文案與舊版 Actions 頁面連結", () => {
  if (resultsPage.includes("立即執行")) throw new Error("ResultsPage 不應出現「立即執行」");
  if (resultsPage.includes("actions/workflows/sheet-sync.yml"))
    throw new Error("ResultsPage 不應再連結 Actions 執行頁面");
  if (resultsPage.includes("handleCopyId") || resultsPage.includes("copiedId"))
    throw new Error("ResultsPage 不應殘留複製對照 ID 程式碼");
});
check("靜態守衛：sheet-sync.mjs 含請求模式（SYNC_REQUESTS_ONLY、runRequestMode、updateMask、runId）", () => {
  for (const needle of [
    "SYNC_REQUESTS_ONLY",
    "runRequestMode",
    "selectPendingRequests",
    "sheetSyncRequests",
    '"running"',
    '"done"',
    '"failed"',
    "runId",
    'trigger: "manual"',
    "return { run, runId }",
  ]) {
    if (!sheetSyncScript.includes(needle)) throw new Error(`sheet-sync.mjs 缺少：${needle}`);
  }
});
check("靜態守衛：請求模式不跑定時排程（SYNC_REQUESTS_ONLY 時直接 return）", () => {
  if (!sheetSyncScript.includes('SYNC_REQUESTS_ONLY === "1"')) throw new Error("缺少請求模式判斷");
  const idx = sheetSyncScript.indexOf('SYNC_REQUESTS_ONLY === "1"');
  const seg = sheetSyncScript.slice(idx, idx + 400);
  if (!seg.includes("runRequestMode") || !seg.includes("return;"))
    throw new Error("請求模式應執行 runRequestMode 後直接 return");
});
check("靜態守衛：poll workflow 每 5 分鐘＋請求模式＋共用 concurrency 群組", () => {
  for (const needle of [
    '"*/5 * * * *"',
    'SYNC_REQUESTS_ONLY: "1"',
    "group: sheet-sync",
    "GCP_SERVICE_ACCOUNT_JSON",
  ]) {
    if (!sheetSyncPollYml.includes(needle)) throw new Error(`sheet-sync-poll.yml 缺少：${needle}`);
  }
});
check("靜態守衛：poll workflow 不含每日 07:00 排程（不重複跑定時同步）", () => {
  if (sheetSyncPollYml.includes("0 23 * * *")) throw new Error("poll workflow 不應含每日排程");
});
check("靜態守衛：rules 有 sheetSyncRequests（登入可讀、管理員可寫，與 mappings 同級）", () => {
  if (!rules.includes("sheetSyncRequests")) throw new Error("rules 缺少 sheetSyncRequests");
  const idx = rules.indexOf("sheetSyncRequests");
  const seg = rules.slice(idx, idx + 300);
  if (!seg.includes("isAuthed()") || !seg.includes("isAdmin()"))
    throw new Error("sheetSyncRequests 權限應為登入可讀、管理員可寫");
});
check("靜態守衛：每日 workflow 未改（定時同步維持原樣）", () => {
  if (!sheetSyncYml.includes('cron: "0 23 * * *"')) throw new Error("sheet-sync.yml 每日排程應維持");
  if (sheetSyncYml.includes("SYNC_REQUESTS_ONLY")) throw new Error("sheet-sync.yml 不應含請求模式");
});
check("版號：version.ts 與 package.json 皆為 1.42.2", () => {
  if (!versionTs.includes('"1.42.2"')) throw new Error("version.ts 未升 1.42.2");
  if (pkg.version !== "1.42.2") throw new Error(`package.json 版本實為 ${pkg.version}`);
});

console.log(`\nPASS: ${pass} checks`);
