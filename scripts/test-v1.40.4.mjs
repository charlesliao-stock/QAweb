/**
 * v1.40.4 斷言測試：結果匯入配合 Google 表單 3 項調整（函式驗證＋靜態守衛，無需 emulator）。
 *
 * 1. 審查月份接受 YYYY/MM/DD（日忽略），自動轉為 YYYY-MM；同時保留
 *    YYYY-MM / YYYY/MM / YYYY.MM；Excel 日期序列（5 位數字）與 Date 物件
 *    亦可解析；無法解析維持逐列報錯，不靜默跳過。
 * 2. 審查結果選項「正確」＝「是」、「不正確」＝「否」；是／否／不適用不變；
 *    前後空白（含全形空白）先去除再比對；驗證通過的列 answers 已正規化。
 * 3. 範本表頭「審查員」→「審查員職編」；匯入同時接受新舊表頭。
 */
import { createRequire } from "node:module";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "/home/hatch/workspace/repos/QAweb";
const importSrc = readFileSync(`${ROOT}/src/lib/import.ts`, "utf8");
const versionTs = readFileSync(`${ROOT}/src/version.ts`, "utf8");
const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));

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
  "/tmp/v1-40-4-test.ts",
  `export { parseReviewMonth, normalizeResultAnswer, normalizeSheetRows, parseResultSheet, validateResultSheet, resultTemplateRows, RESULT_FIXED_HEADERS } from "${ROOT}/src/lib/import";`,
);
await build({
  entryPoints: ["/tmp/v1-40-4-test.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v1-40-4-test.cjs",
  logLevel: "silent",
});
const lib = createRequire("/tmp/v1-40-4-test.cjs")("/tmp/v1-40-4-test.cjs");

// --- 1. 月份：YYYY/MM/DD → YYYY-MM ---
check("月份 2026/11/05 → 2026-11", () => {
  if (!eq(lib.parseReviewMonth("2026/11/05"), { year: 2026, month: 11 }))
    throw new Error("2026/11/05 解析失敗");
});
check("月份 2026/11/5（單數日）→ 2026-11", () => {
  if (!eq(lib.parseReviewMonth("2026/11/5"), { year: 2026, month: 11 }))
    throw new Error("2026/11/5 解析失敗");
});
check("月份 2026-11-30 / 2026.11.05 → 2026-11", () => {
  if (!eq(lib.parseReviewMonth("2026-11-30"), { year: 2026, month: 11 }))
    throw new Error("2026-11-30 解析失敗");
  if (!eq(lib.parseReviewMonth("2026.11.05"), { year: 2026, month: 11 }))
    throw new Error("2026.11.05 解析失敗");
});
check("月份既有格式維持：2026-11 / 2026/11 / 2026.11", () => {
  for (const s of ["2026-11", "2026/11", "2026.11"]) {
    if (!eq(lib.parseReviewMonth(s), { year: 2026, month: 11 }))
      throw new Error(`${s} 解析失敗`);
  }
});
check("月份 Excel 序列 46331（2026-11-05）→ 2026-11", () => {
  if (!eq(lib.parseReviewMonth("46331"), { year: 2026, month: 11 }))
    throw new Error("序列 46331 解析失敗");
  if (!eq(lib.parseReviewMonth("46327"), { year: 2026, month: 11 }))
    throw new Error("序列 46327（2026-11-01）解析失敗");
});
check("月份 Date 物件經 normalizeSheetRows → YYYY-MM-DD 字串", () => {
  const rows = lib.normalizeSheetRows([[new Date(2026, 10, 5), "x"]]);
  if (rows[0][0] !== "2026-11-05") throw new Error(`實為 ${rows[0][0]}`);
  if (!eq(lib.parseReviewMonth(rows[0][0]), { year: 2026, month: 11 }))
    throw new Error("Date 轉出的字串無法解析");
});
check("月份無法解析仍回傳 null：2026-13 / 2026/11/32 / 2026-02-31 / abc / 空白", () => {
  for (const s of ["2026-13", "2026/11/32", "2026-02-31", "abc", "", "123"]) {
    if (lib.parseReviewMonth(s) !== null)
      throw new Error(`${s || "（空白）"} 應為 null`);
  }
});

// --- 2. 答案：正確＝是、不正確＝否 ---
check("答案 正確→是、不正確→否、是／否／不適用不變", () => {
  if (lib.normalizeResultAnswer("正確") !== "是") throw new Error("正確未對應是");
  if (lib.normalizeResultAnswer("不正確") !== "否") throw new Error("不正確未對應否");
  if (lib.normalizeResultAnswer("是") !== "是") throw new Error("是變了");
  if (lib.normalizeResultAnswer("否") !== "否") throw new Error("否變了");
  if (lib.normalizeResultAnswer("不適用") !== "不適用") throw new Error("不適用變了");
});
check("答案先 trim（含全形空白）再比對、未知回傳 null", () => {
  if (lib.normalizeResultAnswer(" 是 ") !== "是") throw new Error("半形空白未處理");
  if (lib.normalizeResultAnswer("　否　") !== "否") throw new Error("全形空白未處理");
  if (lib.normalizeResultAnswer("也許") !== null) throw new Error("未知答案應為 null");
  if (lib.normalizeResultAnswer("") !== null) throw new Error("空白應為 null");
});
check("validateResultSheet：正確／不正確正規化存入，月份 2026/11/05 通過", () => {
  const { headerErrors, data } = lib.parseResultSheet([
    ["指標代號", "受審單位", "審查月份", "審查員職編", "受審人員職編", "床號", "題1", "題2", "題3", "題4", "題5", "題6"],
    ["QI-001", "9A", "2026/11/05", "A12345", "B67890", "9A-01", "正確", "不正確", "是", "否", "不適用", ""],
  ]);
  if (headerErrors.length > 0) throw new Error(`標題錯誤：${headerErrors}`);
  const { fileErrors, rows } = lib.validateResultSheet(data, {
    code: "QI-001",
    questionCount: 6,
    unitHas: () => true,
    staffHas: () => true,
    staffLoaded: true,
  });
  if (fileErrors.length > 0) throw new Error(`檔案錯誤：${fileErrors}`);
  if (!rows[0].ok) throw new Error(`列應通過：${rows[0].errors}`);
  const v = rows[0].values;
  if (v.year !== 2026 || v.month !== 11) throw new Error(`年月實為 ${v.year}-${v.month}`);
  if (!eq(v.answers, ["是", "否", "是", "否", "不適用", ""]))
    throw new Error(`答案實為 ${JSON.stringify(v.answers)}`);
});
check("validateResultSheet：錯誤答案逐列報錯並列出 正確＝是、不正確＝否", () => {
  const { data } = lib.parseResultSheet([
    ["指標代號", "受審單位", "審查月份", "審查員職編", "受審人員職編", "床號", "題1"],
    ["QI-001", "9A", "2026-11", "A12345", "B67890", "9A-01", "也許"],
    ["QI-001", "9A", "2026-13", "A12345", "B67890", "9A-01", "是"],
  ]);
  const { rows } = lib.validateResultSheet(data, {
    code: "QI-001",
    questionCount: 1,
    unitHas: () => true,
    staffHas: () => true,
    staffLoaded: true,
  });
  if (rows[0].ok) throw new Error("錯誤答案的列應失敗");
  if (!rows[0].errors.join("").includes("正確＝是"))
    throw new Error(`錯誤訊息未列出對應：${rows[0].errors}`);
  if (rows[1].ok) throw new Error("月份 2026-13 的列應失敗");
});

// --- 3. 範本表頭：審查員 → 審查員職編，新舊皆可匯入 ---
check("範本表頭第 4 欄為「審查員職編」", () => {
  if (!lib.RESULT_FIXED_HEADERS.includes("審查員職編"))
    throw new Error("RESULT_FIXED_HEADERS 無審查員職編");
  if (lib.RESULT_FIXED_HEADERS.includes("審查員"))
    throw new Error("RESULT_FIXED_HEADERS 仍有舊表頭「審查員」");
  const rows = lib.resultTemplateRows("QI-001", ["題1"]);
  if (rows[0][3] !== "審查員職編") throw new Error(`範本第 4 欄實為 ${rows[0][3]}`);
});
check("舊表頭「審查員」仍可匯入（相容）", () => {
  const { headerErrors, data } = lib.parseResultSheet([
    ["指標代號", "受審單位", "審查月份", "審查員", "受審人員職編", "床號", "題1"],
    ["QI-001", "9A", "2026-11", "A12345", "B67890", "9A-01", "是"],
  ]);
  if (headerErrors.length > 0) throw new Error(`舊表頭被拒：${headerErrors}`);
  if (data[0].reviewerId !== "A12345") throw new Error("舊表頭審查員職編未解析");
});
check("新表頭「審查員職編」可匯入", () => {
  const { headerErrors, data } = lib.parseResultSheet([
    ["指標代號", "受審單位", "審查月份", "審查員職編", "受審人員職編", "床號", "題1"],
    ["QI-001", "9A", "2026-11", "A12345", "B67890", "9A-01", "是"],
  ]);
  if (headerErrors.length > 0) throw new Error(`新表頭被拒：${headerErrors}`);
  if (data[0].reviewerId !== "A12345") throw new Error("新表頭審查員職編未解析");
});
check("import.ts 無殘留舊錯誤訊息「格式須為 2026-11」", () => {
  if (importSrc.includes("格式須為 2026-11"))
    throw new Error("仍有舊月份錯誤訊息");
});

// --- 4. 版號一致 ---
check("版號一致：version.ts 與 package.json 皆為 1.40.4", () => {
  if (!versionTs.includes('VERSION = "1.40.4"'))
    throw new Error("version.ts 不是 1.40.4");
  if (pkg.version !== "1.40.4")
    throw new Error(`package.json 是 ${pkg.version}`);
});

console.log(`\n${pass} passed`);
