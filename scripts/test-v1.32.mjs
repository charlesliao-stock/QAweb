/**
 * v1.32.0 斷言：資料驅動主題（設計 v2）——9 套內建主題＋動態套用＋模板管理資料模型。
 * 執行：node scripts/test-v1.32.mjs（專案根目錄）
 * 檢查：內建定義齊全／對比度／舊 4 套外觀不變／applyTheme 接受全部 id＋自訂定義／
 * 無效退回 green-2／自訂新增不需改程式即可套用／深色底色不被 inline 蓋掉／demo 透傳／rules。
 */
import { build } from "esbuild";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..");
writeFileSync(
  "/tmp/t132.ts",
  [
    `export { BUILT_IN_THEMES, themeName } from "${ROOT}/src/lib/seed";`,
    `export { contrastRatio, isHexColor, validateThemeContrast } from "${ROOT}/src/lib/colorContrast";`,
    `export { applyTheme, getColorMode, getCurrentThemeId, setColorMode } from "${ROOT}/src/lib/uiPrefs";`,
    `export { isValidThemeId, loadThemes, normalizeThemeDef, setThemeRegistry, themeToCssVars, visibleThemes } from "${ROOT}/src/lib/themeRegistry";`,
    `export { getDemoData } from "${ROOT}/src/lib/demoData";`,
    "",
  ].join("\n"),
);
await build({
  entryPoints: ["/tmp/t132.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/t132.cjs",
  logLevel: "silent",
  // firebase.ts 在模組載入期讀 import.meta.env；Node 下以空物件代入
  //（測試不呼叫 getFirebaseDb，不需真實設定值）
  define: { "import.meta.env": "{}" },
});
const L = createRequire("/tmp/t132.cjs")("/tmp/t132.cjs");
const css = readFileSync(resolve(ROOT, "src/styles.css"), "utf8");
let f = 0;
const a = (n, c) => {
  if (!c) {
    f++;
    console.error("FAIL:", n);
  }
};

// 1. 內建主題：9 套、id 唯一、順序正確
a("內建主題共 9 套", L.BUILT_IN_THEMES.length === 9);
a(
  "id 唯一",
  new Set(L.BUILT_IN_THEMES.map((t) => t.id)).size === 9,
);
a(
  "9 個 id 齊全",
  [
    "green-2",
    "blue-3",
    "teal-orange-3",
    "purple-4",
    "printmax-green",
    "dexon-mint",
    "edu-blue",
    "bistro-brown",
    "paw-orange",
  ].every((id) => L.BUILT_IN_THEMES.some((t) => t.id === id)),
);
a(
  "order 0–8 依序",
  L.BUILT_IN_THEMES.every((t, i) => t.order === i),
);

// 2. 舊 4 套：9 變數沿用 v1.31.0 現行值，殼層＝改版前外觀
const OLD_VARS = {
  "green-2": {
    teal: "#0f766e",
    tealDeep: "#0d625c",
    tealSoft: "#e9f5f3",
    accent: "#4d7f78",
    accentDeep: "#3d6660",
    accentSoft: "#edf4f2",
    accent2: "#4d7f78",
    accent2Deep: "#3d6660",
    accent2Soft: "#edf4f2",
  },
  "blue-3": {
    teal: "#1e6fb8",
    tealDeep: "#175a95",
    tealSoft: "#e9f2fb",
    accent: "#2f9fd8",
    accentDeep: "#1f709e",
    accentSoft: "#e6f4fc",
    accent2: "#2f9fd8",
    accent2Deep: "#237fae",
    accent2Soft: "#e6f4fc",
  },
  "teal-orange-3": {
    teal: "#0f766e",
    tealDeep: "#0d625c",
    tealSoft: "#e9f5f3",
    accent: "#d97a2b",
    accentDeep: "#a05518",
    accentSoft: "#fdf0e2",
    accent2: "#d97a2b",
    accent2Deep: "#b25f1d",
    accent2Soft: "#fdf0e2",
  },
  "purple-4": {
    teal: "#6d4fa3",
    tealDeep: "#573d85",
    tealSoft: "#f0eaf8",
    accent: "#0f766e",
    accentDeep: "#0d625c",
    accentSoft: "#e9f5f3",
    accent2: "#c08a2d",
    accent2Deep: "#9a6e22",
    accent2Soft: "#faf3e4",
  },
};
for (const [id, vars] of Object.entries(OLD_VARS)) {
  const def = L.BUILT_IN_THEMES.find((t) => t.id === id);
  a(
    `舊主題 ${id} 9 變數不變`,
    !!def &&
      Object.entries(vars).every(
        (entry) => def[entry[0]] === entry[1],
      ),
  );
  a(
    `舊主題 ${id} 殼層＝現行外觀（8／10／0／none）`,
    !!def &&
      def.radiusBtn === 8 &&
      def.radiusCard === 10 &&
      def.lift === 0 &&
      def.grad === "none" &&
      def.btnHoverBg === def.tealDeep &&
      def.rowHover === "#fcfdfd" &&
      def.navHover === "#f5f8f8",
  );
}

// 3. 新 5 套：方案 A 重調的 printmax-green＋4 套新主題
const pm = L.BUILT_IN_THEMES.find((t) => t.id === "printmax-green");
a("printmax-green 主綠重調 #0e856c", pm?.teal === "#0e856c");
a("printmax-green 淡底 #d8f3e6", pm?.tealSoft === "#d8f3e6");
a("printmax-green 頁底 #eef8f1", pm?.bg === "#eef8f1");
a(
  "printmax-green 殼層 999／16／2",
  pm?.radiusBtn === 999 && pm?.radiusCard === 16 && pm?.lift === 2,
);
a(
  "dexon-mint hover 翻轉：亮黃底＋黑字",
  L.BUILT_IN_THEMES.find((t) => t.id === "dexon-mint")?.btnHoverBg ===
    "#ffde5d" &&
    L.BUILT_IN_THEMES.find((t) => t.id === "dexon-mint")
      ?.btnHoverColor === "#101210",
);
a(
  "edu-blue 主色 #4361ee、hover #3a0ca3",
  L.BUILT_IN_THEMES.find((t) => t.id === "edu-blue")?.teal === "#4361ee" &&
    L.BUILT_IN_THEMES.find((t) => t.id === "edu-blue")?.btnHoverBg ===
      "#3a0ca3",
);
a(
  "bistro-brown 主色已調深 #a85f36（原色 #c17c54 白字僅 3.34）",
  L.BUILT_IN_THEMES.find((t) => t.id === "bistro-brown")?.teal ===
    "#a85f36",
);
a(
  "paw-orange 主色已調深 #9c6210（原色 #f6ab4a 白字僅 1.94）",
  L.BUILT_IN_THEMES.find((t) => t.id === "paw-orange")?.teal ===
    "#9c6210",
);

// 4. 對比度（WCAG AA 4.5:1）：9 套皆無擋下錯誤；亮色不作白字底
for (const def of L.BUILT_IN_THEMES) {
  const { errors } = L.validateThemeContrast(def);
  a(`對比：${def.id} 無擋下錯誤（${errors.join("；") || "通過"}）`, errors.length === 0);
  a(
    `對比：${def.id} 主色白字 ≥4.5（${L.contrastRatio(def.teal, "#ffffff").toFixed(2)}）`,
    L.contrastRatio(def.teal, "#ffffff") >= 4.5,
  );
}
a("亮黃 #ffde5d 不作白字底", L.contrastRatio("#ffde5d", "#ffffff") < 4.5);
a(
  "Dexon 翻轉黑字 on 亮黃 ≥4.5",
  L.contrastRatio("#101210", "#ffde5d") >= 4.5,
);

// 5. CSS：不再有寫死 per-theme 規則區塊，改通用變數殼層
//（註：註解文字含 ":root[data-theme" 字樣，故以「規則本體」正則判斷）
a(
  "CSS 無任何 :root[data-theme] 規則",
  !/:root\[data-theme="[^"]+"\]\s*\{/.test(css),
);
a(
  "通用 .button 用 --radius-btn",
  css.includes("border-radius: var(--radius-btn, 8px);"),
);
a(
  "主按鈕 hover 用 --btn-hover-bg／--btn-hover-color／--shadow-hover",
  css.includes("background: var(--btn-hover-bg, var(--teal-deep));") &&
    css.includes("color: var(--btn-hover-color, #fff);") &&
    css.includes("box-shadow: var(--shadow-hover,"),
);
a(
  "通用 .panel 用 --radius-card 且 position: relative",
  /\.panel \{[^}]*border-radius: var\(--radius-card, 10px\);[^}]*position: relative;/s.test(
    css,
  ),
);
a("卡片頂條 .panel::before 用 --grad", css.includes(".panel::before {"));
a(
  "卡片 hover 用 --lift／--shadow-card-hover",
  css.includes("transform: translateY(calc(var(--lift, 0) * -1px));") &&
    css.includes("box-shadow: var(--shadow-card-hover,"),
);
a(
  "表格列 hover 用 --row-hover",
  css.includes("background: var(--row-hover, #fcfdfd);"),
);
a(
  "導覽 hover 用 --nav-hover",
  css.includes("background: var(--nav-hover, #f5f8f8);"),
);
a("RAG 綠燈色不動", css.includes(".status-pill.success {\n  color: #338675;"));
a("RAG 黃燈色不動", css.includes(".status-pill.warning {\n  color: #b28a40;"));
a("RAG 紅燈色不動", css.includes(".status-pill.danger {\n  color: #bb6f5e;"));
a("深色模式區塊仍在", css.includes(':root[data-mode="dark"] {'));

