import { useCallback, useEffect, useRef, useState} from "react";
import { RefreshCw} from "lucide-react";
import { EmptyState, PageHeading, SectionTitle} from "../components/ui";
import { collection, doc, getDocsFromServer, serverTimestamp, writeBatch} from "../lib/db";
import { getFirebaseDb} from "../lib/firebase";
import { isDemoMode} from "../lib/demoMode";
import { invalidateRefCollection} from "../lib/refCache";
import { useAuth} from "../lib/auth";
import { usePermissions} from "../lib/usePermissions";
import {
ACTION_PERMISSION_ITEMS,
emptyPermissions,
EXCLUDED_ROLE_NAMES,
GROUP_ONLY_PERM_KEYS,
PAGE_PERMISSION_ITEMS,
parsePermissions,
parseTemplateCategory,
PERM_LABELS,
SHARED_PERM_KEYS,
templateDocId,
templateKey,
type PermKey,
type TemplateCategory,
} from "../lib/permissions";
import {
DEFAULT_ROLE_LEVELS,
DEFAULT_TITLE_LEVELS,
roleLevelIdForName,
sortedLevels,
titleLevelIdForName,
type OrgLevel,
} from "../lib/orgLevels";
import { deriveRoleScopeFromLevel } from "../lib/roleDerivation";

/**
 * 設定目標（v1.57.0 B）：動態按層級，一層級一目標。
 * 目標 key 加 kind 前綴（`role:`／`title:`），因角色與職稱都有「單位」層級；
 * 角色目標與職稱目標分兩區列出。範本 category 維持 group／unit／unitRole
 * 不動（方案 A：委員會／品管組層級→group 桶，單位角色層級→unitRole 桶，
 * 職稱層級→unit 桶），can() 不動，不需遷移。
 */
type TargetKind = "role" | "title";

interface PermissionTarget {
key: string;
kind: TargetKind;
levelId: string;
levelName: string;
category: TemplateCategory;
items: MatrixItem[];
}

interface TemplateRow {
key: string;
category: TemplateCategory;
name: string;
kind: TargetKind;
levelId: string;
targetKey: string;
permissions: Record<PermKey, boolean>;
cross: boolean;
}

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
([...SHARED_PERM_KEYS,...GROUP_ONLY_PERM_KEYS] as readonly string[]).includes(
item.key,
),
);

/** 目標列出的權限鍵（v1.57.0 B 第 4 項）：按層級對應的範本桶決定。
 * group 桶＝11 鍵（7 共用＋4 群組專屬），unit／unitRole 桶＝7 鍵；
 * 管理員專屬 4 鍵永不列出。新增角色層級預設 group 桶（11 鍵），
 * 新增職稱層級預設 unit 桶（7 鍵）。 */
function itemsForCategory(category: TemplateCategory): MatrixItem[] {
return category === "group" ? GROUP_ITEMS : SHARED_ITEMS;
}

/** 角色層級對應的範本桶（方案 A）：層級範圍 group→group、unit→unitRole；
 * 自訂層級對不上時看層級名含「單位」與否，否則歸 group。 */
function roleLevelCategory(level: OrgLevel): TemplateCategory {
const scope = deriveRoleScopeFromLevel(level.id, level.name);
if (scope === "unit") return "unitRole";
if (scope === "group") return "group";
return level.name.includes("單位") ? "unitRole" : "group";
}

/** 委員會層級（v1.57.0 B 第 3 項）：新建範本 cross 預設 true。 */
function isCommitteeLevel(level: OrgLevel): boolean {
return level.id === "rl-committee" || level.name === "委員會";
}

/**
 * 層級清單 → 目標清單：角色層級在前、職稱層級在後，各按 order 排序；
 * 新增層級自動多一個目標。
 */
function buildTargets(
roleLevels: OrgLevel[],
titleLevels: OrgLevel[],
): PermissionTarget[] {
const roleTargets: PermissionTarget[] = sortedLevels(roleLevels).map(
(level) => {
const category = roleLevelCategory(level);
return {
key: `role:${level.id}`,
kind: "role",
levelId: level.id,
levelName: level.name,
category,
items: itemsForCategory(category),
};
},
);
const titleTargets: PermissionTarget[] = sortedLevels(titleLevels).map(
(level) => ({
key: `title:${level.id}`,
kind: "title",
levelId: level.id,
levelName: level.name,
category: "unit",
items: SHARED_ITEMS,
}),
);
return [...roleTargets, ...titleTargets];
}

/** 目標尚無任何職稱／角色時的指引（v1.39.2：列只取實際建立的，不寫死名單）。 */
function emptyGuidance(target: PermissionTarget): string {
return target.kind === "role"
? `「${target.levelName}」層級尚未建立任何角色，請先到「群組與人員」建立角色，再回來設定權限。`
: `「${target.levelName}」層級尚未建立任何職稱，請先到「群組與人員」建立職稱，再回來設定權限。`;
}

