/**
 * v1.43.0 斷言測試：移除 Google Sheet 同步＋匯入備註改為最後一題後一個
 * 備註、查詢改為彙整顯示（函式驗證＋靜態守衛，無需 emulator）。
 *
 * 1. 範本：最後一題後一個「備註」欄（所有指標一律如此），備註不計入題數。
 * 2. 解析：新格式單一備註欄寫進最後一題；舊格式（每題「{題目}備註」欄）
 *    各題備註合併進最後一題（單則不加題號、多則每則附題號，再接單一
 *    備註欄內容）；無備註欄檔案仍可匯入。
 * 3. 雜湊：備註先彙整再雜湊，同一內容用新格式或舊格式匯入算出相同文件
 *    ID；備註變了雜湊就變；同一內容兩次同一 ID。
 * 4. 彙整顯示 helper：collectConsolidatedRecordNotes 每筆紀錄彙整為一則
 *    （單則原文、多則附題號），無備註紀錄跳過。
 * 5. 靜態守衛：同步相關檔案與程式皆已移除；手動匯入與去重保留；審查
 *    執行頁（ReviewQuestionList）未動。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "/home/hatch/workspace/repos/QAweb";
const versionTs = readFileSync(`${ROOT}/src/version.ts`, "utf8");
const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));
const rules = readFileSync(`${ROOT}/firestore.rules`, "utf8");
const resultsPage = readFileSync(`${ROOT}/src/features/ResultsPage.tsx`, "utf8");
const importSrc = readFileSync(`${ROOT}/src/lib/import.ts`, "utf8");

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
  "/tmp/v1-43-0-test.ts",
  `export { parseResultSheet, validateResultSheet, resultTemplateRows, sha1Hex, importRecordHash, importRecordDocId, mergeNoteParts } from "${ROOT}/src/lib/import";
export { collectRecordNotes, collectConsolidatedRecordNotes } from "${ROOT}/src/lib/analysisRates";`,
);
await build({
  entryPoints: ["/tmp/v1-43-0-test.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v1-43-0-test.cjs",
  logLevel: "silent",
});
const lib = createRequire("/tmp/v1-43-0-test.cjs")("/tmp/v1-43-0-test.cjs");

// --- 0. 版號 ---
check("版號 1.43.0（version.ts 與 package.json 一致）", () => {
  if (!versionTs.includes('VERSION = "1.43.0"')) throw new Error("version.ts 非 1.43.0");
  if (pkg.version !== "1.43.0") throw new Error(`package.json 為 ${pkg.version}`);
});

// --- 1. SHA-1 標準向量 ---
check("SHA-1：空字串與 abc 標準向量", () => {
  if (lib.sha1Hex("") !== "da39a3ee5e6b4b0d3255bfef95601890afd80709")
    throw new Error(`空字串雜湊為 ${lib.sha1Hex("")}`);
  if (lib.sha1Hex("abc") !== "a9993e364706816aba3e25717850c26c9cd0d89d")
    throw new Error("abc 雜湊不符");
});

// --- 2. 備註彙整規則 ---
check("mergeNoteParts：空／單則原文／多則附題號／無題號接後面", () => {
  if (lib.mergeNoteParts([]) !== "") throw new Error("空應回空字串");
  if (lib.mergeNoteParts([{ questionNo: 1, note: " 原因A " }]) !== "原因A")
    throw new Error("單則應去空白、不加題號");
  if (
    lib.mergeNoteParts([
      { questionNo: 1, note: "A" },
      { questionNo: 2, note: "B" },
    ]) !== "第1題：A；第2題：B"
  )
    throw new Error("多則應每則附題號、以「；」連接");
  if (
    lib.mergeNoteParts([
      { questionNo: 1, note: "A" },
      { questionNo: 0, note: "補充" },
    ]) !== "第1題：A；補充"
  )
    throw new Error("無題號者應直接接在後面");
  if (
    lib.mergeNoteParts([
      { questionNo: 1, note: "" },
      { questionNo: 2, note: "B" },
    ]) !== "B"
  )
    throw new Error("空字串不計入，剩單則應不加題號");
});

// --- 3. 範本：最後一題後一個備註欄 ---
check("範本：固定 6 欄＋每題一欄＋最後一題後一個「備註」欄", () => {
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
      "題二",
      "備註",
    ])
  )
    throw new Error(`範本標題列實為 ${JSON.stringify(rows[0])}`);
  if (!eq(rows[1].slice(6), ["是", "是", ""]))
    throw new Error(`範本範例列實為 ${JSON.stringify(rows[1])}`);
  if (rows[0].filter((h) => h.endsWith("備註")).length !== 1)
    throw new Error("範本應只有一個備註欄");
});

// --- 4. 解析：新格式／舊格式／無備註欄 ---
const ctx = {
  code: "QI-001",
  questionCount: 2,
  unitHas: (c) => ["9A", "9B"].includes(c),
  staffHas: (id) => ["A12345", "B67890"].includes(id),
  staffLoaded: true,
};
const newSheet = [
  ["指標代號", "受審單位", "審查月份", "審查員職編", "受審人員職編", "床號", "題一", "題二", "備註"],
  ["QI-001", "9A", "2026-11", "A12345", "B67890", "9A-01", "是", "否", "未戴口罩"],
  ["QI-001", "9A", "2026-11", "A12345", "B67890", "9A-02", "正確", "不正確", ""],
];
check("解析：新格式單一備註欄寫進最後一題，備註不計入題數", () => {
  const { headerErrors, data } = lib.parseResultSheet(newSheet, {
    questionTitles: ["題一", "題二"],
  });
  if (headerErrors.length > 0) throw new Error(`標題錯誤：${headerErrors}`);
  if (!eq(data[0].answers, ["是", "否"])) throw new Error(`答案實為 ${JSON.stringify(data[0].answers)}`);
  if (!eq(data[0].notes, ["", "未戴口罩"])) throw new Error(`備註實為 ${JSON.stringify(data[0].notes)}`);
  if (!eq(data[1].notes, ["", ""])) throw new Error("空備註應全空");
  const { fileErrors, rows } = lib.validateResultSheet(data, ctx);
  if (fileErrors.length > 0) throw new Error(`檔案錯誤：${fileErrors}`);
  if (!rows[0].ok) throw new Error(`第 1 列應通過：${rows[0].errors}`);
  if (!eq(rows[0].values.notes, ["", "未戴口罩"])) throw new Error("values.notes 應彙整至最後一題");
  if (!eq(rows[0].values.answers, ["是", "否"])) throw new Error("正確／不正確應正規化");
});
const oldSheet = [
  ["指標代號", "受審單位", "審查月份", "審查員職編", "受審人員職編", "床號", "題一", "題一備註", "題二", "題二備註"],
  ["QI-001", "9A", "2026-11", "A12345", "B67890", "9A-01", "是", "手套破損", "否", "未戴口罩"],
  ["QI-001", "9A", "2026-11", "A12345", "B67890", "9A-02", "是", "原因A", "否", ""],
];
check("解析：舊格式各題備註合併進最後一題（多則附題號、單則不加）", () => {
  const { headerErrors, data } = lib.parseResultSheet(oldSheet, {
    questionTitles: ["題一", "題二"],
  });
  if (headerErrors.length > 0) throw new Error(`標題錯誤：${headerErrors}`);
  if (!eq(data[0].notes, ["", "第1題：手套破損；第2題：未戴口罩"]))
    throw new Error(`合併實為 ${JSON.stringify(data[0].notes)}`);
  if (!eq(data[1].notes, ["", "原因A"]))
    throw new Error(`單則合併實為 ${JSON.stringify(data[1].notes)}`);
  const { fileErrors, rows } = lib.validateResultSheet(data, ctx);
  if (fileErrors.length > 0) throw new Error(`檔案錯誤：${fileErrors}`);
  if (!rows[0].ok) throw new Error("舊格式應通過檢核");
});
check("解析：舊格式＋單一備註欄並存時，單一備註內容接在後面", () => {
  const { data } = lib.parseResultSheet(
    [
      ["指標代號", "受審單位", "審查月份", "審查員職編", "受審人員職編", "床號", "題一", "題一備註", "題二", "題二備註", "備註"],
      ["QI-001", "9A", "2026-11", "A12345", "B67890", "9A-01", "是", "A", "否", "B", "補充"],
    ],
    { questionTitles: ["題一", "題二"] },
  );
  if (!eq(data[0].answers, ["是", "否"])) throw new Error("並存時答案應仍為兩題");
  if (!eq(data[0].notes, ["", "第1題：A；第2題：B；補充"]))
    throw new Error(`並存合併實為 ${JSON.stringify(data[0].notes)}`);
});
check("解析：未傳題目時以後綴「備註」判斷舊格式備註欄、單一「備註」欄不誤判為題目", () => {
  const { data } = lib.parseResultSheet(oldSheet);
  if (!eq(data[0].answers, ["是", "否"])) throw new Error("無題目時答案不符");
  if (!eq(data[0].notes, ["", "第1題：手套破損；第2題：未戴口罩"]))
    throw new Error("無題目時合併不符");
  const { data: data2 } = lib.parseResultSheet(newSheet);
  if (!eq(data2[0].answers, ["是", "否"])) throw new Error("無題目時新格式答案不符");
  if (!eq(data2[0].notes, ["", "未戴口罩"])) throw new Error("無題目時新格式備註不符");
});
check("解析：無備註欄檔案仍可匯入，notes 全為空", () => {
  const { headerErrors, data } = lib.parseResultSheet(
    [
      ["指標代號", "受審單位", "審查月份", "審查員職編", "受審人員職編", "床號", "題一", "題二"],
      ["QI-001", "9A", "2026-11", "A12345", "B67890", "9A-01", "是", "否"],
    ],
    { questionTitles: ["題一", "題二"] },
  );
  if (headerErrors.length > 0) throw new Error(`標題錯誤：${headerErrors}`);
  if (!eq(data[0].notes, ["", ""])) throw new Error("無備註欄時 notes 應全空");
  const { fileErrors, rows } = lib.validateResultSheet(data, ctx);
  if (fileErrors.length > 0 || !rows[0].ok) throw new Error("無備註欄檔案應通過檢核");
});

// --- 5. 去重雜湊：新舊格式互通 ---
const identityBase = {
  indicatorId: "G1__QI-001",
  unitCode: "9A",
  year: 2026,
  month: 11,
  reviewerId: "A12345",
  personEmpNo: "B67890",
  bedNo: "9A-01",
  answers: ["是", "否"],
};
check("去重：同一內容兩次同一雜湊、同一文件 ID（import_＋24 字元）", () => {
  const id = { ...identityBase, notes: ["", "未戴口罩"] };
  const h1 = lib.importRecordHash(id);
  const h2 = lib.importRecordHash({ ...id });
  if (h1 !== h2) throw new Error("同一內容雜湊不一致");
  const docId = lib.importRecordDocId(id);
  if (!/^import_[0-9a-f]{24}$/.test(docId)) throw new Error(`文件 ID 格式不符：${docId}`);
  if (docId !== `import_${h1.slice(0, 24)}`) throw new Error("文件 ID 非雜湊前綴");
});
check("去重：新格式與舊格式同一內容算出相同文件 ID（單則備註）", () => {
  const fromNew = lib.importRecordDocId({ ...identityBase, notes: ["", "原因A"] });
  const fromOld = lib.importRecordDocId({ ...identityBase, notes: ["原因A", ""] });
  if (fromNew !== fromOld) throw new Error(`新舊格式文件 ID 不同：${fromNew} vs ${fromOld}`);
});
check("去重：新格式與舊格式同一內容算出相同文件 ID（多則備註）", () => {
  const fromNew = lib.importRecordDocId({
    ...identityBase,
    notes: ["", "第1題：A；第2題：B"],
  });
  const fromOld = lib.importRecordDocId({ ...identityBase, notes: ["A", "B"] });
  if (fromNew !== fromOld) throw new Error(`新舊格式文件 ID 不同：${fromNew} vs ${fromOld}`);
});
check("去重：答案或備註變了雜湊就變（修改可偵測）", () => {
  const base = lib.importRecordHash({ ...identityBase, notes: ["", "未戴口罩"] });
  if (
    lib.importRecordHash({ ...identityBase, answers: ["否", "否"], notes: ["", "未戴口罩"] }) === base
  )
    throw new Error("答案變了雜湊應變");
  if (
    lib.importRecordHash({ ...identityBase, notes: ["", "其他"] }) === base
  )
    throw new Error("備註變了雜湊應變");
});

// --- 6. 彙整顯示 helper ---
const questions = [
  { id: "q1", itemText: "題一" },
  { id: "q2", itemText: "題二" },
];
function rec(empNo, name, answers) {
  return {
    indicatorId: "G1__QI-001",
    unitId: "9A",
    year: 2026,
    month: 11,
    rate: 50,
    personEmpNo: empNo,
    personName: name,
    answers,
  };
}
check("彙整顯示：多題備註附題號、單則原文、無備註跳過、依職編排序", () => {
  const out = lib.collectConsolidatedRecordNotes(
    [
      rec("C11111", "王小明", [
        { questionId: "q1", itemText: "題一", optionLabel: "否", score: 0, note: "手套破損" },
        { questionId: "q2", itemText: "題二", optionLabel: "否", score: 0, note: "未戴口罩" },
      ]),
      rec("B67890", "陳小華", [
        { questionId: "q1", itemText: "題一", optionLabel: "是", score: 1 },
        { questionId: "q2", itemText: "題二", optionLabel: "否", score: 0, note: "原因A" },
      ]),
      rec("D22222", "林大華", [
        { questionId: "q1", itemText: "題一", optionLabel: "是", score: 1 },
        { questionId: "q2", itemText: "題二", optionLabel: "是", score: 1 },
      ]),
    ],
    questions,
  );
  if (out.length !== 2) throw new Error(`應收 2 筆，實為 ${out.length}`);
  if (out[0].personEmpNo !== "B67890") throw new Error("應依職編排序");
  if (out[0].note !== "原因A") throw new Error(`單則應為原文，實為 ${out[0].note}`);
  if (out[1].note !== "第1題：手套破損；第2題：未戴口罩")
    throw new Error(`多則應附題號，實為 ${out[1].note}`);
  if (out[1].parts.length !== 2 || out[1].parts[0].questionNo !== 1)
    throw new Error("parts 應帶題號");
});
check("彙整顯示：舊版 collectRecordNotes 仍保留（相容）", () => {
  const out = lib.collectRecordNotes(
    [
      rec("B67890", "陳小華", [
        { questionId: "q1", itemText: "題一", optionLabel: "是", score: 1 },
        { questionId: "q2", itemText: "題二", optionLabel: "否", score: 0, note: "原因A" },
      ]),
    ],
    questions,
  );
  if (out.length !== 1 || out[0].note !== "原因A") throw new Error("舊 helper 應仍可用");
});

// --- 7. 靜態守衛：同步已移除、手動匯入保留、執行頁未動 ---
check("同步檔案已刪除", () => {
  for (const f of [
    "src/lib/sheetSync.ts",
    "src/lib/sheetBrowser.ts",
    "scripts/sheet-sync.mjs",
    "scripts/sheet-sync-lib.mjs",
    "scripts/test-v1.42.0.mjs",
    "scripts/test-v1.42.1.mjs",
    "scripts/test-v1.42.2.mjs",
    "scripts/test-v1.42.3.mjs",
    "scripts/test-v1.42.4.mjs",
    ".github/workflows/sheet-sync.yml",
  ]) {
    if (existsSync(`${ROOT}/${f}`)) throw new Error(`應已刪除：${f}`);
  }
  if (existsSync("/home/hatch/workspace/your_files/nursing-qi-system/sheet-sync.yml"))
    throw new Error("your_files 的 sheet-sync.yml 副本應已刪除");
});
check("rules：無 sheetSync 相關集合；quota 監測 workflow 未動", () => {
  if (/sheetSync/.test(rules)) throw new Error("rules 仍有 sheetSync");
  if (!rules.includes("match /configs/{id}")) throw new Error("configs 規則應保留");
  // quota-monitor.yml 從未進 repo（在 your_files 待使用者上傳），守衛改查副本
  if (!existsSync("/home/hatch/workspace/your_files/nursing-qi-system/quota-monitor.yml"))
    throw new Error("quota-monitor.yml 副本不應被誤刪");
  if (!existsSync(`${ROOT}/.github/workflows/deploy-firebase.yml`))
    throw new Error("deploy-firebase.yml 不應被誤刪");
});
check("ResultsPage：無同步區／無同步集合／無 5 分鐘文案；手動匯入與去重保留", () => {
  for (const s of ["SheetSyncSection", "sheetSyncMappings", "sheetSyncRuns", "sheetSyncState", "sheetApiKey", "5 分鐘內", "連結 Google Sheet", "列入排程"]) {
    if (resultsPage.includes(s)) throw new Error(`ResultsPage 仍有同步殘留：${s}`);
  }
  if (!resultsPage.includes("importRecordDocId")) throw new Error("手動匯入應保留雜湊去重");
  if (!resultsPage.includes("mergeNoteParts")) throw new Error("應使用 mergeNoteParts 彙整");
  if (!resultsPage.includes("collectConsolidatedRecordNotes"))
    throw new Error("查詢應使用彙整 helper");
  if (!resultsPage.includes("補充說明")) throw new Error("查詢應保留補充說明區");
});
check("import.ts：無同步引用；執行頁 ReviewQuestionList 未動", () => {
  if (/sheet-sync|sheetSync|sheetBrowser/.test(importSrc))
    throw new Error("import.ts 仍有同步引用");
  const execPage = readFileSync(`${ROOT}/src/features/ReviewExecutePage.tsx`, "utf8");
  if (!execPage.includes("ReviewQuestionList")) throw new Error("執行頁應仍用 ReviewQuestionList");
  const ql = readFileSync(`${ROOT}/src/features/ReviewQuestionList.tsx`, "utf8");
  if (!ql.includes("備註")) throw new Error("執行頁每題備註輸入應保留");
});

console.log(`\n${pass} passed`);
