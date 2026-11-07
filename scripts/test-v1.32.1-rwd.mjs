/**
 * v1.32.1 斷言：RWD 修復（P0＋P1＋P2，稽核報告 §5 第 1–15 項）。
 * 執行：node scripts/test-v1.32.1-rwd.mjs（專案根目錄）
 * 檢查：M5 data-label 齊全／模板牆 320px 不溢出／矩陣首欄手機 120px／
 * 分工格斷點／頁籤橫捲／彈窗手機近滿版／權限表精簡＋sticky 首欄／
 * 觸控目標 ≥40px／body overflow-x 兜底／popover 縮減／月份格 2 欄／
 * topbar＋標題列換行／分數輸入下限／radio·checkbox 放大／全部 data-table 皆包橫捲容器。
 */
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..");
const css = readFileSync(resolve(ROOT, "src/styles.css"), "utf8");
const schedule = readFileSync(
  resolve(ROOT, "src/features/SchedulePage.tsx"),
  "utf8",
);
const admin = readFileSync(
  resolve(ROOT, "src/features/AdminPage.tsx"),
  "utf8",
);
const version = readFileSync(resolve(ROOT, "src/version.ts"), "utf8");
let f = 0;
const a = (n, c) => {
  if (!c) {
    f++;
    console.error("FAIL:", n);
  }
};
const block = (cssText, media, startMarker) => {
  const i = cssText.indexOf(media);
  if (i < 0) return "";
  const j = cssText.indexOf(startMarker, i);
  return j < 0 ? "" : cssText.slice(i, j + 2000);
};
const m640 = block(css, "@media (max-width: 640px)", "@media (max-width: 380px)");
const m760 = block(css, "v1.32.1", "@media (max-width: 640px)");

// P0-1：M5 查閱彈窗 10 格 data-label 齊全
const m5Start = schedule.indexOf("查閱：${row.name}");
const m5End = schedule.indexOf('<div className="form-actions">', m5Start);
const m5 = schedule.slice(m5Start, m5End);
for (const label of [
  "期間",
  "審查月份",
  "審查頻次",
  "審查區間",
  "受審單位",
  "審查件數",
  "備註",
  "最後編輯",
  "審查員",
  "負責單位",
]) {
  a(`M5 data-label="${label}"`, m5.includes(`data-label="${label}"`));
}
a("M5 data-label 共 10 處", (m5.match(/data-label="/g) || []).length === 10);

// P0-2：模板卡片牆 320px 不溢出
a(
  "模板牆 minmax(min(240px,100%),1fr)",
  admin.includes('minmax(min(240px, 100%), 1fr)'),
);

// P1-3：結果矩陣首欄手機 120px
a("矩陣首欄手機 120px", /\.analysis-matrix[^{]*\{[^}]*min-width:\s*120px/.test(m640));

// P1-4：分工勾選 640px 2 欄、380px 1 欄
a("分工格 640px 2 欄", m640.includes("repeat(2, minmax(0, 1fr))"));
a(
  "分工格 380px 1 欄",
  css.slice(css.indexOf("@media (max-width: 380px)", css.indexOf("v1.32.1"))).includes("grid-template-columns: minmax(0, 1fr)"),
);

// P1-5：頁籤可橫捲
a(".tabs overflow-x:auto", /\.tabs\s*\{[^}]*overflow-x:\s*auto/.test(css));
a(".tab 不被擠壓", /\.tabs \.tab\s*\{[^}]*flex-shrink:\s*0/.test(css));

// P1-6：彈窗手機近滿版
a(
  "彈窗手機寬 calc(100vw - 16px)",
  m640.includes("width: calc(100vw - 16px)"),
);
a(
  "彈窗手機高 calc(100dvh - 16px)",
  m640.includes("max-height: calc(100dvh - 16px)"),
);

// P1-7：權限表手機精簡＋sticky 首欄
a("權限表手機 min-width 620px", m760.includes("min-width: 620px"));
a(
  "權限表首欄 sticky",
  /\.permission-table[^{]*:first-child\s*\{[^}]*position:\s*sticky/.test(m760),
);

// P2-8：觸控目標 ≥40px
a(".button min-height 40px", /\.button\s*\{[^}]*min-height:\s*40px/.test(css));
a("彈窗關閉鈕 40x40", /\.reviewer-modal-head > \.button\s*\{[^}]*min-width:\s*40px/.test(css));
a("手機 icon-button 40px", m760.includes("width: 40px"));
a("手機 text-button min-height 40px", m760.includes("min-height: 40px"));

// P2-9：body overflow-x 兜底（clip，不建捲動容器，sticky 不受影響）
a("body overflow-x: clip", /body\s*\{[^}]*overflow-x:\s*clip/.test(css));

// P2-10：popover 手機縮減
a(
  "月份 popover 手機寬 min(260px, 100vw-24px)",
  m640.includes("width: min(260px, calc(100vw - 24px))"),
);
a(
  "顯示設定 popover 手機寬 min(240px, 100vw-24px)",
  m640.includes("width: min(240px, calc(100vw - 24px))"),
);

// P2-11：月份格手機 2 欄
a(
  "月份格手機 2 欄",
  /\.results-month-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/.test(m640),
);

// P2-12：topbar＋標題列換行
a(".page-heading flex-wrap", /\.page-heading\s*\{[^}]*flex-wrap:\s*wrap/.test(css));
a(
  "手機 topbar 高度 auto＋換行",
  /\.topbar\s*\{[^}]*height:\s*auto[^}]*flex-wrap:\s*wrap/.test(m640),
);

// P2-13：分數輸入手機不設 240px 下限
a(
  "分數輸入手機 min-width 0",
  /\.fraction\s*\{[^}]*min-width:\s*0/.test(m640),
);

// P2-14：radio／checkbox 手機放大
a(
  "checkbox 手機 22px",
  /\.check-row input\[type="checkbox"\]\s*\{[^}]*width:\s*22px/.test(m640),
);
a(
  "radio 手機 22px",
  /\.radio-group \.check-row input\[type="radio"\]\s*\{[^}]*width:\s*22px/.test(m640),
);

// P2-15：全部 .data-table 皆包橫捲容器（table-scroll 或 analysis-table-wrap）
const tsxFiles = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".tsx")) tsxFiles.push(p);
  }
};
walk(resolve(ROOT, "src"));
let unwrapped = [];
for (const file of tsxFiles) {
  const s = readFileSync(file, "utf8");
  let idx = 0;
  for (;;) {
    const m = s.indexOf('<table className="data-table"', idx);
    if (m < 0) break;
    idx = m + 1;
    const pre = s.slice(Math.max(0, m - 900), m);
    const divs = [...pre.matchAll(/<div[^>]*>/g)];
    const last = divs[divs.length - 1];
    const ok =
      last &&
      /table-scroll|analysis-table-wrap/.test(last[0]) &&
      !pre.slice(last.index + last[0].length).includes("</div>");
    if (!ok) unwrapped.push(`${file.split("src/")[1]}:${s.slice(0, m).split("\n").length}`);
  }
}
a(`全部 data-table 皆包橫捲容器（未包：${unwrapped.join(",") || "無"}）`, unwrapped.length === 0);

// 版號
a('版號 1.32.1', version.includes('VERSION = "1.32.1"'));

console.log(f === 0 ? "v1.32.1 RWD：全部通過" : `v1.32.1 RWD：${f} 項失敗`);
process.exit(f === 0 ? 0 : 1);
