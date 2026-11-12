import { useCallback, useEffect, useMemo, useState } from "react";
import { collection } from "./db";
import { getFirebaseDb } from "./firebase";
import { getCachedRefCollection } from "./refCache";
import { getDocsCacheFirst } from "./cacheFirst";
import { useAuth } from "./auth";
import {
  ADMIN_ONLY_PERM_KEYS,
  can as evaluatePermission,
  parsePermissions,
  parseTemplateCategory,
  templateKey,
  type PermissionCatalog,
  type PermKey,
} from "./permissions";

/**
 * 空 catalog（v1.38.0 範本制：無範本＝無權限）。
 * 無範本的角色／職稱權限一律為空，不再按角色名給預設值；
 * 系統管理員另有 bypass，不受此影響。
 * v1.39.0：catalog 不再含角色／職稱文件（判斷不讀它們），改含
 * 單位→群組對照（單位角色不跨單位時比對用）。
 */
const emptyCatalog = (): PermissionCatalog => ({
  templates: {},
  unitGroups: {},
});

export function usePermissions() {
  const { user } = useAuth();
  const [catalog, setCatalog] = useState<PermissionCatalog>(emptyCatalog);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!user?.staffId) {
      setCatalog(emptyCatalog());
      setReady(false);
      return () => {
        cancelled = true;
      };
    }
    setReady(false);
    Promise.all([
      getCachedRefCollection("permissionTemplates", () =>
        getDocsCacheFirst(collection(getFirebaseDb(), "permissionTemplates")),
      ),
      getCachedRefCollection("units", () =>
        getDocsCacheFirst(collection(getFirebaseDb(), "units")),
      ),
    ])
      .then(([templateSnapshot, unitSnapshot]) => {
        if (cancelled) return;
        const next = emptyCatalog();
        templateSnapshot.docs.forEach((document) => {
          const data = document.data() as Record<string, unknown>;
          const category = parseTemplateCategory(data.category);
          const name = typeof data.name === "string" ? data.name : "";
          if (!category || !name) return;
          next.templates[templateKey(category, name)] = {
            category,
            name,
            permissions: parsePermissions(data.permissions),
            cross: data.cross === true,
          };
        });
        unitSnapshot.docs.forEach((document) => {
          const data = document.data() as Record<string, unknown>;
          const groupId = typeof data.groupId === "string" ? data.groupId : "";
          if (groupId) next.unitGroups[document.id] = groupId;
        });
        setCatalog(next);
      })
      .catch(() => {
        // Fail closed for non-admins. System administrator retains the emergency bypass.
        setCatalog(emptyCatalog());
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.staffId]);

  const permUser = useMemo(
    () =>
      user
        ? {
            roles: user.roles ?? [],
            memberships: user.memberships ?? [],
            title: user.title ?? "",
            titleId: user.titleId ?? "",
            unitCode: user.unitCode ?? "",
          }
        : undefined,
    [user],
  );
  const isAdmin = (user?.roles ?? []).includes("系統管理員");

  const can = useCallback(
    (key: PermKey, groupId?: string) => {
      // v1.56.0：組織與設定專屬鍵（群組與人員／系統管理／權限管理／管理角色與權限）
      // 只限系統管理員。權限頁永不列出這些鍵，但舊範本可能仍勾著殘留值，
      // 範本交集不可再放行非管理員；導覽顯示與路由守衛都走 can()，一併收掉。
      if ((ADMIN_ONLY_PERM_KEYS as readonly string[]).includes(key)) {
        return isAdmin;
      }
      return isAdmin || evaluatePermission(permUser, key, catalog, groupId);
    },
    [isAdmin, permUser, catalog],
  );

  return {
    can,
    ready,
    isAdmin,
    catalog,
  };
}
