/**
 * v1.42.4 斷言測試：連線確認與手動同步改為瀏覽器直接讀 Google Sheet（立即連線）
 * （函式驗證＋靜態守衛，無需 emulator）。
 *
 * 1. sheetApiUrl／sheetRange：URL 與範圍字串（含分頁名單引號跳脫）。
 * 2. classifySheetFetchError：403 未啟用 API vs 未設連結共用、404、400、其他。
 * 3. fetchSheetValues（mock fetch）：成功回值正規化（null→""、去空白）、
 *    無 key 不發請求、403／404 錯誤區分、網路失敗。
 * 4. fetchSheetHeaders：標題列為空時回 empty 錯誤。
 * 5. parseSheetTimestampDate：表單時間戳記、ISO、無效值。
 * 6. mapSheetValuesToResultRows：對應轉結果檔格式、月份由時間戳記推導、
 *    指標代號不符／受審人員未填逐列報錯、全空列跳過、timestamps 對應 lineNo。
 * 7. 雜湊一致：瀏覽器手動同步的文件 ID（importRecordDocId，含 spreadsheetId／
 *    sheetName／timestamp）與同步端 Node 同一輸入算出同一 ID（每日排程可覆寫補快照）。
 * 8. resultRowToPreviewValues：結果檔列 → 預覽顯示值。
 * 9. findQualifyingManualRun：browser 來源的手動同步成功紀錄可通過列入排程 gate。
 * 10. 靜態守衛：ResultsPage 含瀏覽器直讀 UI（API key 設定、立即連線同步），
 *     不含 5 分鐘輪詢／sheetSyncRequests；rules 移除 sheetSyncRequests、
 *     sheetSyncRuns 開放管理員建立；poll workflow 檔已刪除（repo 與 your_files）；
 *     sheet-sync.mjs／lib 已移除請求模式；版號 1.42.4。
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { importRecordDocId as syncImportRecordDocId } from "./sheet-sync-lib.mjs";

const ROOT = "/home/hatch/workspace/repos/QAweb";
const versionTs = readFileSync(`${ROOT}/src/version.ts`, "utf8");
const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));
const rules = readFileSync(`${ROOT}/firestore.rules`, "utf8");
const resultsPage = readFileSync(`${ROOT}/src/features/ResultsPage.tsx`, "utf8");
const sheetBrowserTs = readFileSync(`${ROOT}/src/lib/sheetBrowser.ts`, "utf8");
const sheetSyncScript = readFileSync(`${ROOT}/scripts/sheet-sync.mjs`, "utf8");
const sheetSyncLib = readFileSync(`${ROOT}/scripts/sheet-sync-lib.mjs`, "utf8");

let pass = 0;
const pendingChecks = [];
function check(name, fn) {
  pendingChecks.push((async () => {
    await fn();
    pass++;
    console.log(`ok - ${name}`);
  })());
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
  "/tmp/v1-42-4-test.ts",
  `export { sheetApiUrl, sheetRange, classifySheetFetchError, fetchSheetValues, fetchSheetHeaders, parseSheetTimestampDate, mapSheetValuesToResultRows, resultRowToPreviewValues } from "${ROOT}/src/lib/sheetBrowser";
export { findQualifyingManualRun } from "${ROOT}/src/lib/sheetSync";
export { importRecordDocId } from "${ROOT}/src/lib/import";`,
);
await build({
  entryPoints: ["/tmp/v1-42-4-test.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "/tmp/v1-42-4-test.mjs",
  logLevel: "silent",
});
const lib = await import("/tmp/v1-42-4-test.mjs");

// --- 1. URL 與範圍字串 ---
check("Sheets API URL 與範圍字串：分頁名單引號跳脫、key 參數", () => {
  const url = lib.sheetApiUrl("abc123", "'表單回覆 1'!A1:ZZ1", "KEY-1");
  if (!url.startsWith("https://sheets.googleapis.com/v4/spreadsheets/abc123/values/"))
    throw new Error(`URL 前綴錯誤：${url}`);
  if (!url.includes("key=KEY-1")) throw new Error("URL 須帶 key 參數");
  if (lib.sheetRange("表單回覆 1", "A1:ZZ1") !== "'表單回覆 1'!A1:ZZ1")
    throw new Error("範圍字串錯誤");
  if (lib.sheetRange("A'B", "A1:ZZ5") !== "'A''B'!A1:ZZ5")
    throw new Error("分頁名單引號須以 '' 跳脫");
});

// --- 2. 錯誤區分 ---
check("錯誤區分：403 未啟用 API vs 未設連結共用、404、400、其他", () => {
  const disabled = lib.classifySheetFetchError(
    403,
    JSON.stringify({ error: { message: "Google Sheets API has not been used in project x before or it is disabled." } }),
  );
  if (disabled.kind !== "api-disabled") throw new Error("未啟用 API 應為 api-disabled");
  if (!disabled.message.includes("尚未啟用")) throw new Error("未啟用訊息應含處理指引");
  const notShared = lib.classifySheetFetchError(
    403,
    JSON.stringify({ error: { message: "The caller does not have permission" } }),
  );
  if (notShared.kind !== "not-shared") throw new Error("未設連結共用應為 not-shared");
  if (!notShared.message.includes("知道連結")) throw new Error("未共用訊息應含處理指引");
  if (lib.classifySheetFetchError(404, "{}").kind !== "not-found")
    throw new Error("404 應為 not-found");
  if (lib.classifySheetFetchError(400, "{}").kind !== "bad-range")
    throw new Error("400 應為 bad-range");
  if (lib.classifySheetFetchError(500, "{}").kind !== "http")
    throw new Error("500 應為 http");
});

// --- mock fetch ---
const mockOk = (values) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ values }),
  text: async () => "",
});
const mockErr = (status, message) => async () => ({
  ok: false,
  status,
  json: async () => ({}),
  text: async () => JSON.stringify({ error: { message } }),
});

// --- 3. fetchSheetValues ---
check("fetchSheetValues：成功回值正規化（null→空、去空白）", async () => {
  let called = 0;
  const r = await lib.fetchSheetValues(
    "abc",
    "'表單回覆 1'!A1:ZZ1",
    "KEY",
    async () => {
      called++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ values: [[" 時間戳記 ", "受審單位"], ["2026/11/10", null, "多餘欄"]] }),
        text: async () => "",
      };
    },
  );
  if (called !== 1) throw new Error("應發一次請求");
  if (!("values" in r)) throw new Error("應回 values");
  if (!eq(r.values, [["時間戳記", "受審單位"], ["2026/11/10", "", "多餘欄"]]))
    throw new Error(`正規化錯誤：${JSON.stringify(r.values)}`);
});
check("fetchSheetValues：無 key 不發請求", async () => {
  let called = 0;
  const r = await lib.fetchSheetValues("abc", "A1:ZZ1", "", async () => {
    called++;
    return mockOk([])();
  });
  if (called !== 0) throw new Error("無 key 不應發請求");
  if (!("error" in r) || r.error.kind !== "no-api-key")
    throw new Error("無 key 應回 no-api-key");
});
check("fetchSheetValues：403／404 錯誤區分、網路失敗", async () => {
  const r403 = await lib.fetchSheetValues("abc", "A1:ZZ1", "K", mockErr(403, "The caller does not have permission"));
  if (!("error" in r403) || r403.error.kind !== "not-shared")
    throw new Error("403 未共用應為 not-shared");
  const r404 = await lib.fetchSheetValues("abc", "A1:ZZ1", "K", mockErr(404, "not found"));
  if (!("error" in r404) || r404.error.kind !== "not-found")
    throw new Error("404 應為 not-found");
  const rNet = await lib.fetchSheetValues("abc", "A1:ZZ1", "K", async () => {
    throw new Error("fetch failed");
  });
  if (!("error" in rNet) || rNet.error.kind !== "network")
    throw new Error("fetch 拋錯應為 network");
});

// --- 4. fetchSheetHeaders ---
check("fetchSheetHeaders：標題列為空回 empty 錯誤", async () => {
  const r = await lib.fetchSheetHeaders("abc", "表單回覆 1", "K", mockOk([["", ""], ["x"]]));
  if (!("error" in r) || r.error.kind !== "empty")
    throw new Error("空標題列應回 empty");
  const r2 = await lib.fetchSheetHeaders("abc", "表單回覆 1", "K", mockOk([["時間戳記", "受審單位"]]));
  if (!("headers" in r2) || !eq(r2.headers, ["時間戳記", "受審單位"]))
    throw new Error("應回標題列");
});

// --- 5. 時間戳記解析 ---
check("parseSheetTimestampDate：表單時間戳記、ISO、無效值", () => {
  if (lib.parseSheetTimestampDate("2026/11/10 上午 11:23:45") !== "2026-11-10")
    throw new Error("表單時間戳記應取日期");
  if (lib.parseSheetTimestampDate("2026-11-05 11:23") !== "2026-11-05")
    throw new Error("ISO 日期應取日期");
  if (lib.parseSheetTimestampDate("2026/2/30") !== null)
    throw new Error("不存在日期應為 null");
  if (lib.parseSheetTimestampDate("") !== null || lib.parseSheetTimestampDate("abc") !== null)
    throw new Error("空值／無效值應為 null");
});

// --- 6. 對應轉結果檔格式 ---
const QUESTIONS = ["題一", "題二"];
const MAPPING = {
  "時間戳記": "timestamp",
  "受審單位": "unitCode",
  "審查月份": "monthRaw",
  "審查員職編": "reviewerId",
  "受審人員職編": "personEmpNo",
  "床號": "bedNo",
  "題一": "answer:0",
  "題一備註": "note:0",
  "題二": "answer:1",
  "題二備註": "note:1",
};
const VALUES = [
  ["時間戳記", "受審單位", "審查月份", "審查員職編", "受審人員職編", "床號", "題一", "題一備註", "題二", "題二備註"],
  ["2026/11/10 上午 11:23:45", "9A", "2026-11", "A111", "B222", "9A-01", "正確", "備註一", "不正確", ""],
  ["", "", "", "", "", "", "", "", "", ""],
  ["2026/11/09", "9B", "", "A111", "B333", "", "是", "", "否", "備註二"],
];
check("mapSheetValuesToResultRows：對應轉結果檔格式、時間戳記、空列跳過", () => {
  const { rows, timestamps, rowErrors } = lib.mapSheetValuesToResultRows(VALUES, MAPPING, QUESTIONS, "QI-001");
  if (rows.length !== 3) throw new Error(`應為標題列＋2 列資料，實際 ${rows.length} 列`);
  if (!eq(rows[0].slice(0, 6), ["指標代號", "受審單位", "審查月份", "審查員職編", "受審人員職編", "床號"]))
    throw new Error("標題列前 6 欄應為固定標題");
  if (rows[1][0] !== "QI-001" || rows[1][1] !== "9A" || rows[1][2] !== "2026-11" || rows[1][6] !== "正確" || rows[1][7] !== "備註一")
    throw new Error(`第 1 列對應錯誤：${JSON.stringify(rows[1])}`);
  // 第 3 列（lineNo 4）：無月份欄值，由時間戳記推導 2026-11
  if (rows[2][2] !== "2026-11") throw new Error(`月份應由時間戳記推導，實際 ${rows[2][2]}`);
  if (timestamps.get(2) !== "2026/11/10 上午 11:23:45") throw new Error("lineNo 2 的時間戳記應保留原始字串");
  if (timestamps.get(4) !== "2026/11/09") throw new Error("lineNo 4 的時間戳記應保留原始字串");
  if (rowErrors.size !== 0) throw new Error(`不應有逐列錯誤：${JSON.stringify([...rowErrors])}`);
});
check("mapSheetValuesToResultRows：指標代號不符／受審人員未填逐列報錯", () => {
  const mapping = { ...MAPPING, "指標代號": "code" };
  const values = [
    ["指標代號", "受審單位", "審查月份", "受審人員職編", "題一", "題二"],
    ["QI-999", "9A", "2026-11", "B222", "是", "否"],
    ["QI-001", "9A", "2026-11", "", "是", "否"],
  ];
  const { rows, rowErrors } = lib.mapSheetValuesToResultRows(values, mapping, QUESTIONS, "QI-001");
  if (rows.length !== 3) throw new Error("應為標題列＋2 列");
  if (!rowErrors.get(2)?.some((e) => e.includes("QI-999")))
    throw new Error("代號不符應逐列報錯");
  if (!rowErrors.get(3)?.some((e) => e.includes("受審人員職編未填")))
    throw new Error("受審人員未填應逐列報錯");
  if (rows[1][0] !== "QI-001") throw new Error("代號欄一律用連結指標代號");
});

// --- 7. 雜湊一致（瀏覽器 vs 同步端） ---
check("雜湊一致：瀏覽器手動同步文件 ID 與同步端同一輸入算出同一 ID", () => {
  const input = {
    spreadsheetId: "abc123",
    sheetName: "表單回覆 1",
    timestamp: "2026/11/10 上午 11:23:45",
    indicatorId: "ind-1",
    unitCode: "9A",
    year: 2026,
    month: 11,
    reviewerId: "A111",
    personEmpNo: "B222",
    bedNo: "9A-01",
    answers: ["是", "否"],
    notes: ["備註一", ""],
  };
  const tsId = lib.importRecordDocId(input);
  const mjsId = syncImportRecordDocId(input);
  if (tsId !== mjsId) throw new Error(`文件 ID 不一致：前端 ${tsId}／同步端 ${mjsId}`);
  if (!tsId.startsWith("import_") || tsId.length !== 7 + 24)
    throw new Error(`文件 ID 格式錯誤：${tsId}`);
  const input2 = { ...input, answers: ["是", "是"] };
  if (lib.importRecordDocId(input2) === tsId)
    throw new Error("答案不同應算出不同文件 ID");
});

// --- 8. 預覽顯示值 ---
check("resultRowToPreviewValues：結果檔列 → 預覽顯示值", () => {
  const row = ["QI-001", "9A", "2026-11", "A111", "B222", "9A-01", "正確", "備註一", "否", ""];
  const v = lib.resultRowToPreviewValues(row, QUESTIONS);
  if (v.unitCode !== "9A" || v.monthRaw !== "2026-11" || v["answer:0"] !== "正確" || v["note:0"] !== "備註一" || v["note:1"] !== "")
    throw new Error(`預覽值錯誤：${JSON.stringify(v)}`);
});

// --- 9. 列入排程 gate 認可 browser 手動同步 ---
check("列入排程 gate：browser 來源的手動同步成功紀錄可通過", () => {
  const run = {
    id: "r1", trigger: "manual", source: "browser", status: "ok",
    inserted: 2, updated: 0,
    startedAt: "2026-11-10T08:10:00.000Z", finishedAt: "2026-11-10T08:11:00.000Z",
  };
  if (!lib.findQualifyingManualRun([run], null)) throw new Error("browser 手動同步成功應算數");
  const zero = { ...run, inserted: 0, updated: 0 };
  if (lib.findQualifyingManualRun([zero], null)) throw new Error("0 筆匯入不應算數");
  const schedule = { ...run, trigger: "schedule" };
  if (lib.findQualifyingManualRun([schedule], null)) throw new Error("定時觸發不應算數");
});

// --- 10. 靜態守衛 ---
check("靜態守衛：ResultsPage 含瀏覽器直讀 UI（API key、立即連線同步）", () => {
  for (const s of [
    "configs/sheetApiKey",
    "Google Sheets API 金鑰",
    "立即連線同步",
    "fetchSheetAllValues",
    "mapSheetValuesToResultRows",
    "source: \"browser\"",
  ]) {
    if (!resultsPage.includes(s)) throw new Error(`ResultsPage 須含「${s}」`);
  }
});
check("靜態守衛：ResultsPage 不含 5 分鐘輪詢與請求流程", () => {
  for (const s of ["5 分鐘內執行", "sheetSyncRequests", "findActiveSyncRequest", "requestStatusLabel", "loadRequests", "送出同步請求"]) {
    if (resultsPage.includes(s)) throw new Error(`ResultsPage 不應含「${s}」`);
  }
});
check("靜態守衛：sheetBrowser 模組直讀 Sheets API", () => {
  if (!sheetBrowserTs.includes("sheets.googleapis.com/v4/spreadsheets"))
    throw new Error("sheetBrowser 須呼叫 Sheets API v4");
  if (sheetBrowserTs.includes("private_key") || sheetBrowserTs.includes("service account JSON"))
    throw new Error("sheetBrowser 不可提及 service account 私鑰");
});
check("靜態守衛：rules 移除 sheetSyncRequests、sheetSyncRuns 開放管理員建立", () => {
  if (rules.includes("sheetSyncRequests")) throw new Error("rules 不應再有 sheetSyncRequests");
  const runsBlock = rules.slice(rules.indexOf("match /sheetSyncRuns/"));
  if (!runsBlock.includes("allow create: if isAdmin()"))
    throw new Error("sheetSyncRuns 須開放管理員建立（瀏覽器手動同步寫 run 紀錄）");
  if (!rules.includes('match /configs/{id}')) throw new Error("configs 規則須存在（API key 存放處）");
});
check("靜態守衛：poll workflow 檔已刪除（repo 與 your_files 皆無）", () => {
  if (existsSync(`${ROOT}/.github/workflows/sheet-sync-poll.yml`))
    throw new Error("repo 內 sheet-sync-poll.yml 應已刪除");
  if (existsSync("/home/hatch/workspace/your_files/nursing-qi-system/sheet-sync-poll.yml"))
    throw new Error("your_files 內 sheet-sync-poll.yml 副本應已刪除");
  if (!existsSync(`${ROOT}/.github/workflows/sheet-sync.yml`))
    throw new Error("每日排程 sheet-sync.yml 應保留（仍待使用者上傳）");
});
check("靜態守衛：同步腳本已移除請求模式", () => {
  for (const s of ["SYNC_REQUESTS_ONLY", "fetchHeadersOnly", "runRequestMode", "selectPendingRequests", "selectHeaderFetchTargets"]) {
    if (sheetSyncScript.includes(s)) throw new Error(`sheet-sync.mjs 不應含「${s}」`);
    if (sheetSyncLib.includes(s)) throw new Error(`sheet-sync-lib.mjs 不應含「${s}」`);
  }
  if (!sheetSyncScript.includes("syncMapping")) throw new Error("sheet-sync.mjs 須保留每日排程 syncMapping");
});
check("靜態守衛：版號 1.42.4", () => {
  if (!versionTs.includes('VERSION = "1.42.4"')) throw new Error("version.ts 須為 1.42.4");
  if (pkg.version !== "1.42.4") throw new Error("package.json 須為 1.42.4");
});

await Promise.all(pendingChecks);
console.log(`\nPASS ${pass} checks`);
