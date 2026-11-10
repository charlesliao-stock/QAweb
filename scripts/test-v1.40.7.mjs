/**
 * v1.40.7 斷言測試：結果分析捲動時固定篩選器與表格標頭（靜態守衛，無需 emulator）。
 *
 * 背景：結果分析的指標多，查詢結果需上下捲動，篩選器與矩陣標頭（到月份欄位）
 * 會跟著捲走。頁面為視窗捲動（.main-area 無 overflow；.topbar 樣式已無任何
 * 元件使用，頁面頂部只有 PageHeading＋頁籤），所以篩選器 sticky top 取 0。
 * 矩陣包在 .analysis-table-wrap（overflow-x: auto）內，thead 無法相對視窗
 * sticky，改以 max-height 讓表格區內部捲動、thead 在包層內固定。
 *
 * 本版修正（純 CSS＋版號，ResultsPage.tsx 不動）：
 * - 分析頁籤與審查結果管理的篩選器區 sticky top: 0、不透明背景、底部分隔線，
 *   全幅延伸（負邊距對齊 .page-content 內距，1180px／760px 各有對應值）。
 * - .analysis-table-wrap 加 max-height（100vh-250px）＋overflow auto；
 *   thead th sticky top: 0、不透明背景、底部分隔線；指標欄角落 z-index 4；
 *   深色模式 thead 背景 override。
 * - 下探彈窗內的表格包層 max-height 100dvh-330px；L2 表格橫向捲動時第一欄
 *   （題目）sticky left＋不透明背景。
 * - 矩陣第一欄（指標名稱）橫向固定本就存在（.analysis-matrix th.ind-col
 *   sticky left），本版不動，僅補上 thead 的 top 固定。
 * 覆蓋：
 * 1. topbar 確實無元件使用（sticky top: 0 的前提）
 * 2. 分析篩選器 sticky（top 0、z-index、不透明背景、底部分隔線、全幅）
 * 3. 審查結果管理篩選器同樣 sticky
 * 4. 1180px／760px 斷點的內距對應值
 * 5. 表格包層 max-height＋overflow auto
 * 6. thead th sticky top: 0、不透明背景、底部分隔線
 * 7. 指標欄角落 z-index 4
 * 8. 深色模式 thead 背景 override
 * 9. 彈窗表格包層 max-height
 * 10. 彈窗 L2 第一欄 sticky left＋不透明背景
 * 11. 固定規則只在 .results-page 作用域內（未動全站 .data-table）
 * 12. 版號一致：src/version.ts 與 package.json 皆為 1.40.7
 */
import { readFileSync } from "node:fs";

const ROOT = "/home/hatch/workspace/repos/QAweb";
const read = (p) => readFileSync(`${ROOT}/${p}`, "utf8");
const css = read("src/styles.css");
const versionTs = read("src/version.ts");
const pkg = JSON.parse(read("package.json"));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`ok - ${name}`);
  } catch (err) {
    fail++;
    console.log(`FAIL - ${name}: ${err.message}`);
  }
}

function expectContains(haystack, needle, message) {
  if (!haystack.includes(needle)) throw new Error(message ?? `缺少：${needle}`);
}

// 取 v1.40.7 區塊（自標記註解起，至下一個 @media(1180px) 之前不含 media 覆寫）
const blockStart = css.indexOf("/* v1.40.7：結果分析捲動時固定篩選器與表格標頭");
if (blockStart === -1) throw new Error("找不到 v1.40.7 CSS 區塊");
const block = css.slice(blockStart);

// --- 1. topbar 確實無元件使用（sticky top: 0 的前提）---
check("topbar 無元件使用：TSX 內無 className topbar", () => {
  const tsxFiles = ["src/app/App.tsx", "src/features/ResultsPage.tsx", "src/components/ui.tsx"];
  for (const f of tsxFiles) {
    if (read(f).includes("topbar")) throw new Error(`${f} 仍有 topbar`);
  }
});

