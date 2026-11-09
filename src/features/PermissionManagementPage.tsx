import { useCallback, useEffect, useRef, useState} from "react";
import { RefreshCw} from "lucide-react";
import { EmptyState, PageHeading, SectionTitle} from "../components/ui";
import { collection, doc, getDocsFromServer, serverTimestamp, writeBatch} from "../lib/db";
import { getFirebaseDb} from "../lib/firebase";
import { isDemoMode} from "../lib/demoMode";
import { getCachedRefCollection} from "../lib/refCache";
import { getDocsCacheFirst} from "../lib/cacheFirst";
import { useAuth} from "../lib/auth";
import { usePermissions} from "../lib/usePermissions";
import {
ACTION_PERMISSION_ITEMS,
emptyPermissions,
EXCLUDED_ROLE_NAMES,
GROUP_ONLY_PERM_KEYS,
GROUP_TEMPLATE_BASE_NAMES,
PAGE_PERMISSION_ITEMS,
parsePermissions,
parseRoleKind,
parseTemplateCategory,
PERM_LABELS,
SHARED_PERM_KEYS,
templateDocId,
templateKey,
UNIT_ROLE_TEMPLATE_BASE_NAMES,
UNIT_TEMPLATE_BASE_NAMES,
type PermKey,
type TemplateCategory,
} from "../lib/permissions";

/** 設定目標：群組的角色、單位的職稱、單位角色（v1.38.0 兩段式）。 */
type Target = TemplateCategory;

interface TemplateRow {
key: string;
category: TemplateCategory;
name: string;
permissions: Record<PermKey, boolean>;
cross: boolean;
}

interface MatrixItem {
key: PermKey;
label: string;
}

const TARGET_LABELS: Record<Target, string> = {
group: "群組",
unit: "單位",
unitRole: "單位角色",
};

const BASE_NAMES: Record<Target, readonly string[]> = {
group: GROUP_TEMPLATE_BASE_NAMES,
unit: UNIT_TEMPLATE_BASE_NAMES,
unitRole: UNIT_ROLE_TEMPLATE_BASE_NAMES,
};

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
([...SHARED_PERM_KEYS,...GROUP_ONLY_PERM_KEYS] as readonly string[]).includes(
item.key,
),
);

const TARGET_ITEMS: Record<Target, MatrixItem[]> = {
group: GROUP_ITEMS,
unit: SHARED_ITEMS,
unitRole: SHARED_ITEMS,
};

