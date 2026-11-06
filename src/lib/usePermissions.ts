/**
 * 權限 hook（v1.12.1：移轉語義；v1.12.2：系統管理員 bypass）。
 * 載入 roles＋titles 集合，提供 can(permKey)：
 * - 系統管理員（roles 含「系統管理員」）→ 全部放行（bypass）
 * - 無角色／無職稱（人員沒填）→ 無權限
 * - 職稱從未設定過權限（titles 文件無 permissions 欄位）→ 只看角色聯集
 * - 職稱曾儲存過權限矩陣 → 嚴格交集（角色聯集 AND 職稱）
 */
import { useCallback, useEffect, useState } from "react";
import { collection, getDocs } from "./db";
import { getFirebaseDb } from "./firebase";
import { getCachedRefCollection } from "./refCache";
import { useAuth } from "./auth";
import {
  DEFAULT_ROLE_PERMS,
  can,
  parsePermissions,
  type PermKey,
  type PermUser,
  type RolePermissions,
} from "./permissions";

export function usePermissions() {
  const { user } = useAuth();
  // 先以預設基線提供判斷，Firestore 讀回後再疊加自訂值（避免載入中閃爍）
  const [rolePerms, setRolePerms] =
    useState<Record<string, RolePermissions>>(DEFAULT_ROLE_PERMS);
  // 職稱權限：無程式預設值；另追蹤各職稱是否「曾儲存過」權限矩陣
  //（permissions 欄位存在才算設定過，有別於明確存成全 false）
  const [titlePerms, setTitlePerms] = useState<Record<string, RolePermissions>>(
    {},
  );
  const [titleConfigured, setTitleConfigured] = useState<
    Record<string, boolean>
  >({});

  useEffect(() => {
    let cancelled = false;
    // v1.28 階段 4：roles／titles 走參考資料共用快取（跨頁只讀一次，
    // 自己寫入後由 db.ts 統一出口自動失效；demo 模式不快取）
    Promise.all([
      getCachedRefCollection("roles", () =>
        getDocs(collection(getFirebaseDb(), "roles")),
      ),
      getCachedRefCollection("titles", () =>
        getDocs(collection(getFirebaseDb(), "titles")),
      ),
    ])
      .then(([rsnap, tsnap]) => {
        if (cancelled) return;
        const rp: Record<string, RolePermissions> = {
          ...DEFAULT_ROLE_PERMS,
        };
        rsnap.docs.forEach((d) => {
          const data = d.data() as Record<string, unknown>;
          const name = typeof data.name === "string" ? data.name : d.id;
          rp[name] = {
            ...(DEFAULT_ROLE_PERMS[name] ?? {}),
            ...parsePermissions(data.permissions),
          };
        });
        setRolePerms(rp);
        const tp: Record<string, RolePermissions> = {};
        const tc: Record<string, boolean> = {};
        tsnap.docs.forEach((d) => {
          const data = d.data() as Record<string, unknown>;
          const name = typeof data.name === "string" ? data.name : d.id;
          const parsed = parsePermissions(data.permissions);
          // 同名職稱（例：群組/單位層級的「執行幹事」）取聯集
          tp[name] = { ...(tp[name] ?? {}), ...parsed };
          // 任一同名文件曾存過 permissions 欄位即視為已設定
          if (data.permissions !== undefined && data.permissions !== null) {
            tc[name] = true;
          }
        });
        setTitlePerms(tp);
        setTitleConfigured(tc);
      })
      .catch(() => {
        /* 讀不到就沿用預設基線 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const permUser: PermUser | undefined = user
    ? { roles: user.roles ?? [], title: user.title ?? "" }
    : undefined;
  // 系統管理員權限最大：直接放行所有功能（v1.12.2）
  //（既有管理員判定邏輯：roles 含「系統管理員」；沿用 GroupsPage/AdminPage 的寫法）
  const isAdmin = (user?.roles ?? []).includes("系統管理員");

  const canDo = useCallback(
    (key: PermKey) =>
      isAdmin || can(permUser, key, rolePerms, titlePerms, titleConfigured),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isAdmin, user?.roles, user?.title, rolePerms, titlePerms, titleConfigured],
  );

  return { can: canDo, rolePerms, titlePerms, titleConfigured };
}
