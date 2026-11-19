/**
 * 渲染等價快照（拆分驗證用，僅在 CI 執行）。
 * 用法：node scripts/render-snapshots.mjs <原始碼樹根目錄> <輸出 json>
 * 以展示模式（demo 帳號＋記憶體資料）在 jsdom 中掛載 Groups／Results／Schedule 三頁，
 * 固定時間與亂數，依序操作各頁籤／表單，逐步記錄 DOM（innerHTML）。
 * 同一支腳本對「拆分前」與「拆分後」兩份原始碼各跑一次，再用 scripts/compare-snapshots.mjs 比對。
 */
import { build } from "esbuild";
import { writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const [treeArg, outFile] = process.argv.slice(2);
const TREE = resolve(treeArg).replace(/\\/g, "/");

// ---- 固定時間與亂數 ----
const RealDate = Date;
const FIXED = RealDate.UTC(2026, 10, 19, 4, 0, 0);
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
  static now() { return FIXED; }
};
let seed = 12345;
Math.random = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

// ---- jsdom 環境 ----
const { JSDOM } = await import("jsdom");
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/", pretendToBeVisual: true });
const w = dom.window;
for (const k of ["window", "document", "sessionStorage", "localStorage", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "InputEvent", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver", "DOMParser", "Blob", "File", "FileReader", "URL"]) {
  try { Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true }); } catch { /* 已存在 */ }
}
try { Object.defineProperty(globalThis, "navigator", { value: w.navigator, configurable: true }); } catch { /* */ }
w.matchMedia = globalThis.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
globalThis.ResizeObserver = w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IntersectionObserver = w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
w.HTMLElement.prototype.scrollIntoView = function () {};
w.scrollTo = globalThis.scrollTo = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
sessionStorage.setItem("nurseboard-demo-mode", "1");

// ---- 打包被測樹 ----
const entry = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { AuthProvider } from "${TREE}/src/lib/auth";
import { loadDemoStore } from "${TREE}/src/lib/demoLoader";
import { GroupsPage } from "${TREE}/src/features/GroupsPage";
import { ResultsPage } from "${TREE}/src/features/ResultsPage";
import { SchedulePage } from "${TREE}/src/features/SchedulePage";
export { createElement, createRoot, act, AuthProvider, loadDemoStore, GroupsPage, ResultsPage, SchedulePage };
`;
mkdirSync("/tmp/snap", { recursive: true });
const tag = TREE.replace(/[^a-z0-9]/gi, "_").slice(-30);
const entryFile = `/tmp/snap/entry-${tag}.tsx`;
const bundle = `/tmp/snap/bundle-${tag}.cjs`;
writeFileSync(entryFile, entry);
await build({
  entryPoints: [entryFile], bundle: true, format: "cjs", platform: "node", outfile: bundle, logLevel: "error",
  jsx: "automatic", define: { "import.meta.env": "{}" }, absWorkingDir: TREE, nodePaths: [`${TREE}/node_modules`],
  loader: { ".css": "empty" },
});
const M = createRequire(bundle)(bundle);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(n = 6) { for (let i = 0; i < n; i++) await M.act(async () => { await sleep(30); }); }
async function click(el) { if (!el) return false; await M.act(async () => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true })); }); await settle(); return true; }
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const byText = (sel, text, root = document) => $$(sel, root).find((e) => (e.textContent ?? "").replace(/\s+/g, "").includes(text.replace(/\s+/g, "")));
const snaps = {};
const errors = [];
const snap = (name) => { snaps[name] = document.getElementById("root").innerHTML; };

async function runPage(label, Page, script) {
  const container = document.createElement("div"); container.id = "root";
  document.body.innerHTML = ""; document.body.appendChild(container);
  const root = M.createRoot(container);
  const origErr = console.error; console.error = (...a) => { errors.push(`${label}: ` + a.map(String).join(" ").slice(0, 300)); };
  try {
    await M.act(async () => { root.render(M.createElement(M.AuthProvider, null, M.createElement(Page, { onAction: () => {} }))); });
    await settle(40);
    snap(`${label}/初始`);
    await script();
  } catch (e) { snaps[`${label}/例外`] = String(e && e.stack ? e.stack : e).slice(0, 500); }
  console.error = origErr;
  await M.act(async () => { root.unmount(); });
}

await M.loadDemoStore();

// ---- Groups：逐頁籤、使用者搜尋、新增表單 ----
await runPage("groups", M.GroupsPage, async () => {
  for (const tab of ["單位", "人員", "角色", "職稱", "品管組"]) {
    await click(byText("[role=tab]", tab));
    if (tab === "人員") { await click(byText("button", "搜尋")); }
    snap(`groups/${tab}`);
    const add = $$(".page-heading .button-primary, .page-heading button.button-primary, header .button-primary")[0] ?? byText("button", "新增");
    if (add) {
      await click(add); snap(`groups/${tab}/新增表單`);
      await click(byText("button", "返回清單"));
    }
  }
});

// ---- Results：查詢後逐頁籤 ----
await runPage("results", M.ResultsPage, async () => {
  await click(byText("button", "查詢")); snap("results/查詢後");
  for (const t of $$(".results-tabs [role=tab]")) {
    const name = (t.textContent ?? "").trim();
    await click(t); snap(`results/${name}`);
    await click(byText("button", "查詢")); snap(`results/${name}/查詢後`);
  }
});

// ---- Schedule：查詢後列表、進入前三列的各按鈕 ----
await runPage("schedule", M.SchedulePage, async () => {
  await click(byText("button", "查詢")); snap("schedule/查詢後");
  const rows = $$("tbody tr");
  for (let r = 0; r < Math.min(rows.length, 2); r++) {
    const nBtn = $$("tbody tr")[r]?.querySelectorAll("button").length ?? 0;
    for (let b = 0; b < nBtn; b++) {
      const btn = $$("tbody tr")[r]?.querySelectorAll("button")[b];
      if (!btn) continue;
      const label = (btn.textContent ?? "").trim() || `btn${b}`;
      await click(btn); snap(`schedule/列${r}/${label}`);
      const back = byText("button", "返回") ?? byText("button", "取消") ?? byText("button", "關閉");
      if (back) await click(back);
      if (!$$("tbody tr").length) { await click(byText("button", "查詢")); }
    }
  }
});

writeFileSync(outFile, JSON.stringify({ snaps, errors }, null, 1));
console.log(`已記錄 ${Object.keys(snaps).length} 個快照、${errors.length} 筆 console.error → ${outFile}`);
process.exit(0);
