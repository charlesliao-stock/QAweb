import { useCallback, useEffect, useMemo, useState } from "react";
import { collection } from "./db";
import { getFirebaseDb } from "./firebase";
import { getCachedRefCollection } from "./refCache";
import { getDocsCacheFirst } from "./cacheFirst";
import { useAuth } from "./auth";
import {
  DEFAULT_ROLE_PERMS,
  PERM_KEYS,
  can as evaluatePermission,
  defaultRolePermissions,
  parsePermissions,
  parseScopeMode,
  scopedRoleKey,
  type PermKey,
  type PermissionCatalog,
  type PermissionTitleDefinition,
  type RolePermissions,
} from "./permissions";

const emptyCatalog = (): PermissionCatalog => ({
  globalRolePerms: Object.fromEntries(
    Object.keys(DEFAULT_ROLE_PERMS).map((name) => [
      name,
      defaultRolePermissions(name),
    ]),
  ),
  groupRolePerms: {},
  roleScopes: {},
  titles: [],
});

function mergeStoredPermissions(
  defaults: Record<PermKey, boolean>,
  raw: unknown,
): Record<PermKey, boolean> {
  const merged = { ...defaults };
  if (!raw || typeof raw !== "object") return merged;
  const values = raw as Record<string, unknown>;
  for (const key of PERM_KEYS) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      merged[key] = values[key] === true;
    }
  }
  return merged;
}

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
      getCachedRefCollection("roles", () =>
        getDocsCacheFirst(collection(getFirebaseDb(), "roles")),
      ),
      getCachedRefCollection("titles", () =>
        getDocsCacheFirst(collection(getFirebaseDb(), "titles")),
      ),
    ])
      .then(([roleSnapshot, titleSnapshot]) => {
        if (cancelled) return;
        const next = emptyCatalog();
        roleSnapshot.docs.forEach((document) => {
          const data = document.data() as Record<string, unknown>;
          const name = typeof data.name === "string" ? data.name : document.id;
          const rolePermissions = mergeStoredPermissions(
            defaultRolePermissions(name),
            data.permissions,
          );
          const groupId = typeof data.groupId === "string" ? data.groupId : "";
          const roleUnitCodes = Array.isArray(data.unitCodes)
            ? data.unitCodes.map(String).filter(Boolean)
            : [];
          const roleScope = {
            scopeMode: parseScopeMode(data.scopeMode, roleUnitCodes),
            unitCodes: roleUnitCodes,
          };
          if (groupId) {
            next.groupRolePerms[scopedRoleKey(groupId, name)] = rolePermissions;
            next.roleScopes[scopedRoleKey(groupId, name)] = roleScope;
          } else {
            next.globalRolePerms[name] = rolePermissions;
            next.roleScopes[name] = roleScope;
            if (data.groupPermissionsByGroup && typeof data.groupPermissionsByGroup === "object") {
              Object.entries(data.groupPermissionsByGroup as Record<string, unknown>).forEach(
                ([scopedGroupId, rawPermissions]) => {
                  const groupOverrides = mergeStoredPermissions(rolePermissions, rawPermissions);
                  // v1.36.0：各群組覆寫值合併取交集——任一群組未勾選即不授權，不悄悄擴權。
                  const intersected = { ...rolePermissions };
                  for (const key of PERM_KEYS) {
                    intersected[key] = rolePermissions[key] === true && groupOverrides[key] === true;
                  }
                  next.groupRolePerms[scopedRoleKey(scopedGroupId, name)] = intersected;
                },
              );
            }
          }
        });
        next.titles = titleSnapshot.docs.map((document) => {
          const data = document.data() as Record<string, unknown>;
          const unitCodes = Array.isArray(data.unitCodes)
            ? data.unitCodes.map(String).filter(Boolean)
            : [];
          return {
            id: document.id,
            name: typeof data.name === "string" ? data.name : document.id,
            scopeMode: parseScopeMode(data.scopeMode, unitCodes),
            unitCodes,
            permissions: parsePermissions(data.permissions),
            configured: data.permissions !== undefined && data.permissions !== null,
          } satisfies PermissionTitleDefinition;
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

  const rolePerms = catalog.globalRolePerms;
  const titlePerms = useMemo(
    () => Object.fromEntries(catalog.titles.map((title) => [title.id, title.permissions])) as Record<string, RolePermissions>,
    [catalog.titles],
  );
  const titleConfigured = useMemo(
    () => Object.fromEntries(catalog.titles.map((title) => [title.id, title.configured])) as Record<string, boolean>,
    [catalog.titles],
  );

  return {
    can,
    ready,
    isAdmin,
    catalog,
    rolePerms,
    titlePerms,
    titleConfigured,
  };
}
