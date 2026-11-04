/**
 * 系統版本（集中管理，單一來源）。
 *
 * bump 規則（由負責推送的人在每次功能更新時更新）：
 * - 小修（bug 修復、文案調整、樣式微調）→ patch，例如 1.4.0 → 1.4.1
 * - 新增功能（新頁面、新欄位、新流程）→ minor，例如 1.4.0 → 1.5.0
 * - 重大變更（資料結構、權限模型改變）→ major，例如 1.4.0 → 2.0.0
 * BUILD_DATE 請填實際推送日期（YYYY-MM-DD）。
 *
 * 顯示位置：側邊欄底部（登入後）＋ 登入頁頁尾。
 */
export const VERSION = "1.16.0";
export const BUILD_DATE = "2026-11-05";

/** 畫面顯示用字串，例如「v1.4.0（2026-11-03）」 */
export const VERSION_LABEL = `v${VERSION}（${BUILD_DATE}）`;
