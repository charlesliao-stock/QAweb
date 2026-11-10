/**
 * v1.43.1 斷言測試：結果匯入指標下拉無法選擇——診斷與覆蓋
 * （函式驗證＋靜態守衛，無需 emulator）。
 *
 * 背景（使用者回報）：結果分析 → 結果匯入，只能選組別，指標無法下拉。
 * 查證結論：下拉本身沒有 disabled，下拉選項就是過濾結果；v1.43.0 的
 * diff 只移除了 isAdmin prop，過濾邏輯自 v1.21.0 未變；以 demo 種子
 * 資料（groupId g-ward、狀態「啟用」）驗證過濾正確。為空只可能是
 * 資料面——尚未載入、沒有啟用指標、或所選組別沒有啟用指標。
 * 本版把過濾抽成純函式（filterImportIndicators）並在下拉為空時顯示
 * 診斷提示（importIndicatorEmptyHint），不再靜默空白。
 *
 * 1. 過濾：選組別只出現該組別啟用指標；不選組別列全部啟用指標；
 *    非啟用一律排除。
 * 2. 提示：三種為空原因各有對應提示；有選項時不提示。
 * 3. 靜態守衛：ResultsPage 使用純函式＋傳 indicatorsLoaded＋渲染
 *    提示；.field-hint 樣式存在（淺色＋深色）；版號 1.43.1。
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "/home/hatch/workspace/repos/QAweb";
const versionTs = readFileSync(`${ROOT}/src/version.ts`, "utf8");
const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));
const resultsPage = readFileSync(`${ROOT}/src/features/ResultsPage.tsx`, "utf8");
const stylesCss = readFileSync(`${ROOT}/src/styles.css`, "utf8");

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
  "/tmp/v1-43-1-test.ts",
  `export { filterImportIndicators, importIndicatorEmptyHint } from "${ROOT}/src/lib/import";`,
);
await build({
  entryPoints: ["/tmp/v1-43-1-test.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v1-43-1-test.cjs",
  logLevel: "silent",
});
const lib = createRequire("/tmp/v1-43-1-test.cjs")("/tmp/v1-43-1-test.cjs");

// --- 0. 版號 ---
check("版號 1.43.1（version.ts 與 package.json 一致）", () => {
  if (!versionTs.includes('VERSION = "1.43.1"')) throw new Error("version.ts 非 1.43.1");
  if (pkg.version !== "1.43.1") throw new Error(`package.json 為 ${pkg.version}`);
});

// 測試資料：A 組兩支啟用＋一支草稿，B 組一支啟用；另有一支 groupId 為空的啟用指標。
const INDICATORS = [
  { id: "g-a__QI-001", status: "啟用", groupId: "g-a" },
  { id: "g-a__QI-002", status: "啟用", groupId: "g-a" },
  { id: "g-a__QI-003", status: "草稿", groupId: "g-a" },
  { id: "g-b__QI-001", status: "啟用", groupId: "g-b" },
  { id: "g-b__QI-002", status: "停用", groupId: "g-b" },
  { id: "orphan__QI-009", status: "啟用", groupId: "" },
];

// --- 1. 過濾：回報情境「選了組別後，指標下拉出現該組別的啟用指標」 ---
check("選組別 g-a：只出現該組別兩支啟用指標，草稿排除、他組排除", () => {
  const got = lib.filterImportIndicators(INDICATORS, "g-a").map((i) => i.id);
  if (!eq(got, ["g-a__QI-001", "g-a__QI-002"]))
    throw new Error(`實為 ${JSON.stringify(got)}`);
});
check("選組別 g-b：只出現該組別一支啟用指標，停用排除", () => {
  const got = lib.filterImportIndicators(INDICATORS, "g-b").map((i) => i.id);
  if (!eq(got, ["g-b__QI-001"])) throw new Error(`實為 ${JSON.stringify(got)}`);
});
check("不選組別（全部組別）：列出全部四支啟用指標，草稿／停用排除", () => {
  const got = lib.filterImportIndicators(INDICATORS, "").map((i) => i.id);
  if (
    !eq(got, ["g-a__QI-001", "g-a__QI-002", "g-b__QI-001", "orphan__QI-009"])
  )
    throw new Error(`實為 ${JSON.stringify(got)}`);
});
check("demo 種子形狀（g-ward、啟用）可被列出：過濾邏輯與一致資料相容", () => {
  const demo = [
    { id: "g-ward__QI-001", status: "啟用", groupId: "g-ward" },
    { id: "g-ward__QI-002", status: "啟用", groupId: "g-ward" },
  ];
  const got = lib.filterImportIndicators(demo, "g-ward").map((i) => i.id);
  if (!eq(got, ["g-ward__QI-001", "g-ward__QI-002"]))
    throw new Error(`實為 ${JSON.stringify(got)}`);
});

// --- 2. 提示：三種為空原因各有對應提示；有選項不提示 ---
check("提示：指標清單為空 → 載入／確認資料", () => {
  const hint = lib.importIndicatorEmptyHint([], "g-a");
  if (!hint || !hint.includes("尚未載入任何指標資料"))
    throw new Error(`實為 ${JSON.stringify(hint)}`);
});
check("提示：有指標但無任何啟用 → 到指標管理設為啟用", () => {
  const hint = lib.importIndicatorEmptyHint(
    [
      { id: "x1", status: "草稿", groupId: "g-a" },
      { id: "x2", status: "停用", groupId: "g-b" },
    ],
    "",
  );
  if (!hint || !hint.includes("尚無「啟用」狀態的指標"))
    throw new Error(`實為 ${JSON.stringify(hint)}`);
});
check("提示：有啟用指標但所選組別沒有 → 確認組別與狀態、或改選全部組別", () => {
  const hint = lib.importIndicatorEmptyHint(INDICATORS, "g-none");
  if (!hint || !hint.includes("該組別尚無啟用指標"))
    throw new Error(`實為 ${JSON.stringify(hint)}`);
});
check("提示：有選項時不提示（選組別／不選組別皆然）", () => {
  if (lib.importIndicatorEmptyHint(INDICATORS, "g-a") !== null)
    throw new Error("選 g-a 有選項卻回提示");
  if (lib.importIndicatorEmptyHint(INDICATORS, "") !== null)
    throw new Error("不選組別有選項卻回提示");
});

// --- 3. 靜態守衛 ---
check("ResultsPage：匯入面板用純函式過濾＋傳 indicatorsLoaded＋渲染提示", () => {
  if (!resultsPage.includes("filterImportIndicators(indicators, selGroup)"))
    throw new Error("應使用 filterImportIndicators 過濾");
  if (!resultsPage.includes("importIndicatorEmptyHint(indicators, selGroup)"))
    throw new Error("應使用 importIndicatorEmptyHint 診斷");
  if (!resultsPage.includes("indicatorsLoaded={metaLoaded}"))
    throw new Error("應傳 indicatorsLoaded");
  if (!resultsPage.includes("setMetaLoaded(true)"))
    throw new Error("應在參考資料載入完成後設 metaLoaded");
  if (!resultsPage.includes('<p className="field-hint">{indicatorHint}</p>'))
    throw new Error("應在指標下拉下方渲染提示");
  if (!resultsPage.includes("const [metaLoaded, setMetaLoaded]"))
    throw new Error("應有 metaLoaded state");
});
check("styles.css：.field-hint 存在（淺色＋深色）", () => {
  if (!stylesCss.includes(".field-hint {")) throw new Error("缺 .field-hint");
  if (!stylesCss.includes(':root[data-mode="dark"] .field-hint'))
    throw new Error("缺深色 .field-hint");
});

console.log(`\n${pass} passed`);