// 6. jsdom：applyTheme 動態套用（registry 驅動，無寫死白名單）
const { JSDOM } = await import("jsdom");
const dom = new JSDOM(
  `<!DOCTYPE html><html><head><style>${css}</style></head><body><button class="button button-primary">x</button><div class="panel">x</div></body></html>`,
  { url: "http://localhost", pretendToBeVisual: true },
);
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
const root = dom.window.document.documentElement;
const getVar = (n) =>
  dom.window.getComputedStyle(root).getPropertyValue(n).trim();
const btn = dom.window.document.querySelector(".button");
const panel = dom.window.document.querySelector(".panel");
const cs = (el, p) => dom.window.getComputedStyle(el)[p];

L.setThemeRegistry(L.BUILT_IN_THEMES);
L.applyTheme("printmax-green");
a("套用 printmax-green：dataset.theme", root.dataset.theme === "printmax-green");
a("套用 printmax-green：--teal #0e856c", getVar("--teal") === "#0e856c");
a("套用 printmax-green：--radius-btn 999px", getVar("--radius-btn") === "999px");
a("套用 printmax-green：--bg #eef8f1（淺色）", getVar("--bg") === "#eef8f1");
// jsdom 不解析 var()，計算樣式會原樣回傳 var() 字串；此處驗殼層確實走變數
a("渲染：按鈕圓角走 --radius-btn 變數", cs(btn, "borderRadius") === "var(--radius-btn, 8px)");
a("渲染：卡片圓角走 --radius-card 變數", cs(panel, "borderRadius") === "var(--radius-card, 10px)");

