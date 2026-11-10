/**
 * v1.42.3 斷言測試：Google Sheet 連結流程依使用者定的四步驟重做
 * （連線確認 → 欄位對應 → 手動同步 → 列入排程）（函式驗證＋靜態守衛，無需 emulator）。
 *
 * 1. tsMillis：ISO 字串、Timestamp、seconds、Date、數字、空值／無效值。
 * 2. sameFieldMapping：鍵序不同仍相等、空字串視為未對應、值不同不相等
 *    （前端 TS 與同步端 Node 同一規則）。
 * 3. findQualifyingManualRun（步驟 3 gate）：手動 ok／partial 且 inserted＋updated ≥ 1
 *    才算；0 筆匯入、失敗、定時觸發皆不算；對應改過後只取修改時間之後的紀錄；
 *    無修改紀錄（舊對照）時任何手動成功紀錄皆算；取最新一筆。
 * 4. deriveSyncSteps：四步依序完成；第一個未完成的步驟為進行中，其後為未完成；
 *    四步皆完成時 current 為 0。
 * 5. canEnrollMapping（列入排程 gate）：第 1–3 步皆完成才可列入；缺手動同步
 *    成功時不通過；舊 canConfirmMapping 行為不變（步驟 1＋2 gate）。
 * 6. selectHeaderFetchTargets（同步端 Node）：headerFetchRequestedAt 有值且
 *    尚未讀到者才取；已讀過、未要求、已停用者不取。
 * 7. 靜態守衛：ResultsPage 含四步驟 UI（步驟名稱、列入排程、查詢正常提示、
 *    連線確認、重新讀取欄位、fieldMappingUpdatedAt、headerFetchError），
 *    不含舊版「確認並列入排程」；sheet-sync.mjs 含 fetchHeadersOnly 與輪詢
 *    標題讀取；poll workflow 每 5 分鐘維持不變（不需改 workflow 檔）；
 *    版號 1.42.3。
 */
import { createRequire } from "node:module";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  sameFieldMapping as syncSameFieldMapping,
  selectHeaderFetchTargets,
  selectSyncTargets,
} from "./sheet-sync-lib.mjs";

