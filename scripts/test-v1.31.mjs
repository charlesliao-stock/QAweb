/**
 * v1.31.0 斷言：第 5 套主題「薄荷綠橘」（Printmax 23167 概念借鑑，方案 B）。
 * 執行：node scripts/test-v1.31.mjs（專案根目錄）
 * 檢查：主題清單／CSS 變數 9 項／殼層僅限新主題作用域／對比度／RAG 不動／舊主題仍在。
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { resolve } from "path";
const ROOT = resolve(import.meta.dirname, "..");
writeFileSync(
  "/tmp/t131.ts",
  `export { UI_THEMES, themeName } from "${ROOT}/src/lib/seed";\n`,
);
await build({ entryPoints: ["/tmp/t131.ts"], bundle: true, format: "cjs", platform: "node", outfile: "/tmp/t131.cjs", logLevel: "silent" });
const L = createRequire("/tmp/t131.cjs")("/tmp/t131.cjs");
const css = readFileSync(resolve(ROOT, "src/styles.css"), "utf8");
let f = 0;
const a = (n, c) => { if (!c) { f++; console.error("FAIL:", n); } };

// 1. 主題清單：5 套、id 唯一、新主題在列
a("主題共 5 套", L.UI_THEMES.length === 5);
a("id 唯一", new Set(L.UI_THEMES.map((t) => t.id)).size === 5);
a("新主題 id 為 printmax-green", L.UI_THEMES.some((t) => t.id === "printmax-green"));
a("新主題名稱為薄荷綠橘", L.themeName("printmax-green") === "薄荷綠橘");
a("舊 4 套仍在", ["green-2", "blue-3", "teal-orange-3", "purple-4"].every((id) => L.UI_THEMES.some((t) => t.id === id)));

// 2. CSS 變數：新主題覆寫 9 項
const m = css.match(/:root\[data-theme="printmax-green"\] \{([^}]*)\}/);
a("新主題變數區塊存在", !!m);
const vars = ["--teal:", "--teal-deep:", "--teal-soft:", "--accent:", "--accent-deep:", "--accent-soft:", "--accent2:", "--accent2-deep:", "--accent2-soft:"];
a("9 個變數皆覆寫", !!m && vars.every((v) => m[1].includes(v)));
const val = (name) => { const r = m[1].match(new RegExp(name + "\\s*:\\s*(#[0-9a-f]{6})")); return r ? r[1] : null; };
a("主綠已調深（非模板原色 #35d49b）", val("--teal") !== "#35d49b" && val("--teal") === "#0b7a5f");
a("橘已調深（非模板原色 #ffb08a）", val("--accent2") !== "#ffb08a");

// 3. 殼層只限新主題作用域
a("按鈕膠囊只限新主題", css.includes(':root[data-theme="printmax-green"] .button:not(.login-action) {\n  border-radius: 999px;'));
a("登入按鈕排除在膠囊外", css.includes(".button:not(.login-action)"));
a("卡片圓角 16px 只限新主題", css.includes(':root[data-theme="printmax-green"] .panel {\n  border-radius: 16px;'));
a("通用 .button 圓角仍為 8px", css.includes(".button {\n  border: 1px solid transparent;") && /\.button \{[^}]*border-radius: 8px;/.test(css));
a("通用 .panel 圓角仍為 10px", /\.panel \{[^}]*border-radius: 10px;/.test(css));
a("未動側邊欄寬", css.includes("--sidebar-width") && !/printmax-green[^}]*--sidebar-width/.test(css));

// 4. 對比度（WCAG AA 文字 4.5:1）：白字 on 主色、深字 on 淺底
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const cr = (h1, h2) => { const l1 = lum(h1), l2 = lum(h2); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
for (const v of ["--teal", "--teal-deep", "--accent", "--accent-deep", "--accent2"]) {
  a(`對比：${v} 白字 ≥4.5（${cr(val(v), "#ffffff").toFixed(2)}）`, cr(val(v), "#ffffff") >= 4.5);
}
a(`對比：teal-deep 字 on teal-soft ≥4.5（${cr(val("--teal-deep"), val("--teal-soft")).toFixed(2)}）`, cr(val("--teal-deep"), val("--teal-soft")) >= 4.5);

// 5. RAG 燈號不動、深色覆寫仍在
a("RAG 綠燈色不動", css.includes(".status-pill.success {\n  color: #338675;"));
a("RAG 黃燈色不動", css.includes(".status-pill.warning {\n  color: #b28a40;"));
a("RAG 紅燈色不動", css.includes(".status-pill.danger {\n  color: #bb6f5e;"));
a("深色模式區塊仍在", css.includes(':root[data-mode="dark"] {'));

// 6. jsdom 渲染驗證：切換主題／深色後實際算出的樣式
const { JSDOM } = await import("jsdom");
const dom = new JSDOM(`<!DOCTYPE html><html><head><style>${css}</style></head><body><button class="button button-primary">x</button><div class="panel">x</div><span class="chip">x</span></body></html>`, { pretendToBeVisual: true });
const doc = dom.window.document;
const cs = (el, p) => dom.window.getComputedStyle(el)[p];
const btn = doc.querySelector(".button"), panel = doc.querySelector(".panel");
const root = doc.documentElement;
root.dataset.theme = "printmax-green";
a("渲染：新主題按鈕 radius 999px", cs(btn, "borderRadius") === "999px");
a("渲染：新主題卡片 radius 16px", cs(panel, "borderRadius") === "16px");
a("渲染：新主題 --teal 為 #0b7a5f", dom.window.getComputedStyle(root).getPropertyValue("--teal").trim() === "#0b7a5f");
a("渲染：新主題 chip 仍膠囊", cs(doc.querySelector(".chip"), "borderRadius") === "999px");
root.dataset.theme = "green-2";
a("渲染：舊主題按鈕 radius 回 8px", cs(btn, "borderRadius") === "8px");
a("渲染：舊主題卡片 radius 回 10px", cs(panel, "borderRadius") === "10px");
root.dataset.theme = "printmax-green"; root.dataset.mode = "dark";
a("渲染：深色＋新主題按鈕仍膠囊", cs(btn, "borderRadius") === "999px");
a("渲染：深色＋新主題卡片仍 16px", cs(panel, "borderRadius") === "16px");
a("渲染：深色＋新主題 --surface 仍為深色", dom.window.getComputedStyle(root).getPropertyValue("--surface").trim() === "#152024");

// 7. 建置產物 dist 內含新主題（若 dist 尚未建置則跳過此項）
import { readdirSync, existsSync } from "fs";
const distCss = existsSync(resolve(ROOT, "dist/assets")) ? readdirSync(resolve(ROOT, "dist/assets")).filter((x) => x.endsWith(".css")) : [];
a("dist CSS 內含新主題", distCss.length > 0 && distCss.some((x) => readFileSync(resolve(ROOT, "dist/assets", x), "utf8").includes("printmax-green")));

console.log(f ? `failed ${f}` : "v1.31：35 項通過");
process.exit(f ? 1 : 0);