L.applyTheme("green-2");
a("套用 green-2：--teal #0f766e", getVar("--teal") === "#0f766e");
a("套用 green-2：--radius-btn 8px", getVar("--radius-btn") === "8px");
a("套用 green-2：--radius-card 10px", getVar("--radius-card") === "10px");

L.applyTheme("dexon-mint");
a("套用 dexon-mint：--btn-hover-bg #ffde5d", getVar("--btn-hover-bg") === "#ffde5d");
a("套用 dexon-mint：--btn-hover-color #101210", getVar("--btn-hover-color") === "#101210");

// 自訂主題：不需改程式即可套用（registry 驅動）
const custom = {
  ...L.BUILT_IN_THEMES.find((t) => t.id === "edu-blue"),
  id: "my-custom",
  name: "我的自訂",
  source: "管理員自訂",
  builtIn: false,
  hidden: false,
  order: 9,
  teal: "#0b5cad",
};
L.setThemeRegistry([...L.BUILT_IN_THEMES, custom]);
a("自訂主題 id 有效", L.isValidThemeId("my-custom"));
L.applyTheme("my-custom");
a("套用自訂主題：--teal #0b5cad", getVar("--teal") === "#0b5cad");
a("自訂主題在可見清單", L.visibleThemes().some((t) => t.id === "my-custom"));

