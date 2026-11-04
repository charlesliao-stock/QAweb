/**
 * UI 個人化：個人顯示設定（瀏覽器本機）＋ 主題配色套用（全院統一）。
 * RAG 燈號顏色不在此調整（全院統一標準）。
 */

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

export function setColorMode(v: ColorModeOption): void {
  localStorage.setItem(MODE_KEY, v);
  applyUiPrefs();
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
 * 無效值時退回預設 green-2。
 */
export function applyTheme(themeId: string): void {
  if (typeof document === "undefined") return;
  const valid = ["green-2", "blue-3", "teal-orange-3", "purple-4"];
  document.documentElement.dataset.theme = valid.includes(themeId)
    ? themeId
    : "green-2";
}