export function PermissionManagementPage({
onAction,
}: {
onAction: (message: string) => void;
}) {
const { user} = useAuth();
const { isAdmin} = usePermissions();
const [targets, setTargets] = useState<PermissionTarget[]>([]);
const [target, setTarget] = useState<string>("role:rl-committee");
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
* 範本列只取系統實際建立的職稱／角色（v1.39.2，不寫死名單；
* v1.39.3 進頁改走伺服器讀取；v1.57.0 B：目標改動態按層級，
* 列一律以角色／職稱文件的 levelId 歸層級、再由層級對範本桶）：
* 角色按 levelId 歸入 roleLevels 的層級、職稱按 levelId 歸入 titleLevels
* 的層級；未分層級（levelId 空或對不上任何層級）者視為一般使用者，
* 不列入任何目標。系統管理員、一般人員永不列入。
* 層級集合讀到空（展示模式／遷移前）時以 v1.55.0 預設層級補齊，
* levelId 缺失時以名稱推導（與 v1.55.0 遷移同一對照）；
* 讀取失敗時不補（橫幅顯示失敗集合）。
* 範本不存在時以全不勾顯示，改了即建立範本文件；新建委員會層級
* 角色範本 cross 預設 true（既有範本的 cross 值不自動改）。
* 進頁一律讀伺服器（v1.39.3）：cache-first 在此頁會吃到陳舊快照——
* 記憶體快取無 TTL、持久快取非空即回、forceServerRefetch 從未被接上，
* 他處建立的角色／職稱進不了本頁，「重新載入」也刷不掉。管理員專用頁、
* 每進頁 5 次小集合讀取，正確性優先。讀前先失效 refCache，讓其他頁
* 下次也重讀。
*/
const loadData = useCallback(async () => {
setLoading(true);
setLoadError("");
try {
const db = getFirebaseDb();
invalidateRefCollection("permissionTemplates");
invalidateRefCollection("roles");
invalidateRefCollection("titles");
// 單一集合讀取失敗不拖垮整頁（v1.39.4）：permissionTemplates 在 rules
// 缺放行時，Promise.all 會讓 roles／titles 已讀到的資料也全數作廢、
// 整頁只剩一條籠統紅字。改用 allSettled，讀到的集合照常列出，失敗
// 的集合名稱逐一顯示在橫幅。
const [
templateResult,
roleResult,
titleResult,
roleLevelResult,
titleLevelResult,
] = await Promise.allSettled([
getDocsFromServer(collection(db, "permissionTemplates")),
getDocsFromServer(collection(db, "roles")),
getDocsFromServer(collection(db, "titles")),
getDocsFromServer(collection(db, "roleLevels")),
getDocsFromServer(collection(db, "titleLevels")),
]);
const failures: string[] = [];
const templates = new Map<
string,
{ permissions: Record<PermKey, boolean>; cross: boolean}
>();
if (templateResult.status === "fulfilled") {
templateResult.value.docs.forEach((item) => {
const data = item.data() as Record<string, unknown>;
const category = parseTemplateCategory(data.category);
const name = typeof data.name === "string"? data.name: "";
if (!category ||!name) return;
templates.set(templateKey(category, name), {
permissions: parsePermissions(data.permissions),
cross: data.cross === true,
});
});
} else {
failures.push("權限範本（permissionTemplates）");
}
const roleDocs =
roleResult.status === "fulfilled"
? roleResult.value.docs
: (() => {
failures.push("角色（roles）");
return [];
})();
const titleDocs =
titleResult.status === "fulfilled"
? titleResult.value.docs
: (() => {
failures.push("職稱（titles）");
return [];
})();
/** 層級讀取：成功但空集合時以預設層級補齊；失敗時不補、只報失敗。 */
const readLevels = (
result: PromiseSettledResult<{
docs: Array<{ id: string; data: () => unknown}>;
}>,
label: string,
fallback: OrgLevel[],
): OrgLevel[] => {
if (result.status !== "fulfilled") {
failures.push(label);
return [];
}
const levels = result.value.docs.map((item) => {
const data = item.data() as Record<string, unknown>;
return {
id: item.id,
name: typeof data.name === "string"? data.name: "",
order: typeof data.order === "number"? data.order: 0,
};
});
return levels.length > 0 ? levels : fallback;
};
const roleLevels = readLevels(
roleLevelResult,
"角色層級（roleLevels）",
DEFAULT_ROLE_LEVELS,
);
const titleLevels = readLevels(
titleLevelResult,
"職稱層級（titleLevels）",
DEFAULT_TITLE_LEVELS,
);
const nextTargets = buildTargets(roleLevels, titleLevels);
const roleLevelById = new Map(roleLevels.map((level) => [level.id, level]));
const titleLevelById = new Map(
titleLevels.map((level) => [level.id, level]),
);
const nextRows: TemplateRow[] = [];
const pushRole = (name: string, rawLevelId: string) => {
if (!name || (EXCLUDED_ROLE_NAMES as readonly string[]).includes(name)) {
return;
}
const levelId = rawLevelId || roleLevelIdForName(name);
const level = roleLevelById.get(levelId);
if (!level) return;
const targetKey = `role:${level.id}`;
const category = roleLevelCategory(level);
const key = templateKey(category, name);
const tpl = templates.get(key);
nextRows.push({
key,
category,
name,
kind: "role",
levelId: level.id,
targetKey,
permissions: tpl? {...tpl.permissions}: emptyPermissions(),
cross: tpl? tpl.cross: isCommitteeLevel(level),
});
};
const pushTitle = (name: string, rawLevelId: string) => {
if (!name) return;
const levelId = rawLevelId || titleLevelIdForName(name);
const level = titleLevelById.get(levelId);
if (!level) return;
const targetKey = `title:${level.id}`;
const key = templateKey("unit", name);
const tpl = templates.get(key);
nextRows.push({
key,
category: "unit",
name,
kind: "title",
levelId: level.id,
targetKey,
permissions: tpl? {...tpl.permissions}: emptyPermissions(),
cross: tpl? tpl.cross: false,
});
};
for (const item of roleDocs) {
const data = item.data() as Record<string, unknown>;
pushRole(
typeof data.name === "string"? data.name: item.id,
typeof data.levelId === "string"? data.levelId: "",
);
}
for (const item of titleDocs) {
const data = item.data() as Record<string, unknown>;
pushTitle(
typeof data.name === "string"? data.name: item.id,
typeof data.levelId === "string"? data.levelId: "",
);
}
nextRows.sort((a, b) => {
const targetOrder = (key: string) =>
nextTargets.findIndex((item) => item.key === key);
return (
targetOrder(a.targetKey) - targetOrder(b.targetKey) ||
a.name.localeCompare(b.name, "zh-Hant")
);
});
setTargets(nextTargets);
setRows(nextRows);
setLoadError(
failures.length > 0
? `部分資料讀取失敗：${failures.join("、")}，其餘資料照常顯示`
: "",
);
} catch (error) {
setLoadError(error instanceof Error? error.message: "讀取權限範本失敗");
} finally {
setLoading(false);
}
}, []);

useEffect(() => {
void loadData();
}, [loadData]);

/** 選中層級被刪除時 fallback 到第一個可用目標（預設第一個角色層級「委員會」）。 */
useEffect(() => {
if (targets.length === 0) return;
if (!targets.some((item) => item.key === target)) setTarget(targets[0].key);
}, [targets, target]);

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
const crossLabel = (value: boolean) => (value ? "跨區" : "不跨區");
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
<label style={{ display: "flex", alignItems: "center", gap: 4}}>
<input
type="radio"
name={`cross-${row.key}`}
checked={row.cross === true}
disabled={!isAdmin || busy}
onChange={() => void saveCross(row, true)}
aria-label={`${row.name}：跨區`}
/>
跨區
</label>
<label style={{ display: "flex", alignItems: "center", gap: 4}}>
<input
type="radio"
name={`cross-${row.key}`}
checked={row.cross === false}
disabled={!isAdmin || busy}
onChange={() => void saveCross(row, false)}
aria-label={`${row.name}：不跨區`}
/>
不跨區
</label>
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

const selectedTarget = targets.find((item) => item.key === target);
const rowsForTarget = selectedTarget
? rows.filter((row) => row.targetKey === selectedTarget.key)
: [];
const targetItems = selectedTarget ? selectedTarget.items : SHARED_ITEMS;
const targetGuidance = selectedTarget
? emptyGuidance(selectedTarget)
: "尚未建立任何職稱／角色層級，請先到「群組與人員」建立層級，再回來設定權限。";

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
<div className="panel-inset">
<label>
設定目標
<select
value={selectedTarget? target: ""}
onChange={(event) => setTarget(event.target.value)}
aria-label="設定目標"
style={{ marginLeft: 8}}
>
{targets.length === 0? (
<option value="">（尚無層級）</option>
): (
<>
<optgroup label="角色">
{targets
.filter((item) => item.kind === "role")
.map((item) => (
<option key={item.key} value={item.key}>{item.levelName}</option>
))}
</optgroup>
<optgroup label="職稱">
{targets
.filter((item) => item.kind === "title")
.map((item) => (
<option key={item.key} value={item.key}>{item.levelName}</option>
))}
</optgroup>
</>
)}
</select>
</label>
</div>
</section>
<section className="panel data-panel">
<div className="panel-inset">
<SectionTitle title="一、角色／職稱是否可以跨區" />
{rowsForTarget.length === 0? (
<p className="settings-note">{targetGuidance}</p>
): (
crossSection(rowsForTarget)
)}
</div>
</section>
<section className="panel data-panel">
<div className="panel-inset">
<SectionTitle title="二、權限設定" />
{rowsForTarget.length === 0? (
<p className="settings-note">{targetGuidance}</p>
): null}
</div>
{rowsForTarget.length !== 0 && (
permissionMatrix(rowsForTarget, targetItems)
)}
</section>
<section className="panel data-panel">
<div className="panel-inset">
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
</div>
</section>
</>
)}
</>
);
}
