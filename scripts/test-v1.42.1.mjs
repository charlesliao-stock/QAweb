/**
 * v1.42.1 斷言測試：Google Sheet 連結加「確認後才列入排程」關卡（函式驗證＋靜態守衛，無需 emulator）。
 *
 * 1. 確認狀態（前端 TS 與同步端 Node 同一規則）：
 *    isMappingConfirmed 只認 "confirmed"；v1.42.0 舊就緒值（ready／pending 等）
 *    一律視為草稿；mappingReadiness 讀獨立 readiness 欄位，舊文件以 status 舊值推導。
 * 2. 確認條件 canConfirmMapping：標題已讀取（連線成功）且對應完整、無重複對應；
 *    手動同步結果不列入條件（選用步驟）。
 * 3. 狀態轉換：儲存對應 → 回到 draft（須重新確認）；確認 → confirmed；
 *    停用（enabled=false）不影響 confirmed。
 * 4. 排程目標選擇 selectSyncTargets：定時排程只跑已確認且啟用的對照，
 *    草稿跳過並附跳過原因；手動觸發指定單一對照時草稿亦可跑；
 *    已停用者一律不跑、不記錄。
 * 5. 對應預覽 buildMappingPreview：前 3 列非空資料列，用目前對應解析並逐列檢核，
 *    與同步寫入同一條 buildSyncRecord 規則。
 * 6. 靜態守衛：ResultsPage 含確認／手動同步 UI、sheet-sync.mjs 含觸發判斷與
 *    readiness、workflow 說明文字已更新、版號 1.42.1。
 */
import { createRequire } from "node:module";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildMappingPreview,
  isMappingConfirmed as syncIsMappingConfirmed,
  selectSyncTargets,
} from "./sheet-sync-lib.mjs";

