/**
 * v1.40.2 斷言測試：結果分析頁面呈現修正（靜態守衛＋函式驗證，無需 emulator）。
 * 覆蓋：
 * 1. L2「被審人員各選項結果」橫向標頭為「職編/遮罩姓名」（半形斜線；組別分析與
 *    單位分析共用同一個 DrillModal＋transposePersonOptionRows，一處改動兩處生效）：
 *    有職編＋姓名 →「1130142/王O明」；無姓名 → 只顯示職編；無職編 → 只顯示遮罩姓名
 * 2. 審查結果管理（ReviewResultManager）：審查人員欄顯示「職編/遮罩姓名」，
 *    職編取自 reviewerEmpNo（無則取 reviewerId），姓名以共用 maskName 遮罩
 * 3. 病歷號改用床號（使用者 2026-11-10 決定）：資料模型無病歷號欄位，
 *    L2 表頭下行顯示該欄對應紀錄的床號（bedNo），無床號留空；
 *    每欄＝一筆紀錄，同一人多筆紀錄各列一欄、床號各跟各的
 * 4. 版號一致：src/version.ts 與 package.json 皆為 1.40.2
 */
import { createRequire } from "node:module";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "/home/hatch/workspace/repos/QAweb";
const ratesSrc = readFileSync(`${ROOT}/src/lib/analysisRates.ts`, "utf8");
const resultsSrc = readFileSync(`${ROOT}/src/features/ResultsPage.tsx`, "utf8");
const reviewRecordsSrc = readFileSync(`${ROOT}/src/lib/reviewRecords.ts`, "utf8");
const versionTs = readFileSync(`${ROOT}/src/version.ts`, "utf8");
const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));

let pass = 0;
function check(name, fn) {
  fn();
  pass++;
  console.log(`ok - ${name}`);
}

// --- 1a. L2 標頭格式（靜態） ---
check("L2 標頭用半形斜線「職編/遮罩姓名」", () => {
  if (!ratesSrc.includes("`${r.personEmpNo}/${maskedName}`"))
    throw new Error("找不到半形斜線的標頭格式");
  if (ratesSrc.includes("`${r.personEmpNo}／${maskedName}`"))
    throw new Error("仍有全形斜線的舊標頭格式");
});
check("L2 標頭重用共用 maskName（analysisRates.ts）", () => {
  if (!ratesSrc.includes('import { maskName } from "./mask"'))
    throw new Error("未 import 共用 maskName");
});