const ROOT = "/home/hatch/workspace/repos/QAweb";
const versionTs = readFileSync(`${ROOT}/src/version.ts`, "utf8");
const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));
const rules = readFileSync(`${ROOT}/firestore.rules`, "utf8");
const resultsPage = readFileSync(`${ROOT}/src/features/ResultsPage.tsx`, "utf8");
const sheetSyncTs = readFileSync(`${ROOT}/src/lib/sheetSync.ts`, "utf8");
const sheetSyncScript = readFileSync(`${ROOT}/scripts/sheet-sync.mjs`, "utf8");
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
  "/tmp/v1-42-3-test.ts",
  `export { tsMillis, sameFieldMapping, findQualifyingManualRun, deriveSyncSteps, syncStepStateLabel, canEnrollMapping, canConfirmMapping } from "${ROOT}/src/lib/sheetSync";`,
);
await build({
  entryPoints: ["/tmp/v1-42-3-test.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "/tmp/v1-42-3-test.mjs",
  logLevel: "silent",
});
const lib = await import("/tmp/v1-42-3-test.mjs");

// --- 1. tsMillis ---
check("時間轉毫秒：ISO 字串、Timestamp、seconds、Date、數字、空值／無效值", () => {
  if (lib.tsMillis("2026-11-10T07:00:00.000Z") !== Date.parse("2026-11-10T07:00:00.000Z"))
    throw new Error("ISO 字串應轉毫秒");
  if (lib.tsMillis({ toDate: () => new Date("2026-11-10T07:00:00.000Z") }) !== Date.parse("2026-11-10T07:00:00.000Z"))
    throw new Error("Timestamp 應轉毫秒");
  if (lib.tsMillis({ toMillis: () => 1762732800000 }) !== 1762732800000)
    throw new Error("toMillis 應原樣回傳");
  if (lib.tsMillis({ seconds: 1762732800 }) !== 1762732800 * 1000)
    throw new Error("seconds 應轉毫秒");
  if (lib.tsMillis(new Date("2026-11-10T07:00:00.000Z")) !== Date.parse("2026-11-10T07:00:00.000Z"))
    throw new Error("Date 應轉毫秒");
  if (lib.tsMillis(1762732800000) !== 1762732800000) throw new Error("數字應原樣回傳");
  if (lib.tsMillis(null) !== null || lib.tsMillis(undefined) !== null || lib.tsMillis("") !== null)
    throw new Error("空值應為 null");
  if (lib.tsMillis("not-a-date") !== null) throw new Error("無效字串應為 null");
});

// --- 2. sameFieldMapping ---
check("對應比對（前端）：鍵序不同仍相等、空字串視為未對應、值不同不相等", () => {
  if (!lib.sameFieldMapping({ a: "unitCode", b: "personEmpNo" }, { b: "personEmpNo", a: "unitCode" }))
    throw new Error("鍵序不同應相等");
  if (!lib.sameFieldMapping({ a: "unitCode", b: "" }, { a: "unitCode" }))
    throw new Error("空字串應視為未對應");
  if (lib.sameFieldMapping({ a: "unitCode" }, { a: "personEmpNo" }))
    throw new Error("值不同應不相等");
  if (lib.sameFieldMapping({ a: "unitCode" }, { a: "unitCode", b: "bedNo" }))
    throw new Error("多一鍵應不相等");
  if (!lib.sameFieldMapping({}, {})) throw new Error("空對應應相等");
});
check("對應比對（同步端 Node）：與前端同一規則", () => {
  if (!syncSameFieldMapping({ a: "unitCode", b: "personEmpNo" }, { b: "personEmpNo", a: "unitCode" }))
    throw new Error("同步端鍵序不同應相等");
  if (syncSameFieldMapping({ a: "unitCode" }, { a: "personEmpNo" }))
    throw new Error("同步端值不同應不相等");
});

// --- 3. findQualifyingManualRun（步驟 3 gate）---
const editMs = Date.parse("2026-11-10T08:00:00.000Z");
const runOkAfter = {
  id: "r1", trigger: "manual", status: "ok", inserted: 2, updated: 0,
  startedAt: "2026-11-10T08:10:00.000Z", finishedAt: "2026-11-10T08:11:00.000Z",
};
const runOkBefore = {
  id: "r2", trigger: "manual", status: "ok", inserted: 3, updated: 0,
  startedAt: "2026-11-10T07:00:00.000Z", finishedAt: "2026-11-10T07:01:00.000Z",
};
const runPartialAfter = {
  id: "r3", trigger: "manual", status: "partial", inserted: 0, updated: 1,
  startedAt: "2026-11-10T08:20:00.000Z", finishedAt: "2026-11-10T08:21:00.000Z",
};
const runZeroAfter = {
  id: "r4", trigger: "manual", status: "ok", inserted: 0, updated: 0,
  startedAt: "2026-11-10T08:30:00.000Z", finishedAt: "2026-11-10T08:31:00.000Z",
};
const runFailedAfter = {
  id: "r5", trigger: "manual", status: "failed", inserted: 0, updated: 0,
  startedAt: "2026-11-10T08:40:00.000Z", finishedAt: "2026-11-10T08:41:00.000Z",
};
const runScheduleAfter = {
  id: "r6", trigger: "schedule", status: "ok", inserted: 5, updated: 0,
  startedAt: "2026-11-10T08:50:00.000Z", finishedAt: "2026-11-10T08:51:00.000Z",
};

check("步驟 3 gate：對應修改後的手動成功紀錄（ok／partial，≥1 筆）才算，取最新一筆", () => {
  const found = lib.findQualifyingManualRun(
    [runOkBefore, runOkAfter, runPartialAfter, runZeroAfter, runFailedAfter, runScheduleAfter],
    editMs,
  );
  if (!found || found.id !== "r3") throw new Error(`應取最新的 r3（partial，更新 1 筆），實為 ${found?.id}`);
});
check("步驟 3 gate：對應改過後、修改時間前成功的紀錄不算", () => {
  const found = lib.findQualifyingManualRun([runOkBefore], editMs);
  if (found !== null) throw new Error("修改前的成功紀錄不應算數");
});
check("步驟 3 gate：0 筆匯入、失敗、定時觸發皆不算", () => {
  if (lib.findQualifyingManualRun([runZeroAfter], editMs) !== null)
    throw new Error("0 筆匯入不應算成功");
  if (lib.findQualifyingManualRun([runFailedAfter], editMs) !== null)
    throw new Error("失敗不應算成功");
  if (lib.findQualifyingManualRun([runScheduleAfter], editMs) !== null)
    throw new Error("定時同步不應算手動同步");
  if (lib.findQualifyingManualRun([], editMs) !== null) throw new Error("空清單應為 null");
});
check("步驟 3 gate：無對應修改紀錄（舊對照）時，任何手動成功紀錄皆算", () => {
  const found = lib.findQualifyingManualRun([runOkBefore], null);
  if (!found || found.id !== "r2") throw new Error("無修改紀錄時舊成功紀錄應算數");
});

// --- 4. deriveSyncSteps ---
check("四步驟推導：四步皆完成時 current 為 0", () => {
  const s = lib.deriveSyncSteps({ step1Done: true, step2Done: true, step3Done: true, step4Done: true });
  if (!eq([s.step1, s.step2, s.step3, s.step4], ["done", "done", "done", "done"]) || s.current !== 0)
    throw new Error(`四步皆完成應全 done、current 0，實為 ${JSON.stringify(s)}`);
});
check("四步驟推導：第一個未完成的步驟為進行中，其後為未完成", () => {
  const s1 = lib.deriveSyncSteps({ step1Done: false, step2Done: false, step3Done: false, step4Done: false });
  if (!eq([s1.step1, s1.step2, s1.step3, s1.step4], ["active", "todo", "todo", "todo"]) || s1.current !== 1)
    throw new Error(`步驟 1 未完成應為 active／todo，實為 ${JSON.stringify(s1)}`);
  const s2 = lib.deriveSyncSteps({ step1Done: true, step2Done: false, step3Done: false, step4Done: false });
  if (!eq([s2.step1, s2.step2, s2.step3, s2.step4], ["done", "active", "todo", "todo"]) || s2.current !== 2)
    throw new Error(`步驟 2 未完成應為 done／active／todo，實為 ${JSON.stringify(s2)}`);
  const s3 = lib.deriveSyncSteps({ step1Done: true, step2Done: true, step3Done: false, step4Done: false });
  if (!eq([s3.step1, s3.step2, s3.step3, s3.step4], ["done", "done", "active", "todo"]) || s3.current !== 3)
    throw new Error(`步驟 3 未完成應為 done／done／active／todo，實為 ${JSON.stringify(s3)}`);
  const s4 = lib.deriveSyncSteps({ step1Done: true, step2Done: true, step3Done: true, step4Done: false });
  if (!eq([s4.step1, s4.step2, s4.step3, s4.step4], ["done", "done", "done", "active"]) || s4.current !== 4)
    throw new Error(`步驟 4 未完成應為 done／done／done／active，實為 ${JSON.stringify(s4)}`);
});
check("四步驟狀態中文：已完成／進行中／未完成", () => {
  if (lib.syncStepStateLabel("done") !== "已完成") throw new Error("done 應為已完成");
  if (lib.syncStepStateLabel("active") !== "進行中") throw new Error("active 應為進行中");
  if (lib.syncStepStateLabel("todo") !== "未完成") throw new Error("todo 應為未完成");
});

// --- 5. canEnrollMapping ---
check("列入排程 gate：第 1–3 步皆完成才可列入；缺手動同步成功時不通過", () => {
  const ok = lib.canEnrollMapping({ headersRead: true, missing: [], hasDuplicate: false, manualSyncOk: true });
  if (!ok.ok) throw new Error(`三步皆完成應可列入，實為 ${JSON.stringify(ok)}`);
  const noManual = lib.canEnrollMapping({ headersRead: true, missing: [], hasDuplicate: false, manualSyncOk: false });
  if (noManual.ok || !noManual.reasons.some((r) => r.includes("手動同步")))
    throw new Error(`缺手動同步應不通過且理由提及手動同步，實為 ${JSON.stringify(noManual)}`);
  const noHeaders = lib.canEnrollMapping({ headersRead: false, missing: [], hasDuplicate: false, manualSyncOk: true });
  if (noHeaders.ok) throw new Error("未讀標題應不通過");
  const missing = lib.canEnrollMapping({ headersRead: true, missing: ["受審單位"], hasDuplicate: false, manualSyncOk: true });
  if (missing.ok) throw new Error("對應缺欄應不通過");
});
check("舊 canConfirmMapping 行為不變（步驟 1＋2 gate，手動同步不列入條件）", () => {
  const ok = lib.canConfirmMapping({ headersRead: true, missing: [], hasDuplicate: false });
  if (!ok.ok) throw new Error("連線＋對應完整應可確認");
  const noHeaders = lib.canConfirmMapping({ headersRead: false, missing: [], hasDuplicate: false });
  if (noHeaders.ok) throw new Error("未讀標題應不通過");
});

// --- 6. selectHeaderFetchTargets（同步端 Node）---
check("標題讀取目標選擇：要求讀取且尚未讀到者才取；已讀過、未要求、已停用者不取", () => {
  const all = [
    { id: "m1", enabled: true, headerFetchRequestedAt: "2026-11-10T08:00:00.000Z", lastHeaderFetchAt: null },
    { id: "m2", enabled: true, headerFetchRequestedAt: "2026-11-10T08:00:00.000Z", lastHeaderFetchAt: "2026-11-10T08:05:00.000Z" },
    { id: "m3", enabled: true, headerFetchRequestedAt: "2026-11-10T08:00:00.000Z", lastHeaderFetchAt: "2026-11-10T07:00:00.000Z" },
    { id: "m4", enabled: true, headerFetchRequestedAt: null, lastHeaderFetchAt: null },
    { id: "m5", enabled: false, headerFetchRequestedAt: "2026-11-10T08:00:00.000Z", lastHeaderFetchAt: null },
  ];
  const picked = selectHeaderFetchTargets(all);
  if (!eq(picked.map((m) => m.id), ["m1", "m3"]))
    throw new Error(`應取 m1（未讀）、m3（讀取早於要求），實為 ${JSON.stringify(picked.map((m) => m.id))}`);
  if (selectHeaderFetchTargets([]).length !== 0) throw new Error("空清單應為空");
});

// --- 7. 靜態守衛 ---
check("靜態守衛：ResultsPage 含四步驟 UI（步驟名稱、列入排程、查詢正常提示）", () => {
  for (const needle of [
    "步驟 1：連線確認",
    "步驟 2：欄位對應",
    "步驟 3：手動同步",
    "步驟 4：列入排程",
    "連線確認",
    "列入排程",
    "請先到結果分析查詢，確認匯入的資料顯示正常，再按列入排程",
    "手動同步一次",
    "重新讀取欄位",
    "讀到的欄位名稱",
    "findQualifyingManualRun",
    "deriveSyncSteps",
    "canEnrollMapping",
    "fieldMappingUpdatedAt",
    "headerFetchError",
    "loadRecentRuns",
  ]) {
    if (!resultsPage.includes(needle)) throw new Error(`ResultsPage 缺少：${needle}`);
  }
});
check("靜態守衛：ResultsPage 不含舊版「確認並列入排程」與「確認排程」標題", () => {
  if (resultsPage.includes("確認並列入排程")) throw new Error("ResultsPage 不應再出現「確認並列入排程」");
  if (resultsPage.includes('title="確認排程"')) throw new Error("ResultsPage 不應再有「確認排程」標題");
});
check("靜態守衛：sheet-sync.mjs 含標題讀取（fetchHeadersOnly、輪詢處理待讀標題）", () => {
  for (const needle of [
    "fetchHeadersOnly",
    "selectHeaderFetchTargets",
    "sameFieldMapping",
    "fieldMappingUpdatedAt",
    "headerFetchError",
    "headerFetchRequestedAt",
    "A1:ZZ5",
  ]) {
    if (!sheetSyncScript.includes(needle)) throw new Error(`sheet-sync.mjs 缺少：${needle}`);
  }
});
check("靜態守衛：poll workflow 每 5 分鐘＋請求模式維持不變（不需改 workflow 檔）", () => {
  for (const needle of ['"*/5 * * * *"', 'SYNC_REQUESTS_ONLY: "1"', "group: sheet-sync"]) {
    if (!sheetSyncPollYml.includes(needle)) throw new Error(`sheet-sync-poll.yml 缺少：${needle}`);
  }
});
check("靜態守衛：定時排程仍只跑已確認且啟用的對照（草稿跳過）", () => {
  const all = [
    { id: "m1", status: "confirmed", enabled: true },
    { id: "m2", status: "draft", enabled: true },
    { id: "m3", status: "confirmed", enabled: false },
  ];
  const { targets, skipped } = selectSyncTargets(all, { manual: false, mappingId: "" });
  if (!eq(targets.map((m) => m.id), ["m1"])) throw new Error("定時目標應只有 m1");
  if (!eq(skipped.map((s) => s.mapping.id), ["m2"])) throw new Error("定時應跳過草稿 m2");
});
check("靜態守衛：sheetSync.ts 新欄位與函式存在", () => {
  for (const needle of [
    "fieldMappingUpdatedAt",
    "headerFetchError",
    "tsMillis",
    "sameFieldMapping",
    "findQualifyingManualRun",
    "deriveSyncSteps",
    "syncStepStateLabel",
    "canEnrollMapping",
  ]) {
    if (!sheetSyncTs.includes(needle)) throw new Error(`sheetSync.ts 缺少：${needle}`);
  }
});
check("版號：version.ts 與 package.json 皆為 1.42.3", () => {
  if (!versionTs.includes('"1.42.3"')) throw new Error("version.ts 未升 1.42.3");
  if (pkg.version !== "1.42.3") throw new Error(`package.json 版本實為 ${pkg.version}`);
});

console.log(`\nPASS: ${pass} checks`);