// 無效 id 退回 green-2
L.applyTheme("does-not-exist");
a("無效 id 退回 green-2", root.dataset.theme === "green-2");
a("無效 id 後 --teal 回 #0f766e", getVar("--teal") === "#0f766e");

// 隱藏主題不進可見清單
L.setThemeRegistry(
  L.BUILT_IN_THEMES.map((t) =>
    t.id === "paw-orange" ? { ...t, hidden: true } : t,
  ),
);
a("隱藏主題不進可見清單", !L.visibleThemes().some((t) => t.id === "paw-orange"));
a("可見清單剩 8 套", L.visibleThemes().length === 8);

// 7. 深色模式：底色不被 inline 蓋掉（removeProperty 後 dark 區塊接管）
L.setThemeRegistry(L.BUILT_IN_THEMES);
dom.window.localStorage.setItem("qi-ui-mode", "dark");
root.dataset.mode = "dark"; // 模擬 applyUiPrefs() 的行為
L.applyTheme("printmax-green");
a("深色：--teal 仍寫入 #0e856c", getVar("--teal") === "#0e856c");
a(
  "深色：inline --bg 已移除",
  root.style.getPropertyValue("--bg") === "",
);
a(
  "深色：計算 --bg 由 dark 區塊接管 #0e1518",
  getVar("--bg") === "#0e1518",
);
a(
  "深色：inline --surface 已移除",
  root.style.getPropertyValue("--surface") === "",
);
dom.window.localStorage.removeItem("qi-ui-mode");
delete root.dataset.mode;
L.applyTheme("printmax-green");
a("切回淺色：--bg 恢復 #eef8f1", getVar("--bg") === "#eef8f1");

// 8. normalizeThemeDef：缺欄位以同 id 內建值補齊
const partial = L.normalizeThemeDef("edu-blue", { teal: "#111111" });
a("normalize：缺欄位補內建 tealDeep", partial.tealDeep === "#3a0ca3");
a("normalize：有給的欄位保留", partial.teal === "#111111");

// 9. demo 種子：uiThemes 9 套透傳
const demo = L.getDemoData();
a("demo 有 uiThemes 種子", !!demo.uiThemes);
a(
  "demo uiThemes 9 套",
  demo.uiThemes && Object.keys(demo.uiThemes).length === 9,
);
a(
  "demo printmax-green 已重調",
  demo.uiThemes?.["printmax-green"]?.teal === "#0e856c",
);

// 10. firestore.rules：uiThemes 登入可讀、管理員可寫
const rules = readFileSync(resolve(ROOT, "firestore.rules"), "utf8");
a("rules 有 uiThemes match", rules.includes("match /uiThemes/{id}"));
a(
  "rules uiThemes 管理員可寫",
  /match \/uiThemes\/\{id\} \{[^}]*allow create, update, delete: if isAdmin\(\);/s.test(
    rules,
  ),
);

// 11. 建置產物 dist 內含新殼層（若 dist 尚未建置則跳過此項）
const distCss = existsSync(resolve(ROOT, "dist/assets"))
  ? readdirSync(resolve(ROOT, "dist/assets")).filter((x) => x.endsWith(".css"))
  : [];
a(
  "dist CSS 無寫死 data-theme 且含 --radius-btn",
  distCss.length > 0 &&
    distCss.some(
      (x) =>
        !readFileSync(resolve(ROOT, "dist/assets", x), "utf8").includes(
          ":root[data-theme",
        ) &&
        readFileSync(resolve(ROOT, "dist/assets", x), "utf8").includes(
          "--radius-btn",
        ),
    ),
);

console.log(f ? `failed ${f}` : "v1.32：全部通過");
process.exit(f ? 1 : 0);
