import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { collection, doc, serverTimestamp, writeBatch } from "../lib/db";
import { getFirebaseDb } from "../lib/firebase";
import { getCachedRefCollection } from "../lib/refCache";
import { getDocsCacheFirst } from "../lib/cacheFirst";
import { useAuth } from "../lib/auth";
import { usePermissions } from "../lib/usePermissions";
import {
  ACTION_PERMISSION_ITEMS,
  emptyPermissions,
  PAGE_PERMISSION_ITEMS,
  PERM_KEYS,
  PERM_LABELS,
  parsePermissions,
  type PermKey,
} from "../lib/permissions";
import { isGroupScopedRole } from "../lib/roleIdentity";

type Scope = "global" | "group" | "unit";

interface GroupRow {
  id: string;
  name: string;
}

interface UnitRow {
  code: string;
  name: string;
}

interface RoleRow {
  id: string;
  name: string;
  description: string;
  groupId: string;
  permissions: Record<PermKey, boolean>;
  groupPermissionsByGroup: Record<string, Record<PermKey, boolean>>;
  isSeed: boolean;
}

interface TitleRow {
  id: string;
  name: string;
  level: string;
  unitCodes: string[];
  permissions: Record<PermKey, boolean>;
  configured: boolean;
}

function mergePermissionValues(
  defaults: Record<PermKey, boolean>,
  raw: unknown,
): Record<PermKey, boolean> {
  const result = { ...defaults };
  if (!raw || typeof raw !== "object") return result;
  const source = raw as Record<string, unknown>;
  for (const key of PERM_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      result[key] = source[key] === true;
    }
  }
  return result;
}

function emptyGroupOverrides(raw: unknown): Record<string, Record<PermKey, boolean>> {
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).map(([groupId, permissions]) => [
      groupId,
      parsePermissions(permissions),
    ]),
  );
}

function selectedRolePermissions(row: RoleRow, groupId: string): Record<PermKey, boolean> {
  if (row.groupId === groupId) return row.permissions;
  return row.groupPermissionsByGroup[groupId] ?? row.permissions;
}