// --- 1b. L2 標頭格式（函式驗證） ---
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
  "/tmp/v1-40-2-test.ts",
  `export { transposePersonOptionRows } from "${ROOT}/src/lib/analysisRates";`,
);
await build({
  entryPoints: ["/tmp/v1-40-2-test.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v1-40-2-test.cjs",
  logLevel: "silent",
});
const lib = createRequire("/tmp/v1-40-2-test.cjs")("/tmp/v1-40-2-test.cjs");
const row = (personEmpNo, personName, bedNo = "") => ({
  personEmpNo,
  personName,
  bedNo,
  year: 2026,
  month: 9,
  rate: 90,
  passing: true,
  answers: new Map(),
});
check("L2 標頭：有職編＋姓名 → 1130142/王O明", () => {
  const m = lib.transposePersonOptionRows([row("1130142", "王小明")], []);
  if (m.headers[0] !== "1130142/王O明") throw new Error(`實為 ${m.headers[0]}`);
});
check("L2 標頭：無姓名 → 只顯示職編（無空斜線）", () => {
  const m = lib.transposePersonOptionRows([row("1130142", "")], []);
  if (m.headers[0] !== "1130142") throw new Error(`實為 ${m.headers[0]}`);
});
check("L2 標頭：無職編 → 只顯示遮罩姓名", () => {
  const m = lib.transposePersonOptionRows([row("", "王小明")], []);
  if (m.headers[0] !== "王O明") throw new Error(`實為 ${m.headers[0]}`);
});
check("L2 標頭：兩字名／四字名遮罩規則不變", () => {
  const m = lib.transposePersonOptionRows(
    [row("E001", "王明"), row("E002", "歐陽小明")],
    [],
  );
  if (m.headers[0] !== "E001/王O" || m.headers[1] !== "E002/歐OO明")
    throw new Error(`實為 ${JSON.stringify(m.headers)}`);
});

// --- 1c. 床號下行：接線（靜態） ---
check("ReviewRecord 資料模型無病歷號欄位（只有床號 bedNo）", () => {
  if (/chartNo|medicalRecord|patientId|病歷號/i.test(reviewRecordsSrc))
    throw new Error("資料模型出現病歷號相關欄位，與預期不符");
  if (!reviewRecordsSrc.includes("bedNo"))
    throw new Error("床號欄位消失，檢查資料模型是否被誤改");
});
check("L2 床號接線：AnalysisRecord／PersonOptionRow／transpose 皆帶 bedNo", () => {
  if (!ratesSrc.includes("bedNo?: string;"))
    throw new Error("AnalysisRecord 缺 bedNo");
  if (!ratesSrc.includes("bedNo: string;"))
    throw new Error("PersonOptionRow 缺 bedNo");
  if (!ratesSrc.includes('bedNos: rows.map((r) => r.bedNo ?? "")'))
    throw new Error("transpose 未回傳 bedNos");
  if (!ratesSrc.includes('bedNo: r.bedNo ?? ""'))
    throw new Error("personOptionRows 未帶 bedNo");
});
check("ResultsPage 兩處 AnalysisRecord 建構皆帶 bedNo（Firestore 載入＋下探明細）", () => {
  const uses =
    resultsSrc.match(
      /bedNo: typeof (v|value)\.bedNo === "string" \? \1\.bedNo : ""/g,
    ) ?? [];
  if (uses.length !== 2) throw new Error(`bedNo 接線 ${uses.length} 處，應為 2 處`);
});
check("DrillModal 表頭兩行：上行職編/姓名、下行床號（無床號留空）", () => {
  if (!resultsSrc.includes("<div>{h}</div>"))
    throw new Error("表頭上行未渲染");
  if (!resultsSrc.includes('<div>{l2Matrix.bedNos[i] ?? ""}</div>'))
    throw new Error("表頭下行未渲染床號");
});

// --- 1d. 床號下行（函式驗證） ---
check("L2 床號下行：有床號顯示該床號、無床號留空", () => {
  const m = lib.transposePersonOptionRows(
    [row("1130142", "王小明", "12A"), row("1130143", "李大華")],
    [],
  );
  if (m.bedNos[0] !== "12A" || m.bedNos[1] !== "")
    throw new Error(`實為 ${JSON.stringify(m.bedNos)}`);
});
check("L2 床號跟著對應紀錄走：同一人兩筆紀錄床號各跟各的", () => {
  const m = lib.transposePersonOptionRows(
    [row("1130142", "王小明", "12A"), row("1130142", "王小明", "15B")],
    [],
  );
  if (JSON.stringify(m.bedNos) !== JSON.stringify(["12A", "15B"]))
    throw new Error(`實為 ${JSON.stringify(m.bedNos)}`);
  if (m.headers[0] !== m.headers[1])
    throw new Error("同一人兩欄標頭應相同、只差床號");
});

// --- 2. 審查結果管理：審查人員「職編/遮罩姓名」 ---
check("ReviewResultManager 取 reviewerEmpNo（無則取 reviewerId）", () => {
  if (
    !resultsSrc.includes(
      'reviewerEmpNo: String(value.reviewerEmpNo ?? value.reviewerId ?? "")',
    )
  )
    throw new Error("找不到 reviewerEmpNo 取值");
});
check("審查人員欄用 staffLabel（職編/遮罩姓名）顯示", () => {
  if (!resultsSrc.includes("{staffLabel(row.reviewerEmpNo, row.reviewerName)}"))
    throw new Error("審查人員欄未改用 staffLabel");
  if (resultsSrc.includes("<td>{row.reviewerName ||"))
    throw new Error("仍有舊的 reviewerName 直顯");
});
check("staffLabel 用共用 maskName 遮罩、姓名與職編相同時只顯示職編", () => {
  const mgr = resultsSrc.slice(resultsSrc.indexOf("function staffLabel"));
  if (!mgr.includes("maskName(name)")) throw new Error("未用 maskName");
  if (!mgr.includes("name !== empNo")) throw new Error("缺少姓名＝職編的防呆");
  if (!mgr.includes("`${empNo}/${masked}`")) throw new Error("格式不是 職編/遮罩姓名");
});
check("ResultsPage 引用共用 maskName（非自寫遮罩）", () => {
  if (!resultsSrc.includes('import { maskName } from "../lib/mask"'))
    throw new Error("未 import 共用 maskName");
});

// --- 5. 「未審月份不顯示」核取方塊（v1.40.2 新增） ---
check("核取方塊文字為「未審月份不顯示」，預設不勾選", () => {
  if (!resultsSrc.includes("未審月份不顯示")) throw new Error("找不到核取方塊文字");
  if (!resultsSrc.includes('const [hideEmptyMonths, setHideEmptyMonths] = useState(false)'))
    throw new Error("預設值不是不勾選");
  if (!resultsSrc.includes('type="checkbox"')) throw new Error("不是核取方塊");
  if (!resultsSrc.includes("checked={hideEmptyMonths}")) throw new Error("未綁定 hideEmptyMonths");
});
check("核取方塊在共用篩選區：區間單位之後、查詢按鈕之前", () => {
  const filters = resultsSrc.slice(resultsSrc.indexOf("results-analysis-filters"));
  const intervalAt = filters.indexOf('label="區間單位"');
  const boxAt = filters.indexOf("未審月份不顯示");
  const queryAt = filters.indexOf("results-query-actions");
  if (intervalAt < 0 || boxAt < 0 || queryAt < 0) throw new Error("篩選區缺少元件");
  if (!(intervalAt < boxAt && boxAt < queryAt)) throw new Error("核取方塊位置不在區間單位與查詢按鈕之間");
});
check("組別／單位矩陣皆改用 visibleColumns（共 2 處），無殘留 appliedColumns", () => {
  const uses = resultsSrc.match(/columns=\{visibleColumns\}/g) ?? [];
  if (uses.length !== 2) throw new Error(`visibleColumns 使用 ${uses.length} 處，應為 2 處`);
  if (resultsSrc.includes("columns={appliedColumns}")) throw new Error("仍有矩陣用 appliedColumns");
});
check("可見欄位只影響矩陣：allMonths 與曲線圖仍用 appliedColumns", () => {
  if (!resultsSrc.includes("appliedColumns.flatMap((c) => c.months)"))
    throw new Error("allMonths 被改動");
  if (!resultsSrc.includes("for (const col of appliedColumns)"))
    throw new Error("曲線圖欄位來源被改動");
});

// --- 5b. 欄位計數與篩選（函式驗證） ---
writeFileSync(
  "/tmp/v1-40-2-cols-test.ts",
  `export { buildRecordIndex, columnRecordCount } from "${ROOT}/src/lib/resultsMatrix";\nexport { expandMonthRangeColumns } from "${ROOT}/src/lib/analysisPeriod";`,
);
await build({
  entryPoints: ["/tmp/v1-40-2-cols-test.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v1-40-2-cols-test.cjs",
  logLevel: "silent",
});
const colsLib = createRequire("/tmp/v1-40-2-cols-test.cjs")("/tmp/v1-40-2-cols-test.cjs");
const mkRec2 = (indicatorId, unitId, year, month) => ({
  indicatorId,
  unitId,
  year,
  month,
  rate: 90,
  answers: [],
  personEmpNo: "E001",
  personName: "王小明",
});
const idx = colsLib.buildRecordIndex([
  mkRec2("ind-1", "U1", 2026, 2),
  mkRec2("ind-2", "U2", 2026, 3),
]);
const monthCols = colsLib.expandMonthRangeColumns("2026-01", "2026-03", "month");
check("未勾選顯示全部月份（3 欄皆保留）", () => {
  if (monthCols.length !== 3) throw new Error(`欄數為 ${monthCols.length}`);
});
check("勾選隱藏零審查月份、保留有審查月份（1 月隱藏、2／3 月顯示）", () => {
  const kept = monthCols.filter(
    (c) => colsLib.columnRecordCount(idx, ["ind-1", "ind-2"], c.months) > 0,
  );
  if (JSON.stringify(kept.map((c) => c.label)) !== JSON.stringify(["2026/2", "2026/3"]))
    throw new Error(`保留欄位為 ${JSON.stringify(kept.map((c) => c.label))}`);
});
check("單位範圍：只計該單位的審查（U1 在 3 月為 0 → 隱藏）", () => {
  const mar = monthCols.find((c) => c.label === "2026/3");
  if (colsLib.columnRecordCount(idx, ["ind-1", "ind-2"], mar.months, "U1") !== 0)
    throw new Error("U1 在 3 月應為 0 筆");
  if (colsLib.columnRecordCount(idx, ["ind-1", "ind-2"], mar.months, "U2") !== 1)
    throw new Error("U2 在 3 月應為 1 筆");
});
check("區間單位為季時同理：Q1 有審查保留、Q2 零審查隱藏", () => {
  const qCols = colsLib.expandMonthRangeColumns("2026-01", "2026-06", "quarter");
  const kept = qCols.filter(
    (c) => colsLib.columnRecordCount(idx, ["ind-1", "ind-2"], c.months) > 0,
  );
  if (kept.length !== 1 || !kept[0].label.includes("1-3"))
    throw new Error(`保留的季欄為 ${JSON.stringify(kept.map((c) => c.label))}`);
});
check("半年／年區間：區間內有一筆就算有審查", () => {
  const halfCols = colsLib.expandMonthRangeColumns("2026-01", "2026-12", "halfYear");
  const counts = halfCols.map((c) => colsLib.columnRecordCount(idx, ["ind-1", "ind-2"], c.months));
  if (JSON.stringify(counts) !== JSON.stringify([2, 0]))
    throw new Error(`半年計數為 ${JSON.stringify(counts)}`);
});

// --- 6. 版號一致 ---
check("版號一致：version.ts 與 package.json 皆為 1.40.2", () => {
  if (!versionTs.includes('VERSION = "1.40.2"')) throw new Error("version.ts 不是 1.40.2");
  if (pkg.version !== "1.40.2") throw new Error(`package.json 為 ${pkg.version}`);
});

console.log(`PASS: v1.40.2 assertions (${pass} checks)`);