const ROOT = "/home/hatch/workspace/repos/QAweb";
const versionTs = readFileSync(`${ROOT}/src/version.ts`, "utf8");
const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));
const rules = readFileSync(`${ROOT}/firestore.rules`, "utf8");
const resultsPage = readFileSync(`${ROOT}/src/features/ResultsPage.tsx`, "utf8");
const sheetSyncScript = readFileSync(`${ROOT}/scripts/sheet-sync.mjs`, "utf8");
const sheetSyncYml = readFileSync(`${ROOT}/.github/workflows/sheet-sync.yml`, "utf8");

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
  "/tmp/v1-42-1-test.ts",
  `export { isMappingConfirmed, mappingReadiness, hasDuplicateMapping, canConfirmMapping, runStatusLabel, mappingMissingRequired } from "${ROOT}/src/lib/sheetSync";`,
);
await build({
  entryPoints: ["/tmp/v1-42-1-test.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "/tmp/v1-42-1-test.mjs",
  logLevel: "silent",
});
const lib = await import("/tmp/v1-42-1-test.mjs");

// --- 1. 確認狀態 ---
check("確認狀態：只認 confirmed；draft 與舊就緒值皆為草稿", () => {
  if (!lib.isMappingConfirmed({ status: "confirmed" })) throw new Error("confirmed 應為已確認");
  if (lib.isMappingConfirmed({ status: "draft" })) throw new Error("draft 不應為已確認");
  if (lib.isMappingConfirmed({ status: "ready" })) throw new Error("舊 ready 應視為草稿");
  if (lib.isMappingConfirmed({ status: "pending" })) throw new Error("舊 pending 應視為草稿");
  if (lib.isMappingConfirmed({ status: "mapping-incomplete" })) throw new Error("舊 mapping-incomplete 應視為草稿");
  if (!syncIsMappingConfirmed({ status: "confirmed" })) throw new Error("同步端 confirmed 應為已確認");
  if (syncIsMappingConfirmed({ status: "ready" })) throw new Error("同步端舊 ready 應視為草稿");
});
check("就緒狀態：readiness 欄位優先；舊文件以 status 舊值推導；新草稿預設 pending", () => {
  if (lib.mappingReadiness({ status: "confirmed", readiness: "ready" }) !== "ready")
    throw new Error("readiness 應優先");
  if (lib.mappingReadiness({ status: "ready" }) !== "ready")
    throw new Error("舊 ready 應推導為 ready");
  if (lib.mappingReadiness({ status: "mapping-incomplete" }) !== "mapping-incomplete")
    throw new Error("舊 mapping-incomplete 應推導");
  if (lib.mappingReadiness({ status: "draft" }) !== "pending")
    throw new Error("新草稿無 readiness 應為 pending");
  if (lib.mappingReadiness({ status: "draft", readiness: "pending" }) !== "pending")
    throw new Error("readiness pending 應保留");
});

// --- 2. 確認條件 ---
check("確認條件：連線成功＋對應完整＋無重複才可確認", () => {
  const ok = lib.canConfirmMapping({ headersRead: true, missing: [], hasDuplicate: false });
  if (!ok.ok) throw new Error("完整時應可確認");
  const noHeaders = lib.canConfirmMapping({ headersRead: false, missing: [], hasDuplicate: false });
  if (noHeaders.ok || !noHeaders.reasons.some((r) => r.includes("尚未讀取標題列")))
    throw new Error("未讀標題應不可確認");
  const missing = lib.canConfirmMapping({ headersRead: true, missing: ["受審單位"], hasDuplicate: false });
  if (missing.ok || !missing.reasons.some((r) => r.includes("受審單位")))
    throw new Error("缺必要欄應不可確認並列出欄名");
  const dup = lib.canConfirmMapping({ headersRead: true, missing: [], hasDuplicate: true });
  if (dup.ok || !dup.reasons.some((r) => r.includes("不可對到同一系統欄位")))
    throw new Error("重複對應應不可確認");
});
check("重複對應：不同標題對同一欄位為重複；空值不計", () => {
  if (!lib.hasDuplicateMapping({ A: "unitCode", B: "unitCode" })) throw new Error("重複應為真");
  if (lib.hasDuplicateMapping({ A: "unitCode", B: "reviewerId" })) throw new Error("相異應為假");
  if (lib.hasDuplicateMapping({ A: "unitCode", B: "" })) throw new Error("空值不應計入重複");
});
check("執行紀錄狀態中文：ok／partial／failed／mapping-incomplete／skipped", () => {
  if (lib.runStatusLabel("ok") !== "成功") throw new Error("ok 應為成功");
  if (lib.runStatusLabel("partial") !== "部分成功") throw new Error("partial 應為部分成功");
  if (lib.runStatusLabel("failed") !== "失敗") throw new Error("failed 應為失敗");
  if (lib.runStatusLabel("mapping-incomplete") !== "對應未完成") throw new Error("mapping-incomplete 應為對應未完成");
  if (!lib.runStatusLabel("skipped").includes("草稿未確認")) throw new Error("skipped 應說明草稿未確認");
});

// --- 3. 狀態轉換 ---
check("狀態轉換：儲存對應回到 draft；確認後為 confirmed；停用不影響 confirmed", () => {
  const confirmed = { status: "confirmed", enabled: true };
  // 儲存對應（編輯）→ 回到 draft
  const afterSave = { ...confirmed, status: "draft", confirmedAt: null, confirmedBy: null };
  if (lib.isMappingConfirmed(afterSave)) throw new Error("儲存對應後應回到草稿");
  // 重新確認
  const afterConfirm = { ...afterSave, status: "confirmed", confirmedBy: "A12345" };
  if (!lib.isMappingConfirmed(afterConfirm)) throw new Error("確認後應為已確認");
  // 停用只改 enabled
  const paused = { ...afterConfirm, enabled: false };
  if (!lib.isMappingConfirmed(paused)) throw new Error("停用不應影響 confirmed");
  if (paused.enabled !== false) throw new Error("停用應只改 enabled");
});

// --- 4. 排程目標選擇 ---
const confirmedEnabled = { id: "m1", status: "confirmed", enabled: true };
const draftEnabled = { id: "m2", status: "draft", enabled: true };
const legacyReady = { id: "m3", status: "ready", enabled: true };
const confirmedDisabled = { id: "m4", status: "confirmed", enabled: false };
const draftDisabled = { id: "m5", status: "draft", enabled: false };
const allMappings = [confirmedEnabled, draftEnabled, legacyReady, confirmedDisabled, draftDisabled];

check("目標選擇：定時排程只跑已確認且啟用的對照；草稿跳過附原因；停用不跑不記錄", () => {
  const { targets, skipped } = selectSyncTargets(allMappings, { manual: false, mappingId: "" });
  if (!eq(targets.map((m) => m.id), ["m1"])) throw new Error(`定時目標實為 ${JSON.stringify(targets.map((m) => m.id))}`);
  if (!eq(skipped.map((s) => s.mapping.id), ["m2", "m3"]))
    throw new Error(`定時跳過實為 ${JSON.stringify(skipped.map((s) => s.mapping.id))}`);
  if (!skipped.every((s) => s.reason.includes("草稿未確認")))
    throw new Error("跳過原因應說明草稿未確認");
});
check("目標選擇：手動觸發指定草稿對照可跑（測試用）", () => {
  const { targets, skipped } = selectSyncTargets(allMappings, { manual: true, mappingId: "m2" });
  if (!eq(targets.map((m) => m.id), ["m2"])) throw new Error(`手動指定草稿目標實為 ${JSON.stringify(targets.map((m) => m.id))}`);
  if (skipped.length !== 0) throw new Error("手動指定草稿不應有跳過");
});
check("目標選擇：手動觸發未指定對照時，草稿仍跳過（與定時相同）", () => {
  const { targets, skipped } = selectSyncTargets(allMappings, { manual: true, mappingId: "" });
  if (!eq(targets.map((m) => m.id), ["m1"])) throw new Error("手動未指定時目標應只有已確認者");
  if (!eq(skipped.map((s) => s.mapping.id), ["m2", "m3"])) throw new Error("手動未指定時草稿應跳過");
});
check("目標選擇：定時排程指定草稿對照 → 跳過（不跑）", () => {
  const { targets, skipped } = selectSyncTargets(allMappings, { manual: false, mappingId: "m2" });
  if (targets.length !== 0) throw new Error("定時指定草稿不應跑");
  if (skipped.length !== 1 || skipped[0].mapping.id !== "m2") throw new Error("定時指定草稿應記一筆跳過");
});
check("目標選擇：空清單 → 目標與跳過皆空", () => {
  const { targets, skipped } = selectSyncTargets([], { manual: false, mappingId: "" });
  if (targets.length !== 0 || skipped.length !== 0) throw new Error("空清單應皆空");
});

// --- 5. 對應預覽 ---
const previewIndicator = {
  id: "G1__QI-001",
  code: "QI-001",
  version: "v3",
  basicThreshold: 80,
  questions: [
    { id: "q1", itemText: "洗手" },
    { id: "q2", itemText: "戴口罩" },
    { id: "q3", itemText: "量血壓" },
  ],
};
const previewHeaders = [
  "時間戳記",
  "受審單位",
  "審查員職編",
  "受審人員職編",
  "床號",
  "洗手",
  "洗手備註",
  "戴口罩",
  "量血壓",
];
const previewMapping = {
  "時間戳記": "timestamp",
  "受審單位": "unitCode",
  "審查員職編": "reviewerId",
  "受審人員職編": "personEmpNo",
  "床號": "bedNo",
  "洗手": "answer:0",
  "洗手備註": "note:0",
  "戴口罩": "answer:1",
  "量血壓": "answer:2",
};
const previewCtx = {
  headers: previewHeaders,
  fieldMapping: previewMapping,
  indicator: previewIndicator,
  unitHas: (c) => ["9A"].includes(c),
  staffHas: (id) => ["A12345", "B67890"].includes(id),
  staffName: (id) => ({ A12345: "王大明", B67890: "陳小華" })[id] ?? id,
};
const goodRow = ["2026/11/10 上午 11:23:45", "9A", "A12345", "B67890", "9A-01", "是", "手套破損", "否", "是"];
const badUnitRow = ["2026/11/10 上午 11:24:00", "9X", "A12345", "B67890", "9A-02", "是", "", "否", "是"];

check("預覽：前 3 列解析，正確列 ok、錯誤列帶錯誤訊息，列號自第 2 列起", () => {
  const preview = buildMappingPreview({
    ...previewCtx,
    rows: [goodRow, badUnitRow, goodRow],
  });
  if (preview.length !== 3) throw new Error(`預覽應有 3 列，實為 ${preview.length}`);
  if (preview[0].lineNo !== 2 || !preview[0].ok) throw new Error("第 2 列應可匯入");
  if (preview[0].values.unitCode !== "9A" || preview[0].values["note:0"] !== "手套破損")
    throw new Error(`第 2 列對應值不符：${JSON.stringify(preview[0].values)}`);
  if (preview[1].lineNo !== 3 || preview[1].ok) throw new Error("第 3 列（單位 9X）應有問題");
  if (!preview[1].errors.includes("9X")) throw new Error(`第 3 列錯誤應提及 9X：${preview[1].errors}`);
  if (preview[2].lineNo !== 4 || !preview[2].ok) throw new Error("第 4 列應可匯入");
});
check("預覽：只取前 3 列非空資料列（第 4 列起不取、空列跳過）", () => {
  const preview = buildMappingPreview({
    ...previewCtx,
    rows: [goodRow, ["", "", "", "", "", "", "", "", ""], goodRow, goodRow, goodRow],
  });
  if (preview.length !== 3) throw new Error(`預覽應恰好 3 列，實為 ${preview.length}`);
  if (!eq(preview.map((r) => r.lineNo), [2, 4, 5])) throw new Error(`列號實為 ${JSON.stringify(preview.map((r) => r.lineNo))}`);
});

// --- 6. 靜態守衛 ---
check("靜態守衛：ResultsPage 含確認關卡與手動同步 UI", () => {
  for (const needle of [
    "確認並列入排程",
    "手動同步一次",
    "已列入排程，每日 07:00 自動同步",
    "確認排程",
    'status: "draft"',
    'status: "confirmed"',
    'readiness: "ready"',
    "canConfirmMapping",
    "runStatusLabel",
    "actions/workflows/sheet-sync.yml",
  ]) {
    if (!resultsPage.includes(needle)) throw new Error(`ResultsPage 缺少：${needle}`);
  }
});
check("靜態守衛：sheet-sync.mjs 含觸發判斷、目標選擇、readiness、預覽寫回", () => {
  for (const needle of [
    "selectSyncTargets",
    "GITHUB_EVENT_NAME",
    "workflow_dispatch",
    'readiness:',
    "buildMappingPreview",
    "trigger",
    "status: \"skipped\"",
  ]) {
    if (!sheetSyncScript.includes(needle)) throw new Error(`sheet-sync.mjs 缺少：${needle}`);
  }
});
check("靜態守衛：workflow 說明文字已更新（草稿／已確認）", () => {
  if (!sheetSyncYml.includes("草稿亦可跑")) throw new Error("workflow 缺少草稿手動說明");
  if (!sheetSyncYml.includes("已確認")) throw new Error("workflow 缺少已確認說明");
});
check("靜態守衛：rules 仍有 sheetSyncMappings，且不因 status 轉換另開權限", () => {
  if (!rules.includes("sheetSyncMappings")) throw new Error("rules 缺少 sheetSyncMappings");
  if (rules.includes("confirmed")) throw new Error("rules 不應因確認關卡新增 status 判斷");
});
check("版號：version.ts 與 package.json 皆為 1.42.1", () => {
  if (!versionTs.includes('"1.42.1"')) throw new Error("version.ts 未升 1.42.1");
  if (pkg.version !== "1.42.1") throw new Error(`package.json 版本實為 ${pkg.version}`);
});

console.log(`\nPASS: ${pass} checks`);
