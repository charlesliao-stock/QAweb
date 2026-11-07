/**
 * UI 個人化：個人顯示設定（瀏覽器本機）＋ 主題配色套用（全院統一）。
 * RAG 燈號顏色不在此調整（全院統一標準）。
 *
 * v1.32.0：主題改資料驅動（設計 v2）。applyTheme 簽名不變，但有效主題改為
 * 查 themeRegistry（Firestore uiThemes＋內建 fallback），不再有寫死白名單
 *（根治 v1.31.0 白名單 bug：新主題存得到、選得到、套不上）。
 * 套用方式改 JS 動態寫 CSS 變數（inline style），不再依賴 :root[data-theme]。
 */
import { getThemeDef, themeToCssVars } from "./themeRegistry";

export type FontSizeOption = "standard" | "large" | "xlarge";
export type ColorModeOption = "light" | "dark";

const FONT_KEY = "qi-ui-font";
const MODE_KEY = "qi-ui-mode";

/** 依 styles.css 字體單位（px 為主）採 body zoom 縮放 */
const FONT_ZOOM: Record<FontSizeOption, number> = {
  standard: 1,
  large: 1.125,
  xlarge: 1.25,
};

export const FONT_SIZE_LABELS: Record<FontSizeOption, string> = {
  standard: "標準",
  large: "大",
  xlarge: "特大",
};

export function getFontSize(): FontSizeOption {
  const v = localStorage.getItem(FONT_KEY);
  return v === "large" || v === "xlarge" ? v : "standard";
}

export function setFontSize(v: FontSizeOption): void {
  localStorage.setItem(FONT_KEY, v);
  applyUiPrefs();
}

export function getColorMode(): ColorModeOption {
  return localStorage.getItem(MODE_KEY) === "dark" ? "dark" : "light";
}

/** 目前套用的主題 id（切換深色時重套同一主題用）。 */
let currentThemeId = "green-2";

export function getCurrentThemeId(): string {
  return currentThemeId;
}

export function setColorMode(v: ColorModeOption): void {
  localStorage.setItem(MODE_KEY, v);
  applyUiPrefs();
  // 深色切換會改變底色接管規則，需重套目前主題（dark-aware 底色邏輯在 applyTheme）
  applyTheme(currentThemeId);
}

/** 套用本機顯示設定（字體縮放＋深色模式）。登入前後皆可呼叫。 */
export function applyUiPrefs(): void {
  if (typeof document === "undefined") return;
  const zoom = FONT_ZOOM[getFontSize()];
  document.body.style.zoom = zoom === 1 ? "" : String(zoom);
  if (getColorMode() === "dark") {
    document.documentElement.dataset.mode = "dark";
  } else {
    delete document.documentElement.dataset.mode;
  }
}

/**
 * 套用全院主題配色（管理員於系統參數設定）。
 * 查無 id 時退回 green-2；連 green-2 都查無時只設 dataset.theme，
 * 靠 :root 預設值撐住。
 *
 * 深色模式關鍵：setProperty 寫的是 inline style，優先權高於
 * :root[data-mode="dark"] 的 stylesheet 規則。故底色變數（--bg／--surface）
 * 只在淺色模式寫入；深色模式時 removeProperty，讓 dark 區塊接管。
 * 色相變數（主色／輔色／圓角／光暈／漸層）永遠寫入。
 */
export function applyTheme(themeId: string): void {
  if (typeof document === "undefined") return;
  const def = getThemeDef(themeId) ?? getThemeDef("green-2");
  const root = document.documentElement;
  if (!def) {
    root.dataset.theme = "green-2";
    return;
  }
  currentThemeId = def.id;
  root.dataset.theme = def.id;
  const vars = themeToCssVars(def);
  const dark = getColorMode() === "dark";
  for (const [name, value] of Object.entries(vars)) {
    if (name === "--bg" || name === "--surface") continue;
    root.style.setProperty(name, value);
  }
  if (dark) {
    root.style.removeProperty("--bg");
    root.style.removeProperty("--surface");
  } else {
    root.style.setProperty("--bg", def.bg);
    root.style.setProperty("--surface", "#ffffff");
  }
}
