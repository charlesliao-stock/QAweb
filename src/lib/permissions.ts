/**
 * 權限模型（v1.12.1：移轉語義）。
 * 角色定義存於 Firestore `roles` 集合（permissions 欄位）；
 * 職稱（titles）的 permissions 欄位採移轉語義：
 *   欄位不存在／null（從未設定過）→ 只看角色聯集；
 *   欄位存在（即使全 false，代表曾儲存過矩陣）→ 嚴格交集（角色聯集 AND 職稱）。
 * 目的：避免上線第一天所有人被交集鎖死（既有職稱都沒設定過權限）。
 */

/** 5 個功能權限鍵（沿用系統管理頁原 5 列矩陣） */
export const PERM_KEYS = [
  "resultQuery",
  "viewPhotos",
  "manageSchedule",
  "editSubmitted",
  "manageRoles",
] as const;

export type PermKey = (typeof PERM_KEYS)[number];

export const PERM_LABELS: Record<PermKey, string> = {
  resultQuery: "結果查詢",
  viewPhotos: "檢視審查照片",
  manageSchedule: "排程建立／改派",
  editSubmitted: "修改已提交審查",
  manageRoles: "管理角色與權限",
};

/** 單一角色的功能權限表（key→bool；缺鍵視為 false） */
export type RolePermissions = Partial<Record<PermKey, boolean>>;

/** 全 false（新增角色預設值） */
export function emptyPermissions(): Record<PermKey, boolean> {
  return {
    resultQuery: false,
    viewPhotos: false,
    manageSchedule: false,
    editSubmitted: false,
    manageRoles: false,
  };
}

/**
 * 7 個預設角色的權限基線（由系統管理頁原寫死矩陣轉換；bool 化）。
 * 供 Firestore 上該角色尚無 permissions 欄位時的相容預設。
 */
export const DEFAULT_ROLE_PERMS: Record<string, RolePermissions> = {
  一般人員: { resultQuery: true },
  審查員: { resultQuery: true, viewPhotos: true, editSubmitted: true },
  護理長: { resultQuery: true, viewPhotos: true },
  督導: { resultQuery: true, viewPhotos: true },
  品管執行幹事: {
    resultQuery: true,
    viewPhotos: true,
    manageSchedule: true,
    editSubmitted: true,
  },
  系統管理員: {
    resultQuery: true,
    viewPhotos: true,
    manageSchedule: true,
    editSubmitted: true,
    manageRoles: true,
  },
  指標負責人: { resultQuery: true },
  /** 召集人（v1.16.0）：可建立／改派排程（分組限縮下一版再加） */
  召集人: { resultQuery: true, manageSchedule: true },
  // v1.21：新角色預設權限＝對應舊角色（單位級無排程權限）
  品管組審查員: { resultQuery: true, viewPhotos: true, editSubmitted: true },
  單位審查員: { resultQuery: true, viewPhotos: true, editSubmitted: true },
  品管組召集人: { resultQuery: true, manageSchedule: true },
  品管組執行幹事: {
    resultQuery: true,
    viewPhotos: true,
    manageSchedule: true,
    editSubmitted: true,
  },
  單位召集人: { resultQuery: true },
  單位執行幹事: { resultQuery: true, viewPhotos: true, editSubmitted: true },
};

/** 防禦性解析 roles/titles 文件的 permissions 欄位 */
export function parsePermissions(raw: unknown): RolePermissions {
  const out: RolePermissions = {};
  if (raw && typeof raw === "object") {
    for (const k of PERM_KEYS) {
      const v = (raw as Record<string, unknown>)[k];
      if (v === true) out[k] = true;
      else if (v === false) out[k] = false;
    }
  }
  return out;
}

/**
 * 單一權限判斷（純函式）：只看角色，多重角色取聯集。
 * rolePerms：角色名稱 → 該角色的權限表（Firestore 讀取結果）；
 * 角色不在表中或缺鍵時，退回 DEFAULT_ROLE_PERMS（舊資料相容）。
 */
export function canByRoles(
  userRoles: string[],
  permKey: PermKey,
  rolePerms: Record<string, RolePermissions>,
): boolean {
  return userRoles.some((r) => {
    const p = rolePerms[r] ?? DEFAULT_ROLE_PERMS[r];
    return p?.[permKey] === true;
  });
}

/** 權限判斷用的使用者身分（角色＋職稱） */
export interface PermUser {
  roles: string[];
  /** 職稱名稱；""＝無職稱 */
  title: string;
}

/**
 * 單一權限判斷（純函式，v1.12.1：移轉語義）。
 * - 無角色，或無職稱（人員沒填職稱，title === ""）→ 視為無該權限
 * - 職稱「從未設定過權限」（titles 文件無 permissions 欄位／null，
 *   即 titleConfigured[title] 非 true）→ 移轉期：只看角色聯集
 * - 職稱「曾儲存過權限矩陣」（欄位存在，即使全 false）→ 嚴格交集：
 *   （多重角色取聯集有該權限）AND（職稱有該權限）
 *
 * titlePermsByName：職稱名稱 → 該職稱的權限表（Firestore titles 集合）；
 * titleConfigured：職稱名稱 → 是否曾儲存過權限矩陣（缺鍵＝未設定；
 *   整個參數省略時視為全部未設定＝只看角色）。
 */
export function can(
  user: PermUser | null | undefined,
  permKey: PermKey,
  rolePerms: Record<string, RolePermissions>,
  titlePermsByName: Record<string, RolePermissions>,
  titleConfigured?: Record<string, boolean>,
): boolean {
  if (!user || user.roles.length === 0) return false;
  if (!user.title) return false;
  if (!canByRoles(user.roles, permKey, rolePerms)) return false;
  if (titleConfigured?.[user.title] !== true) return true;
  return titlePermsByName[user.title]?.[permKey] === true;
}
