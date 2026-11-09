import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { collection, doc, getDocsFromServer, serverTimestamp, writeBatch } from "../lib/db";
import { getFirebaseDb } from "../lib/firebase";
import { isDemoMode } from "../lib/demoMode";
import { getCachedRefCollection } from "../lib/refCache";
import { getDocsCacheFirst } from "../lib/cacheFirst";
import { useAuth } from "../lib/auth";
import { usePermissions } from "../lib/usePermissions";
import {
  ACTION_PERMISSION_ITEMS,
  emptyPermissions,
  EXCLUDED_ROLE_NAMES,
  GROUP_ONLY_PERM_KEYS,
  PAGE_PERMISSION_ITEMS,
  PERM_KEYS,
  PERM_LABELS,
  parseGroupScopeMode,
  parseRoleKind,
  SHARED_PERM_KEYS,
  type GroupScopeMode,
  type PermKey,
  type RoleKind,
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
  kind: RoleKind;
  groupId: string;
  unitCode: string;
  groupScopeMode: GroupScopeMode;
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

type MatrixKind = "title" | "unitRole" | "groupRole";

interface MatrixItem {
  key: PermKey;
  label: string;
}

const SHARED_ITEMS: MatrixItem[] = [
  ...PAGE_PERMISSION_ITEMS,
  ...ACTION_PERMISSION_ITEMS,
].filter((item) =>
  (SHARED_PERM_KEYS as readonly string[]).includes(item.key),
);

const GROUP_ITEMS: MatrixItem[] = [
  ...PAGE_PERMISSION_ITEMS,
  ...ACTION_PERMISSION_ITEMS,
].filter((item) =>
  ([...SHARED_PERM_KEYS, ...GROUP_ONLY_PERM_KEYS] as readonly string[]).includes(
    item.key,
  ),
);

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
  const [savingScope, setSavingScope] = useState("");
  const [loadError, setLoadError] = useState("");

  // ---- 重置權限資料（v1.37.0 洗掉重來；僅系統管理員，展示模式停用） ----
  const [resetStep, setResetStep] = useState<"idle" | "ready" | "done">("idle");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState("");
  const [resetSummary, setResetSummary] = useState("");
  const [resetRecheck, setResetRecheck] = useState("");
  const resetBackupRef = useRef<unknown>(null);
  const resetMountedRef = useRef(true);

  useEffect(() => {
    resetMountedRef.current = true;
    return () => {
      resetMountedRef.current = false;
    };
  }, []);

  /** 步驟 1：從伺服器讀取現況、備份下載到管理員電腦，通過後才開放刪除。 */
  async function preparePermissionReset() {
    if (!user || !isAdmin || resetBusy) return;
    setResetBusy(true);
    setResetError("");
    setResetSummary("");
    setResetRecheck("");
    try {
      const db = getFirebaseDb();
      const [roleSnap, titleSnap, groupSnap, userSnap] = await Promise.all([
        getDocsFromServer(collection(db, "roles")),
        getDocsFromServer(collection(db, "titles")),
        getDocsFromServer(collection(db, "groups")),
        getDocsFromServer(collection(db, "users")),
      ]);
      const backup = {
        version: "v1.37.0",
        exportedAt: new Date().toISOString(),
        exportedBy: user.staffId,
        roles: roleSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
        titles: titleSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
        groups: groupSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
        users: userSnap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>;
          return {
            id: d.id,
            name: typeof data.name === "string" ? data.name : "",
            roles: Array.isArray(data.roles) ? data.roles.map(String) : [],
            memberships: Array.isArray(data.memberships) ? data.memberships : [],
            title: typeof data.title === "string" ? data.title : "",
            titleId: typeof data.titleId === "string" ? data.titleId : "",
            unitCode: typeof data.unitCode === "string" ? data.unitCode : "",
          };
        }),
      };
      resetBackupRef.current = backup;
      const blob = new Blob([JSON.stringify(backup, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "permission-rebuild-backup-20261109.json";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setResetSummary(
        `備份已下載：角色 ${backup.roles.length} 筆、職稱 ${backup.titles.length} 筆、群組 ${backup.groups.length} 筆、人員 ${backup.users.length} 筆。請確認備份檔已存好，再按步驟 2 刪除。`,
      );
      setResetStep("ready");
    } catch (error) {
      setResetError(error instanceof Error ? `備份讀取失敗：${error.message}` : "備份讀取失敗");
    } finally {
      setResetBusy(false);
    }
  }

  /** 步驟 2：刪除 roles／titles 全部文件，清空人員指派（Auth 帳號、群組與其他集合不動）。 */
  async function executePermissionReset() {
    if (!user || !isAdmin || resetBusy || resetStep !== "ready") return;
    const ok = window.confirm(
      "確定刪除全部角色與職稱，並清空所有人員的角色／群組／職稱指派嗎？\n\n此動作無法復原（備份檔已在步驟 1 下載到你的電腦）。群組、指標、排程、任務與紀錄不受影響，登入帳號也不受影響。",
    );
    if (!ok) return;
    setResetBusy(true);
    setResetError("");
    setResetRecheck("");
    try {
      const db = getFirebaseDb();
      const [roleSnap, titleSnap, userSnap] = await Promise.all([
        getDocsFromServer(collection(db, "roles")),
        getDocsFromServer(collection(db, "titles")),
        getDocsFromServer(collection(db, "users")),
      ]);
      const roleIds = roleSnap.docs.map((d) => d.id);
      const titleIds = titleSnap.docs.map((d) => d.id);
      const usersToClear = userSnap.docs
        .map((d) => {
          const data = d.data() as Record<string, unknown>;
          const roles = Array.isArray(data.roles) ? data.roles.map(String) : [];
          const memberships = Array.isArray(data.memberships) ? data.memberships : [];
          const groupIds = Array.isArray(data.groupIds) ? data.groupIds.map(String) : [];
          const title = typeof data.title === "string" ? data.title : "";
          const titleId = typeof data.titleId === "string" ? data.titleId : "";
          return {
            id: d.id,
            keepAdmin: roles.includes("系統管理員"),
            needsClear: roles.some((r) => r !== "系統管理員") || memberships.length > 0 || groupIds.length > 0 || title !== "" || titleId !== "",
          };
        })
        .filter((item) => item.needsClear);
      // 每批 ≤400 次寫入
      const ops: Array<{ type: "delete"; path: [string, string] } | { type: "updateUser"; id: string; keepAdmin: boolean }> = [
        ...roleIds.map((id) => ({ type: "delete" as const, path: ["roles", id] as [string, string] })),
        ...titleIds.map((id) => ({ type: "delete" as const, path: ["titles", id] as [string, string] })),
        ...usersToClear.map((item) => ({ type: "updateUser" as const, id: item.id, keepAdmin: item.keepAdmin })),
      ];
      for (let i = 0; i < ops.length; i += 400) {
        const batch = writeBatch(db);
        for (const op of ops.slice(i, i + 400)) {
          if (op.type === "delete") {
            batch.delete(doc(db, op.path[0], op.path[1]));
          } else {
            batch.update(doc(db, "users", op.id), {
              roles: op.keepAdmin ? ["系統管理員"] : [],
              memberships: [],
              groupIds: [],
              title: "",
              titleId: "",
              updatedAt: serverTimestamp(),
              updatedBy: user.staffId,
            });
          }
        }
        if (i === 0) {
          batch.set(doc(collection(db, "auditLogs")), {
            actor: user.staffId,
            actorName: user.name,
            action: "權限資料重置",
            targetType: "system",
            targetId: "permission-rebuild-20261109",
            detail: `洗掉重來：刪除角色 ${roleIds.length} 筆、職稱 ${titleIds.length} 筆，清空 ${usersToClear.length} 位人員指派（roles 只留系統管理員）`,
            before: { roles: roleIds.length, titles: titleIds.length, usersCleared: usersToClear.length },
            after: { roles: 0, titles: 0 },
            createdAt: serverTimestamp(),
          });
        }
        await batch.commit();
      }
      // 立即驗證（伺服器端重讀）
      const [roleAfter, titleAfter, userAfter] = await Promise.all([
        getDocsFromServer(collection(db, "roles")),
        getDocsFromServer(collection(db, "titles")),
        getDocsFromServer(collection(db, "users")),
      ]);
      const uncleared = userAfter.docs.filter((d) => {
        const data = d.data() as Record<string, unknown>;
        const roles = Array.isArray(data.roles) ? data.roles.map(String) : [];
        const memberships = Array.isArray(data.memberships) ? data.memberships : [];
        return (
          roles.some((r) => r !== "系統管理員") ||
          memberships.length > 0 ||
          (typeof data.title === "string" && data.title !== "") ||
          (typeof data.titleId === "string" && data.titleId !== "")
        );
      }).length;
      const verifyText =
        roleAfter.docs.length === 0 && titleAfter.docs.length === 0 && uncleared === 0
          ? `驗證通過：roles ${roleAfter.docs.length} 筆、titles ${titleAfter.docs.length} 筆、未清空人員 ${uncleared} 位。`
          : `驗證異常：roles ${roleAfter.docs.length} 筆、titles ${titleAfter.docs.length} 筆、未清空人員 ${uncleared} 位，請檢查後重試。`;
      setResetSummary(
        `已刪除角色 ${roleIds.length} 筆、職稱 ${titleIds.length} 筆，清空 ${usersToClear.length} 位人員指派。${verifyText}`,
      );
      setResetStep("done");
      onAction(`權限資料已重置：刪除角色 ${roleIds.length} 筆、職稱 ${titleIds.length} 筆。${verifyText}`);
      await loadData();
      // 60 秒後再複查一次，確認沒有自動補種回來
      window.setTimeout(() => {
        if (!resetMountedRef.current) return;
        void (async () => {
          try {
            const db2 = getFirebaseDb();
            const [r2, t2] = await Promise.all([
              getDocsFromServer(collection(db2, "roles")),
              getDocsFromServer(collection(db2, "titles")),
            ]);
            if (!resetMountedRef.current) return;
            setResetRecheck(
              r2.docs.length === 0 && t2.docs.length === 0
                ? `60 秒後複查：roles ${r2.docs.length} 筆、titles ${t2.docs.length} 筆，未自動補種。`
                : `60 秒後複查異常：roles ${r2.docs.length} 筆、titles ${t2.docs.length} 筆，請檢查是否有舊版程式自動補種。`,
            );
          } catch {
            if (resetMountedRef.current) setResetRecheck("60 秒後複查讀取失敗，請手動重新整理確認。");
          }
        })();
      }, 60_000);
    } catch (error) {
      setResetError(error instanceof Error ? `重置失敗：${error.message}` : "重置失敗：權限不足或網路異常");
    } finally {
      setResetBusy(false);
    }
  }

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
          const groupId = typeof data.groupId === "string" ? data.groupId : "";
          return {
            id: item.id,
            name,
            kind: parseRoleKind(data.kind, groupId),
            groupId,
            unitCode: typeof data.unitCode === "string" ? data.unitCode : "",
            groupScopeMode: parseGroupScopeMode(data.groupScopeMode),
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
            // 本頁預設不跨：只有明確記為 all 才視為跨單位。
            scopeMode: (data.scopeMode === "all" ? "all" : "units") as ScopeMode,
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

  function scopeText(row: TitleRow): string {
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

  function unitText(unitCode: string): string {
    if (!unitCode) return "";
    const unit = units.find((item) => item.code === unitCode);
    return unit ? `${unit.name}（${unit.code}）` : unitCode;
  }

  // 單位職稱：層級為單位者（舊群組層級職稱不在此列）；系統管理員／一般人員不是職稱，不影響。
  const unitTitles = titles.filter((row) => row.level !== "群組");
  const visibleRoles = roles.filter(
    (row) => !(EXCLUDED_ROLE_NAMES as readonly string[]).includes(row.name),
  );
  const unitRoles = visibleRoles.filter((row) => row.kind === "unit");
  const groupRoles = visibleRoles.filter((row) => row.kind === "group");
  const legacyTitles = unitTitles.filter(
    (row) => row.scopeMode === "units" && row.unitCodes.length === 0,
  );

  async function savePermissions(
    kind: MatrixKind,
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
      const isRole = kind !== "title";
      const collectionName = isRole ? "roles" : "titles";
      batch.update(doc(db, collectionName, row.id), {
        permissions: nextPermissions,
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      });
      const auditRef = doc(collection(db, "auditLogs"));
      const scopeLabel =
        kind === "title"
          ? scopeText(row as TitleRow)
          : kind === "groupRole"
            ? `群組 ${groupText((row as RoleRow).groupId)}／${(row as RoleRow).groupScopeMode === "all" ? "跨群組" : "不跨群組"}`
            : `單位角色（所屬單位 ${unitText((row as RoleRow).unitCode) || "未設定"}）`;
      batch.set(auditRef, {
        actor: user.staffId,
        actorName: user.name,
        action: isRole ? "角色功能權限異動" : "職稱功能權限異動",
        targetId: row.id,
        detail: `${scopeLabel}／${row.name}：${PERM_LABELS[key]} ${before ? "允許→拒絕" : "拒絕→允許"}`,
        before: { [key]: before },
        after: { [key]: !before },
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      if (kind === "title") {
        setTitles((current) => current.map((item) => item.id === row.id ? { ...item, permissions: nextPermissions, configured: true } : item));
      } else {
        setRoles((current) => current.map((item) => item.id === row.id ? { ...item, permissions: nextPermissions } : item));
      }
      onAction(`已更新「${row.name}」的${PERM_LABELS[key]}權限`);
    } catch (error) {
      onAction(error instanceof Error ? `權限儲存失敗：${error.message}` : "權限儲存失敗：權限不足或網路異常");
      await loadData();
    } finally {
      setSavingCell("");
    }
  }

  async function saveTitleScope(row: TitleRow, nextMode: ScopeMode) {
    if (!user || !isAdmin) {
      onAction("權限矩陣僅系統管理員可修改");
      return;
    }
    if (nextMode === row.scopeMode) return;
    const scopeId = `title-scope:${row.id}`;
    setSavingScope(scopeId);
    const nextUnitCodes = nextMode === "all" ? [] : row.unitCodes;
    try {
      const db = getFirebaseDb();
      const batch = writeBatch(db);
      batch.update(doc(db, "titles", row.id), {
        scopeMode: nextMode,
        unitCodes: nextUnitCodes,
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      });
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user.staffId,
        actorName: user.name,
        action: "職稱適用範圍異動",
        targetType: "title",
        targetId: row.id,
        detail: `權限管理頁更新職稱「${row.name}」適用範圍：${row.scopeMode === "all" ? "不分單位" : "分單位"} → ${nextMode === "all" ? "不分單位" : "分單位"}`,
        before: { scopeMode: row.scopeMode, unitCodes: row.unitCodes },
        after: { scopeMode: nextMode, unitCodes: nextUnitCodes },
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      setTitles((current) =>
        current.map((item) =>
          item.id === row.id
            ? { ...item, scopeMode: nextMode, unitCodes: nextUnitCodes }
            : item,
        ),
      );
      onAction(`職稱「${row.name}」已改為${nextMode === "all" ? "跨單位" : "不跨單位"}`);
    } catch (error) {
      onAction(error instanceof Error ? `範圍儲存失敗：${error.message}` : "範圍儲存失敗：權限不足或網路異常");
      await loadData();
    } finally {
      setSavingScope("");
    }
  }

  async function saveGroupScope(row: RoleRow, nextMode: GroupScopeMode) {
    if (!user || !isAdmin) {
      onAction("權限矩陣僅系統管理員可修改");
      return;
    }
    if (nextMode === row.groupScopeMode) return;
    const scopeId = `group-scope:${row.id}`;
    setSavingScope(scopeId);
    try {
      const db = getFirebaseDb();
      const batch = writeBatch(db);
      batch.update(doc(db, "roles", row.id), {
        groupScopeMode: nextMode,
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      });
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user.staffId,
        actorName: user.name,
        action: "群組角色跨群組範圍異動",
        targetType: "role",
        targetId: row.id,
        detail: `權限管理頁更新角色「${row.name}」跨群組範圍：${row.groupScopeMode === "all" ? "跨群組" : "不跨群組"} → ${nextMode === "all" ? "跨群組" : "不跨群組"}`,
        before: { groupScopeMode: row.groupScopeMode },
        after: { groupScopeMode: nextMode },
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      setRoles((current) =>
        current.map((item) =>
          item.id === row.id ? { ...item, groupScopeMode: nextMode } : item,
        ),
      );
      onAction(`角色「${row.name}」已改為${nextMode === "all" ? "跨群組" : "不跨群組"}`);
    } catch (error) {
      onAction(error instanceof Error ? `範圍儲存失敗：${error.message}` : "範圍儲存失敗：權限不足或網路異常");
      await loadData();
    } finally {
      setSavingScope("");
    }
  }

  function permissionMatrix<T extends RoleRow | TitleRow>(
    rows: T[],
    kind: MatrixKind,
    items: MatrixItem[],
  ) {
    const keys = items.map((item) => item.key);
    const busy = savingCell !== "" || savingScope !== "";
    return (
      <div className="table-scroll permission-matrix-scroll">
        <table className="permission-table permission-matrix-wide">
          <thead>
            <tr>
              <th rowSpan={2} className="permission-matrix-sticky">角色／職稱</th>
              <th colSpan={items.length}>權限</th>
            </tr>
            <tr>
              {items.map((item) => (
                <th key={item.key} className="permission-matrix-feature">{item.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${kind}:${row.id}`}>
                <td className="permission-matrix-sticky">
                  <b>{row.name}</b>
                  {kind === "groupRole" && (
                    <div className="muted-text">群組：{groupText((row as RoleRow).groupId) || "未設定"}</div>
                  )}
                  {kind === "unitRole" && (
                    <div className="muted-text">所屬單位：{unitText((row as RoleRow).unitCode) || "未設定"}</div>
                  )}
                  {kind === "title" && (
                    <div className="muted-text">{scopeText(row as TitleRow)}</div>
                  )}
                  {kind === "title" && !(row as TitleRow).configured && (
                    <span className="status-pill warning" style={{ marginLeft: 6 }}>尚未設定</span>
                  )}
                  {kind === "title" && (
                    <div style={{ marginTop: 4 }}>
                      <select
                        value={(row as TitleRow).scopeMode}
                        disabled={!isAdmin || busy}
                        onChange={(event) =>
                          void saveTitleScope(
                            row as TitleRow,
                            event.target.value === "all" ? "all" : "units",
                          )
                        }
                        aria-label={`${row.name}：跨單位設定`}
                      >
                        <option value="units">不跨單位</option>
                        <option value="all">跨單位</option>
                      </select>
                    </div>
                  )}
                  {kind === "groupRole" && (
                    <div style={{ marginTop: 4 }}>
                      <select
                        value={(row as RoleRow).groupScopeMode}
                        disabled={!isAdmin || busy}
                        onChange={(event) =>
                          void saveGroupScope(
                            row as RoleRow,
                            event.target.value === "all" ? "all" : "group",
                          )
                        }
                        aria-label={`${row.name}：跨群組設定`}
                      >
                        <option value="group">不跨群組</option>
                        <option value="all">跨群組</option>
                      </select>
                    </div>
                  )}
                  {kind === "unitRole" && (
                    <div className="muted-text">跨單位跟職稱走</div>
                  )}
                </td>
                {keys.map((key) => {
                  const id = `${kind}:${row.id}:${key}`;
                  return (
                    <td key={key} style={{ textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={row.permissions[key] === true}
                        disabled={!isAdmin || busy}
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

  function emptyGuide(text: string) {
    return <p className="settings-note">{text}</p>;
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
            <SectionTitle title="單位職稱權限" note="授權採交集：人員所屬角色與其適用單位職稱，必須同時勾選該功能。跨單位／不跨單位可在此切換（預設不跨）；適用單位清單請至「群組與人員 → 職稱」設定。" />
            {legacyTitles.length > 0 && (
              <div className="settings-note permission-legacy-warning">
                有 {legacyTitles.length} 個職稱設為分單位但尚未設定適用單位，目前不適用任何單位、不會出現在人員職稱選單。請至「群組與人員 → 職稱」補上單位，或改為跨單位。
              </div>
            )}
            {unitTitles.length === 0
              ? emptyGuide("尚未建立單位職稱。請先到「群組與人員 → 職稱」建立職稱，再回來設定權限。")
              : permissionMatrix(unitTitles, "title", SHARED_ITEMS)}
          </section>
          <section className="panel data-panel">
            <SectionTitle title="單位角色權限" note="單位角色不設跨單位，單位限制由職稱側把關；此處只設定該角色可用的功能。所屬單位請至「群組與人員 → 角色」設定。" />
            {unitRoles.length === 0
              ? emptyGuide("尚未建立單位角色。請先到「群組與人員 → 角色」建立單位角色，再回來設定權限。")
              : permissionMatrix(unitRoles, "unitRole", SHARED_ITEMS)}
          </section>
          <section className="panel data-panel">
            <SectionTitle title="群組角色權限" note="群組角色另有群組專屬功能；跨群組／不跨群組可在此切換（預設不跨群組）。跨群組時，該角色在任一群組持有即生效；不跨群組時，只在所屬群組生效。" />
            {groupRoles.length === 0
              ? emptyGuide("尚未建立群組角色。請先到「群組與人員 → 角色」建立群組角色，再回來設定權限。")
              : permissionMatrix(groupRoles, "groupRole", GROUP_ITEMS)}
          </section>
          <section className="panel data-panel">
            <SectionTitle title="重置權限資料（洗掉重來）" note="僅系統管理員。先備份、再刪除；刪除後無法復原。" />
            {isDemoMode() ? (
              <p className="settings-note">展示模式不提供重置（僅影響記憶體展示資料，重新整理即還原）。</p>
            ) : (
              <>
                <p className="settings-note">
                  步驟 1 會從伺服器讀取角色、職稱、群組與人員指派，備份檔（permission-rebuild-backup-20261109.json）下載到你的電腦，請妥善保存。
                  步驟 2 會刪除 roles、titles 兩個集合的全部文件，並清空所有人員的角色（只留「系統管理員」）、群組與職稱指派；unitCode 保留。
                  群組、指標、排程、任務、紀錄等其他集合不動，登入帳號也不動。完成後會立即驗證，60 秒後再複查一次是否自動補種。
                </p>
                {resetError && <div className="login-error">{resetError}</div>}
                {resetSummary && <p className="settings-note">{resetSummary}</p>}
                {resetRecheck && <p className="settings-note">{resetRecheck}</p>}
                <div className="form-actions">
                  <button
                    className="button button-outline"
                    disabled={resetBusy}
                    onClick={() => void preparePermissionReset()}
                  >
                    {resetBusy && resetStep === "idle" ? "備份中…" : "1. 備份並準備重置"}
                  </button>
                  <button
                    className="button button-primary"
                    disabled={resetBusy || resetStep !== "ready"}
                    onClick={() => void executePermissionReset()}
                  >
                    {resetBusy && resetStep === "ready" ? "刪除中…" : "2. 確認刪除並清空指派"}
                  </button>
                </div>
              </>
            )}
          </section>
          <section className="panel data-panel">
            <SectionTitle title="權限矩陣欄位說明" note="勾選代表授予該功能；未勾選即不授權。" />
            <p className="settings-note">授權採交集：人員所屬角色與其適用單位職稱必須同時勾選同一功能。系統管理員（另有 bypass）與一般人員不列出；管理員專屬權限（系統管理、權限管理、管理角色與權限、群組與人員）不在此設定。職稱範圍為跨單位時適用全部單位，不跨單位時只適用勾選單位；舊人員資料中的 titleId 空值會依「職稱名稱＋所屬單位」唯一比對（跨單位職稱不受單位限制）。</p>
          </section>
        </>
      )}
    </>
  );
}
