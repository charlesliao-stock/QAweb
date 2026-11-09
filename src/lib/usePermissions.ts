import { useCallback, useEffect, useMemo, useState } from "react";
import { collection } from "./db";
import { getFirebaseDb } from "./firebase";
import { getCachedRefCollection } from "./refCache";
import { getDocsCacheFirst } from "./cacheFirst";
import { useAuth } from "./auth";
import {
  can as evaluatePermission,
  parsePermissions,
  parseRoleKind,
  parseTemplateCategory,
  templateKey,
  type PermissionCatalog,
  type PermKey,
} from "./permissions";

/**
 * 空 catalog（v1.38.0 範本制：無範本＝無權限）。
 * 無範本的角色／職稱權限一律為空，不再按角色名給預設值；
 * 系統管理員另有 bypass，不受此影響。
 */
const emptyCatalog = (): PermissionCatalog => ({
  templates: {},
  roleDocs: {},
  titleDocs: [],
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
      getCachedRefCollection("roles", () =>
        getDocsCacheFirst(collection(getFirebaseDb(), "roles")),
      ),
      getCachedRefCollection("titles", () =>
        getDocsCacheFirst(collection(getFirebaseDb(), "titles")),
      ),
    ])
      .then(([templateSnapshot, roleSnapshot, titleSnapshot]) => {
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
        roleSnapshot.docs.forEach((document) => {
          const data = document.data() as Record<string, unknown>;
          const name = typeof data.name === "string" ? data.name : document.id;
          const groupId = typeof data.groupId === "string" ? data.groupId : "";
          const unitCode = typeof data.unitCode === "string" ? data.unitCode : "";
          const meta = { kind: parseRoleKind(data.kind, groupId), groupId, unitCode };
          const list = next.roleDocs[name] ?? [];
          list.push(meta);
          next.roleDocs[name] = list;
        });
        next.titleDocs = titleSnapshot.docs.map((document) => {
          const data = document.data() as Record<string, unknown>;
          const unitCodes = Array.isArray(data.unitCodes)
            ? data.unitCodes.map(String).filter(Boolean)
            : [];
          return {
            id: document.id,
            name: typeof data.name === "string" ? data.name : document.id,
            unitCodes,
          };
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
    (key: PermKey, groupId?: string) =>
      isAdmin || evaluatePermission(permUser, key, catalog, groupId),
    [isAdmin, permUser, catalog],
  );

  return {
    can,
    ready,
    isAdmin,
    catalog,
  };
}
