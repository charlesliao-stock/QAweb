/**
 * 系統版本（集中管理，單一來源）。
 *
 * bump 規則（每次更新推送前都要同步版次與日期）：
 * - 小修（bug 修復、文案調整、樣式微調）→ patch，例如 1.4.0 → 1.4.1
 * - 新增功能（新頁面、新欄位、新流程）→ minor，例如 1.4.0 → 1.5.0
 * - 重大變更（資料結構、權限模型改變）→ major，例如 1.4.0 → 2.0.0
 * src/version.ts 的 VERSION 與 package.json version 必須一致；BUILD_DATE 填實際 GitHub 推送日期（YYYY-MM-DD）。
 *
 * 顯示位置：側邊欄底部（登入後）＋ 登入頁頁尾。
 */
export const VERSION = "1.50.0";
export const BUILD_DATE = "2026-11-11";

/** 畫面顯示用字串，例如「v1.4.0（2026-11-03）」 */
export const VERSION_LABEL = `v${VERSION}（${BUILD_DATE}）`;
