/**
 * 審查頁版面切換（v1.88.10）：右上角「自動／電腦版／移動版」。
 *
 * 背景：手機／平板樣式原先只靠 `@media (max-width: 1100px)` 生效； iPad 橫放寬度
 * 1180px 起跳（Air 11 吋 1180、Pro 11 吋 1194、Pro 12.9 吋 1366）超過 1100px，
 * 所以走電腦版。切換後不再只看寬度，改由 `:root[data-layout="mobile"]` 決定
 * 是否套用手機／平板那套樣式（CSS 已由寬度媒體查詢改為屬性判斷）。
 *
 * 選擇記在 localStorage，下次開啟沿用；「自動」＝依寬度判斷（預設行為），
 * 隨時可切回，不會卡死在某個版面。切換範圍僅審查表單頁本身，不動側邊欄／
 * 手機導覽（760px 斷點維持寬度判斷）。
 */

export type LayoutMode = "auto" | "mobile" | "desktop";

export const LAYOUT_MODE_STORAGE_KEY = "qaweb:layout-mode:v1";

/** 手機／平板版面的寬度門檻（與舊媒體查詢一致）。 */
export const MOBILE_LAYOUT_QUERY = "(max-width: 1100px)";

export function parseLayoutMode(value: unknown): LayoutMode {
  return value === "mobile" || value === "desktop" || value === "auto" ? value : "auto";
}

export function getStoredLayoutMode(
  storage: Pick<Storage, "getItem"> | null | undefined = typeof window === "undefined"
    ? undefined
    : window.localStorage,
): LayoutMode {
  try {
    return parseLayoutMode(storage?.getItem(LAYOUT_MODE_STORAGE_KEY) ?? null);
  } catch {
    return "auto";
  }
}

export function storeLayoutMode(
  mode: LayoutMode,
  storage: Pick<Storage, "setItem"> | null | undefined = typeof window === "undefined"
    ? undefined
    : window.localStorage,
): void {
  try {
    storage?.setItem(LAYOUT_MODE_STORAGE_KEY, mode);
  } catch {
    /* 無痕模式等寫入失敗時不阻擋切換 */
  }
}

/** 是否套用手機／平板版面：移動版一律套用；自動依寬度；電腦版不強制套用。 */
export function isMobileLayout(mode: LayoutMode, widthIsMobile: boolean): boolean {
  return mode === "mobile" || (mode === "auto" && widthIsMobile);
}

export function applyLayoutMode(
  root: { setAttribute: (name: string, value: string) => void; removeAttribute: (name: string) => void },
  mode: LayoutMode,
  widthIsMobile: boolean,
): void {
  if (isMobileLayout(mode, widthIsMobile)) root.setAttribute("data-layout", "mobile");
  else root.removeAttribute("data-layout");
}