// --- 2. 分析篩選器 sticky ---
check("分析篩選器 sticky top: 0、不透明背景、底部分隔線、全幅", () => {
  expectContains(block, ".results-page .results-filters.results-analysis-filters,");
  expectContains(block, "position: sticky;");
  expectContains(block, "top: 0;");
  expectContains(block, "z-index: 15;");
  expectContains(block, "background: var(--bg);");
  expectContains(block, "margin: 0 -34px 16px;");
  expectContains(block, "padding: 12px 34px;");
  expectContains(block, "border-bottom: 1px solid var(--line, #e6ebec);");
});

// --- 3. 審查結果管理篩選器同樣 sticky ---
check("審查結果管理篩選器同樣 sticky", () => {
  expectContains(block, ".results-page .review-results-manager .results-filters {");
});

// --- 4. 斷點內距對應值 ---
check("1180px／760px 斷點的篩選器內距對應 .page-content", () => {
  expectContains(block, "margin: 0 -25px 16px;");
  expectContains(block, "padding: 12px 25px;");
  expectContains(block, "margin: 0 -15px 16px;");
  expectContains(block, "padding: 10px 15px;");
});

// --- 5. 表格包層 max-height＋overflow auto ---
check("表格包層 max-height＋overflow auto（內部捲動）", () => {
  expectContains(block, ".results-page .analysis-table-wrap {");
  expectContains(block, "max-height: calc(100vh - 250px);");
  expectContains(block, "overflow: auto;");
});

// --- 6. thead th sticky top: 0、不透明背景、底部分隔線 ---
check("thead th sticky top: 0、不透明背景、底部分隔線", () => {
  expectContains(block, ".results-page .analysis-table-wrap thead th {");
  expectContains(block, "background: #fafbfb;");
  expectContains(block, "box-shadow: 0 1px 0 var(--line, #e6ebec);");
});

// --- 7. 指標欄角落 z-index 4 ---
check("指標欄角落（thead th.ind-col）z-index 4", () => {
  expectContains(block, ".results-page .analysis-table-wrap thead th.ind-col {");
  expectContains(block, "z-index: 4;");
});

// --- 8. 深色模式 thead 背景 override ---
check("深色模式 thead 背景 override", () => {
  expectContains(
    block,
    ':root[data-mode="dark"] .results-page .analysis-table-wrap thead th {',
  );
  expectContains(block, "background: var(--surface, #152024);");
});

// --- 9. 彈窗表格包層 max-height ---
check("下探彈窗表格包層 max-height 100dvh-330px", () => {
  expectContains(block, ".results-page .reviewer-modal .analysis-table-wrap {");
  expectContains(block, "max-height: calc(100dvh - 330px);");
});

// --- 10. 彈窗 L2 第一欄 sticky left＋不透明背景 ---
check("彈窗 L2 第一欄 sticky left＋不透明背景", () => {
  expectContains(
    block,
    ".results-page .reviewer-modal .analysis-table-wrap .data-table tbody td:first-child {",
  );
  expectContains(block, "left: 0;");
  expectContains(block, "background: var(--surface, #fff);");
});

// --- 11. 固定規則只在 .results-page 作用域內 ---
check("固定規則只在 .results-page 作用域內（未動全站 .data-table）", () => {
  const baseTh = css.slice(css.indexOf(".data-table th {"), css.indexOf(".data-table th {") + 300);
  if (baseTh.includes("position: sticky")) throw new Error("全站 .data-table th 被加上 sticky");
  const stickyRules = [...css.matchAll(/position: sticky;/g)].map((m) => {
    const start = Math.max(0, m.index - 220);
    return css.slice(start, m.index);
  });
  for (const ctx of stickyRules) {
    if (ctx.includes("thead th") && !ctx.includes(".results-page")) {
      throw new Error("有 thead sticky 規則落在 .results-page 作用域外");
    }
  }
});

// --- 12. 版號一致 ---
check("版號一致：version.ts 與 package.json 皆為 1.40.7", () => {
  if (!versionTs.includes('VERSION = "1.40.7"')) throw new Error("version.ts 不是 1.40.7");
  if (pkg.version !== "1.40.7") throw new Error(`package.json 是 ${pkg.version}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
