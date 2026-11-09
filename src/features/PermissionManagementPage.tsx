import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
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
  parseScopeMode,
  type PermKey,
  type ScopeMode,
} from "../lib/permissions";

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
  groupId: string;
  scopeMode: ScopeMode;
  unitCodes: string[];
  permissions: Record<PermKey, boolean>;
}

interface TitleRow {
  id: string;
  name: string;
  level: string;
  scopeMode: ScopeMode;
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

export function PermissionManagementPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  const { user } = useAuth();
  const { isAdmin } = usePermissions();
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [titles, setTitles] = useState<TitleRow[]>([]);
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
          const unitCodes = Array.isArray(data.unitCodes)
            ? data.unitCodes.map(String).filter(Boolean)
            : [];
          return {
            id: item.id,
            name,
            groupId: typeof data.groupId === "string" ? data.groupId : "",
            scopeMode: parseScopeMode(data.scopeMode, unitCodes),
            unitCodes,
            permissions: mergePermissionValues(emptyPermissions(), data.permissions),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
      const titleRows = titleSnapshot.docs
        .map((item) => {
          const data = item.data() as Record<string, unknown>;
          const unitCodes = Array.isArray(data.unitCodes)
            ? data.unitCodes.map(String).filter(Boolean)
            : [];
          return {
            id: item.id,
            name: typeof data.name === "string" ? data.name : item.id,
            level: typeof data.level === "string" ? data.level : "",
            scopeMode: parseScopeMode(data.scopeMode, unitCodes),
            unitCodes,
            permissions: mergePermissionValues(emptyPermissions(), data.permissions),
            configured: data.permissions !== undefined && data.permissions !== null,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
      setGroups(groupRows);
      setUnits(unitRows);
      setRoles(roleRows);
      setTitles(titleRows);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "讀取角色與職稱失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  /** 範圍只顯示純文字，不提供下拉選單；要改範圍請至「群組與人員」角色／職稱管理。 */
  function scopeText(row: RoleRow | TitleRow): string {
    if (row.scopeMode === "all") return "不分單位";
    if (row.unitCodes.length === 0) return "分單位：未設定單位";
    const names = row.unitCodes.map(
      (code) => units.find((unit) => unit.code === code)?.name ?? code,
    );
    return `分單位：${names.join("、")}`;
  }

  function groupText(groupId: string): string {
    if (!groupId) return "";
    return groups.find((item) => item.id === groupId)?.name ?? groupId;
  }

  const legacyTitles = titles.filter(
    (row) => row.scopeMode === "units" && row.unitCodes.length === 0,
  );

  async function savePermissions(
    kind: "role" | "title",
    row: RoleRow | TitleRow,
    key: PermKey,
  ) {
    if (!user || !isAdmin) {
      onAction("權限矩陣僅系統管理員可修改");
      return;
    }
    const cellId = `${kind}:${row.id}:${key}`;
    setSavingCell(cellId);
    const oldPermissions = row.permissions;
    const nextPermissions = {
      ...oldPermissions,
      [key]: !oldPermissions[key],
    } as Record<PermKey, boolean>;
    const before = oldPermissions[key] === true;
    try {
      const db = getFirebaseDb();
      const batch = writeBatch(db);
      const isRole = kind === "role";
      const collectionName = isRole ? "roles" : "titles";
      batch.update(doc(db, collectionName, row.id), {
        permissions: nextPermissions,
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      });
      const auditRef = doc(collection(db, "auditLogs"));
      const scopeLabel = scopeText(row);
      const groupLabel =
        isRole && (row as RoleRow).groupId
          ? `群組 ${groupText((row as RoleRow).groupId)}／`
          : "";
      batch.set(auditRef, {
        actor: user.staffId,
        actorName: user.name,
        action: isRole ? "角色功能權限異動" : "職稱功能權限異動",
        targetId: row.id,
        detail: `${groupLabel}${scopeLabel}／${row.name}：${PERM_LABELS[key]} ${before ? "允許→拒絕" : "拒絕→允許"}`,
        before: { [key]: before },
        after: { [key]: !before },
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      if (kind === "role") {
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
    kind: "role" | "title",
  ) {
    if (!rows.length) {
      return <p className="settings-note">目前沒有角色或職稱。</p>;
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
            {rows.map((row) => (
              <tr key={`${kind}:${row.id}`}>
                <td className="permission-matrix-sticky">
                  <b>{row.name}</b>
                  {kind === "role" && (row as RoleRow).groupId && (
                    <div className="muted-text">群組：{groupText((row as RoleRow).groupId)}</div>
                  )}
                  <div className="muted-text">{scopeText(row)}</div>
                  {kind === "title" && !(row as TitleRow).configured && (
                    <span className="status-pill warning" style={{ marginLeft: 6 }}>尚未設定</span>
                  )}
                </td>
                {PERM_KEYS.map((key) => {
                  const id = `${kind}:${row.id}:${key}`;
                  return (
                    <td key={key} style={{ textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={row.permissions[key] === true}
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
            ))}
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
            <SectionTitle title="角色權限矩陣" note="授權採交集：人員所屬角色與其適用單位職稱，必須同時勾選該功能；角色另受其適用範圍限制。適用範圍請至「群組與人員」角色管理設定，本頁只顯示範圍。" />
            {permissionMatrix(roles, "role")}
          </section>
          <section className="panel data-panel">
            <SectionTitle title="職稱權限矩陣" note="職稱只對其範圍內的單位生效（不分單位＝全部單位；分單位＝勾選單位）；與角色採交集。適用範圍請至「群組與人員」職稱管理設定，本頁只顯示範圍。" />
            {legacyTitles.length > 0 && (
              <div className="settings-note permission-legacy-warning">
                有 {legacyTitles.length} 個職稱設為分單位但尚未設定適用單位，目前不適用任何單位、不會出現在人員職稱選單。請至「群組與人員 → 職稱」補上單位，或改為不分單位。
              </div>
            )}
            {permissionMatrix(titles, "title")}
          </section>
          <section className="panel data-panel">
            <SectionTitle title="權限矩陣欄位說明" note="勾選代表授予該功能；未勾選即不授權。" />
            <p className="settings-note">頁面存取控制導覽與頁面入口；操作功能控制頁面內的查詢、照片、排程、已提交審查更正及權限管理。職稱範圍為不分單位時適用全部單位，分單位時只適用勾選單位；舊人員資料中的 titleId 空值會依「職稱名稱＋所屬單位」唯一比對（不分單位職稱不受單位限制）。適用範圍（不分單位／分單位）請至「群組與人員」角色／職稱管理設定。</p>
          </section>
        </>
      )}
    </>
  );
}
