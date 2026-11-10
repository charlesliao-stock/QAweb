/**
 * v1.42.0 斷言測試：結果匯入接 Google Sheet（函式驗證＋靜態守衛，無需 emulator）。
 *
 * 1. 範本備註欄：每題結果欄後加「{題目}備註」欄成對；解析與檢核一致，
 *    備註不計入題數、寫入 answers[].note；舊範本（無備註欄）仍可匯入。
 * 2. 欄位對應：parseSheetUrl／autoFieldMapping／mappingMissingRequired，
 *    前端 TS（src/lib/sheetSync.ts）與同步端 Node（scripts/sheet-sync-lib.mjs）
 *    同一規則，以相同 fixture 守住一致。
 * 3. 去重雜湊：SHA-1 標準向量；內容雜湊決定性；同一列匯兩次同一文件 ID；
 *    修改後雜湊變、文件 ID 變，但 rowKey 不變（state 追蹤舊文件刪除）。
 *    前端 TS 與同步端 Node 的雜湊以相同 fixture 比對，必須完全一致。
 * 4. 同步列建檔：buildSyncRecord 檢核／計分／快照欄位（任務快照優先，
 *    否則指標當下版本與閾值，標註 snapshotSource）。
 * 5. Firestore REST 編碼：巢狀陣列／map／時間戳 roundtrip。
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  autoFieldMapping as syncAutoFieldMapping,
  buildSyncRecord,
  decodeFirestoreDoc,
  effectiveThreshold as syncEffectiveThreshold,
  encodeFirestoreFields,
  importRecordDocId as syncImportRecordDocId,
  importRecordHash as syncImportRecordHash,
  mappingMissingRequired as syncMappingMissingRequired,
  parseSheetUrl as syncParseSheetUrl,
  parseTimestampDate,
  sha1Hex as syncSha1Hex,
  syncRowKey,
  syncStateDocId,
} from "./sheet-sync-lib.mjs";

const ROOT = "/home/hatch/workspace/repos/QAweb";
const versionTs = readFileSync(`${ROOT}/src/version.ts`, "utf8");
const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));
const rules = readFileSync(`${ROOT}/firestore.rules`, "utf8");
const resultsPage = readFileSync(`${ROOT}/src/features/ResultsPage.tsx`, "utf8");

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
  "/tmp/v1-42-0-test.ts",
  `export { parseResultSheet, validateResultSheet, resultTemplateRows, sha1Hex, importRecordHash, importRecordDocId } from "${ROOT}/src/lib/import";
export { parseSheetUrl, autoFieldMapping, mappingMissingRequired } from "${ROOT}/src/lib/sheetSync";`,
);
await build({
  entryPoints: ["/tmp/v1-42-0-test.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v1-42-0-test.cjs",
  logLevel: "silent",
});
const lib = createRequire("/tmp/v1-42-0-test.cjs")("/tmp/v1-42-0-test.cjs");

// --- 0. 版號 ---
check("版號 1.42.0（version.ts 與 package.json 一致）", () => {
  if (!versionTs.includes('VERSION = "1.42.0"')) throw new Error("version.ts 非 1.42.0");
  if (pkg.version !== "1.42.0") throw new Error(`package.json 為 ${pkg.version}`);
});

// --- 1. SHA-1 標準向量（兩端） ---
check("SHA-1：空字串與 abc 標準向量（TS 端）", () => {
  if (lib.sha1Hex("") !== "da39a3ee5e6b4b0d3255bfef95601890afd80709")
    throw new Error(`空字串雜湊為 ${lib.sha1Hex("")}`);
  if (lib.sha1Hex("abc") !== "a9993e364706816aba3e25717850c26c9cd0d89d")
    throw new Error("abc 雜湊不符");
});
check("SHA-1：空字串與 abc 標準向量（Node 端）", () => {
  if (syncSha1Hex("") !== "da39a3ee5e6b4b0d3255bfef95601890afd80709")
    throw new Error("Node 端空字串雜湊不符");
  if (syncSha1Hex("abc") !== "a9993e364706816aba3e25717850c26c9cd0d89d")
    throw new Error("Node 端 abc 雜湊不符");
});

// --- 2. 範本備註欄 ---
check("範本：每題結果欄＋備註欄成對", () => {
  const rows = lib.resultTemplateRows("QI-001", ["題一", "題二"]);
  if (
    !eq(rows[0], [
      "指標代號",
      "受審單位",
      "審查月份",
      "審查員職編",
      "受審人員職編",
      "床號",
      "題一",
      "題一備註",
      "題二",
      "題二備註",
    ])
  )
    throw new Error(`範本標題列實為 ${JSON.stringify(rows[0])}`);
  if (!eq(rows[1].slice(6), ["是", "", "是", ""]))
    throw new Error(`範本範例列實為 ${JSON.stringify(rows[1])}`);
});

// --- 3. 解析：成對備註欄／舊範本 ---
const pairedSheet = [
  ["指標代號", "受審單位", "審查月份", "審查員職編", "受審人員職編", "床號", "題一", "題一備註", "題二", "題二備註"],
  ["QI-001", "9A", "2026-11", "A12345", "B67890", "9A-01", "是", "手套破損", "否", ""],
  ["QI-001", "9A", "2026-11", "A12345", "B67890", "9A-02", "正確", "", "不正確", "未戴口罩"],
];
const ctx = {
  code: "QI-001",
  questionCount: 2,
  unitHas: (c) => ["9A", "9B"].includes(c),
  staffHas: (id) => ["A12345", "B67890"].includes(id),
  staffLoaded: true,
};
check("解析：成對備註欄（傳題目）→ answers 與 notes 配對", () => {
  const { headerErrors, data } = lib.parseResultSheet(pairedSheet, {
    questionTitles: ["題一", "題二"],
  });
  if (headerErrors.length > 0) throw new Error(`標題錯誤：${headerErrors}`);
  if (!eq(data[0].answers, ["是", "否"])) throw new Error(`答案實為 ${JSON.stringify(data[0].answers)}`);
  if (!eq(data[0].notes, ["手套破損", ""])) throw new Error(`備註實為 ${JSON.stringify(data[0].notes)}`);
  if (!eq(data[1].answers, ["正確", "不正確"])) throw new Error("第二列答案未保留原始值");
  if (!eq(data[1].notes, ["", "未戴口罩"])) throw new Error("第二列備註不符");
});
check("檢核：備註欄不計入題數，備註寫入 values.notes（正規化後答案）", () => {
  const { data } = lib.parseResultSheet(pairedSheet, { questionTitles: ["題一", "題二"] });
  const { fileErrors, rows } = lib.validateResultSheet(data, ctx);
  if (fileErrors.length > 0) throw new Error(`檔案錯誤：${fileErrors}`);
  if (!rows[0].ok) throw new Error(`第 1 列應通過：${rows[0].errors}`);
  if (!eq(rows[0].values.answers, ["是", "否"])) throw new Error("答案未正規化");
  if (!eq(rows[0].values.notes, ["手套破損", ""])) throw new Error("notes 未寫入 values");
  if (!eq(rows[1].values.answers, ["是", "否"])) throw new Error("正確／不正確未正規化");
  if (!eq(rows[1].values.notes, ["", "未戴口罩"])) throw new Error("第二列 notes 不符");
});
check("解析：舊範本（無備註欄）仍可匯入，notes 全為空", () => {
  const oldSheet = [
    ["指標代號", "受審單位", "審查月份", "審查員職編", "受審人員職編", "床號", "題一", "題二"],
    ["QI-001", "9A", "2026-11", "A12345", "B67890", "9A-01", "是", "否"],
  ];
  const { headerErrors, data } = lib.parseResultSheet(oldSheet, {
    questionTitles: ["題一", "題二"],
  });
  if (headerErrors.length > 0) throw new Error(`標題錯誤：${headerErrors}`);
  if (!eq(data[0].answers, ["是", "否"])) throw new Error("舊範本答案不符");
  if (!eq(data[0].notes, ["", ""])) throw new Error("舊範本 notes 應全空");
  const { fileErrors, rows } = lib.validateResultSheet(data, ctx);
  if (fileErrors.length > 0 || !rows[0].ok) throw new Error("舊範本應通過檢核");
});
check("解析：未傳題目時以後綴「備註」判斷備註欄", () => {
  const { data } = lib.parseResultSheet(pairedSheet);
  if (!eq(data[0].answers, ["是", "否"])) throw new Error("無題目時答案不符");
  if (!eq(data[0].notes, ["手套破損", ""])) throw new Error("無題目時備註不符");
});

// --- 4. 去重雜湊 ---
const identity = {
  spreadsheetId: "abc123",
  sheetName: "表單回覆 1",
  timestamp: "2026/11/10 上午 11:23:45",
  indicatorId: "G1__QI-001",
  unitCode: "9A",
  year: 2026,
  month: 11,
  reviewerId: "A12345",
  personEmpNo: "B67890",
  bedNo: "9A-01",
  answers: ["是", "否"],
  notes: ["手套破損", ""],
};
check("去重：同一內容兩次同一雜湊、同一文件 ID（import_＋24 字元）", () => {
  const h1 = lib.importRecordHash(identity);
  const h2 = lib.importRecordHash({ ...identity });
  if (h1 !== h2) throw new Error("同一內容雜湊不一致");
  const id = lib.importRecordDocId(identity);
  if (!/^import_[0-9a-f]{24}$/.test(id)) throw new Error(`文件 ID 格式不符：${id}`);
  if (id !== `import_${h1.slice(0, 24)}`) throw new Error("文件 ID 非雜湊前綴");
});
check("去重：答案或備註變了雜湊就變（修改可偵測）", () => {
  const base = lib.importRecordHash(identity);
  if (lib.importRecordHash({ ...identity, answers: ["否", "否"] }) === base)
    throw new Error("答案變了雜湊應變");
  if (lib.importRecordHash({ ...identity, notes: ["其他", ""] }) === base)
    throw new Error("備註變了雜湊應變");
});
check("去重：前端 TS 與同步端 Node 雜湊完全一致（同一 fixture）", () => {
  if (syncImportRecordHash(identity) !== lib.importRecordHash(identity))
    throw new Error("兩端雜湊不一致");
  if (syncImportRecordDocId(identity) !== lib.importRecordDocId(identity))
    throw new Error("兩端文件 ID 不一致");
});
check("去重：rowKey 有時間戳記時不含答案（修改後同一列可追蹤）", () => {
  const k1 = syncRowKey(identity);
  const k2 = syncRowKey({ ...identity, answers: ["否", "否"], notes: ["其他", ""] });
  if (k1 !== k2) throw new Error("同一列修改後 rowKey 應不變");
  if (!/^row_[0-9a-f]{24}$/.test(syncStateDocId(k1))) throw new Error("state 文件 ID 格式不符");
});

// --- 5. 欄位對應（兩端一致） ---
const sheetHeaders = [
  "時間戳記",
  "受審單位",
  "審查員職編",
  "受審人員職編",
  "床號",
  "審查月份",
  "洗手",
  "洗手備註",
  "未對應欄",
];
const questions = ["洗手"];
check("欄位對應：自動對應（時間戳記／固定欄／題目／備註）", () => {
  const m = lib.autoFieldMapping(sheetHeaders, questions);
  const want = {
    時間戳記: "timestamp",
    受審單位: "unitCode",
    審查員職編: "reviewerId",
    受審人員職編: "personEmpNo",
    床號: "bedNo",
    審查月份: "monthRaw",
    洗手: "answer:0",
    洗手備註: "note:0",
  };
  if (!eq(m, want)) throw new Error(`自動對應實為 ${JSON.stringify(m)}`);
  if (!eq(syncAutoFieldMapping(sheetHeaders, questions), want))
    throw new Error("兩端自動對應不一致");
});
check("欄位對應：缺必要欄列出（無月份也無時間戳記時補列）", () => {
  const missing = lib.mappingMissingRequired({ 受審單位: "unitCode" }, questions);
  if (!missing.includes("受審人員職編")) throw new Error("應列出受審人員職編");
  if (!missing.includes("審查月份（或時間戳記）")) throw new Error("應列出審查月份");
  if (!missing.includes("第 1 題結果：洗手")) throw new Error("應列出第 1 題結果");
  if (!eq(syncMappingMissingRequired({ 受審單位: "unitCode" }, questions), missing))
    throw new Error("兩端缺欄檢查不一致");
});
check("欄位對應：有時間戳記時月份可缺", () => {
  const missing = lib.mappingMissingRequired(
    { 時間戳記: "timestamp", 受審單位: "unitCode", 受審人員職編: "personEmpNo", 洗手: "answer:0" },
    questions,
  );
  if (missing.length !== 0) throw new Error(`應無缺欄，實為 ${missing}`);
});
check("網址解析：取 spreadsheetId 與 gid；非試算表網址報錯", () => {
  const ok = lib.parseSheetUrl(
    "https://docs.google.com/spreadsheets/d/abc123XYZ/edit#gid=123456",
  );
  if (ok.spreadsheetId !== "abc123XYZ" || ok.gid !== "123456")
    throw new Error(`解析實為 ${JSON.stringify(ok)}`);
  if (!("error" in lib.parseSheetUrl("https://example.com/foo")))
    throw new Error("非試算表網址應報錯");
  if (!eq(syncParseSheetUrl("https://docs.google.com/spreadsheets/d/abc123XYZ/edit#gid=123456"), ok))
    throw new Error("兩端網址解析不一致");
});

// --- 6. 時間戳記解析 ---
check("時間戳記：表單中文格式取日期", () => {
  if (parseTimestampDate("2026/11/10 上午 11:23:45") !== "2026-11-10")
    throw new Error("中文時間戳記解析失敗");
  if (parseTimestampDate("2026-11-10 11:23") !== "2026-11-10")
    throw new Error("ISO 時間戳記解析失敗");
  if (parseTimestampDate("沒有日期") !== null) throw new Error("無日期應回 null");
  if (parseTimestampDate("2026/13/40") !== null) throw new Error("不存在的日期應回 null");
});

// --- 7. 同步列建檔 ---
const syncIndicator = {
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
const syncMapping = {
  spreadsheetId: "abc123",
  sheetName: "表單回覆 1",
  indicatorId: "G1__QI-001",
  fieldMapping: {
    時間戳記: "timestamp",
    受審單位: "unitCode",
    審查員職編: "reviewerId",
    受審人員職編: "personEmpNo",
    床號: "bedNo",
    洗手: "answer:0",
    洗手備註: "note:0",
    戴口罩: "answer:1",
    量血壓: "answer:2",
  },
};
const syncCtx = {
  mapping: syncMapping,
  headers: [
    "時間戳記",
    "受審單位",
    "審查員職編",
    "受審人員職編",
    "床號",
    "洗手",
    "洗手備註",
    "戴口罩",
    "量血壓",
  ],
  rowCells: [
    "2026/11/10 上午 11:23:45",
    "9A",
    "A12345",
    "B67890",
    "9A-01",
    "是",
    "手套破損",
    "否",
    "是",
  ],
  indicator: syncIndicator,
  unitHas: (c) => ["9A"].includes(c),
  staffHas: (id) => ["A12345", "B67890"].includes(id),
  staffName: (id) => ({ A12345: "王大明", B67890: "陳小華" })[id] ?? id,
  taskSnapshot: null,
};
check("同步建檔：無任務時用指標當下版本與閾值，snapshotSource 標註", () => {
  const r = buildSyncRecord(syncCtx);
  if (!r.ok) throw new Error(`應通過：${r.errors}`);
  if (r.record.snapshotSource !== "indicator-current")
    throw new Error(`snapshotSource 實為 ${r.record.snapshotSource}`);
  if (r.record.indicatorVersionAtSchedule !== "v3") throw new Error("版本快照不符");
  if (r.record.thresholdAtSchedule !== 80) throw new Error("閾值快照不符");
  if (r.record.reviewDate !== "2026-11-10") throw new Error(`reviewDate 實為 ${r.record.reviewDate}`);
  if (r.record.year !== 2026 || r.record.month !== 11) throw new Error("年月應由時間戳記推導");
  if (r.record.totalScore !== 2 || r.record.maxScore !== 3) throw new Error("計分不符（2/3）");
  if (r.record.rate !== 66.7) throw new Error(`正確率實為 ${r.record.rate}`);
  if (r.record.answers[0].note !== "手套破損") throw new Error("備註未寫入 answers[].note");
  if (r.record.source !== "sheet-sync" || r.record.submittedBy !== "sheet-sync")
    throw new Error("來源標記不符");
  if (!/^import_[0-9a-f]{24}$/.test(r.docId)) throw new Error("文件 ID 格式不符");
});
check("同步建檔：有任務時抄任務快照", () => {
  const r = buildSyncRecord({
    ...syncCtx,
    taskSnapshot: {
      id: "task-1",
      indicatorVersionAtSchedule: "v2",
      thresholdAtSchedule: 75,
      thresholdRuleAtSchedule: ">=",
      scheduleStartYear: 2026,
      scheduleStartMonth: 11,
      scheduleEndYear: 2026,
      scheduleEndMonth: 11,
    },
  });
  if (!r.ok) throw new Error(`應通過：${r.errors}`);
  if (r.record.snapshotSource !== "reviewTask") throw new Error("應標註 reviewTask");
  if (r.record.indicatorVersionAtSchedule !== "v2") throw new Error("應抄任務版本");
  if (r.record.thresholdAtSchedule !== 75) throw new Error("應抄任務閾值");
  if (r.record.taskId !== "task-1") throw new Error("taskId 應為任務 ID");
});
check("同步建檔：單位不存在／答案無效／人員未填逐列報錯", () => {
  const badUnit = buildSyncRecord({
    ...syncCtx,
    rowCells: [...syncCtx.rowCells.slice(0, 1), "9X", ...syncCtx.rowCells.slice(2)],
  });
  if (badUnit.ok || !badUnit.errors.some((e) => e.includes("9X"))) throw new Error("單位不存在應報錯");
  const badAns = buildSyncRecord({
    ...syncCtx,
    rowCells: [...syncCtx.rowCells.slice(0, 5), "也許", "", "", ""],
  });
  if (badAns.ok || !badAns.errors.some((e) => e.includes("第 1 題"))) throw new Error("非法答案應報錯");
  const noPerson = buildSyncRecord({
    ...syncCtx,
    rowCells: [...syncCtx.rowCells.slice(0, 3), "", ...syncCtx.rowCells.slice(4)],
  });
  if (noPerson.ok || !noPerson.errors.some((e) => e.includes("受審人員"))) throw new Error("人員未填應報錯");
});
check("閾值：basicThreshold 優先，否則 tenSteps step5，皆無為 0", () => {
  if (syncEffectiveThreshold({ basicThreshold: 80, tenSteps: { step5: [{ value: 70 }] } }) !== 80)
    throw new Error("basicThreshold 應優先");
  if (syncEffectiveThreshold({ tenSteps: { step5: [{ value: 70 }] } }) !== 70)
    throw new Error("應取 step5 閾值");
  if (syncEffectiveThreshold({}) !== 0) throw new Error("皆無應為 0");
});

// --- 8. Firestore REST 編碼 roundtrip ---
check("REST 編碼：巢狀陣列／map／時間戳 roundtrip", () => {
  const values = {
    name: "測試",
    count: 3,
    rate: 66.7,
    ok: true,
    at: new Date("2026-11-10T03:00:00.000Z"),
    answers: [{ questionId: "q1", score: 1, note: "手套破損" }],
    missing: null,
  };
  const decoded = decodeFirestoreDoc(encodeFirestoreFields(values));
  if (!eq(decoded, { ...values, at: "2026-11-10T03:00:00.000Z" }))
    throw new Error(`roundtrip 實為 ${JSON.stringify(decoded)}`);
});

// --- 9. 靜態守衛 ---
check("rules：sheetSyncMappings／Runs／State 三集合已加", () => {
  for (const coll of ["sheetSyncMappings", "sheetSyncRuns", "sheetSyncState"]) {
    if (!rules.includes(`match /${coll}/{id}`)) throw new Error(`rules 缺 ${coll}`);
  }
  if (!rules.includes("allow create, update, delete: if isAdmin();"))
    throw new Error("rules 應限管理員寫入對照");
});
check("結果匯入頁：有「連結 Google Sheet」區與欄位對應編輯器", () => {
  if (!resultsPage.includes("連結 Google Sheet")) throw new Error("缺連結區標題");
  if (!resultsPage.includes("SheetSyncSection")) throw new Error("缺 SheetSyncSection");
  if (!resultsPage.includes("importRecordDocId")) throw new Error("手動匯入未改雜湊 ID");
  if (!resultsPage.includes("欄位對應")) throw new Error("缺欄位對應編輯器");
});
check("workflow 檔存在（repo 內，推送時排除、另存供使用者上傳）", () => {
  if (!existsSync(`${ROOT}/.github/workflows/sheet-sync.yml`))
    throw new Error("缺 .github/workflows/sheet-sync.yml");
  const wf = readFileSync(`${ROOT}/.github/workflows/sheet-sync.yml`, "utf8");
  if (!wf.includes('cron: "0 23 * * *"')) throw new Error("cron 應為每日 07:00 台北時間");
  if (!wf.includes("node scripts/sheet-sync.mjs")) throw new Error("workflow 應跑 sheet-sync.mjs");
});

console.log(`\n${pass} passed`);
