import type { PageId, Role } from "../types";

/**
 * 展示用的角色可見頁面對照。僅影響導覽與畫面，不是授權機制；
 * 正式版必須由後端（Firebase Auth 與 Security Rules）強制執行。
 */
export const ROLE_PAGES: Record<Role, readonly PageId[]> = {
  一般人員: ["dashboard", "results"],
  審查員: ["dashboard", "schedule", "audit", "results"],
  護理長: ["dashboard", "indicators", "schedule", "results", "capa"],
  主任: ["dashboard", "indicators", "schedule", "results", "capa", "groups"],
  副主任: ["dashboard", "indicators", "schedule", "results", "capa", "groups"],
  督導: ["dashboard", "indicators", "schedule", "results", "capa", "groups"],
  各組召集人: [
    "dashboard",
    "indicators",
    "schedule",
    "audit",
    "results",
    "capa",
    "groups",
  ],
  執行幹事: [
    "dashboard",
    "indicators",
    "schedule",
    "audit",
    "results",
    "capa",
    "groups",
  ],
  品管執行幹事: [
    "dashboard",
    "indicators",
    "schedule",
    "audit",
    "results",
    "capa",
    "groups",
  ],
  系統管理員: [
    "dashboard",
    "indicators",
    "schedule",
    "audit",
    "results",
    "capa",
    "groups",
    "admin",
  ],
  指標負責人: ["dashboard", "indicators", "schedule", "results", "capa"],
  // v1.21：新角色（展示用導覽對照；正式授權見 lib/roleIdentity）
  品管組召集人: [
    "dashboard",
    "indicators",
    "schedule",
    "audit",
    "results",
    "capa",
    "groups",
  ],
  品管組執行幹事: [
    "dashboard",
    "indicators",
    "schedule",
    "audit",
    "results",
    "capa",
    "groups",
  ],
  品管組審查員: ["dashboard", "schedule", "audit", "results"],
  單位召集人: ["dashboard", "schedule", "audit", "results"],
  單位執行幹事: ["dashboard", "schedule", "audit", "results"],
  單位審查員: ["dashboard", "schedule", "audit", "results"],
};

export function canView(role: Role, page: PageId): boolean {
  return ROLE_PAGES[role].includes(page);
}
