import { useCallback, useEffect, useMemo, useState } from "react";
import { collection } from "./db";
import { getFirebaseDb } from "./firebase";
import { getCachedRefCollection } from "./refCache";
import { getDocsCacheFirst } from "./cacheFirst";
import { useAuth } from "./auth";
import {
  PERM_KEYS,
  can as evaluatePermission,
  parseGroupScopeMode,
  parsePermissions,
  parseRoleKind,
  parseScopeMode,
  scopedRoleKey,
  type PermKey,
  type PermissionCatalog,
  type PermissionTitleDefinition,
  type RolePermissions,
} from "./permissions";

/**
 * 空 catalog（v1.37.0：無預設權限）。
 * 無 catalog 紀錄的角色／職稱權限一律為空，不再按角色名給預設值；
 * 系統管理員另有 bypass，不受此影響。
 */
const emptyCatalog = (): PermissionCatalog => ({
  globalRolePerms: {},
  groupRolePerms: {},
  groupRoleScopes: {},
  groupRolesByName: {},
  titles: [],
});

/** 群組覆寫值與全域基準取交集（v1.36.0 沿用）：任一群組未勾選即不授權。 */
function intersectPermissions(
  baseline: Record<PermKey, boolean>,
  raw: unknown,
): Record<PermKey, boolean> {
  const overrides = parsePermissions(raw);
  const out = { ...baseline };
  for (const key of PERM_KEYS) {
    out[key] = baseline[key] === true && overrides[key] === true;
  }
  return out;
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
          // 無 permissions 欄位＝尚未設定，零權限（不再套用角色名預設值）。
          const rolePermissions = parsePermissions(data.permissions);
          const groupId = typeof data.groupId === "string" ? data.groupId : "";
          const kind = parseRoleKind(data.kind, groupId);
          if (kind === "group" && groupId) {
            const scopedKey = scopedRoleKey(groupId, name);
            next.groupRolePerms[scopedKey] = rolePermissions;
            next.groupRoleScopes[scopedKey] = {
              groupScopeMode: parseGroupScopeMode(data.groupScopeMode),
              groupId,
            };
            const definitions = next.groupRolesByName[name] ?? [];
            definitions.push({
              groupId,
              groupScopeMode: parseGroupScopeMode(data.groupScopeMode),
              permissions: rolePermissions,
            });
            next.groupRolesByName[name] = definitions;
            if (data.groupPermissionsByGroup && typeof data.groupPermissionsByGroup === "object") {
              Object.entries(data.groupPermissionsByGroup as Record<string, unknown>).forEach(
                ([scopedGroupId, rawPermissions]) => {
                  next.groupRolePerms[scopedRoleKey(scopedGroupId, name)] =
                    intersectPermissions(rolePermissions, rawPermissions);
                },
              );
            }
          } else {
            next.globalRolePerms[name] = rolePermissions;
            if (data.groupPermissionsByGroup && typeof data.groupPermissionsByGroup === "object") {
              Object.entries(data.groupPermissionsByGroup as Record<string, unknown>).forEach(
                ([scopedGroupId, rawPermissions]) => {
                  next.groupRolePerms[scopedRoleKey(scopedGroupId, name)] =
                    intersectPermissions(rolePermissions, rawPermissions);
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