export function PermissionManagementPage({
onAction,
}: {
onAction: (message: string) => void;
}) {
const { user} = useAuth();
const { isAdmin} = usePermissions();
const [target, setTarget] = useState<Target>("group");
const [rows, setRows] = useState<TemplateRow[]>([]);
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
if (!user ||!isAdmin || resetBusy) return;
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
roles: roleSnap.docs.map((d) => ({ id: d.id,...d.data()})),
titles: titleSnap.docs.map((d) => ({ id: d.id,...d.data()})),
groups: groupSnap.docs.map((d) => ({ id: d.id,...d.data()})),
users: userSnap.docs.map((d) => {
const data = d.data() as Record<string, unknown>;
return {
id: d.id,
name: typeof data.name === "string"? data.name: "",
roles: Array.isArray(data.roles)? data.roles.map(String): [],
memberships: Array.isArray(data.memberships)? data.memberships: [],
title: typeof data.title === "string"? data.title: "",
titleId: typeof data.titleId === "string"? data.titleId: "",
unitCode: typeof data.unitCode === "string"? data.unitCode: "",
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
setResetError(error instanceof Error? `備份讀取失敗：${error.message}`: "備份讀取失敗");
} finally {
setResetBusy(false);
}
}

/** 步驟 2：刪除 roles／titles 全部文件，清空人員指派（Auth 帳號、群組與其他集合不動）。 */
async function executePermissionReset() {
if (!user ||!isAdmin || resetBusy || resetStep!== "ready") return;
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
const roles = Array.isArray(data.roles)? data.roles.map(String): [];
const memberships = Array.isArray(data.memberships)? data.memberships: [];
const groupIds = Array.isArray(data.groupIds)? data.groupIds.map(String): [];
const title = typeof data.title === "string"? data.title: "";
const titleId = typeof data.titleId === "string"? data.titleId: "";
return {
id: d.id,
keepAdmin: roles.includes("系統管理員"),
needsClear: roles.some((r) => r!== "系統管理員") || memberships.length > 0 || groupIds.length > 0 || title!== "" || titleId!== "",
};
})
.filter((item) => item.needsClear);
// 每批 ≤400 次寫入
const ops: Array<{ type: "delete"; path: [string, string]} | { type: "updateUser"; id: string; keepAdmin: boolean}> = [
...roleIds.map((id) => ({ type: "delete" as const, path: ["roles", id] as [string, string]})),
...titleIds.map((id) => ({ type: "delete" as const, path: ["titles", id] as [string, string]})),
...usersToClear.map((item) => ({ type: "updateUser" as const, id: item.id, keepAdmin: item.keepAdmin})),
];
for (let i = 0; i < ops.length; i += 400) {
const batch = writeBatch(db);
for (const op of ops.slice(i, i + 400)) {
if (op.type === "delete") {
batch.delete(doc(db, op.path[0], op.path[1]));
} else {
batch.update(doc(db, "users", op.id), {
roles: op.keepAdmin? ["系統管理員"]: [],
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
before: { roles: roleIds.length, titles: titleIds.length, usersCleared: usersToClear.length},
after: { roles: 0, titles: 0},
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
const roles = Array.isArray(data.roles)? data.roles.map(String): [];
const memberships = Array.isArray(data.memberships)? data.memberships: [];
return (
roles.some((r) => r!== "系統管理員") ||
memberships.length > 0 ||
(typeof data.title === "string" && data.title!== "") ||
(typeof data.titleId === "string" && data.titleId!== "")
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
setResetError(error instanceof Error? `重置失敗：${error.message}`: "重置失敗：權限不足或網路異常");
} finally {
setResetBusy(false);
}
}

/**
* 範本列＝固定基準名稱＋文件裡同類名稱（去重）：
* 群組目標補 kind=group 角色文件名稱、單位目標補 titles 文件名稱、
* 單位角色目標補 kind=unit 角色文件名稱；系統管理員、一般人員永不列入。
* 範本不存在時以全不勾、預設不跨顯示，改了即建立範本文件。
*/
const loadData = useCallback(async () => {
setLoading(true);
setLoadError("");
try {
const db = getFirebaseDb();
const [templateSnapshot, roleSnapshot, titleSnapshot] = await Promise.all([
getCachedRefCollection("permissionTemplates", () =>
getDocsCacheFirst(collection(db, "permissionTemplates")),
),
getCachedRefCollection("roles", () =>
getDocsCacheFirst(collection(db, "roles")),
),
getCachedRefCollection("titles", () =>
getDocsCacheFirst(collection(db, "titles")),
),
]);
const templates = new Map<
string,
{ permissions: Record<PermKey, boolean>; cross: boolean}
>();
templateSnapshot.docs.forEach((item) => {
const data = item.data() as Record<string, unknown>;
const category = parseTemplateCategory(data.category);
const name = typeof data.name === "string"? data.name: "";
if (!category ||!name) return;
templates.set(templateKey(category, name), {
permissions: parsePermissions(data.permissions),
cross: data.cross === true,
});
});
const dynamicNames: Record<Target, string[]> = {
group: [],
unit: [],
unitRole: [],
};
const pushName = (category: Target, name: string) => {
if (!name || dynamicNames[category].includes(name)) return;
dynamicNames[category].push(name);
};
roleSnapshot.docs.forEach((item) => {
const data = item.data() as Record<string, unknown>;
const name = typeof data.name === "string"? data.name: item.id;
if ((EXCLUDED_ROLE_NAMES as readonly string[]).includes(name)) return;
const groupId = typeof data.groupId === "string"? data.groupId: "";
const kind = parseRoleKind(data.kind, groupId);
pushName(kind === "group"? "group": "unitRole", name);
});
titleSnapshot.docs.forEach((item) => {
const data = item.data() as Record<string, unknown>;
const name = typeof data.name === "string"? data.name: item.id;
pushName("unit", name);
});
const nextRows: TemplateRow[] = [];
(Object.keys(BASE_NAMES) as Target[]).forEach((category) => {
const names = [
...BASE_NAMES[category],
...[...dynamicNames[category]].sort((a, b) =>
a.localeCompare(b, "zh-Hant"),
),
];
for (const name of new Set(names)) {
const key = templateKey(category, name);
const tpl = templates.get(key);
nextRows.push({
key,
category,
name,
permissions: tpl? {...tpl.permissions}: emptyPermissions(),
cross: tpl? tpl.cross: false,
});
}
});
setRows(nextRows);
} catch (error) {
setLoadError(error instanceof Error? error.message: "讀取權限範本失敗");
} finally {
setLoading(false);
}
}, []);

useEffect(() => {
void loadData();
}, [loadData]);

/** 範本寫入（upsert＋稽核紀錄）；寫入成功後失效 permissionTemplates 快取。 */
async function saveTemplate(
row: TemplateRow,
next: { permissions?: Record<PermKey, boolean>; cross?: boolean},
auditAction: string,
detail: string,
) {
if (!user ||!isAdmin) {
onAction("權限範本僅系統管理員可修改");
return;
}
const nextPermissions = next.permissions?? row.permissions;
const nextCross = next.cross?? row.cross;
try {
const db = getFirebaseDb();
const batch = writeBatch(db);
batch.set(
doc(db, "permissionTemplates", templateDocId(row.category, row.name)),
{
category: row.category,
name: row.name,
permissions: nextPermissions,
cross: nextCross,
updatedAt: serverTimestamp(),
updatedBy: user.staffId,
},
{ merge: true},
);
batch.set(doc(collection(db, "auditLogs")), {
actor: user.staffId,
actorName: user.name,
action: auditAction,
targetType: "permissionTemplate",
targetId: templateDocId(row.category, row.name),
detail,
createdAt: serverTimestamp(),
});
await batch.commit();
setRows((current) =>
current.map((item) =>
item.key === row.key
? {...item, permissions: nextPermissions, cross: nextCross}
: item,
),
);
} catch (error) {
onAction(
error instanceof Error
? `範本儲存失敗：${error.message}`
: "範本儲存失敗：權限不足或網路異常",
);
await loadData();
}
}

async function saveCross(row: TemplateRow, nextCross: boolean) {
if (nextCross === row.cross) return;
const scopeId = `cross:${row.key}`;
setSavingScope(scopeId);
try {
const crossLabel = (value: boolean) =>
row.category === "group"
? value
? "跨群組"
: "不跨群組"
: value
? "跨單位"
: "不跨單位";
await saveTemplate(
row,
{ cross: nextCross},
"範本跨範圍異動",
`${row.name}：${crossLabel(row.cross)} → ${crossLabel(nextCross)}`,
);
onAction(`「${row.name}」已改為${crossLabel(nextCross)}`);
} finally {
setSavingScope("");
}
}

async function savePermission(row: TemplateRow, key: PermKey) {
const cellId = `${row.key}:${key}`;
setSavingCell(cellId);
try {
const before = row.permissions[key] === true;
const nextPermissions = {...row.permissions, [key]:!before};
await saveTemplate(
row,
{ permissions: nextPermissions},
"範本權限異動",
`${row.name}：${PERM_LABELS[key]} ${before? "允許→拒絕": "拒絕→允許"}`,
);
onAction(`已更新「${row.name}」的${PERM_LABELS[key]}權限`);
} finally {
setSavingCell("");
}
}

function crossSection(rowsForTarget: TemplateRow[]) {
const busy = savingCell!== "" || savingScope!== "";
return (
<div>
{rowsForTarget.map((row) => {
const isGroup = row.category === "group";
return (
<div
key={row.key}
style={{
display: "flex",
alignItems: "center",
gap: 12,
padding: "6px 0",
}}
>
<b style={{ minWidth: 120}}>{row.name}</b>
<select
value={row.cross? "all": "scoped"}
disabled={!isAdmin || busy}
onChange={(event) =>
void saveCross(row, event.target.value === "all")
}
aria-label={`${row.name}：跨範圍設定`}
>
<option value="scoped">{isGroup? "不跨群組": "不跨單位"}</option>
<option value="all">{isGroup? "跨群組": "跨單位"}</option>
</select>
</div>
);
})}
</div>
);
}

function permissionMatrix(rowsForTarget: TemplateRow[], items: MatrixItem[]) {
const keys = items.map((item) => item.key);
const busy = savingCell!== "" || savingScope!== "";
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
{rowsForTarget.map((row) => (
<tr key={row.key}>
<td className="permission-matrix-sticky">
<b>{row.name}</b>
</td>
{keys.map((key) => {
const id = `${row.key}:${key}`;
return (
<td key={key} style={{ textAlign: "center"}}>
<input
type="checkbox"
checked={row.permissions[key] === true}
disabled={!isAdmin || busy}
onChange={() => void savePermission(row, key)}
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

const rowsForTarget = rows.filter((row) => row.category === target);

return (
<>
<PageHeading page="permissions" action={
<button className="button button-outline" onClick={() => void loadData()} disabled={loading}>
<RefreshCw size={15} /> 重新載入
</button>
} />
{loadError && <div className="login-error">{loadError}</div>}
{loading? (
<section className="panel"><p className="settings-note">載入權限範本…</p></section>
): (
<>
<section className="panel data-panel">
<label>
設定目標
<select
value={target}
onChange={(event) => setTarget(event.target.value as Target)}
aria-label="設定目標"
style={{ marginLeft: 8}}
>
{(Object.keys(TARGET_LABELS) as Target[]).map((key) => (
<option key={key} value={key}>{TARGET_LABELS[key]}</option>
))}
</select>
</label>
</section>
<section className="panel data-panel">
<SectionTitle title="一、權限是否跨單位／組" />
{crossSection(rowsForTarget)}
</section>
<section className="panel data-panel">
<SectionTitle title="二、權限設定" />
{permissionMatrix(rowsForTarget, TARGET_ITEMS[target])}
</section>
<section className="panel data-panel">
<SectionTitle title="重置權限資料（洗掉重來）" note="僅系統管理員。先備份、再刪除；刪除後無法復原。" />
{isDemoMode()? (
<p className="settings-note">展示模式不提供重置（僅影響記憶體展示資料，重新整理即還原）。</p>
): (
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
{resetBusy && resetStep === "idle"? "備份中…": "1. 備份並準備重置"}
</button>
<button
className="button button-primary"
disabled={resetBusy || resetStep!== "ready"}
onClick={() => void executePermissionReset()}
>
{resetBusy && resetStep === "ready"? "刪除中…": "2. 確認刪除並清空指派"}
</button>
</div>
</>
)}
</section>
</>
)}
</>
);
}
