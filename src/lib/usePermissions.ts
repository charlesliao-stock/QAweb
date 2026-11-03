/**
 * 權限 hook（v1.12.0：交集語義）。
 * 載入 roles＋titles 集合，提供 can(permKey)：
 * （多重角色取聯集有該權限）AND（職稱有該權限）；
 * 無角色或無職稱者視為無該權限。
 */
import { useCallback, useEffect, useState } from "react";
import { collection, getDocs } from "./db";
import { getFirebaseDb } from "./firebase";
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
  // 職稱權限：無程式預設值，缺＝無權限（v1.12.0 定案）
  const [titlePerms, setTitlePerms] = useState<Record<string, RolePermissions>>(
    {},
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getDocs(collection(getFirebaseDb(), "roles")),
      getDocs(collection(getFirebaseDb(), "titles")),
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
        tsnap.docs.forEach((d) => {
          const data = d.data() as Record<string, unknown>;
          const name = typeof data.name === "string" ? data.name : d.id;
          const parsed = parsePermissions(data.permissions);
          // 同名職稱（例：群組/單位層級的「執行幹事」）取聯集
          tp[name] = { ...(tp[name] ?? {}), ...parsed };
        });
        setTitlePerms(tp);
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

  const canDo = useCallback(
    (key: PermKey) => can(permUser, key, rolePerms, titlePerms),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.roles, user?.title, rolePerms, titlePerms],
  );

  return { can: canDo, rolePerms, titlePerms };
}
