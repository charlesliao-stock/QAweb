/**
 * 角色身分推導（v1.57.0 A3：移除角色文件的 category／kind 欄位，
 * 改由層級＋名稱關鍵字推導）。
 *
 * 身分（category）：只看角色名稱關鍵字，依下列順序判定
 * - 含「召集人」→召集人；
 * - 含「執行幹事」或「執行秘書」→執行幹事（委員會執行秘書維持執行幹事）；
 * - 含「審查員」→審查員；
 * - 其餘→一般。
 *
 * 範圍（scope）：層級優先（層級名稱／層級 id 對照），無層級資料時
 * 退回名稱推導（含「單位」→單位角色，其餘→群組角色；與舊
 * legacyRoleScope 一致）。
 *
 * 注意——與定案目標模型的差異（跨區另議，不在此版）：
 * 目標模型說委員會層級＝全院，但現行 RoleScope 只有 group／unit
 * 兩值，且 readReviewRecords／AuditPage／TaskHandoffPage／
 * dashboardVariant 都把召集人／執行幹事視為群組範圍；把委員會
 * 升為全院會改變現行資料可視範圍，故此版委員會仍推導為 group
 *（現行有效行為），全院化留待跨區定案後再做。
 *
 * 本檔零依賴、不碰 Firestore，可在 node 直接單元測試。
 * 角色身分關鍵字只出現在此檔，各處一律引用，不得另寫一份。
 */

import type { RoleCategory, RoleScope } from "./orgMeta";

/** 層級名稱 → 範圍（現行有效行為；委員會＝群組，見檔頭說明）。 */
export const ROLE_LEVEL_SCOPE_BY_NAME: Readonly<Record<string, RoleScope>> = {
  委員會: "group",
  品管組: "group",
  單位: "unit",
};

/** 預設層級 id → 範圍（與 DEFAULT_ROLE_LEVELS 的 id 對應）。 */
export const ROLE_LEVEL_SCOPE_BY_ID: Readonly<Record<string, RoleScope>> = {
  "rl-committee": "group",
  "rl-qi": "group",
  "rl-unit": "unit",
};

/** 角色名稱 → 身分（關鍵字包含判定，非精確比對）。 */
export function deriveRoleCategory(name: string): RoleCategory {
  const n = name ?? "";
  if (n.includes("召集人")) return "convener";
  if (n.includes("執行幹事") || n.includes("執行秘書")) return "officer";
  if (n.includes("審查員")) return "reviewer";
  return "general";
}

export interface RoleScopeSource {
  levelId?: unknown;
  levelName?: unknown;
  name: string;
}

/** 層級 → 範圍：層級名稱優先、其次層級 id；對不上的自訂層級回傳 undefined。 */
export function deriveRoleScopeFromLevel(
  levelId?: unknown,
  levelName?: unknown,
): RoleScope | undefined {
  if (
    typeof levelName === "string" &&
    Object.prototype.hasOwnProperty.call(ROLE_LEVEL_SCOPE_BY_NAME, levelName)
  ) {
    return ROLE_LEVEL_SCOPE_BY_NAME[levelName];
  }
  if (
    typeof levelId === "string" &&
    Object.prototype.hasOwnProperty.call(ROLE_LEVEL_SCOPE_BY_ID, levelId)
  ) {
    return ROLE_LEVEL_SCOPE_BY_ID[levelId];
  }
  return undefined;
}

/**
 * 角色適用範圍：層級優先；無層級資料（未分層級／自訂層級）時
 * 退回名稱推導——含「單位」→單位角色，其餘→群組角色。
 */
export function deriveRoleScope(input: RoleScopeSource): RoleScope {
  return (
    deriveRoleScopeFromLevel(input.levelId, input.levelName) ??
    (input.name.includes("單位") ? "unit" : "group")
  );
}