export function PermissionManagementPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  const { user } = useAuth();
  const { isAdmin } = usePermissions();
  const [scope, setScope] = useState<Scope>("group");
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [titles, setTitles] = useState<TitleRow[]>([]);
  const [groupId, setGroupId] = useState("");
  const [unitCode, setUnitCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingCell, setSavingCell] = useState("");
  const [loadError, setLoadError] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const db = getFirebaseDb();
      const [roleSnapshot, groupSnapshot, unitSnapshot, titleSnapshot] = await Promise.all([
        getCachedRefCollection("roles", () => getDocsCacheFirst(collection(db, "roles"))),
        getCachedRefCollection("groups", () => getDocsCacheFirst(collection(db, "groups"))),
        getCachedRefCollection("units", () => getDocsCacheFirst(collection(db, "units"))),
        getCachedRefCollection("titles", () => getDocsCacheFirst(collection(db, "titles"))),
      ]);
      const groupRows = groupSnapshot.docs
        .map((item) => {
          const data = item.data() as Record<string, unknown>;
          return { id: item.id, name: typeof data.name === "string" ? data.name : item.id };
        })
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
      const unitRows = unitSnapshot.docs
        .map((item) => {
          const data = item.data() as Record<string, unknown>;
          const code = typeof data.code === "string" ? data.code : item.id;
          return { code, name: typeof data.name === "string" ? data.name : code };
        })
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
      const roleRows = roleSnapshot.docs
        .map((item) => {
          const data = item.data() as Record<string, unknown>;
          const name = typeof data.name === "string" ? data.name : item.id;
          return {
            id: item.id,
            name,
            description: typeof data.description === "string" ? data.description : "",
            groupId: typeof data.groupId === "string" ? data.groupId : "",
            permissions: mergePermissionValues(emptyPermissions(), data.permissions),
            groupPermissionsByGroup: emptyGroupOverrides(data.groupPermissionsByGroup),
            isSeed: data.isSeed === true,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
      const titleRows = titleSnapshot.docs
        .map((item) => {
          const data = item.data() as Record<string, unknown>;
          return {
            id: item.id,
            name: typeof data.name === "string" ? data.name : item.id,
            level: typeof data.level === "string" ? data.level : "",
            unitCodes: Array.isArray(data.unitCodes) ? data.unitCodes.map(String).filter(Boolean) : [],
            permissions: mergePermissionValues(emptyPermissions(), data.permissions),
            configured: data.permissions !== undefined && data.permissions !== null,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
      setGroups(groupRows);
      setUnits(unitRows);
      setRoles(roleRows);
      setTitles(titleRows);
      setGroupId((current) => current || groupRows[0]?.id || "");
      setUnitCode((current) => current || unitRows[0]?.code || "");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "讀取角色與職稱失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const scopedGroupRoles = useMemo(() => {
    if (!groupId) return [];
    const exact = roles.filter((row) => row.groupId === groupId);
    const legacy = roles.filter((row) => !row.groupId && isGroupScopedRole(row.name));
    return [...exact, ...legacy];
  }, [groupId, roles]);
  const globalRoles = useMemo(
    () => roles.filter((row) => !row.groupId && !isGroupScopedRole(row.name)),
    [roles],
  );
  const scopedTitles = useMemo(
    () => (unitCode ? titles.filter((row) => row.unitCodes.includes(unitCode)) : []),
    [titles, unitCode],
  );
  const legacyTitles = useMemo(() => titles.filter((row) => row.unitCodes.length === 0), [titles]);

  async function savePermissions(
    kind: "role-global" | "role-group" | "title",
    row: RoleRow | TitleRow,
    key: PermKey,
  ) {
    if (!user || !isAdmin) {
      onAction("權限矩陣僅系統管理員可修改");
      return;
    }
    const scopeId = kind === "role-group" ? groupId : kind === "title" ? unitCode : "global";
    const cellId = `${kind}:${row.id}:${scopeId}:${key}`;
    setSavingCell(cellId);
    const oldPermissions = kind === "role-group"
      ? selectedRolePermissions(row as RoleRow, groupId)
      : row.permissions;
    const nextPermissions = {
      ...oldPermissions,
      [key]: !oldPermissions[key],
    } as Record<PermKey, boolean>;
    const before = oldPermissions[key] === true;
    try {
      const db = getFirebaseDb();
      const batch = writeBatch(db);
      const isRole = kind !== "title";
      const collectionName = isRole ? "roles" : "titles";
      const recordId = row.id;
      const recordRef = doc(db, collectionName, recordId);
      if (kind === "role-group" && !(row as RoleRow).groupId) {
        const roleRow = row as RoleRow;
        const groupOverrides = {
          ...roleRow.groupPermissionsByGroup,
          [groupId]: nextPermissions,
        };
        batch.update(recordRef, {
          groupPermissionsByGroup: groupOverrides,
          updatedAt: serverTimestamp(),
          updatedBy: user.staffId,
        });
      } else {
        batch.update(recordRef, {
          permissions: nextPermissions,
          updatedAt: serverTimestamp(),
          updatedBy: user.staffId,
        });
      }
      const auditRef = doc(collection(db, "auditLogs"));
      const scopeLabel =
        kind === "role-group"
          ? `群組 ${groups.find((item) => item.id === groupId)?.name ?? groupId}`
          : kind === "title"
            ? `單位 ${units.find((item) => item.code === unitCode)?.name ?? unitCode}`
            : "全域";
      batch.set(auditRef, {
        actor: user.staffId,
        actorName: user.name,
        action: isRole ? "角色功能權限異動" : "職稱功能權限異動",
        targetId: recordId,
        detail: `${scopeLabel}／${row.name}：${PERM_LABELS[key]} ${before ? "允許→拒絕" : "拒絕→允許"}`,
        before: { [key]: before },
        after: { [key]: !before },
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      if (kind === "role-group") {
        setRoles((current) => current.map((item) => {
          if (item.id !== row.id) return item;
          if (item.groupId === groupId) return { ...item, permissions: nextPermissions };
          return {
            ...item,
            groupPermissionsByGroup: {
              ...item.groupPermissionsByGroup,
              [groupId]: nextPermissions,
            },
          };
        }));
      } else if (kind === "role-global") {
        setRoles((current) => current.map((item) => item.id === row.id ? { ...item, permissions: nextPermissions } : item));
      } else {
        setTitles((current) => current.map((item) => item.id === row.id ? { ...item, permissions: nextPermissions, configured: true } : item));
      }
      onAction(`已更新「${row.name}」的${PERM_LABELS[key]}權限`);
    } catch (error) {
      onAction(error instanceof Error ? `權限儲存失敗：${error.message}` : "權限儲存失敗：權限不足或網路異常");
      await loadData();
    } finally {
      setSavingCell("");
    }
  }

  function permissionMatrix<T extends RoleRow | TitleRow>(
    rows: T[],
    kind: "role-global" | "role-group" | "title",
  ) {
    if (!rows.length) {
      return <p className="settings-note">目前沒有符合此範圍的角色或職稱。</p>;
    }
    return (
      <div className="table-scroll permission-matrix-scroll">
        <table className="permission-table permission-matrix-wide">
          <thead>
            <tr>
              <th rowSpan={2} className="permission-matrix-sticky">角色／職稱</th>
              <th colSpan={PAGE_PERMISSION_ITEMS.length}>頁面存取</th>
              <th colSpan={ACTION_PERMISSION_ITEMS.length}>操作功能</th>
            </tr>
            <tr>
              {[...PAGE_PERMISSION_ITEMS, ...ACTION_PERMISSION_ITEMS].map((item) => (
                <th key={item.key} className="permission-matrix-feature">{item.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const permissions = kind === "role-group"
                ? selectedRolePermissions(row as RoleRow, groupId)
                : row.permissions;
              const cellScopeId = kind === "role-group" ? groupId : kind === "title" ? unitCode : "global";
              return (
                <tr key={`${kind}:${row.id}:${cellScopeId}`}>
                  <td className="permission-matrix-sticky">
                    <b>{row.name}</b>
                    {kind === "role-group" && !(row as RoleRow).groupId && (
                      <span className="status-pill muted" style={{ marginLeft: 6 }}>沿用舊角色設定</span>
                    )}
                    {kind === "title" && !(row as TitleRow).configured && (
                      <span className="status-pill warning" style={{ marginLeft: 6 }}>尚未設定</span>
                    )}
                  </td>
                  {PERM_KEYS.map((key) => {
                    const id = `${kind}:${row.id}:${cellScopeId}:${key}`;
                    return (
                      <td key={key} style={{ textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={permissions[key] === true}
                          disabled={!isAdmin || savingCell !== ""}
                          onChange={() => void savePermissions(kind, row, key)}
                          aria-label={`${row.name}：${PERM_LABELS[key]}`}
                          title={`${row.name}：${PERM_LABELS[key]}`}
                          data-saving={savingCell === id || undefined}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <>
        <PageHeading page="permissions" />
        <EmptyState
          title="僅系統管理員可管理權限"
          description="如需調整角色或職稱權限，請聯絡系統管理員。"
        />
      </>
    );
  }

  return (
    <>
      <PageHeading page="permissions" action={
        <button className="button button-outline" onClick={() => void loadData()} disabled={loading}>
          <RefreshCw size={15} /> 重新載入
        </button>
      } />
      {loadError && <div className="login-error">{loadError}</div>}
      {loading ? (
        <section className="panel"><p className="settings-note">載入權限矩陣…</p></section>
      ) : (
        <>
          <section className="panel data-panel">
            <SectionTitle title="角色權限矩陣" note="角色權限依全域或所屬群組分開保存；同名角色在不同群組的勾選互不影響。" />
            <div className="form-grid permission-scope-controls">
              <div className="form-field">
                <label className="field-label">角色範圍</label>
                <div className="select-wrap">
                  <select value={scope === "global" ? "global" : "group"} onChange={(event) => setScope(event.target.value === "global" ? "global" : "group")}>
                    <option value="global">全域角色</option>
                    <option value="group">群組角色</option>
                  </select><ChevronDown size={15} />
                </div>
              </div>
              {scope === "group" && (
                <div className="form-field">
                  <label className="field-label">群組</label>
                  <div className="select-wrap">
                    <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
                      <option value="">請選擇群組</option>
                      {groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select><ChevronDown size={15} />
                  </div>
                </div>
              )}
            </div>
            <p className="settings-note">授權採交集：人員所屬角色與其適用單位職稱，必須同時勾選該功能。群組角色權限僅在所選群組內生效。</p>
            {permissionMatrix(scope === "global" ? globalRoles : scopedGroupRoles, scope === "global" ? "role-global" : "role-group")}
          </section>
          <section className="panel data-panel">
            <SectionTitle title="職稱權限矩陣" note="職稱只對已設定的適用單位生效；與群組角色採交集。" />
            <div className="form-field permission-scope-controls" style={{ maxWidth: 420 }}>
              <label className="field-label">適用單位</label>
              <div className="select-wrap">
                <select value={unitCode} onChange={(event) => setUnitCode(event.target.value)}>
                  <option value="">請選擇單位</option>
                  {units.map((item) => <option key={item.code} value={item.code}>{item.name}（{item.code}）</option>)}
                </select><ChevronDown size={15} />
              </div>
            </div>
            {legacyTitles.length > 0 && (
              <div className="settings-note permission-legacy-warning">
                有 {legacyTitles.length} 個職稱尚未設定適用單位，保留舊資料但不會出現在人員職稱選單。請至「群組與人員 → 職稱」為職稱設定單位。
              </div>
            )}
            {permissionMatrix(scopedTitles, "title")}
          </section>
          <section className="panel data-panel">
            <SectionTitle title="權限矩陣欄位說明" note="勾選代表授予該功能；未勾選即不授權。" />
            <p className="settings-note">頁面存取控制導覽與頁面入口；操作功能控制頁面內的查詢、照片、排程、已提交審查更正及權限管理。職稱需指定適用單位，舊人員資料中的 titleId 空值會依「職稱名稱＋所屬單位」唯一比對。</p>
          </section>
        </>
      )}
    </>
  );
}
