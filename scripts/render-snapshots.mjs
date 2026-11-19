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
import { useAuth } from "${TREE}/src/lib/auth";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { AuthProvider } from "${TREE}/src/lib/auth";
import { loadDemoStore } from "${TREE}/src/lib/demoLoader";
import * as demo from "${TREE}/src/lib/demoStore";
import { GroupsPage } from "${TREE}/src/features/GroupsPage";
import { ResultsPage } from "${TREE}/src/features/ResultsPage";
import { SchedulePage } from "${TREE}/src/features/SchedulePage";
function Gate({ Page, extra }) { const { user } = useAuth(); return user ? createElement(Page, { onAction: () => {}, ...extra }) : null; }
export { demo, Gate, createElement, createRoot, act, AuthProvider, loadDemoStore, GroupsPage, ResultsPage, SchedulePage };
`;
mkdirSync("/tmp/snap", { recursive: true });
const tag = TREE.replace(/[^a-z0-9]/gi, "_").slice(-30);
const entryFile = `/tmp/snap/entry-${tag}.tsx`;
const bundle = `/tmp/snap/bundle-${tag}.cjs`;
writeFileSync(entryFile, entry);
await build({
  entryPoints: [entryFile], bundle: true, format: "cjs", platform: "node", outfile: bundle, logLevel: "error",
  jsx: "automatic", define: { "import.meta.env": JSON.stringify({ VITE_FIREBASE_API_KEY: "x", VITE_FIREBASE_AUTH_DOMAIN: "x.firebaseapp.com", VITE_FIREBASE_PROJECT_ID: "demo-project", VITE_FIREBASE_APP_ID: "1:1:web:1", VITE_DB_MODE: "firebase" }) }, absWorkingDir: TREE, nodePaths: [`${TREE}/node_modules`],
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

async function runPage(label, Page, script, extra = {}) {
  const container = document.createElement("div"); container.id = "root";
  document.body.innerHTML = ""; document.body.appendChild(container);
  const root = M.createRoot(container);
  const origErr = console.error; console.error = (...a) => { errors.push(`${label}: ` + a.map(String).join(" ").slice(0, 300)); };
  try {
    await M.act(async () => { root.render(M.createElement(M.AuthProvider, null, M.createElement(M.Gate, { Page, extra }))); });
    await settle(40);
    snap(`${label}/初始`);
    await script();
  } catch (e) { snaps[`${label}/例外`] = String(e && e.stack ? e.stack : e).slice(0, 500); }
  console.error = origErr;
  await M.act(async () => { root.unmount(); });
}

await M.loadDemoStore();
M.demo.ensureSeeded();
{ // 種入審查紀錄，讓結果分析有資料
  const units = ["9A", "9B"]; const inds = [["g-ward__QI-001", 7], ["g-ward__QI-002", 4]]; const months = [[2026, 9], [2026, 10], [2026, 11]];
  let n = 0;
  for (const [ind, nq] of inds) for (const u of units) for (const [y, m] of months) for (let seq = 1; seq <= 2; seq++) {
    const answers = Array.from({ length: nq }, (_, q) => { const yes = (n + q) % 5 !== 0; return { questionId: `q${q}`, itemText: `題${q + 1}`, optionLabel: yes ? "是" : "否", score: yes ? 1 : 0 }; });
    const total = answers.reduce((a, b) => a + b.score, 0);
    const id = `rec-${ind}-${u}-${y}${m}-${seq}`; n++;
    M.demo.setDoc(M.demo.docOf("db", "reviewRecords", id), { taskId: `task-${ind}-${u}-${y}${m}`, indicatorId: ind, unitId: u, reviewerId: "B67890", year: y, month: m, caseSeq: seq, reviewDate: `${y}-${String(m).padStart(2, "0")}-15`, reviewerEmpNo: "B67890", reviewerName: "王小明", reviewedPersonEmpNo: `E${n}`, reviewedPersonName: `受審${n}`, bedNo: "", answers, totalScore: total, maxScore: nq, rate: Math.round((total / nq) * 1000) / 10, submittedAt: M.demo.serverTimestamp(), submittedBy: "B67890" });
  }
}
async function setSelect(sel, optionText) {
  if (!sel) return false;
  const opt = [...sel.options].find((o) => (o.textContent ?? "").includes(optionText));
  if (!opt) return false;
  await M.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, "value").set;
    setter.call(sel, opt.value);
    sel.dispatchEvent(new w.Event("change", { bubbles: true }));
  });
  await settle();
  return true;
}
const closeAny = async () => { const b = $$("button").find((x) => /^(關閉|取消|返回|返回清單)$/.test((x.textContent ?? "").replace(/\s+/g, "")) || x.getAttribute("aria-label") === "關閉"); if (b) await click(b); return !!b; };
async function probeCells(label, max = 3) {
  const cells = $$(".results-page table tbody button, .results-page table tbody [role=button]").filter((b) => !b.disabled);
  for (let i = 0; i < Math.min(cells.length, max); i++) {
    const c = $$(".results-page table tbody button, .results-page table tbody [role=button]").filter((b) => !b.disabled)[i];
    if (!c) break;
    await click(c); snap(`${label}/格${i}`);
    await closeAny();
  }
}

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

for (const [name, target] of [["群組單位", { kind: "group", id: "g-ward" }], ["單位成員", { kind: "unit", id: "9A" }]]) {
  await runPage(`groups-member/${name}`, M.GroupsPage, async () => {
    for (const b of $$("button").slice(0, 6)) { const t = (b.textContent ?? "").trim(); snap(`groups-member/${name}/按鈕:${t}`); break; }
  }, { memberPage: target });
}

// ---- Results：種入資料後，三個分析頁籤選取條件、搜尋、點格子 ----
await runPage("results", M.ResultsPage, async () => {
  await click(byText("button", "搜尋")); snap("results/查詢後");
  const tabs = $$(".results-tabs [role=tab]");
  for (const t of tabs) {
    const name = (t.textContent ?? "").trim();
    await click(t); snap(`results/${name}`);
    if (name === "組別分析") { await setSelect($$(".results-page select")[0], "病房組"); }
    if (name === "單位分析") { await setSelect($$(".results-page select").find((x) => [...x.options].some((o) => (o.textContent ?? "").includes("9A"))), "9A"); }
    if (name === "指標分析") { const ss = $$(".results-page select"); await setSelect(ss[0], "病房組"); await setSelect($$(".results-page select")[1], "QI-001"); }
    await click(byText("button", "搜尋")); snap(`results/${name}/搜尋後`);
    if (["組別分析", "單位分析", "指標分析"].includes(name)) await probeCells(`results/${name}`);
  }
});

// ---- Schedule：查詢後列表、進入前三列的各按鈕 ----
await runPage("schedule", M.SchedulePage, async () => {
  await click(byText("button", "搜尋")); snap("schedule/查詢後");
  const rows = $$("tbody tr");
  for (let r = 0; r < Math.min(rows.length, 2); r++) {
    const nBtn = $$("tbody tr")[r]?.querySelectorAll("button").length ?? 0;
    for (let b = 0; b < nBtn; b++) {
      const btn = $$("tbody tr")[r]?.querySelectorAll("button")[b];
      if (!btn) continue;
      const label = `${b}-` + ((btn.textContent ?? "").trim() || "btn");
      await click(btn); snap(`schedule/列${r}/${label}`);
      const back = byText("button", "返回") ?? byText("button", "取消") ?? byText("button", "關閉");
      if (back) await click(back);
      if (!$$("tbody tr").length) { await click(byText("button", "搜尋")); }
    }
  }
});

writeFileSync(outFile, JSON.stringify({ snaps, errors }, null, 1));
console.log(`已記錄 ${Object.keys(snaps).length} 個快照、${errors.length} 筆 console.error → ${outFile}`);
process.exit(0);
