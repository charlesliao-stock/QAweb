import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Download,
  Pencil,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getDocsFromServer,
  limit,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type WriteBatch,
} from "../lib/db";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { getFirebaseDb } from "../lib/firebase";
import { getCachedRefCollection } from "../lib/refCache";
import { getDocsCacheFirst } from "../lib/cacheFirst";
import { useAuth } from "../lib/auth";
import { maskName } from "../lib/mask";
import { SEED_GROUP_NAMES } from "../lib/seed";
import { reviewerDocId, UNCATEGORIZED_GROUP_ID, shouldAutoLinkReviewer } from "../lib/scheduling";
import {
  emptyPermissions,
  parseGroupScopeMode,
  parsePermissions,
  parseRoleKind,
  parseScopeMode,
  scopeAppliesToUnit,
  type GroupScopeMode,
  type RoleKind,
  type ScopeMode,
} from "../lib/permissions";
import {
  deriveGroupIds,
  deriveRoles,
  isGroupScopedRole,
  isReviewerRole,
  isUnitLevelRole,
  parseMemberships,
  type Membership,
} from "../lib/roleIdentity";
import { wouldCreateUnitHistoryCycle } from "../lib/unitHistory";
import {
  UNIT_TEMPLATE_HEADERS,
  USER_TEMPLATE_HEADERS,
  parseUnitSheet,
  parseUserSheet,
  unitTemplateRows,
  userTemplateRows,
  validateUnitRows as validateUnitRowsLib,
  validateUserRows as validateUserRowsLib,
} from "../lib/orgImport";
import { downloadTemplate, readSheetFile } from "../lib/sheetFile";

/** v1.21：組織與設定重整為五區（人員／單位／角色／職稱／群組） */
type Tab = "users" | "units" | "roles" | "titles" | "groups";

interface GroupRow {
  id: string;
  name: string;
  unitCount: number;
}

interface UnitRow {
  code: string;
  name: string;
  groupId: string;
  mergedFromUnitCodes: string[];
  groupName: string;
  memberCount: number | null;
}

interface TitleRow {
  id: string;
  name: string;
  level: string;
  userCount: number | null;
  scopeMode: ScopeMode;
  unitCodes: string[];
  /** 功能權限（v1.12.0：與角色分開設定，目前僅儲存） */
  permissions: Record<string, boolean>;
}

interface UserRow {
  staffId: string;
  name: string;
  unitCode: string;
  title: string;
  titleId: string;
  roles: string[];
  /** 群組＋角色配對（v1.21；無則由舊 groupIds＋roles 推導） */
  memberships: Membership[];
  status: string;
  reviewerAccessExpiresAt: string;
}

interface RoleRow {
  id: string;
  name: string;
  kind: RoleKind;
  groupId: string;
  unitCode: string;
  groupScopeMode: GroupScopeMode;
  memberCount: number | null;
}

interface OptionItem {
  id: string;
  name: string;
  kind: RoleKind;
  groupId?: string;
  unitCode?: string;
  groupScopeMode: GroupScopeMode;
}

function SortHeader({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
}: {
  label: string;
  sortKey: string;
  activeKey: string;
  direction: 1 | -1;
  onSort: (key: string) => void;
}) {
  return (
    <th>
      <button type="button" className="th-sort" onClick={() => onSort(sortKey)}>
        {label}
        {activeKey === sortKey &&
          (direction === 1 ? <ChevronDown size={13} /> : <ChevronUp size={13} />)}
      </button>
    </th>
  );
}

interface GroupForm {
  name: string;
}

interface UnitForm {
  code: string;
  name: string;
  groupId: string;
  mergedFromUnitCodes: string[];
}

interface TitleForm {
  name: string;
  /** v1.37.0：職稱層級只留單位（群組層級已取消）。 */
  level: "單位";
  scopeMode: ScopeMode;
  unitCodes: string[];
}

interface UserForm {
  staffId: string;
  name: string;
  unitCode: string;
  title: string;
  titleId: string;
  hireDate: string;
  email: string;
  phone: string;
  /** 群組＋角色配對列（v1.21：可多個、各群組角色可不同） */
  memberships: Membership[];
  /** 非群組角色（一般人員／護理長／主任／副主任／督導／系統管理員／指標負責人） */
  otherRoles: string[];
  mustChangePassword: boolean;
  /** 督導負責的群組 id（v1.15.0：督導儀表板轄區用） */
  districtGroupIds: string[];
  reviewerAccessExpiresAt: string;
}

interface PreviewRow {
  index: number;
  values: string[];
  ok: boolean;
  error: string;
}

function emptyGroupForm(): GroupForm {
  return { name: "" };
}

function emptyUnitForm(): UnitForm {
  return { code: "", name: "", groupId: "", mergedFromUnitCodes: [] };
}

function emptyTitleForm(): TitleForm {
  return { name: "", level: "單位", scopeMode: "all", unitCodes: [] };
}

function emptyUserForm(): UserForm {
  return {
    staffId: "",
    name: "",
    unitCode: "",
    title: "",
    titleId: "",
    hireDate: "",
    email: "",
    phone: "",
    memberships: [],
    otherRoles: [],
    mustChangePassword: true,
    districtGroupIds: [],
    reviewerAccessExpiresAt: "",
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "讀寫失敗，請檢查網路連線後再試";
}

function auditFields(staffId: string, isCreate: boolean) {
  const now = serverTimestamp();
  return isCreate
    ? {
        createdAt: now,
        createdBy: staffId,
        updatedAt: now,
        updatedBy: staffId,
      }
    : { updatedAt: now, updatedBy: staffId };
}

/** Firestore batch 寫入；每個操作最多包含人員更新＋auditLogs 兩次寫入 */
async function commitInBatches(
  ops: Array<(b: WriteBatch) => void>,
): Promise<void> {
  const db = getFirebaseDb();
  for (let i = 0; i < ops.length; i += 250) {
    const b = writeBatch(db);
    ops.slice(i, i + 250).forEach((op) => op(b));
    await b.commit();
  }
}


// ================= 範例檔 =================

const GROUP_SAMPLE: string[][] = [["群組名稱"], ["病房組"], ["加護組"]];
const GROUP_HEADER = ["群組名稱"];

// v1.21：單位／人員範本改用 lib/orgImport（匯入欄位與範本單一來源）
const UNIT_SAMPLE: string[][] = unitTemplateRows();
const UNIT_HEADER = UNIT_TEMPLATE_HEADERS;

const TITLE_SAMPLE: string[][] = [
  ["職稱名稱", "層級", "適用單位代碼（逗號分隔）"],
  ["護理長", "單位", "請填實際單位代碼"],
  ["副護理長", "單位", "請填實際單位代碼"],
  ["督導", "單位", ""],
  ["護理師", "單位", ""],
];
const TITLE_HEADER = ["職稱名稱", "層級", "適用單位代碼（逗號分隔）"];

const ROLE_SAMPLE: string[][] = [["角色名稱", "所屬群組"], ["自訂角色", "請填實際群組"]];
const ROLE_HEADER = ["角色名稱", "所屬群組"];

const USER_SAMPLE: string[][] = userTemplateRows();
const USER_HEADER = USER_TEMPLATE_HEADERS;

// ================= 批次上傳共用元件 =================

function BatchImporter({
  sampleBaseName,
  sampleRows,
  header,
  validateRows,
  importRows,
  postImportNote,
  onDone,
  onAction,
}: {
  sampleBaseName: string;
  sampleRows: string[][];
  header: string[];
  validateRows: (rows: string[][]) => Promise<PreviewRow[]>;
  /** 回傳摘要字串時以該字串為匯入結果訊息（新增／更新筆數） */
  importRows: (rows: PreviewRow[]) => Promise<string | void>;
  postImportNote?: string;
  onDone: () => void | Promise<void>;
  onAction: (message: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [fileError, setFileError] = useState("");
  const [result, setResult] = useState("");
  const [importing, setImporting] = useState(false);
  // v1.28 階段 5（A2）：xlsx 動態載入，首次讀 .xlsx 檔要多等一次 chunk 下載，顯示讀取中
  const [readingFile, setReadingFile] = useState(false);

  function handlePick() {
    setFileError("");
    setResult("");
    fileRef.current?.click();
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setPreview(null);
    setResult("");
    setReadingFile(true);
    try {
      // v1.21：Excel／CSV 皆可（.xlsx 走 SheetJS，.csv 走自寫解析）
      const rows = await readSheetFile(f);
      if (rows.length === 0) {
        setFileError("檔案為空");
        return;
      }
      const head = rows[0].map((c) => c.trim());
      const matched =
        head.length === header.length &&
        head.every((h, i) => h === header[i]);
      if (!matched) {
        setFileError(
          `標題列不符（應為：${header.join("、")}），請下載範例檔重新填寫`,
        );
        return;
      }
      const data = rows.slice(1);
      if (data.length === 0) {
        setFileError("檔案中沒有資料列");
        return;
      }
      setPreview(await validateRows(data));
    } catch (error) {
      setFileError(`讀取檔案失敗：${toErrorMessage(error)}`);
    } finally {
      setReadingFile(false);
    }
  }

  async function handleConfirm() {
    if (!preview) return;
    const valid = preview.filter((p) => p.ok);
    if (valid.length === 0) {
      setFileError("沒有可匯入的資料列");
      return;
    }
    setImporting(true);
    setFileError("");
    try {
      const summary = await importRows(valid);
      const skipped = preview.length - valid.length;
      const message =
        summary ||
        `匯入完成：成功 ${valid.length} 筆${skipped > 0 ? `，跳過 ${skipped} 筆（資料有誤）` : ""}`;
      setResult(message);
      onAction(message);
      setPreview(null);
      await onDone();
    } catch (error) {
      setFileError(`匯入失敗：${toErrorMessage(error)}`);
    } finally {
      setImporting(false);
    }
  }

  const okCount = preview?.filter((p) => p.ok).length ?? 0;

  return (
    <>
      <button
        className="button button-outline"
        onClick={() => {
          // v1.28 階段 5：downloadTemplate 為 async；xlsx 元件載入失敗時退回 CSV，提示使用者
          void downloadTemplate(sampleRows, "範本", sampleBaseName).then(
            (fmt) => {
              if (fmt === "csv")
                onAction("Excel 元件載入失敗，已改下載 CSV 範例檔");
            },
          );
        }}
      >
        <Download size={14} />
        下載範例檔
      </button>
      <button
        className="button button-outline"
        onClick={handlePick}
        disabled={readingFile || importing}
      >
        <Upload size={14} />
        批次上傳
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        hidden
        onChange={handleFile}
      />
      {fileError && <div className="login-error">{fileError}</div>}
      {readingFile && (
        <p className="settings-note" role="status">
          讀取檔案中…
        </p>
      )}
      {result && <p className="settings-note">{result}</p>}
      {postImportNote && result && (
        <p className="settings-note">{postImportNote}</p>
      )}
      {preview && (
        <section className="panel data-panel import-preview">
          <SectionTitle
            title={`匯入預覽（共 ${preview.length} 筆，可匯入 ${okCount} 筆）`}
            note="僅「通過」的資料列會被匯入"
          />
          <div className="table-scroll">
            <table className="permission-table">
              <thead>
                <tr>
                  <th>列</th>
                  {header.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                  <th>狀態</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((p) => (
                  <tr key={p.index}>
                    <td>{p.index}</td>
                    {header.map((_, i) => (
                      <td key={i}>{p.values[i] ?? ""}</td>
                    ))}
                    <td>
                      <span
                        className={`status-pill ${p.ok ? "success" : "danger"}`}
                      >
                        {p.ok ? "通過" : "錯誤"}
                      </span>
                    </td>
                    <td>{p.error || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-actions">
            <button
              className="button button-primary"
              disabled={importing || okCount === 0}
              onClick={handleConfirm}
            >
              {importing ? "匯入中…" : `確認匯入（${okCount} 筆）`}
            </button>
            <button
              className="button button-outline"
              onClick={() => setPreview(null)}
            >
              取消
            </button>
          </div>
        </section>
      )}
    </>
  );
}

// ================= 成員勾選清單共用（v1.21：全選＋批次移除） =================

function MemberChecklist({
  title,
  note,
  emptyText = "尚無成員。",
  items,
  checked,
  onToggle,
  onToggleAll,
  onRemoveSelected,
  removeLabel,
  busy,
}: {
  title: string;
  note?: string;
  emptyText?: string;
  items: { id: string; label: string; sub?: string }[];
  checked: string[];
  onToggle: (id: string, next: boolean) => void;
  onToggleAll: (next: boolean) => void;
  onRemoveSelected: () => void;
  removeLabel: string;
  busy: boolean;
}) {
  const allChecked =
    items.length > 0 && items.every((i) => checked.includes(i.id));
  return (
    <div>
      <SectionTitle title={title} note={note} />
      {items.length === 0 ? (
        <p className="settings-note">{emptyText}</p>
      ) : (
        <>
          <div className="table-scroll">
            <table className="permission-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={(e) => onToggleAll(e.target.checked)}
                      aria-label="全選"
                    />
                  </th>
                  <th>職編／代號</th>
                  <th>姓名／名稱</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={checked.includes(it.id)}
                        onChange={(e) => onToggle(it.id, e.target.checked)}
                        aria-label={`選擇 ${it.id}`}
                      />
                    </td>
                    <td>
                      <b>{it.id}</b>
                    </td>
                    <td>{it.sub ? `${it.label}（${it.sub}）` : it.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-actions">
            <button
              className="button button-outline"
              disabled={checked.length === 0 || busy}
              onClick={onRemoveSelected}
            >
              {removeLabel}（{checked.length}）
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ================= 主頁 =================

/**
 * v1.28 階段 4：users 全量讀取走參考資料共用快取（getCachedRefCollection）。
 * v1.27.2 的 usersInflight（只去重、不留快取）由它取代：進行中去重＋命中後
 * 跨頁共用；自己寫入後由 db.ts 統一出口自動失效，存檔後的 loadUsers 會重查。
 */

export function GroupsPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  const { user } = useAuth();
  const isAdmin = (user?.roles ?? []).includes("系統管理員");
  const canManageMaster =
    isAdmin || (user?.roles ?? []).includes("品管執行幹事");

  const [tab, setTab] = useState<Tab>("users");
  const [sortState, setSortState] = useState<{ key: string; dir: 1 | -1 }>({
    key: "",
    dir: 1,
  });
  const [userUnitFilter, setUserUnitFilter] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [unitGroupFilter, setUnitGroupFilter] = useState("");
  const [unitSearch, setUnitSearch] = useState("");

  function toggleListSort(key: string) {
    setSortState((prev) => ({
      key,
      dir: prev.key === key ? (prev.dir === 1 ? -1 : 1) : 1,
    }));
  }

  function sortedRows<T>(
    items: T[],
    key: string,
    valueOf: (row: T, key: string) => string | number,
  ) {
    return [...items].sort((a, b) => {
      const av = valueOf(a, key);
      const bv = valueOf(b, key);
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv), "zh-Hant", { numeric: true });
      return sortState.dir * cmp;
    });
  }

  // ---- 群組 ----
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [masterLoading, setMasterLoading] = useState(true);
  const [groupView, setGroupView] = useState<
    { kind: "list" } | { kind: "create" } | { kind: "edit"; id: string }
  >({ kind: "list" });
  const [groupForm, setGroupForm] = useState<GroupForm>(emptyGroupForm());
  const [groupError, setGroupError] = useState("");
  const [groupSaving, setGroupSaving] = useState(false);

  // ---- 單位 ----
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [unitView, setUnitView] = useState<
    { kind: "list" } | { kind: "create" } | { kind: "edit"; code: string }
  >({ kind: "list" });
  const [unitForm, setUnitForm] = useState<UnitForm>(emptyUnitForm());
  const [unitError, setUnitError] = useState("");
  const [unitSaving, setUnitSaving] = useState(false);

  // ---- 職稱 ----
  const [titles, setTitles] = useState<TitleRow[]>([]);
  const [titlesLoading, setTitlesLoading] = useState(true);
  const [titleView, setTitleView] = useState<
    { kind: "list" } | { kind: "create" } | { kind: "edit"; id: string }
  >({ kind: "list" });
  const [titleForm, setTitleForm] = useState<TitleForm>(emptyTitleForm());
  const [titleError, setTitleError] = useState("");
  const [titleSaving, setTitleSaving] = useState(false);

  // ---- 人員 ----
  const [users, setUsers] = useState<UserRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [userView, setUserView] = useState<
    { kind: "list" } | { kind: "create" } | { kind: "edit"; staffId: string }
  >({ kind: "list" });
  const [userForm, setUserForm] = useState<UserForm>(emptyUserForm());
  const [userError, setUserError] = useState("");
  const [userSaving, setUserSaving] = useState(false);
  const [roleOptions, setRoleOptions] = useState<OptionItem[]>([]);

  // ---- 角色（v1.37.0：kind 單位／群組；建立後請至權限管理設定權限） ----
  const [roleCreateOpen, setRoleCreateOpen] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleKind, setNewRoleKind] = useState<RoleKind>("group");
  const [newRoleGroupId, setNewRoleGroupId] = useState("");
  const [newRoleUnitCode, setNewRoleUnitCode] = useState("");
  const [newRoleGroupScopeMode, setNewRoleGroupScopeMode] =
    useState<GroupScopeMode>("group");
  const [roleCreateError, setRoleCreateError] = useState("");
  const [roleCreateSaving, setRoleCreateSaving] = useState(false);
  /** 正在管理成員的角色 id（""＝未開啟） */
  const [managingRoleId, setManagingRoleId] = useState("");
  const [roleMemberChecked, setRoleMemberChecked] = useState<string[]>([]);
  const [roleAddSearch, setRoleAddSearch] = useState("");
  const [roleAddGroupId, setRoleAddGroupId] = useState("");
  const [roleAddChecked, setRoleAddChecked] = useState<string[]>([]);
  const [roleBusy, setRoleBusy] = useState(false);

  // ---- 單位成員管理（v1.21） ----
  const [managingUnitCode, setManagingUnitCode] = useState("");
  const [unitMemberChecked, setUnitMemberChecked] = useState<string[]>([]);
  const [unitAddSearch, setUnitAddSearch] = useState("");
  const [unitBusy, setUnitBusy] = useState(false);

  // ---- 職稱成員管理（v1.21） ----
  const [managingTitleId, setManagingTitleId] = useState("");
  const [titleMemberChecked, setTitleMemberChecked] = useState<string[]>([]);
  const [titleAddSearch, setTitleAddSearch] = useState("");
  const [titleBusy, setTitleBusy] = useState(false);

  // ---- 群組單位管理（v1.21） ----
  const [managingGroupId, setManagingGroupId] = useState("");
  const [groupUnitChecked, setGroupUnitChecked] = useState<string[]>([]);
  const [groupUnitAdd, setGroupUnitAdd] = useState("");
  const [groupBusy, setGroupBusy] = useState(false);

  const visibleUnits = sortedRows(
    units.filter((row) => {
      const keyword = unitSearch.trim().toLocaleLowerCase();
      return (
        (!unitGroupFilter || row.groupId === unitGroupFilter) &&
        (!keyword ||
          row.code.toLocaleLowerCase().includes(keyword) ||
          row.name.toLocaleLowerCase().includes(keyword))
      );
    }),
    sortState.key,
    (row, key) =>
      key === "unit-name"
        ? row.name
        : key === "unit-group"
          ? row.groupName
          : key === "unit-count"
            ? (row.memberCount ?? -1)
            : row.code,
  );
  const visibleUsers = sortedRows(
    users.filter((row) => {
      const keyword = userSearch.trim().toLocaleLowerCase();
      return (
        (!userUnitFilter || row.unitCode === userUnitFilter) &&
        (!keyword ||
          row.staffId.toLocaleLowerCase().includes(keyword) ||
          row.name.toLocaleLowerCase().includes(keyword))
      );
    }),
    sortState.key,
    (row, key) =>
      key === "user-name"
        ? row.name
        : key === "user-unit"
          ? row.unitCode
          : key === "user-title"
            ? row.title
            : key === "user-role"
              ? row.roles.join("、")
              : key === "user-status"
                ? row.status
                : row.staffId,
  );

  /** 角色清單＋成員數（由 roleOptions 與人員清單衍生） */
  const roleRows: RoleRow[] = useMemo(
    () =>
      roleOptions.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        groupId: r.groupId ?? "",
        unitCode: r.unitCode ?? "",
        groupScopeMode: r.groupScopeMode,
        memberCount:
          users.length > 0
            ? users.filter((u) => r.groupId
                ? u.memberships.some((m) => m.groupId === r.groupId && m.roles.includes(r.name))
                : isGroupScopedRole(r.name)
                  ? u.memberships.some((m) => m.roles.includes(r.name))
                  : u.roles.includes(r.name)).length
            : null,
      })),
    [roleOptions, users],
  );

  // ---- 各成員管理面板的衍生清單（v1.21） ----
  const managingRole = roleRows.find((r) => r.id === managingRoleId) ?? null;
  const managingTitle = titles.find((item) => item.id === managingTitleId) ?? null;
  const roleMembers = useMemo(
    () =>
      managingRole
        ? users.filter((u) => managingRole.groupId
            ? u.memberships.some((m) => m.groupId === managingRole.groupId && m.roles.includes(managingRole.name))
            : isGroupScopedRole(managingRole.name)
              ? u.memberships.some((m) => m.roles.includes(managingRole.name))
              : u.roles.includes(managingRole.name))
        : [],
    [users, managingRole],
  );
  const roleCandidates = useMemo(() => {
    if (!managingRole) return [];
    const kw = roleAddSearch.trim().toLowerCase();
    return users.filter(
        (u) =>
          u.status === "在職" &&
        !(managingRole.groupId
          ? u.memberships.some((m) => m.groupId === managingRole.groupId && m.roles.includes(managingRole.name))
          : isGroupScopedRole(managingRole.name)
            ? u.memberships.some((m) => m.roles.includes(managingRole.name))
            : u.roles.includes(managingRole.name)) &&
        (kw === "" ||
          u.staffId.toLowerCase().includes(kw) ||
          u.name.toLowerCase().includes(kw)),
    );
  }, [users, managingRole, roleAddSearch]);

  const unitMembers = useMemo(
    () =>
      managingUnitCode
        ? users.filter((u) => u.unitCode === managingUnitCode)
        : [],
    [users, managingUnitCode],
  );
  const unitCandidates = useMemo(() => {
    if (!managingUnitCode) return [];
    const kw = unitAddSearch.trim().toLowerCase();
    return users
      .filter(
        (u) =>
          u.status === "在職" &&
          u.unitCode !== managingUnitCode &&
          (kw === "" ||
            u.staffId.toLowerCase().includes(kw) ||
            u.name.toLowerCase().includes(kw)),
      )
      .slice(0, 20);
  }, [users, managingUnitCode, unitAddSearch]);

  const titleMembers = useMemo(
    () => {
      const title = titles.find((item) => item.id === managingTitleId);
      if (!title) return [];
      return users.filter((u) => u.titleId === title.id || (
        !u.titleId && u.title === title.name && scopeAppliesToUnit(title.scopeMode, title.unitCodes, u.unitCode)
      ));
    },
    [users, titles, managingTitleId],
  );
  const titleCandidates = useMemo(() => {
    const title = titles.find((item) => item.id === managingTitleId);
    if (!title) return [];
    const kw = titleAddSearch.trim().toLowerCase();
    return users
      .filter(
        (u) =>
          u.status === "在職" &&
          scopeAppliesToUnit(title.scopeMode, title.unitCodes, u.unitCode) &&
          u.titleId !== title.id &&
          (u.titleId || u.title !== title.name || !scopeAppliesToUnit(title.scopeMode, title.unitCodes, u.unitCode)) &&
          (kw === "" ||
            u.staffId.toLowerCase().includes(kw) ||
            u.name.toLowerCase().includes(kw)),
      )
      .slice(0, 20);
  }, [users, titles, managingTitleId, titleAddSearch]);

  const groupUnits = useMemo(
    () =>
      managingGroupId
        ? units.filter((u) => u.groupId === managingGroupId)
        : [],
    [units, managingGroupId],
  );

  const usersLoadedRef = useRef(false);

  const loadRoles = useCallback(async () => {
    try {
      const snap = await getCachedRefCollection("roles", () =>
        getDocsCacheFirst(collection(getFirebaseDb(), "roles")),
      );
      setRoleOptions(
        snap.docs.map((d) => {
          const data = d.data();
          const groupId = typeof data.groupId === "string" ? data.groupId : "";
          return {
            id: d.id,
            name: typeof data.name === "string" ? data.name : d.id,
            kind: parseRoleKind(data.kind, groupId),
            groupId,
            unitCode: typeof data.unitCode === "string" ? data.unitCode : "",
            groupScopeMode: parseGroupScopeMode(data.groupScopeMode),
          };
        }),
      );
    } catch {
      setRoleOptions([]);
    }
  }, []);

  /** 群組＋單位一起載入（單位需對應群組名稱、人數） */
  const loadMaster = useCallback(async () => {
    setMasterLoading(true);
    try {
      const db = getFirebaseDb();
      const [gsnap, usnap] = await Promise.all([
        getCachedRefCollection("groups", () =>
          getDocsCacheFirst(collection(db, "groups")),
        ),
        getCachedRefCollection("units", () =>
          getDocsCacheFirst(collection(db, "units")),
        ),
      ]);
      const groupList = gsnap.docs
        .map((d) => ({
          id: d.id,
          name: typeof d.data().name === "string" ? d.data().name : "",
        }))
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
      const groupIdToName = new Map(groupList.map((g) => [g.id, g.name]));

      // 各單位人數（非管理員無 users 查詢權限，顯示「—」）
      const counts = new Map<string, number>();
      try {
        const usersSnap = await getCachedRefCollection("users", () =>
          getDocsFromServer(collection(getFirebaseDb(), "users")),
        );
        usersSnap.docs.forEach((d) => {
          const uc = d.data().unitCode;
          if (typeof uc === "string" && uc) {
            counts.set(uc, (counts.get(uc) ?? 0) + 1);
          }
        });
      } catch {
        // 維持空 map
      }

      const unitList: UnitRow[] = usnap.docs
        .map((d) => {
          const data = d.data();
          const groupId =
            typeof data.groupId === "string" ? data.groupId : "";
          return {
            code: d.id,
            name: typeof data.name === "string" ? data.name : "",
            groupId,
            mergedFromUnitCodes: Array.isArray(data.mergedFromUnitCodes)
              ? data.mergedFromUnitCodes.map(String).filter(Boolean)
              : [],
            groupName: groupIdToName.get(groupId) ?? "未分類",
            memberCount: counts.has(d.id) ? (counts.get(d.id) ?? 0) : null,
          };
        })
        .sort((a, b) => a.code.localeCompare(b.code, "zh-Hant"));

      const unitCountByGroup = new Map<string, number>();
      unitList.forEach((u) => {
        if (u.groupId) {
          unitCountByGroup.set(u.groupId, (unitCountByGroup.get(u.groupId) ?? 0) + 1);
        }
      });

      setGroups(
        groupList.map((g) => ({
          ...g,
          unitCount: unitCountByGroup.get(g.id) ?? 0,
        })),
      );
      setUnits(unitList);
    } catch (error) {
      onAction(`讀取群組／單位清單失敗：${toErrorMessage(error)}`);
    } finally {
      setMasterLoading(false);
    }
  }, [onAction]);

  const loadTitles = useCallback(async () => {
    setTitlesLoading(true);
    try {
      const db = getFirebaseDb();
      const snap = await getCachedRefCollection("titles", () =>
        getDocsCacheFirst(collection(db, "titles")),
      );
      const list = snap.docs
        .map((d) => {
          const data = d.data();
          const unitCodes = Array.isArray(data.unitCodes)
            ? data.unitCodes.map(String).filter(Boolean)
            : [];
          return {
            id: d.id,
            name: typeof data.name === "string" ? data.name : "",
            level: typeof data.level === "string" ? data.level : "",
            scopeMode: parseScopeMode(data.scopeMode, unitCodes),
            unitCodes,
            permissions: { ...parsePermissions(data.permissions) },
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
      // 各職稱使用人數（僅管理員可查 users）
      const titleCounts = new Map<string, number>();
      const legacyTitleCounts = new Map<string, number>();
      try {
        const usnap = await getCachedRefCollection("users", () =>
          getDocsFromServer(collection(getFirebaseDb(), "users")),
        );
        usnap.docs.forEach((d) => {
          const data = d.data();
          const titleId = typeof data.titleId === "string" ? data.titleId : "";
          const titleName = typeof data.title === "string" ? data.title : "";
          const unitCode = typeof data.unitCode === "string" ? data.unitCode : "";
          if (titleId) {
            titleCounts.set(titleId, (titleCounts.get(titleId) ?? 0) + 1);
          } else if (titleName && unitCode) {
            const key = `${encodeURIComponent(unitCode)}::${encodeURIComponent(titleName)}`;
            legacyTitleCounts.set(key, (legacyTitleCounts.get(key) ?? 0) + 1);
          }
        });
      } catch {
        titleCounts.clear();
        legacyTitleCounts.clear();
      }
      setTitles(
        list.map((t) => {
          // 不分單位職稱：舊人員以職稱名稱比對（不限單位）；分單位職稱：只計勾選單位內的舊人員。
          const legacyCount =
            t.scopeMode === "all"
              ? [...legacyTitleCounts.entries()]
                  .filter(([key]) => key.endsWith(`::${encodeURIComponent(t.name)}`))
                  .reduce((sum, [, count]) => sum + count, 0)
              : t.unitCodes.reduce(
                  (count, code) => count + (legacyTitleCounts.get(
                    `${encodeURIComponent(code)}::${encodeURIComponent(t.name)}`,
                  ) ?? 0),
                  0,
                );
          return {
            ...t,
            userCount: titleCounts.has(t.id) || t.scopeMode === "all" || t.unitCodes.length > 0
              ? (titleCounts.get(t.id) ?? 0) + legacyCount
              : null,
          };
        }),
      );
    } catch (error) {
      onAction(`讀取職稱清單失敗：${toErrorMessage(error)}`);
    } finally {
      setTitlesLoading(false);
    }
  }, [onAction]);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const snap = await getCachedRefCollection("users", () =>
        getDocsFromServer(collection(getFirebaseDb(), "users")),
      );
      usersLoadedRef.current = true;
      const list: UserRow[] = snap.docs
        .map((d) => {
          const data = d.data();
          const roles = Array.isArray(data.roles)
            ? data.roles.map(String)
            : [];
          return {
            staffId: d.id,
            name: typeof data.name === "string" ? data.name : "",
            unitCode: typeof data.unitCode === "string" ? data.unitCode : "",
            title: typeof data.title === "string" ? data.title : "",
            titleId: typeof data.titleId === "string" ? data.titleId : "",
            roles,
            // v1.21：讀取以 memberships 為主，無則 fallback 舊 groupIds＋roles
            memberships: parseMemberships(data.memberships, {
              roles,
              groupIds: Array.isArray(data.groupIds)
                ? data.groupIds.map(String)
                : [],
            }),
            status: typeof data.status === "string" ? data.status : "在職",
            reviewerAccessExpiresAt: typeof data.reviewerAccessExpiresAt === "string"
              ? data.reviewerAccessExpiresAt
              : "",
          };
        })
        .sort((a, b) => a.staffId.localeCompare(b.staffId, "zh-Hant"));
      setUsers(list);
    } catch (error) {
      onAction(`讀取人員清單失敗：${toErrorMessage(error)}`);
    } finally {
      setUsersLoading(false);
    }
  }, [onAction]);

  /**
   * v1.37.0：只補種群組（SEED_GROUP_NAMES，不存在才建立）。
   * 角色／職稱不再有預設、也不自動補種，由系統管理員自行建立。
   */
  const ensureSeeds = useCallback(async () => {
    // 群組種子寫入含 groups 集合（rules 限幹事以上寫入），僅管理員執行
    if (!isAdmin) return;
    try {
      const db = getFirebaseDb();
      const me = user?.staffId ?? "";
      const gSnap = await getCachedRefCollection("groups", () =>
        getDocsCacheFirst(collection(db, "groups")),
      );
      const groupNames = new Set(
        gSnap.docs.map((d) => String(d.data().name ?? "")),
      );
      const ops: Array<(b: WriteBatch) => void> = [];
      for (const name of SEED_GROUP_NAMES) {
        if (!groupNames.has(name)) {
          ops.push((b) =>
            b.set(doc(collection(db, "groups")), {
              name,
              ...auditFields(me, true),
            }),
          );
        }
      }
      if (ops.length > 0) await commitInBatches(ops);
    } catch {
      // 種子建立失敗不阻擋清單載入（下次開頁再補）
    }
  }, [isAdmin, user]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // v1.37.0：先補種群組（不存在才建立），再載入清單
      await ensureSeeds();
      if (cancelled) return;
      loadMaster();
      loadRoles();
      loadTitles();
      // v1.12.0：掛載時即預載人員（修頁籤 badge 初始顯示 0 的問題）
      if (isAdmin) loadUsers();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadMaster, loadRoles, loadTitles, isAdmin, ensureSeeds]);

  useEffect(() => {
    // v1.27.2：掛載時已預載人員，切回頁籤不重拉（存檔後各 handler 會自行 loadUsers）
    if (tab === "users" && isAdmin && !usersLoadedRef.current) {
      loadUsers();
    }
  }, [tab, isAdmin, loadUsers]);

  useEffect(() => {
    if (tab === "roles" && canManageMaster && users.length === 0) {
      loadUsers();
    }
  }, [tab, canManageMaster, users.length, loadUsers]);

  // ================= 群組 =================

  function openGroupCreate() {
    setGroupForm(emptyGroupForm());
    setGroupError("");
    setGroupView({ kind: "create" });
  }

  function openGroupEdit(id: string) {
    const row = groups.find((g) => g.id === id);
    if (!row) return;
    setGroupForm({ name: row.name });
    setGroupError("");
    setGroupView({ kind: "edit", id });
  }

  async function handleGroupSave() {
    const view = groupView;
    const name = groupForm.name.trim();
    if (!name) {
      setGroupError("請填寫群組名稱");
      return;
    }
    if (!user) {
      setGroupError("請先登入");
      return;
    }
    if (
      groups.some(
        (g) => g.name === name && (view.kind !== "edit" || g.id !== view.id),
      )
    ) {
      setGroupError(`群組「${name}」已存在`);
      return;
    }
    setGroupError("");
    setGroupSaving(true);
    try {
      const db = getFirebaseDb();
      if (view.kind === "create") {
        await setDoc(doc(collection(db, "groups")), {
          name,
          ...auditFields(user.staffId, true),
        });
        onAction(`已新增群組 ${name}`);
      } else if (view.kind === "edit") {
        await updateDoc(doc(db, "groups", view.id), {
          name,
          ...auditFields(user.staffId, false),
        });
        onAction(`群組已更新為 ${name}`);
      }
      setGroupView({ kind: "list" });
      await loadMaster();
    } catch (error) {
      setGroupError(`儲存失敗：${toErrorMessage(error)}`);
    } finally {
      setGroupSaving(false);
    }
  }

  async function handleGroupDelete(row: GroupRow) {
    if (!user) return;
    try {
      const db = getFirebaseDb();
      const unitSnap = await getDocs(
        query(collection(db, "units"), where("groupId", "==", row.id), limit(1)),
      );
      if (!unitSnap.empty) {
        onAction(`群組「${row.name}」尚有單位歸屬，無法刪除（請先將單位移出）`);
        return;
      }
    } catch {
      onAction("刪除前檢查單位歸屬失敗，請確認權限後再試");
      return;
    }
    const ok = window.confirm(`確定刪除群組「${row.name}」？此動作無法復原。`);
    if (!ok) return;
    try {
      await deleteDoc(doc(getFirebaseDb(), "groups", row.id));
      onAction(`群組「${row.name}」已刪除`);
      await loadMaster();
    } catch (error) {
      onAction(`刪除失敗：${toErrorMessage(error)}`);
    }
  }

  // ================= 單位 =================

  function openUnitCreate() {
    setUnitForm(emptyUnitForm());
    setUnitError("");
    setUnitView({ kind: "create" });
  }

  function openUnitEdit(code: string) {
    const row = units.find((u) => u.code === code);
    if (!row) return;
    setUnitForm({
      code: row.code,
      name: row.name,
      groupId: row.groupId,
      mergedFromUnitCodes: [...row.mergedFromUnitCodes],
    });
    setUnitError("");
    setUnitView({ kind: "edit", code });
  }

  async function handleUnitSave() {
    const view = unitView;
    if (view.kind === "list") return;
    if (view.kind === "create" && !unitForm.code.trim()) {
      setUnitError("請填寫單位代號");
      return;
    }
    if (!unitForm.name.trim()) {
      setUnitError("請填寫單位名稱");
      return;
    }
    if (!user) {
      setUnitError("請先登入");
      return;
    }
    const code = view.kind === "create" ? unitForm.code.trim() : view.code;
    const mergedFromUnitCodes = [...new Set(unitForm.mergedFromUnitCodes)]
      .filter((source) => source && source !== code);
    if (wouldCreateUnitHistoryCycle(units, code, mergedFromUnitCodes)) {
      setUnitError("合併來源會形成單位沿革循環，請重新選擇");
      return;
    }
    setUnitError("");
    setUnitSaving(true);
    try {
      const db = getFirebaseDb();
      const payload = {
        name: unitForm.name.trim(),
        groupId: unitForm.groupId,
        mergedFromUnitCodes,
        ...auditFields(user.staffId, false),
      };
      if (view.kind === "create") {
        const ref = doc(db, "units", code);
        const exists = await getDoc(ref);
        if (exists.exists()) {
          setUnitError(`單位代號 ${code} 已存在`);
          setUnitSaving(false);
          return;
        }
        const batch = writeBatch(db);
        batch.set(ref, { ...payload, ...auditFields(user.staffId, true) });
        if (mergedFromUnitCodes.length > 0) {
          batch.set(doc(collection(db, "auditLogs")), {
            actor: user.staffId,
            actorName: user.name,
            action: "單位合併沿革權限建立",
            targetType: "unit",
            targetId: code,
            detail: `新增單位 ${code}，設定可存取的合併前單位資料`,
            before: { mergedFromUnitCodes: [] },
            after: { mergedFromUnitCodes },
            createdAt: serverTimestamp(),
          });
        }
        await batch.commit();
        onAction(`已新增單位 ${code}`);
      } else if (view.kind === "edit") {
        const ref = doc(db, "units", view.code);
        const previous = (await getDoc(ref)).data() ?? {};
        const beforeCodes = Array.isArray(previous.mergedFromUnitCodes)
          ? previous.mergedFromUnitCodes.map(String).filter(Boolean)
          : [];
        const changed = JSON.stringify(beforeCodes) !== JSON.stringify(mergedFromUnitCodes);
        const batch = writeBatch(db);
        batch.update(ref, payload);
        if (changed) {
          batch.set(doc(collection(db, "auditLogs")), {
            actor: user.staffId,
            actorName: user.name,
            action: "單位合併沿革權限異動",
            targetType: "unit",
            targetId: view.code,
            detail: `更新單位 ${view.code} 的合併歷史資料可見範圍`,
            before: { mergedFromUnitCodes: beforeCodes },
            after: { mergedFromUnitCodes },
            createdAt: serverTimestamp(),
          });
        }
        await batch.commit();
        onAction(`單位 ${view.code} 已更新`);
      }
      setUnitView({ kind: "list" });
      await loadMaster();
    } catch (error) {
      setUnitError(`儲存失敗：${toErrorMessage(error)}`);
    } finally {
      setUnitSaving(false);
    }
  }

  async function handleUnitDelete(code: string) {
    if (!user) return;
    const historicalReference = units.find(
      (unit) => unit.code !== code && unit.mergedFromUnitCodes.includes(code),
    );
    if (historicalReference) {
      onAction(`單位 ${code} 是 ${historicalReference.code} 的合併歷史來源，請先調整沿革設定，不能刪除`);
      return;
    }
    try {
      const db = getFirebaseDb();
      const memberSnap = await getDocs(
        query(collection(db, "users"), where("unitCode", "==", code), limit(1)),
      );
      if (!memberSnap.empty) {
        onAction(`單位 ${code} 尚有人員歸屬，無法刪除（請先將人員移出或改派）`);
        return;
      }
    } catch {
      onAction("刪除前檢查人員歸屬失敗，請確認權限後再試");
      return;
    }
    const ok = window.confirm(`確定刪除單位 ${code}？此動作無法復原。`);
    if (!ok) return;
    try {
      await deleteDoc(doc(getFirebaseDb(), "units", code));
      onAction(`單位 ${code} 已刪除`);
      await loadMaster();
    } catch (error) {
      onAction(`刪除失敗：${toErrorMessage(error)}`);
    }
  }

  // ================= 職稱 =================

  function openTitleCreate() {
    setTitleForm(emptyTitleForm());
    setTitleError("");
    setTitleView({ kind: "create" });
  }

  function openTitleEdit(id: string) {
    const row = titles.find((t) => t.id === id);
    if (!row) return;
    setTitleForm({
      name: row.name,
      level: "單位",
      scopeMode: row.scopeMode,
      unitCodes: [...row.unitCodes],
    });
    setTitleError("");
    setTitleView({ kind: "edit", id });
  }

  async function handleTitleSave() {
    const view = titleView;
    const name = titleForm.name.trim();
    const scopeMode = titleForm.scopeMode;
    const unitCodes = scopeMode === "all"
      ? []
      : [...new Set(titleForm.unitCodes)].filter(Boolean);
    if (!name) {
      setTitleError("請填寫職稱名稱");
      return;
    }
    if (!user) {
      setTitleError("請先登入");
      return;
    }
    if (scopeMode === "units" && unitCodes.length === 0) {
      setTitleError("分單位時請至少設定一個適用單位；或改為不分單位");
      return;
    }
    if (
      titles.some(
        (t) =>
          t.name === name &&
          (scopeMode === "all" ||
            t.scopeMode === "all" ||
            t.unitCodes.some((code) => unitCodes.includes(code))) &&
          (view.kind !== "edit" || t.id !== view.id),
      )
    ) {
      setTitleError(`職稱「${name}」在所選適用範圍中已存在；同名職稱可設定在不同單位`);
      return;
    }
    setTitleError("");
    setTitleSaving(true);
    const scopeLabel = scopeMode === "all"
      ? "不分單位（適用全部單位）"
      : `分單位（${unitCodes.join("、")}）`;
    try {
      const db = getFirebaseDb();
      if (view.kind === "create") {
        const titleRef = doc(collection(db, "titles"));
        const batch = writeBatch(db);
        batch.set(titleRef, {
          name,
          level: titleForm.level,
          scopeMode,
          unitCodes,
          permissions: emptyPermissions(),
          ...auditFields(user.staffId, true),
        });
        batch.set(doc(collection(db, "auditLogs")), {
          actor: user.staffId,
          actorName: user.name,
          action: "職稱適用單位異動",
          targetType: "title",
          targetId: titleRef.id,
          detail: `新增職稱「${name}」並設定適用範圍：${scopeLabel}`,
          before: null,
          after: { name, level: titleForm.level, scopeMode, unitCodes },
          createdAt: serverTimestamp(),
        });
        await batch.commit();
        onAction(`已新增職稱 ${name}（${titleForm.level}）；請至權限管理設定權限`);
      } else if (view.kind === "edit") {
        const old = titles.find((title) => title.id === view.id);
        const batch = writeBatch(db);
        batch.update(doc(db, "titles", view.id), {
          name,
          level: titleForm.level,
          scopeMode,
          unitCodes,
          ...auditFields(user.staffId, false),
        });
        batch.set(doc(collection(db, "auditLogs")), {
          actor: user.staffId,
          actorName: user.name,
          action: "職稱適用單位異動",
          targetType: "title",
          targetId: view.id,
          detail: `更新職稱「${name}」適用範圍：${old?.scopeMode === "all" ? "不分單位" : (old?.unitCodes ?? []).join("、")} → ${scopeLabel}`,
          before: old ? { name: old.name, level: old.level, scopeMode: old.scopeMode, unitCodes: old.unitCodes } : null,
          after: { name, level: titleForm.level, scopeMode, unitCodes },
          createdAt: serverTimestamp(),
        });
        await batch.commit();
        onAction(`職稱已更新為 ${name}（${titleForm.level}）`);
      }
      setTitleView({ kind: "list" });
      await loadTitles();
    } catch (error) {
      setTitleError(`儲存失敗：${toErrorMessage(error)}`);
    } finally {
      setTitleSaving(false);
    }
  }

  async function handleTitleDelete(row: TitleRow) {
    if (!user) return;
    try {
      const db = getFirebaseDb();
      const usedSnap = await getDocsFromServer(collection(db, "users"));
      const hasUsers = usedSnap.docs.some((document) => {
        const data = document.data();
        if (data.titleId === row.id) return true;
        const titleName = typeof data.title === "string" ? data.title : "";
        const userUnit = typeof data.unitCode === "string" ? data.unitCode : "";
        return !data.titleId && titleName === row.name && (
          scopeAppliesToUnit(row.scopeMode, row.unitCodes, userUnit)
        );
      });
      if (hasUsers) {
        onAction(`職稱「${row.name}」尚有人員使用，無法刪除`);
        return;
      }
    } catch {
      onAction("無權限檢查人員使用情形，請聯絡系統管理員刪除");
      return;
    }
    const ok = window.confirm(
      `確定刪除職稱「${row.name}（${row.level}）」？此動作無法復原。`,
    );
    if (!ok) return;
    try {
      const db = getFirebaseDb();
      const batch = writeBatch(db);
      batch.delete(doc(db, "titles", row.id));
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user.staffId,
        actorName: user.name,
        action: "職稱適用範圍刪除",
        targetType: "title",
        targetId: row.id,
        detail: `刪除職稱「${row.name}」及其適用單位設定`,
        before: { name: row.name, level: row.level, unitCodes: row.unitCodes, permissions: row.permissions },
        after: null,
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      onAction(`職稱「${row.name}」已刪除`);
      await loadTitles();
    } catch (error) {
      onAction(`刪除失敗：${toErrorMessage(error)}`);
    }
  }

  // ================= 人員 =================

  function openUserCreate() {
    setUserForm(emptyUserForm());
    setUserError("");
    setUserView({ kind: "create" });
  }

  function openUserEdit(staffId: string) {
    const row = users.find((u) => u.staffId === staffId);
    if (!row) return;
    setUserForm({
      staffId: row.staffId,
      name: row.name,
      unitCode: row.unitCode,
      title: row.title,
      titleId: row.titleId || (() => {
        const matches = titles.filter((title) => title.name === row.title && scopeAppliesToUnit(title.scopeMode, title.unitCodes, row.unitCode));
        return matches.length === 1 ? matches[0].id : "";
      })(),
      hireDate: "",
      email: "",
      phone: "",
      // v1.21：群組角色走 memberships 配對列；非群組角色另列勾選
      memberships: row.memberships.map((m) => ({
        groupId: m.groupId,
        roles: [...m.roles],
      })),
      otherRoles: row.roles.filter((r) =>
        !isGroupScopedRole(r) && !row.memberships.some((membership) => membership.roles.includes(r)),
      ),
      mustChangePassword: true,
      districtGroupIds: [],
      reviewerAccessExpiresAt: row.reviewerAccessExpiresAt,
    });
    setUserError("");
    void (async () => {
      try {
        const snap = await getDoc(doc(getFirebaseDb(), "users", staffId));
        if (snap.exists()) {
          const data = snap.data();
          setUserForm((prev) => ({
            ...prev,
            hireDate: typeof data.hireDate === "string" ? data.hireDate : "",
            email: typeof data.email === "string" ? data.email : "",
            phone: typeof data.phone === "string" ? data.phone : "",
            districtGroupIds: Array.isArray(data.districtGroupIds)
              ? data.districtGroupIds.map(String)
              : [],
            reviewerAccessExpiresAt: typeof data.reviewerAccessExpiresAt === "string"
              ? data.reviewerAccessExpiresAt
              : "",
          }));
        }
      } catch {
        // 讀不到細節欄位不阻擋編輯
      }
    })();
    setUserView({ kind: "edit", staffId });
  }

  /** 群組＋角色配對列（v1.21）：新增一列 */
  function addMembershipRow() {
    setUserForm((prev) => ({
      ...prev,
      memberships: [...prev.memberships, { groupId: "", roles: [] }],
    }));
  }

  function updateMembershipRow(index: number, patch: Partial<Membership>) {
    setUserForm((prev) => ({
      ...prev,
      memberships: prev.memberships.map((m, i) =>
        i === index ? { ...m, ...patch } : m,
      ),
    }));
  }

  function removeMembershipRow(index: number) {
    setUserForm((prev) => ({
      ...prev,
      memberships: prev.memberships.filter((_, i) => i !== index),
    }));
  }

  function toggleMembershipRole(index: number, roleName: string) {
    setUserForm((prev) => ({
      ...prev,
      memberships: prev.memberships.map((m, i) =>
        i === index
          ? {
              ...m,
              roles: m.roles.includes(roleName)
                ? m.roles.filter((r) => r !== roleName)
                : [...m.roles, roleName],
            }
          : m,
      ),
    }));
  }

  function toggleOtherRole(roleName: string) {
    setUserForm((prev) => ({
      ...prev,
      otherRoles: prev.otherRoles.includes(roleName)
        ? prev.otherRoles.filter((r) => r !== roleName)
        : [...prev.otherRoles, roleName],
    }));
  }

  async function handleUserSave() {
    const view = userView;
    if (view.kind === "create" && !userForm.staffId.trim()) {
      setUserError("請填寫職編");
      return;
    }
    if (!userForm.name.trim()) {
      setUserError("請填寫姓名");
      return;
    }
    if (!user) {
      setUserError("請先登入");
      return;
    }
    const selectedTitle = userForm.titleId
      ? titles.find((title) => title.id === userForm.titleId)
      : undefined;
    if (!userForm.titleId || !selectedTitle) {
      setUserError("請選擇職稱");
      return;
    }
    if (!scopeAppliesToUnit(selectedTitle.scopeMode, selectedTitle.unitCodes, userForm.unitCode)) {
      setUserError("所選職稱不適用目前單位，請重新選擇職稱");
      return;
    }
    const roles = [
      ...new Set([
        ...deriveRoles(userForm.memberships.filter((m) => m.groupId)),
        ...userForm.otherRoles,
      ]),
    ];
    const reviewerAccessExpiresAt = isReviewerRole(roles)
      ? userForm.reviewerAccessExpiresAt.trim()
      : "";
    if (reviewerAccessExpiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(reviewerAccessExpiresAt)) {
      setUserError("審查員效期請選擇有效日期；留白代表永久有效");
      return;
    }
    setUserError("");
    setUserSaving(true);
    try {
      const db = getFirebaseDb();
      // v1.21：memberships 為主；同步更新 groupIds（衍生）與 roles（聯集＋非群組角色）
      const memberships = userForm.memberships.filter((m) => m.groupId);
      const payload = {
        name: userForm.name.trim(),
        unitCode: userForm.unitCode,
        title: selectedTitle?.name ?? userForm.title,
        titleId: selectedTitle?.id ?? "",
        hireDate: userForm.hireDate,
        email: userForm.email.trim(),
        phone: userForm.phone.trim(),
        memberships,
        groupIds: deriveGroupIds(memberships),
        roles,
        reviewerAccessExpiresAt: reviewerAccessExpiresAt || null,
        districtGroupIds: userForm.districtGroupIds,
        ...auditFields(user.staffId, false),
      };
      if (view.kind === "create") {
        const staffId = userForm.staffId.trim();
        const ref = doc(db, "users", staffId);
        const exists = await getDoc(ref);
        if (exists.exists()) {
          setUserError(`職編 ${staffId} 已存在`);
          setUserSaving(false);
          return;
        }
        const userPayload = {
          ...payload,
          mustChangePassword: userForm.mustChangePassword,
          ...auditFields(user.staffId, true),
        };
        const batch = writeBatch(db);
        batch.set(ref, userPayload);
        if (roles.length > 0 || memberships.length > 0) {
          batch.set(doc(collection(db, "auditLogs")), {
            actor: user.staffId,
            actorName: user.name,
            action: "建立人員權限",
            targetType: "user",
            targetId: staffId,
            detail: `建立職編 ${staffId} 並設定角色／群組權限`,
            before: { roles: [], memberships: [] },
            after: {
              roles,
              memberships,
              reviewerAccessExpiresAt: reviewerAccessExpiresAt || null,
              unitCode: userForm.unitCode,
              titleId: selectedTitle?.id ?? "",
              title: selectedTitle?.name ?? userForm.title,
            },
            createdAt: serverTimestamp(),
          });
        }
        await batch.commit();
        onAction(
          `已新增人員 ${staffId}。請再到 Firebase Console → Authentication 新增使用者，email 格式為 ${staffId}@nurseboard.internal`,
        );
      } else if (view.kind === "edit") {
        const userRef = doc(db, "users", view.staffId);
        const previousSnap = await getDoc(userRef);
        const previous = previousSnap.exists()
          ? (previousSnap.data() as Record<string, unknown>)
          : {};
        const beforePermissions = {
          roles: Array.isArray(previous.roles) ? previous.roles : [],
          memberships: Array.isArray(previous.memberships) ? previous.memberships : [],
          districtGroupIds: Array.isArray(previous.districtGroupIds) ? previous.districtGroupIds : [],
          reviewerAccessExpiresAt: typeof previous.reviewerAccessExpiresAt === "string"
            ? previous.reviewerAccessExpiresAt
            : null,
          unitCode: typeof previous.unitCode === "string" ? previous.unitCode : "",
          titleId: typeof previous.titleId === "string" ? previous.titleId : "",
          title: typeof previous.title === "string" ? previous.title : "",
        };
        const afterPermissions = {
          roles,
          memberships,
          districtGroupIds: userForm.districtGroupIds,
          reviewerAccessExpiresAt: reviewerAccessExpiresAt || null,
          unitCode: userForm.unitCode,
          titleId: selectedTitle?.id ?? "",
          title: selectedTitle?.name ?? userForm.title,
        };
        const permissionChanged = JSON.stringify(beforePermissions) !== JSON.stringify(afterPermissions);
        const batch = writeBatch(db);
        batch.update(userRef, payload);
        if (permissionChanged) {
          batch.set(doc(collection(db, "auditLogs")), {
            actor: user.staffId,
            actorName: user.name,
            action: "人員權限異動",
            targetType: "user",
            targetId: view.staffId,
            detail: `更新職編 ${view.staffId} 的角色／群組權限`,
            before: beforePermissions,
            after: afterPermissions,
            createdAt: serverTimestamp(),
          });
        }
        await batch.commit();
        onAction(`人員 ${view.staffId} 已更新`);
      }
      setUserView({ kind: "list" });
      await loadUsers();
      // 審查員連動（v1.12.0）：roles 含任一審查員身分 → 自動加入審查員名單（未分類）
      const savedStaffId =
        view.kind === "edit" ? view.staffId : userForm.staffId.trim();
      try {
        if (shouldAutoLinkReviewer(roles)) {
          const existing = await getDocs(
            query(
              collection(db, "reviewReviewers"),
              where("personId", "==", savedStaffId),
              limit(1),
            ),
          );
          if (existing.empty) {
            await setDoc(
              doc(
                db,
                "reviewReviewers",
                reviewerDocId(UNCATEGORIZED_GROUP_ID, savedStaffId),
              ),
              {
                groupId: UNCATEGORIZED_GROUP_ID,
                personId: savedStaffId,
                createdAt: serverTimestamp(),
              },
            );
            onAction(`已將 ${savedStaffId} 自動加入審查員名單（未分類）`);
          }
        } else {
          // 移除角色時，同步移除自動加入的「未分類」審查員（手動指派的不動）
          await deleteDoc(
            doc(
              db,
              "reviewReviewers",
              reviewerDocId(UNCATEGORIZED_GROUP_ID, savedStaffId),
            ),
          );
        }
      } catch {
        onAction("審查員名單連動失敗，請聯絡系統管理員手動調整");
      }
    } catch (error) {
      setUserError(`儲存失敗：${toErrorMessage(error)}`);
    } finally {
      setUserSaving(false);
    }
  }

  async function handleToggleStatus(row: UserRow) {
    if (!user) return;
    const next = row.status === "停用" ? "在職" : "停用";
    if (row.staffId === user.staffId && next === "停用") {
      onAction("不能停用自己的帳號");
      return;
    }
    const ok = window.confirm(
      `確定將 ${row.staffId}（${row.name}）設為「${next}」？` +
        (next === "停用" ? "停用後該人員將無法登入。" : ""),
    );
    if (!ok) return;
    try {
      const db = getFirebaseDb();
      const userRef = doc(db, "users", row.staffId);
      const batch = writeBatch(db);
      batch.update(userRef, {
        status: next,
        ...auditFields(user.staffId, false),
      });
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user.staffId,
        actorName: user.name,
        action: "人員帳號狀態異動",
        targetType: "user",
        targetId: row.staffId,
        detail: `職編 ${row.staffId} 帳號狀態由「${row.status}」改為「${next}」`,
        before: { status: row.status },
        after: { status: next },
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      onAction(`人員 ${row.staffId} 已設為${next}`);
      await loadUsers();
    } catch (error) {
      onAction(`狀態變更失敗：${toErrorMessage(error)}`);
    }
  }

  // ================= 角色成員（v1.21） =================

  /** 從人員的 roles／memberships 移除指定角色（角色刪除／成員移除共用） */
  function removeRoleFromUser(row: UserRow, roleName: string, groupId = "") {
    return (b: WriteBatch) => {
      const memberships = row.memberships
        .map((m) => ({
          ...m,
          roles: m.roles.filter((r) => r !== roleName || (groupId && m.groupId !== groupId)),
        }))
        .filter((m) => m.roles.length > 0);
      const remainsInMembership = memberships.some((m) => m.roles.includes(roleName));
      const roles = row.roles.filter((r) => r !== roleName || remainsInMembership);
      b.update(doc(getFirebaseDb(), "users", row.staffId), {
        roles,
        memberships,
        groupIds: deriveGroupIds(memberships),
        ...auditFields(user?.staffId ?? "", false),
      });
      b.set(doc(collection(getFirebaseDb(), "auditLogs")), {
        actor: user?.staffId ?? "",
        actorName: user?.name ?? "",
        action: "移除人員角色",
        targetType: "user",
        targetId: row.staffId,
        detail: `移除職編 ${row.staffId} 的角色「${roleName}」${groupId ? `（群組 ${groupId}）` : ""}`,
        before: { roles: row.roles, memberships: row.memberships },
        after: { roles, memberships },
        createdAt: serverTimestamp(),
      });
    };
  }

  /** 將角色加入人員（群組範圍角色需指定群組；單位級以其單位所屬群組計） */
  function addRoleToUser(row: UserRow, roleName: string, groupId: string) {
    return (b: WriteBatch) => {
      const roles = [...new Set([...row.roles, roleName])];
      let memberships = row.memberships;
      if (groupId || isGroupScopedRole(roleName)) {
        const existing = memberships.find((m) => m.groupId === groupId);
        if (existing) {
          memberships = memberships.map((m) =>
            m.groupId === groupId
              ? { ...m, roles: [...new Set([...m.roles, roleName])] }
              : m,
          );
        } else {
          memberships = [...memberships, { groupId, roles: [roleName] }];
        }
      }
      b.set(doc(collection(getFirebaseDb(), "auditLogs")), {
        actor: user?.staffId ?? "",
        actorName: user?.name ?? "",
        action: "新增人員角色",
        targetType: "user",
        targetId: row.staffId,
        detail: `為職編 ${row.staffId} 新增角色「${roleName}」${groupId ? `（群組 ${groupId}）` : ""}`,
        before: { roles: row.roles, memberships: row.memberships },
        after: { roles, memberships },
        createdAt: serverTimestamp(),
      });
      b.update(doc(getFirebaseDb(), "users", row.staffId), {
        roles,
        memberships,
        groupIds: deriveGroupIds(memberships),
        ...auditFields(user?.staffId ?? "", false),
      });
    };
  }

  function openRoleMembers(roleId: string) {
    const role = roleRows.find((item) => item.id === roleId);
    setManagingRoleId(roleId);
    setRoleMemberChecked([]);
    setRoleAddSearch("");
    setRoleAddGroupId(role?.groupId ?? "");
    setRoleAddChecked([]);
    setRoleEditKind(role?.kind ?? "group");
    setRoleEditGroupId(role?.groupId ?? "");
    setRoleEditUnitCode(role?.unitCode ?? "");
    setRoleEditGroupScopeMode(role?.groupScopeMode ?? "group");
    setRoleEditError("");
  }

  async function handleRoleMembersRemove() {
    const role = roleRows.find((r) => r.id === managingRoleId);
    if (!role || roleMemberChecked.length === 0) return;
    const ok = window.confirm(
      `確定將 ${roleMemberChecked.length} 位人員移出角色「${role.name}」？`,
    );
    if (!ok) return;
    setRoleBusy(true);
    try {
      const targets = users.filter((u) =>
        roleMemberChecked.includes(u.staffId),
      );
      await commitInBatches(
        targets.map((u) => removeRoleFromUser(u, role.name, role.groupId)),
      );
      onAction(`已將 ${targets.length} 位人員移出角色「${role.name}」`);
      setRoleMemberChecked([]);
      await loadUsers();
    } catch (error) {
      onAction(`移除失敗：${toErrorMessage(error)}`);
    } finally {
      setRoleBusy(false);
    }
  }

  async function handleRoleMembersAdd() {
    const role = roleRows.find((r) => r.id === managingRoleId);
    if (!role || roleAddChecked.length === 0) return;
    const groupScoped = Boolean(role.groupId) || isGroupScopedRole(role.name);
    const unitLevel = isUnitLevelRole(role.name);
    const unitGroupOf = (unitCode: string) =>
      units.find((u) => u.code === unitCode)?.groupId ?? "";
    const targets = users.filter((u) => roleAddChecked.includes(u.staffId));
    const noUnit: string[] = [];
    const ops: Array<(b: WriteBatch) => void> = [];
    for (const u of targets) {
      let gid = "";
      if (unitLevel) {
        gid = unitGroupOf(u.unitCode);
        if (!gid) {
          noUnit.push(u.staffId);
          continue;
        }
      } else if (groupScoped) {
        gid = role.groupId || roleAddGroupId;
        if (!gid) {
          onAction("請先選擇此角色適用的群組");
          return;
        }
      }
      ops.push(addRoleToUser(u, role.name, gid));
    }
    if (noUnit.length > 0) {
      onAction(
        `以下人員無所屬單位群組，無法加入單位級角色：${noUnit.join("、")}`,
      );
      if (ops.length === 0) return;
    }
    setRoleBusy(true);
    try {
      await commitInBatches(ops);
      onAction(`已將 ${ops.length} 位人員加入角色「${role.name}」`);
      setRoleAddChecked([]);
      setRoleAddSearch("");
      await loadUsers();
    } catch (error) {
      onAction(`加入失敗：${toErrorMessage(error)}`);
    } finally {
      setRoleBusy(false);
    }
  }

  async function handleRoleDelete(row: RoleRow) {
    if (!user) return;
    const ok = window.confirm(
      `確定刪除角色「${row.name}」？將同時從所有人員的角色中移除此角色，此動作無法復原。`,
    );
    if (!ok) return;
    setRoleBusy(true);
    try {
      const targets = users.filter((u) => row.groupId
        ? u.memberships.some((m) => m.groupId === row.groupId && m.roles.includes(row.name))
        : isGroupScopedRole(row.name)
          ? u.memberships.some((m) => m.roles.includes(row.name))
          : u.roles.includes(row.name));
      await commitInBatches(
        targets.map((u) => removeRoleFromUser(u, row.name, row.groupId)),
      );
      const db = getFirebaseDb();
      const batch = writeBatch(db);
      batch.delete(doc(db, "roles", row.id));
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user.staffId,
        actorName: user.name,
        action: "群組角色刪除",
        targetType: "role",
        targetId: row.id,
        detail: `刪除群組 ${row.groupId || "全域／預設"} 的角色「${row.name}」`,
        before: { name: row.name, groupId: row.groupId, memberCount: targets.length },
        after: null,
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      onAction(
        `角色「${row.name}」已刪除（已從 ${targets.length} 位人員移除）`,
      );
      setManagingRoleId("");
      await loadRoles();
      await loadUsers();
    } catch (error) {
      onAction(`刪除失敗：${toErrorMessage(error)}`);
    } finally {
      setRoleBusy(false);
    }
  }

  async function handleRoleCreate() {
    const name = newRoleName.trim();
    const kind = newRoleKind;
    if (!name) {
      setRoleCreateError("請輸入角色名稱");
      return;
    }
    if (kind === "group" && !newRoleGroupId) {
      setRoleCreateError("群組角色請先選擇所屬群組");
      return;
    }
    if (kind === "unit" && !newRoleUnitCode) {
      setRoleCreateError("單位角色請先選擇所屬單位");
      return;
    }
    const groupId = kind === "group" ? newRoleGroupId : "";
    const unitCode = kind === "unit" ? newRoleUnitCode : "";
    const groupScopeMode: GroupScopeMode =
      kind === "group" ? newRoleGroupScopeMode : "group";
    if (roleRows.some((role) =>
      role.name === name && role.kind === kind &&
      (kind === "group" ? role.groupId === groupId : role.unitCode === unitCode),
    )) {
      setRoleCreateError(
        kind === "group"
          ? `此群組已存在角色「${name}」；其他群組可建立同名角色`
          : `此單位已存在角色「${name}」；其他單位可建立同名角色`,
      );
      return;
    }
    setRoleCreateSaving(true);
    setRoleCreateError("");
    try {
      const db = getFirebaseDb();
      const roleRef = doc(collection(db, "roles"));
      const batch = writeBatch(db);
      batch.set(roleRef, {
        name,
        kind,
        groupId,
        unitCode,
        groupScopeMode,
        description: "",
        permissions: emptyPermissions(),
        ...auditFields(user?.staffId ?? "", true),
      });
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user?.staffId ?? "",
        actorName: user?.name ?? "",
        action: kind === "group" ? "群組角色建立" : "單位角色建立",
        targetType: "role",
        targetId: roleRef.id,
        detail: kind === "group"
          ? `於群組 ${groupId} 建立角色「${name}」（${groupScopeMode === "all" ? "跨群組" : "不跨群組"}）`
          : `於單位 ${unitCode} 建立角色「${name}」`,
        before: null,
        after: { name, kind, groupId, unitCode, groupScopeMode, permissions: emptyPermissions() },
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      setNewRoleName("");
      setNewRoleKind("group");
      setNewRoleGroupId("");
      setNewRoleUnitCode("");
      setNewRoleGroupScopeMode("group");
      setRoleCreateOpen(false);
      await loadRoles();
      onAction(`已新增角色「${name}」；請至權限管理設定權限`);
    } catch (error) {
      setRoleCreateError(`新增失敗：${toErrorMessage(error)}`);
    } finally {
      setRoleCreateSaving(false);
    }
  }

  /** 既有角色設定異動（v1.37.0）：在成員管理面板編輯 kind／所屬群組／單位／跨群組範圍。 */
  const [roleEditKind, setRoleEditKind] = useState<RoleKind>("group");
  const [roleEditGroupId, setRoleEditGroupId] = useState("");
  const [roleEditUnitCode, setRoleEditUnitCode] = useState("");
  const [roleEditGroupScopeMode, setRoleEditGroupScopeMode] =
    useState<GroupScopeMode>("group");
  const [roleEditError, setRoleEditError] = useState("");
  const [roleEditSaving, setRoleEditSaving] = useState(false);
  async function handleRoleSettingsSave() {
    const role = roleRows.find((r) => r.id === managingRoleId);
    if (!role || !user) return;
    if (roleEditKind === "group" && !roleEditGroupId) {
      setRoleEditError("群組角色請先選擇所屬群組");
      return;
    }
    if (roleEditKind === "unit" && !roleEditUnitCode) {
      setRoleEditError("單位角色請先選擇所屬單位");
      return;
    }
    const groupId = roleEditKind === "group" ? roleEditGroupId : "";
    const unitCode = roleEditKind === "unit" ? roleEditUnitCode : "";
    const groupScopeMode: GroupScopeMode =
      roleEditKind === "group" ? roleEditGroupScopeMode : "group";
    setRoleEditError("");
    setRoleEditSaving(true);
    try {
      const db = getFirebaseDb();
      const batch = writeBatch(db);
      batch.update(doc(db, "roles", role.id), {
        kind: roleEditKind,
        groupId,
        unitCode,
        groupScopeMode,
        ...auditFields(user.staffId, false),
      });
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user.staffId,
        actorName: user.name,
        action: "角色設定異動",
        targetType: "role",
        targetId: role.id,
        detail: `角色「${role.name}」改為${roleEditKind === "group" ? `群組角色（群組 ${groupId}，${groupScopeMode === "all" ? "跨群組" : "不跨群組"}）` : `單位角色（單位 ${unitCode}）`}`,
        before: { kind: role.kind, groupId: role.groupId, unitCode: role.unitCode, groupScopeMode: role.groupScopeMode },
        after: { kind: roleEditKind, groupId, unitCode, groupScopeMode },
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      await loadRoles();
      onAction(`角色「${role.name}」設定已更新`);
    } catch (error) {
      setRoleEditError(`儲存失敗：${toErrorMessage(error)}`);
    } finally {
      setRoleEditSaving(false);
    }
  }

  // ================= 單位成員（v1.21） =================

  async function handleUnitMembersRemove() {
    if (!managingUnitCode || unitMemberChecked.length === 0) return;
    const ok = window.confirm(
      `確定將 ${unitMemberChecked.length} 位人員移出單位 ${managingUnitCode}？`,
    );
    if (!ok) return;
    setUnitBusy(true);
    try {
      const me = user?.staffId ?? "";
      const targets = users.filter((item) => unitMemberChecked.includes(item.staffId));
      await commitInBatches(
        targets.map(
          (target) => (b: WriteBatch) => {
            b.update(doc(getFirebaseDb(), "users", target.staffId), {
              unitCode: "",
              title: "",
              titleId: "",
              ...auditFields(me, false),
            });
            b.set(doc(collection(getFirebaseDb(), "auditLogs")), {
              actor: me,
              actorName: user?.name ?? "",
              action: "人員單位職稱範圍異動",
              targetType: "user",
              targetId: target.staffId,
              detail: `職編 ${target.staffId} 移出單位 ${managingUnitCode}`,
              before: { unitCode: target.unitCode, titleId: target.titleId, title: target.title },
              after: { unitCode: "", titleId: "", title: "" },
              createdAt: serverTimestamp(),
            });
          },
        ),
      );
      onAction(
        `已將 ${unitMemberChecked.length} 位人員移出單位 ${managingUnitCode}`,
      );
      setUnitMemberChecked([]);
      await loadUsers();
      await loadMaster();
    } catch (error) {
      onAction(`移除失敗：${toErrorMessage(error)}`);
    } finally {
      setUnitBusy(false);
    }
  }

  async function handleUnitMemberAdd(staffId: string) {
    if (!managingUnitCode) return;
    const target = users.find((item) => item.staffId === staffId);
    if (!target) return;
    const legacyMatches = titles.filter((title) =>
      !target.titleId && title.name === target.title && scopeAppliesToUnit(title.scopeMode, title.unitCodes, target.unitCode),
    );
    const currentTitle = target.titleId
      ? titles.find((title) => title.id === target.titleId)
      : legacyMatches.length === 1 ? legacyMatches[0] : undefined;
    const retainedTitle = currentTitle && scopeAppliesToUnit(currentTitle.scopeMode, currentTitle.unitCodes, managingUnitCode) ? currentTitle : undefined;
    setUnitBusy(true);
    try {
      const db = getFirebaseDb();
      const batch = writeBatch(db);
      batch.update(doc(db, "users", staffId), {
        unitCode: managingUnitCode,
        title: retainedTitle?.name ?? "",
        titleId: retainedTitle?.id ?? "",
        ...auditFields(user?.staffId ?? "", false),
      });
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user?.staffId ?? "",
        actorName: user?.name ?? "",
        action: "人員單位職稱範圍異動",
        targetType: "user",
        targetId: staffId,
        detail: `職編 ${staffId} 單位 ${target.unitCode} → ${managingUnitCode}`,
        before: { unitCode: target.unitCode, titleId: target.titleId, title: target.title },
        after: { unitCode: managingUnitCode, titleId: retainedTitle?.id ?? "", title: retainedTitle?.name ?? "" },
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      onAction(`已將 ${staffId} 加入單位 ${managingUnitCode}`);
      setUnitAddSearch("");
      await loadUsers();
      await loadMaster();
    } catch (error) {
      onAction(`加入失敗：${toErrorMessage(error)}`);
    } finally {
      setUnitBusy(false);
    }
  }

  // ================= 職稱成員（v1.21） =================

  async function handleTitleMembersRemove() {
    const title = titles.find((item) => item.id === managingTitleId);
    if (!title || titleMemberChecked.length === 0) return;
    const ok = window.confirm(
      `確定將 ${titleMemberChecked.length} 位人員移出職稱「${title.name}」？`,
    );
    if (!ok) return;
    setTitleBusy(true);
    try {
      const me = user?.staffId ?? "";
      const targets = users.filter((item) => titleMemberChecked.includes(item.staffId));
      await commitInBatches(
        targets.map(
          (target) => (b: WriteBatch) => {
            b.update(doc(getFirebaseDb(), "users", target.staffId), {
              title: "",
              titleId: "",
              ...auditFields(me, false),
            });
            b.set(doc(collection(getFirebaseDb(), "auditLogs")), {
              actor: me,
              actorName: user?.name ?? "",
              action: "人員職稱異動",
              targetType: "user",
              targetId: target.staffId,
              detail: `移除職編 ${target.staffId} 的職稱「${target.title}」`,
              before: { titleId: target.titleId, title: target.title, unitCode: target.unitCode },
              after: { titleId: "", title: "", unitCode: target.unitCode },
              createdAt: serverTimestamp(),
            });
          },
        ),
      );
      onAction(
        `已將 ${titleMemberChecked.length} 位人員移出職稱「${title.name}」`,
      );
      setTitleMemberChecked([]);
      await loadUsers();
      await loadTitles();
    } catch (error) {
      onAction(`移除失敗：${toErrorMessage(error)}`);
    } finally {
      setTitleBusy(false);
    }
  }

  async function handleTitleMemberAdd(staffId: string) {
    const title = titles.find((item) => item.id === managingTitleId);
    const target = users.find((item) => item.staffId === staffId);
    if (!title || !target || !scopeAppliesToUnit(title.scopeMode, title.unitCodes, target.unitCode)) return;
    setTitleBusy(true);
    try {
      const db = getFirebaseDb();
      const batch = writeBatch(db);
      batch.update(doc(db, "users", staffId), {
        title: title.name,
        titleId: title.id,
        ...auditFields(user?.staffId ?? "", false),
      });
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user?.staffId ?? "",
        actorName: user?.name ?? "",
        action: "人員職稱異動",
        targetType: "user",
        targetId: staffId,
        detail: `職編 ${staffId} 職稱「${target.title}」→「${title.name}」`,
        before: { titleId: target.titleId, title: target.title, unitCode: target.unitCode },
        after: { titleId: title.id, title: title.name, unitCode: target.unitCode },
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      onAction(`已將 ${staffId} 轉任「${title.name}」`);
      setTitleAddSearch("");
      await loadUsers();
      await loadTitles();
    } catch (error) {
      onAction(`加入失敗：${toErrorMessage(error)}`);
    } finally {
      setTitleBusy(false);
    }
  }

  // ================= 群組單位（v1.21） =================

  async function handleGroupUnitsRemove() {
    if (!managingGroupId || groupUnitChecked.length === 0) return;
    const group = groups.find((g) => g.id === managingGroupId);
    const ok = window.confirm(
      `確定將 ${groupUnitChecked.length} 個單位移出群組「${group?.name ?? ""}」？`,
    );
    if (!ok) return;
    setGroupBusy(true);
    try {
      const me = user?.staffId ?? "";
      await commitInBatches(
        groupUnitChecked.map(
          (code) => (b: WriteBatch) =>
            b.update(doc(getFirebaseDb(), "units", code), {
              groupId: "",
              ...auditFields(me, false),
            }),
        ),
      );
      onAction(
        `已將 ${groupUnitChecked.length} 個單位移出群組「${group?.name ?? ""}」`,
      );
      setGroupUnitChecked([]);
      await loadMaster();
    } catch (error) {
      onAction(`移除失敗：${toErrorMessage(error)}`);
    } finally {
      setGroupBusy(false);
    }
  }

  async function handleGroupUnitAdd(code: string) {
    if (!managingGroupId) return;
    setGroupBusy(true);
    try {
      await updateDoc(doc(getFirebaseDb(), "units", code), {
        groupId: managingGroupId,
        ...auditFields(user?.staffId ?? "", false),
      });
      onAction(`已將單位 ${code} 加入群組`);
      setGroupUnitAdd("");
      await loadMaster();
    } catch (error) {
      onAction(`加入失敗：${toErrorMessage(error)}`);
    } finally {
      setGroupBusy(false);
    }
  }

  // ================= 批次上傳驗證與匯入 =================

  function validateGroupRows(rows: string[][]): Promise<PreviewRow[]> {
    const existing = new Set(groups.map((g) => g.name));
    const seen = new Set<string>();
    return Promise.resolve(
      rows.map((r, i) => {
        const index = i + 1;
        const name = (r[0] ?? "").trim();
        if (!name) return { index, values: r, ok: false, error: "群組名稱不可空白" };
        if (existing.has(name))
          return { index, values: r, ok: false, error: `「${name}」已存在` };
        if (seen.has(name))
          return { index, values: r, ok: false, error: `檔案內重複：${name}` };
        seen.add(name);
        return { index, values: r, ok: true, error: "" };
      }),
    );
  }

  async function importGroupRows(rows: PreviewRow[]): Promise<void> {
    const me = user?.staffId ?? "";
    await commitInBatches(
      rows.map(
        (r) => (b: WriteBatch) =>
          b.set(doc(collection(getFirebaseDb(), "groups")), {
            name: r.values[0].trim(),
            ...auditFields(me, true),
          }),
      ),
    );
  }

  function validateRoleRows(rows: string[][]): Promise<PreviewRow[]> {
    const groupByName = new Map(groups.map((group) => [group.name, group.id]));
    const seen = new Set<string>();
    return Promise.resolve(
      rows.map((row, i) => {
        const name = (row[0] ?? "").trim();
        const groupName = (row[1] ?? "").trim();
        const groupId = groupByName.get(groupName) ?? "";
        const key = `${groupId}::${name}`;
        let error = "";
        if (!name) error = "角色名稱不可空白";
        else if (!groupId) error = `群組「${groupName}」不存在或未填`;
        else if (roleRows.some((role) => role.name === name && (!role.groupId || role.groupId === groupId))
          || seen.has(key)) error = `群組「${groupName}」已有同名角色「${name}」`;
        seen.add(key);
        return { index: i + 1, values: row, ok: !error, error };
      }),
    );
  }

  async function importRoleRows(rows: PreviewRow[]): Promise<void> {
    const me = user?.staffId ?? "";
    const groupByName = new Map(groups.map((group) => [group.name, group.id]));
    await commitInBatches(
      rows.map((row) => {
        const name = row.values[0].trim();
        const groupName = row.values[1].trim();
        const groupId = groupByName.get(groupName) ?? "";
        const roleRef = doc(collection(getFirebaseDb(), "roles"));
        return (batch: WriteBatch) => {
          batch.set(roleRef, {
            name,
            kind: "group",
            groupId,
            unitCode: "",
            groupScopeMode: "group",
            description: "",
            permissions: emptyPermissions(),
            ...auditFields(me, true),
          });
          batch.set(doc(collection(getFirebaseDb(), "auditLogs")), {
            actor: me,
            actorName: user?.name ?? "",
            action: "群組角色建立",
            targetType: "role",
            targetId: roleRef.id,
            detail: `批次於群組 ${groupId} 建立角色「${name}」（群組角色，不跨群組）`,
            before: null,
            after: { name, kind: "group", groupId, groupScopeMode: "group", permissions: emptyPermissions() },
            createdAt: serverTimestamp(),
          });
        };
      }),
    );
  }

  /** 單位匯入驗證（v1.21：舊資料匯入，未填忽略；代號已存在→更新） */
  function validateUnitRows(rows: string[][]): Promise<PreviewRow[]> {
    const groupByName = new Map(groups.map((g) => [g.name, g.id]));
    const { headerErrors, data } = parseUnitSheet([UNIT_HEADER, ...rows]);
    if (headerErrors.length > 0) {
      return Promise.resolve(
        rows.map((r, i) => ({
          index: i + 1,
          values: r,
          ok: false,
          error: headerErrors.join("；"),
        })),
      );
    }
    const results = validateUnitRowsLib(data, {
      existingCodes: new Set(units.map((u) => u.code)),
      groupByName,
    });
    return Promise.resolve(
      results.map((r, j) => ({
        index: j + 1,
        values: rows[j] ?? [],
        ok: r.ok,
        error: r.ok ? "" : r.errors.join("；"),
      })),
    );
  }

  async function importUnitRows(rows: PreviewRow[]): Promise<string> {
    const me = user?.staffId ?? "";
    const groupByName = new Map(groups.map((g) => [g.name, g.id]));
    const { data } = parseUnitSheet([
      UNIT_HEADER,
      ...rows.map((r) => r.values),
    ]);
    const results = validateUnitRowsLib(data, {
      existingCodes: new Set(units.map((u) => u.code)),
      groupByName,
    });
    let created = 0;
    let updated = 0;
    const ops = results
      .filter((r) => r.ok && r.values)
      .map((r) => {
        const v = r.values!;
        if (r.action === "update") updated += 1;
        else created += 1;
        const ref = doc(getFirebaseDb(), "units", v.code);
        if (r.action === "update") {
          const patch: Record<string, any> = {
            ...auditFields(me, false),
          };
          if (v.name !== null) patch.name = v.name;
          if (v.groupId !== null) patch.groupId = v.groupId;
          return (b: WriteBatch) => b.update(ref, patch);
        }
        return (b: WriteBatch) =>
          b.set(ref, {
            name: v.name ?? "",
            groupId: v.groupId ?? "",
            ...auditFields(me, true),
          });
      });
    await commitInBatches(ops);
    return `單位匯入完成：新增 ${created} 筆、更新 ${updated} 筆`;
  }

  function validateTitleRows(rows: string[][]): Promise<PreviewRow[]> {
    const keyFor = (name: string, unitCode: string) => `${name}::${unitCode}`;
    const existing = new Set(titles.flatMap((title) => title.unitCodes.map((code) => keyFor(title.name, code))));
    const existingAllScope = new Set(
      titles.filter((title) => title.scopeMode === "all").map((title) => title.name),
    );
    const seen = new Set<string>();
    return Promise.resolve(
      rows.map((r, i) => {
        const index = i + 1;
        const name = (r[0] ?? "").trim();
        const level = (r[1] ?? "").trim();
        const unitCodes = [...new Set((r[2] ?? "").split(/[,，、]/).map((code) => code.trim()).filter(Boolean))];
        if (!name) return { index, values: r, ok: false, error: "職稱名稱不可空白" };
        if (level !== "單位")
          return { index, values: r, ok: false, error: "層級限填「單位」（v1.37.0 起職稱只分單位層級）" };
        // 適用單位代碼可空白＝不分單位（v1.37.0：拿掉強制至少填一個單位代碼的驗證）
        const unknownCodes = unitCodes.filter((code) => !units.some((unit) => unit.code === code));
        if (unknownCodes.length > 0) return { index, values: r, ok: false, error: `找不到單位代碼：${unknownCodes.join("、")}` };
        if (unitCodes.length === 0) {
          if (existingAllScope.has(name) || seen.has(`all::${name}`))
            return { index, values: r, ok: false, error: `不分單位職稱「${name}」已存在` };
          seen.add(`all::${name}`);
          return { index, values: r, ok: true, error: "" };
        }
        const keys = unitCodes.map((code) => keyFor(name, code));
        const existingKey = keys.find((key) => existing.has(key));
        if (existingKey) return { index, values: r, ok: false, error: `職稱「${name}」已在部分適用單位中存在` };
        if (keys.some((key) => seen.has(key))) return { index, values: r, ok: false, error: `檔案內有同名職稱重疊適用單位：${name}` };
        keys.forEach((key) => seen.add(key));
        return { index, values: r, ok: true, error: "" };
      }),
    );
  }

  async function importTitleRows(rows: PreviewRow[]): Promise<void> {
    const me = user?.staffId ?? "";
    await commitInBatches(
      rows.map((r) => {
        const name = r.values[0].trim();
        const level = "單位";
        const unitCodes = [...new Set((r.values[2] ?? "").split(/[,，、]/).map((code) => code.trim()).filter(Boolean))];
        const scopeMode: ScopeMode = unitCodes.length === 0 ? "all" : "units";
        const titleRef = doc(collection(getFirebaseDb(), "titles"));
        return (b: WriteBatch) => {
          b.set(titleRef, {
            name,
            level,
            scopeMode,
            unitCodes,
            permissions: emptyPermissions(),
            ...auditFields(me, true),
          });
          b.set(doc(collection(getFirebaseDb(), "auditLogs")), {
            actor: me,
            actorName: user?.name ?? "",
            action: "職稱適用單位異動",
            targetType: "title",
            targetId: titleRef.id,
            detail: scopeMode === "all"
              ? `批次建立職稱「${name}」（不分單位）`
              : `批次建立職稱「${name}」並設定適用單位：${unitCodes.join("、")}`,
            before: null,
            after: { name, level, scopeMode, unitCodes },
            createdAt: serverTimestamp(),
          });
        };
      }),
    );
  }

  function roleGroupScopes() {
    const scopes = new Map<string, string[]>();
    roleOptions.forEach((role) => {
      const current = scopes.get(role.name) ?? [];
      if (role.groupId) current.push(role.groupId);
      else if (isGroupScopedRole(role.name)) current.push("*");
      scopes.set(role.name, current);
    });
    return scopes;
  }

  function validateUserImportData(data: ReturnType<typeof parseUserSheet>["data"]) {
    const base = validateUserRowsLib(data, {
      existingStaffIds: new Set(users.map((u) => u.staffId)),
      groupByName: new Map(groups.map((g) => [g.name, g.id])),
      roleNames: new Set(roleOptions.map((r) => r.name)),
      roleGroupIdsByName: roleGroupScopes(),
      titleNames: new Set(titles.map((t) => t.name)),
      unitCodes: new Set(units.map((u) => u.code)),
    });
    return base.map((result) => {
      if (!result.ok || !result.values) return result;
      const existing = users.find((item) => item.staffId === result.values?.staffId);
      const unitCode = result.values.unitCode ?? existing?.unitCode ?? "";
      const titleName = result.values.title ?? existing?.title ?? "";
      if (!titleName) {
        // v1.36.0：人員新增須填職稱；更新時未填則沿用既有職稱。
        if (result.action === "create") {
          return {
            ...result,
            ok: false,
            errors: [...result.errors, "請填寫職稱（人員新增須填職稱）"],
            values: null,
          };
        }
        return result;
      }
      const matchingTitles = titles.filter((title) =>
        title.name === titleName && scopeAppliesToUnit(title.scopeMode, title.unitCodes, unitCode),
      );
      if (matchingTitles.length === 1) return result;
      return {
        ...result,
        ok: false,
        errors: [...result.errors, unitCode
          ? `職稱「${titleName}」未設定適用單位 ${unitCode}（或存在同名歧義）`
          : `職稱「${titleName}」需搭配已設定單位的職稱`],
        values: null,
      };
    });
  }

  /** 人員匯入驗證（v1.21：舊資料匯入，未填忽略；職編已存在→更新） */
  function validateUserRows(rows: string[][]): Promise<PreviewRow[]> {
    const { headerErrors, data } = parseUserSheet([USER_HEADER, ...rows]);
    if (headerErrors.length > 0) {
      return Promise.resolve(
        rows.map((r, i) => ({
          index: i + 1,
          values: r,
          ok: false,
          error: headerErrors.join("；"),
        })),
      );
    }
    return Promise.resolve(
      validateUserImportData(data).map((r, j) => ({
        index: j + 1,
        values: rows[j] ?? [],
        ok: r.ok,
        error: r.ok ? "" : r.errors.join("；"),
      })),
    );
  }

  async function importUserRows(rows: PreviewRow[]): Promise<string> {
    const me = user?.staffId ?? "";
    const { data } = parseUserSheet([
      USER_HEADER,
      ...rows.map((r) => r.values),
    ]);
    const results = validateUserImportData(data);
    let created = 0;
    let updated = 0;
    const ops = results
      .filter((r) => r.ok && r.values)
      .map((r) => {
        const v = r.values!;
        const existing = users.find((item) => item.staffId === v.staffId);
        const nextUnitCode = v.unitCode ?? existing?.unitCode ?? "";
        const nextTitleName = v.title ?? existing?.title ?? "";
        const matchedTitle = nextTitleName
          ? titles.filter((title) => title.name === nextTitleName && scopeAppliesToUnit(title.scopeMode, title.unitCodes, nextUnitCode))
          : [];
        const assignedTitle = matchedTitle.length === 1 ? matchedTitle[0] : undefined;
        if (r.action === "update") updated += 1;
        else created += 1;
        const ref = doc(getFirebaseDb(), "users", v.staffId);
        if (r.action === "update") {
          const patch: Record<string, any> = {
            ...auditFields(me, false),
          };
          if (v.name !== null) patch.name = v.name;
          if (v.unitCode !== null) patch.unitCode = v.unitCode;
          if (v.title !== null || v.unitCode !== null) {
            patch.title = assignedTitle?.name ?? "";
            patch.titleId = assignedTitle?.id ?? "";
          }
          if (v.memberships !== null) {
            // 更新 memberships 時保留既有非群組角色（匯入檔不含此欄）
            const keep = (existing?.roles ?? []).filter(
              (x) => !isGroupScopedRole(x),
            );
            patch.memberships = v.memberships;
            patch.groupIds = deriveGroupIds(v.memberships);
            patch.roles = [
              ...new Set([...deriveRoles(v.memberships), ...keep]),
            ];
          }
          const nextRoles = patch.roles ?? existing?.roles ?? [];
          const nextMemberships = patch.memberships ?? existing?.memberships ?? [];
          const before = existing ? {
            name: existing.name, unitCode: existing.unitCode, titleId: existing.titleId,
            title: existing.title, roles: existing.roles, memberships: existing.memberships,
          } : null;
          const after = {
            name: v.name ?? existing?.name ?? "",
            unitCode: nextUnitCode,
            titleId: v.title !== null || v.unitCode !== null ? assignedTitle?.id ?? "" : existing?.titleId ?? "",
            title: v.title !== null || v.unitCode !== null ? assignedTitle?.name ?? "" : existing?.title ?? "",
            roles: nextRoles,
            memberships: nextMemberships,
          };
          return (b: WriteBatch) => {
            b.update(ref, patch);
            b.set(doc(collection(getFirebaseDb(), "auditLogs")), {
              actor: me,
              actorName: user?.name ?? "",
              action: "批次人員權限異動",
              targetType: "user",
              targetId: v.staffId,
              detail: `批次更新職編 ${v.staffId} 的單位、職稱或群組角色`,
              before,
              after,
              createdAt: serverTimestamp(),
            });
          };
        }
        return (b: WriteBatch) => {
          b.set(ref, {
            name: v.name ?? "",
            unitCode: v.unitCode ?? "",
            title: assignedTitle?.name ?? "",
            titleId: assignedTitle?.id ?? "",
            hireDate: "",
            email: "",
            phone: "",
            memberships: v.memberships ?? [],
            groupIds: deriveGroupIds(v.memberships ?? []),
            roles:
              v.memberships && v.memberships.length > 0
                ? deriveRoles(v.memberships)
                : ["一般人員"],
            districtGroupIds: [],
            mustChangePassword: true,
            status: "在職",
            ...auditFields(me, true),
          });
          b.set(doc(collection(getFirebaseDb(), "auditLogs")), {
            actor: me,
            actorName: user?.name ?? "",
            action: "批次人員權限異動",
            targetType: "user",
            targetId: v.staffId,
            detail: `批次建立職編 ${v.staffId} 人員與初始群組角色`,
            before: null,
            after: {
              name: v.name ?? "", unitCode: v.unitCode ?? "", titleId: assignedTitle?.id ?? "",
              title: assignedTitle?.name ?? "", roles: v.memberships?.length ? deriveRoles(v.memberships) : ["一般人員"],
              memberships: v.memberships ?? [],
            },
            createdAt: serverTimestamp(),
          });
        };
      });
    await commitInBatches(ops);
    return `人員匯入完成：新增 ${created} 筆、更新 ${updated} 筆`;
  }

  // ================= 版面 =================

  const isGroupEditing = groupView.kind === "edit";
  const isUnitEditing = unitView.kind === "edit";
  const isTitleEditing = titleView.kind === "edit";
  const isUserEditing = userView.kind === "edit";
  const reviewerRoleSelected = isReviewerRole([
    ...deriveRoles(userForm.memberships.filter((membership) => membership.groupId)),
    ...userForm.otherRoles,
  ]);

  const headingAction = (() => {
    const back = (reset: () => void) => (
      <button className="button button-outline" onClick={reset}>
        <X size={15} />
        返回清單
      </button>
    );
    if (tab === "groups") {
      if (groupView.kind === "list")
        return canManageMaster ? (
          <button className="button button-primary" onClick={openGroupCreate}>
            <Plus size={16} />
            新增群組
          </button>
        ) : undefined;
      return back(() => setGroupView({ kind: "list" }));
    }
    if (tab === "units") {
      if (unitView.kind === "list")
        return canManageMaster ? (
          <button className="button button-primary" onClick={openUnitCreate}>
            <Plus size={16} />
            新增單位
          </button>
        ) : undefined;
      return back(() => setUnitView({ kind: "list" }));
    }
    if (tab === "titles") {
      if (titleView.kind === "list")
        return canManageMaster ? (
          <button className="button button-primary" onClick={openTitleCreate}>
            <Plus size={16} />
            新增職稱
          </button>
        ) : undefined;
      return back(() => setTitleView({ kind: "list" }));
    }
    if (tab === "roles") {
      if (roleCreateOpen)
        return back(() => {
          setRoleCreateOpen(false);
          setRoleCreateError("");
        });
      if (managingRoleId) return back(() => setManagingRoleId(""));
      return isAdmin ? (
        <button
          className="button button-primary"
          onClick={() => {
            setNewRoleName("");
            setNewRoleKind("group");
            setNewRoleGroupId("");
            setNewRoleUnitCode("");
            setNewRoleGroupScopeMode("group");
            setRoleCreateError("");
            setRoleCreateOpen(true);
          }}
        >
          <Plus size={16} /> 新增角色
        </button>
      ) : undefined;
    }
    if (tab === "users") {
      if (userView.kind === "list")
        return isAdmin ? (
          <button className="button button-primary" onClick={openUserCreate}>
            <Plus size={16} />
            新增人員
          </button>
        ) : undefined;
      return back(() => setUserView({ kind: "list" }));
    }
    return undefined;
  })();

  return (
    <>
      <PageHeading page="groups" action={headingAction} />

      <div className="tabs" style={{ marginBottom: 12 }}>
        <button
          className={`tab${tab === "users" ? " active" : ""}`}
          onClick={() => setTab("users")}
        >
          人員{isAdmin && <span>{users.length}</span>}
        </button>
        <button
          className={`tab${tab === "units" ? " active" : ""}`}
          onClick={() => setTab("units")}
        >
          單位<span>{units.length}</span>
        </button>
        <button
          className={`tab${tab === "roles" ? " active" : ""}`}
          onClick={() => setTab("roles")}
        >
          角色<span>{roleOptions.length}</span>
        </button>
        <button
          className={`tab${tab === "titles" ? " active" : ""}`}
          onClick={() => setTab("titles")}
        >
          職稱<span>{titles.length}</span>
        </button>
        <button
          className={`tab${tab === "groups" ? " active" : ""}`}
          onClick={() => setTab("groups")}
        >
          群組<span>{groups.length}</span>
        </button>
      </div>

      {tab === "users" && userView.kind === "list" && isAdmin && (
        <div className="org-filter-row" role="search">
          <div className="select-wrap">
            <select
              value={userUnitFilter}
              aria-label="依單位篩選人員"
              onChange={(e) => setUserUnitFilter(e.target.value)}
            >
              <option value="">全部單位</option>
              {units.map((unit) => (
                <option key={unit.code} value={unit.code}>
                  {unit.name}（{unit.code}）
                </option>
              ))}
            </select>
            <ChevronDown size={15} />
          </div>
          <input
            className="text-input"
            placeholder="搜尋職編／姓名"
            aria-label="搜尋職編或姓名"
            value={userSearch}
            onChange={(e) => setUserSearch(e.target.value)}
          />
        </div>
      )}
      {tab === "units" && unitView.kind === "list" && (
        <div className="org-filter-row" role="search">
          <div className="select-wrap">
            <select
              value={unitGroupFilter}
              aria-label="依組別篩選單位"
              onChange={(e) => setUnitGroupFilter(e.target.value)}
            >
              <option value="">全部組別</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
            <ChevronDown size={15} />
          </div>
          <input
            className="text-input"
            placeholder="搜尋單位代號／名稱"
            aria-label="搜尋單位代號或名稱"
            value={unitSearch}
            onChange={(e) => setUnitSearch(e.target.value)}
          />
        </div>
      )}

      {/* 批次上傳工具列（僅清單檢視） */}
      {tab === "groups" && groupView.kind !== "edit" && canManageMaster && (
        <div className="batch-toolbar">
          <BatchImporter
            sampleBaseName="群組範例"
            sampleRows={GROUP_SAMPLE}
            header={GROUP_HEADER}
            validateRows={validateGroupRows}
            importRows={importGroupRows}
            onDone={loadMaster}
            onAction={onAction}
          />
        </div>
      )}
      {tab === "units" && unitView.kind !== "edit" && canManageMaster && (
        <div className="batch-toolbar">
          <BatchImporter
            sampleBaseName="單位範例"
            sampleRows={UNIT_SAMPLE}
            header={UNIT_HEADER}
            validateRows={validateUnitRows}
            importRows={importUnitRows}
            onDone={loadMaster}
            onAction={onAction}
          />
        </div>
      )}
      {tab === "titles" && titleView.kind !== "edit" && canManageMaster && (
        <div className="batch-toolbar">
          <BatchImporter
            sampleBaseName="職稱範例"
            sampleRows={TITLE_SAMPLE}
            header={TITLE_HEADER}
            validateRows={validateTitleRows}
            importRows={importTitleRows}
            onDone={loadTitles}
            onAction={onAction}
          />
        </div>
      )}
      {tab === "users" && userView.kind !== "edit" && isAdmin && (
        <div className="batch-toolbar">
          <BatchImporter
            sampleBaseName="人員範例"
            sampleRows={USER_SAMPLE}
            header={USER_HEADER}
            validateRows={validateUserRows}
            importRows={importUserRows}
            postImportNote="提醒：匯入的人員仍需到 Firebase Console → Authentication 手動建立登入帳號（email 格式為「職編@nurseboard.internal」）。"
            onDone={loadUsers}
            onAction={onAction}
          />
        </div>
      )}
      {tab === "roles" && !managingRole && canManageMaster && (
        <div className="batch-toolbar">
          <BatchImporter
            sampleBaseName="角色範例"
            sampleRows={ROLE_SAMPLE}
            header={ROLE_HEADER}
            validateRows={validateRoleRows}
            importRows={importRoleRows}
            onDone={loadRoles}
            onAction={onAction}
          />
        </div>
      )}

      {tab === "groups" ? (
        groupView.kind === "list" ? (
          masterLoading ? (
            <section className="panel">
              <p className="settings-note">讀取中…</p>
            </section>
          ) : groups.length === 0 ? (
            <EmptyState
              title="尚無群組"
              description="使用右上角「新增群組」或「批次上傳」建立群組（例如：病房組、加護組）。"
            />
          ) : (
            <section className="panel data-panel">
              <div className="table-scroll">
                <table className="permission-table">
                  <thead>
                    <tr>
                      <SortHeader label="群組名稱" sortKey="group-name" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
                      <SortHeader label="所屬單位數" sortKey="group-count" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
                      {canManageMaster && <th>操作</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows(groups, sortState.key, (row, key) => key === "group-count" ? row.unitCount : row.name).map((row) => (
                      <tr key={row.id}>
                        <td>
                          <b>{row.name}</b>
                        </td>
                        <td>{row.unitCount} 個</td>
                        {canManageMaster && (
                          <td>
                            <button
                              className="text-button"
                              onClick={() => openGroupEdit(row.id)}
                            >
                              <Pencil size={13} /> 編輯
                            </button>{" "}
                            <button
                              className="text-button"
                              onClick={() => {
                                setManagingGroupId(
                                  managingGroupId === row.id ? "" : row.id,
                                );
                                setGroupUnitChecked([]);
                                setGroupUnitAdd("");
                              }}
                            >
                              單位管理
                            </button>{" "}
                            <button
                              className="text-button"
                              onClick={() => handleGroupDelete(row)}
                            >
                              <Trash2 size={13} /> 刪除
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {managingGroupId && canManageMaster && (
                <div style={{ marginTop: 12 }}>
                  <MemberChecklist
                    title={`群組「${groups.find((g) => g.id === managingGroupId)?.name ?? ""}」的單位`}
                    note="加入／移除單位（改 unit.groupId）"
                    emptyText="此群組尚無單位。"
                    items={groupUnits.map((u) => ({
                      id: u.code,
                      label: u.name,
                    }))}
                    checked={groupUnitChecked}
                    onToggle={(id, next) =>
                      setGroupUnitChecked((prev) =>
                        next
                          ? [...prev, id]
                          : prev.filter((x) => x !== id),
                      )
                    }
                    onToggleAll={(next) =>
                      setGroupUnitChecked(
                        next ? groupUnits.map((u) => u.code) : [],
                      )
                    }
                    onRemoveSelected={handleGroupUnitsRemove}
                    removeLabel="批次移出"
                    busy={groupBusy}
                  />
                  <div className="form-field" style={{ maxWidth: 320 }}>
                    <label className="field-label">加入單位</label>
                    <div className="select-wrap">
                      <select
                        value={groupUnitAdd}
                        onChange={(e) => setGroupUnitAdd(e.target.value)}
                      >
                        <option value="">請選擇單位</option>
                        {units
                          .filter((u) => u.groupId !== managingGroupId)
                          .map((u) => (
                            <option key={u.code} value={u.code}>
                              {u.code}・{u.name}
                            </option>
                          ))}
                      </select>
                      <ChevronDown size={15} />
                    </div>
                  </div>
                  <div className="form-actions">
                    <button
                      className="button button-primary"
                      disabled={!groupUnitAdd || groupBusy}
                      onClick={() => handleGroupUnitAdd(groupUnitAdd)}
                    >
                      加入此群組
                    </button>
                    <button
                      className="button button-outline"
                      onClick={() => setManagingGroupId("")}
                    >
                      關閉
                    </button>
                  </div>
                </div>
              )}
              {!canManageMaster && (
                <p className="settings-note">
                  群組維護限品管執行幹事或系統管理員。
                </p>
              )}
            </section>
          )
        ) : (
          <section className="panel data-panel indicator-form">
            <SectionTitle
              title={isGroupEditing ? "編輯群組" : "新增群組"}
              note="群組名稱不可重複（例如：病房組）"
            />
            {groupError && <div className="login-error">{groupError}</div>}
            <div className="form-grid">
              <div className="form-field">
                <label className="field-label">群組名稱 *</label>
                <input
                  className="text-input"
                  value={groupForm.name}
                  placeholder="例如 病房組"
                  onChange={(e) =>
                    setGroupForm({ name: e.target.value })
                  }
                />
              </div>
            </div>
            <div className="form-actions">
              <button
                className="button button-primary"
                disabled={groupSaving}
                onClick={handleGroupSave}
              >
                {groupSaving ? "儲存中…" : isGroupEditing ? "儲存修改" : "建立群組"}
              </button>
              <button
                className="button button-outline"
                onClick={() => setGroupView({ kind: "list" })}
              >
                取消
              </button>
            </div>
          </section>
        )
      ) : tab === "units" ? (
        unitView.kind === "list" ? (
          masterLoading ? (
            <section className="panel">
              <p className="settings-note">讀取中…</p>
            </section>
          ) : units.length === 0 ? (
            <EmptyState
              title="尚無單位"
              description="使用右上角「新增單位」或「批次上傳」建立單位（例如：9A病房，歸屬病房組）。"
            />
          ) : (
            <section className="panel data-panel">
              <div className="table-scroll">
                <table className="permission-table">
                  <thead>
                    <tr>
                      <SortHeader label="單位代號" sortKey="unit-code" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
                      <SortHeader label="單位名稱" sortKey="unit-name" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
                      <SortHeader label="所屬群組" sortKey="unit-group" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
                      <SortHeader label="所屬人員數" sortKey="unit-count" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
                      {canManageMaster && <th>操作</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleUnits.length === 0 ? (
                      <tr><td colSpan={canManageMaster ? 5 : 4} className="muted-text">沒有符合篩選條件的單位</td></tr>
                    ) : visibleUnits.map((row) => (
                      <tr key={row.code}>
                        <td>
                          <b>{row.code}</b>
                        </td>
                        <td>{row.name}</td>
                        <td>{row.groupName}</td>
                        <td>
                          {row.memberCount === null ? "—" : `${row.memberCount} 人`}
                        </td>
                        {canManageMaster && (
                          <td>
                            <button
                              className="text-button"
                              onClick={() => openUnitEdit(row.code)}
                            >
                              <Pencil size={13} /> 編輯
                            </button>{" "}
                            {isAdmin && (
                              <button
                                className="text-button"
                                onClick={() => {
                                  setManagingUnitCode(
                                    managingUnitCode === row.code
                                      ? ""
                                      : row.code,
                                  );
                                  setUnitMemberChecked([]);
                                  setUnitAddSearch("");
                                }}
                              >
                                成員管理
                              </button>
                            )}{" "}
                            <button
                              className="text-button"
                              onClick={() => handleUnitDelete(row.code)}
                            >
                              <Trash2 size={13} /> 刪除
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {managingUnitCode && isAdmin && (
                <div style={{ marginTop: 12 }}>
                  <MemberChecklist
                    title={`單位 ${managingUnitCode} 的成員`}
                    note="加入／移除人員（改 person.unitCode）"
                    items={unitMembers.map((u) => ({
                      id: u.staffId,
                      label: maskName(u.name),
                      sub: u.title || undefined,
                    }))}
                    checked={unitMemberChecked}
                    onToggle={(id, next) =>
                      setUnitMemberChecked((prev) =>
                        next ? [...prev, id] : prev.filter((x) => x !== id),
                      )
                    }
                    onToggleAll={(next) =>
                      setUnitMemberChecked(
                        next ? unitMembers.map((u) => u.staffId) : [],
                      )
                    }
                    onRemoveSelected={handleUnitMembersRemove}
                    removeLabel="批次移出"
                    busy={unitBusy}
                  />
                  <div className="form-field" style={{ maxWidth: 320 }}>
                    <label className="field-label">加入人員</label>
                    <input
                      className="text-input"
                      placeholder="輸入職編或姓名搜尋"
                      value={unitAddSearch}
                      onChange={(e) => setUnitAddSearch(e.target.value)}
                    />
                  </div>
                  {unitAddSearch.trim() !== "" &&
                    (unitCandidates.length === 0 ? (
                      <p className="settings-note">無符合的在職人員。</p>
                    ) : (
                      <div className="table-scroll">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>職編</th>
                              <th>姓名</th>
                              <th>所屬單位</th>
                              <th>操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {unitCandidates.map((u) => (
                              <tr key={u.staffId}>
                                <td>{u.staffId}</td>
                                <td>{maskName(u.name)}</td>
                                <td>{u.unitCode || "—"}</td>
                                <td>
                                  <button
                                    className="text-button"
                                    disabled={unitBusy}
                                    onClick={() =>
                                      handleUnitMemberAdd(u.staffId)
                                    }
                                  >
                                    <Plus size={13} /> 加入
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  <div className="form-actions">
                    <button
                      className="button button-outline"
                      onClick={() => setManagingUnitCode("")}
                    >
                      關閉
                    </button>
                  </div>
                </div>
              )}
              {!canManageMaster && (
                <p className="settings-note">
                  單位維護限品管執行幹事或系統管理員。
                </p>
              )}
            </section>
          )
        ) : (
          <section className="panel data-panel indicator-form">
            <SectionTitle
              title={isUnitEditing ? `編輯單位 ${unitForm.code}` : "新增單位"}
              note={isUnitEditing ? "單位代號不可變更（更名時代號不變）" : ""}
            />
            {unitError && <div className="login-error">{unitError}</div>}
            <div className="form-grid">
              <div className="form-field">
                <label className="field-label">單位代號 *</label>
                <input
                  className="text-input"
                  value={unitForm.code}
                  disabled={isUnitEditing}
                  placeholder="例如 9A"
                  onChange={(e) =>
                    setUnitForm((prev) => ({ ...prev, code: e.target.value }))
                  }
                />
              </div>
              <div className="form-field">
                <label className="field-label">單位名稱 *</label>
                <input
                  className="text-input"
                  value={unitForm.name}
                  placeholder="例如 9A病房"
                  onChange={(e) =>
                    setUnitForm((prev) => ({ ...prev, name: e.target.value }))
                  }
                />
              </div>
              <div className="form-field">
                <label className="field-label">所屬群組</label>
                <div className="select-wrap">
                  <select
                    value={unitForm.groupId}
                    onChange={(e) =>
                      setUnitForm((prev) => ({ ...prev, groupId: e.target.value }))
                    }
                  >
                    <option value="">— 未分類 —</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={15} />
                </div>
              </div>
              <div className="form-field">
                <label className="field-label" htmlFor="merged-from-units">合併自舊單位（可複選）</label>
                <select
                  id="merged-from-units"
                  className="text-input"
                  multiple
                  size={Math.min(5, Math.max(3, units.length))}
                  value={unitForm.mergedFromUnitCodes}
                  onChange={(event) => setUnitForm((prev) => ({
                    ...prev,
                    mergedFromUnitCodes: Array.from(event.target.selectedOptions, (option) => option.value),
                  }))}
                >
                  {units.filter((candidate) => candidate.code !== unitForm.code && (
                    unitForm.mergedFromUnitCodes.includes(candidate.code) ||
                    !units.some((other) => other.code !== unitForm.code && other.mergedFromUnitCodes.includes(candidate.code))
                  )).map((candidate) => (
                    <option key={candidate.code} value={candidate.code}>{candidate.name}（{candidate.code}）</option>
                  ))}
                </select>
                <p className="settings-note">選取後，新單位護理長可在分析中查看合併前歷史資料；不會授予個人明細下鑽權限。</p>
              </div>
            </div>
            <div className="form-actions">
              <button
                className="button button-primary"
                disabled={unitSaving}
                onClick={handleUnitSave}
              >
                {unitSaving ? "儲存中…" : isUnitEditing ? "儲存修改" : "建立單位"}
              </button>
              <button
                className="button button-outline"
                onClick={() => setUnitView({ kind: "list" })}
              >
                取消
              </button>
            </div>
          </section>
        )
      ) : tab === "titles" ? (
        titleView.kind === "list" ? (
          titlesLoading ? (
            <section className="panel">
              <p className="settings-note">讀取中…</p>
            </section>
          ) : titles.length === 0 ? (
            <EmptyState
              title="尚無職稱"
              description="使用右上角「新增職稱」或「批次上傳」建立職稱。"
            />
          ) : (
            <section className="panel data-panel">
              <div className="table-scroll">
                <table className="permission-table">
                  <thead>
                    <tr>
                      <SortHeader label="職稱名稱" sortKey="title-name" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
                      <SortHeader label="層級" sortKey="title-level" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
                      <th>適用單位</th>
                      <SortHeader label="使用人數" sortKey="title-count" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
                      {canManageMaster && <th>操作</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows(titles, sortState.key, (row, key) => key === "title-level" ? row.level : key === "title-count" ? (row.userCount ?? -1) : row.name).map((row) => (
                      <tr key={row.id}>
                        <td>
                          <b>{row.name}</b>
                        </td>
                        <td>
                          <span
                            className={`status-pill ${row.level === "群組" ? "info" : "muted"}`}
                          >
                            {row.level || "—"}
                          </span>
                        </td>
                        <td>{row.scopeMode === "all"
                          ? <span className="status-pill muted">不分單位</span>
                          : row.unitCodes.length > 0
                            ? row.unitCodes.map((code) => units.find((unit) => unit.code === code)?.name ?? code).join("、")
                            : <span className="status-pill warning">待補單位</span>}</td>
                        <td>
                          {row.userCount === null ? "—" : `${row.userCount} 人`}
                        </td>
                        {canManageMaster && (
                          <td>
                            <button
                              className="text-button"
                              onClick={() => openTitleEdit(row.id)}
                            >
                              <Pencil size={13} /> 編輯
                            </button>{" "}
                            {isAdmin && (
                              <button
                                className="text-button"
                                onClick={() => {
                                  setManagingTitleId(
                                    managingTitleId === row.id
                                      ? ""
                                      : row.id,
                                  );
                                  setTitleMemberChecked([]);
                                  setTitleAddSearch("");
                                }}
                              >
                                成員管理
                              </button>
                            )}{" "}
                            <button
                              className="text-button"
                              onClick={() => handleTitleDelete(row)}
                            >
                              <Trash2 size={13} /> 刪除
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {managingTitle && isAdmin && (
                <div style={{ marginTop: 12 }}>
                  <MemberChecklist
                    title={`職稱「${managingTitle.name}」的成員`}
                    note="加入即轉任此職稱（一人一職稱）；移除即清除職稱"
                    items={titleMembers.map((u) => ({
                      id: u.staffId,
                      label: maskName(u.name),
                      sub: u.unitCode || undefined,
                    }))}
                    checked={titleMemberChecked}
                    onToggle={(id, next) =>
                      setTitleMemberChecked((prev) =>
                        next ? [...prev, id] : prev.filter((x) => x !== id),
                      )
                    }
                    onToggleAll={(next) =>
                      setTitleMemberChecked(
                        next ? titleMembers.map((u) => u.staffId) : [],
                      )
                    }
                    onRemoveSelected={handleTitleMembersRemove}
                    removeLabel="批次移出"
                    busy={titleBusy}
                  />
                  <div className="form-field" style={{ maxWidth: 320 }}>
                    <label className="field-label">加入人員（加入即轉任）</label>
                    <input
                      className="text-input"
                      placeholder="輸入職編或姓名搜尋"
                      value={titleAddSearch}
                      onChange={(e) => setTitleAddSearch(e.target.value)}
                    />
                  </div>
                  {titleAddSearch.trim() !== "" &&
                    (titleCandidates.length === 0 ? (
                      <p className="settings-note">無符合的在職人員。</p>
                    ) : (
                      <div className="table-scroll">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>職編</th>
                              <th>姓名</th>
                              <th>現職稱</th>
                              <th>操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {titleCandidates.map((u) => (
                              <tr key={u.staffId}>
                                <td>{u.staffId}</td>
                                <td>{maskName(u.name)}</td>
                                <td>{u.title || "—"}</td>
                                <td>
                                  <button
                                    className="text-button"
                                    disabled={titleBusy}
                                    onClick={() =>
                                      handleTitleMemberAdd(u.staffId)
                                    }
                                  >
                                    <Plus size={13} /> 加入
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  <div className="form-actions">
                    <button
                      className="button button-outline"
                      onClick={() => setManagingTitleId("")}
                    >
                      關閉
                    </button>
                  </div>
                </div>
              )}
              {!canManageMaster && (
                <p className="settings-note">
                  職稱維護限品管執行幹事或系統管理員。
                </p>
              )}
            </section>
          )
        ) : (
          <section className="panel data-panel indicator-form">
            <SectionTitle
              title={isTitleEditing ? "編輯職稱" : "新增職稱"}
              note="不分單位＝適用全部單位；分單位＝只套用至勾選的單位，同一名稱可分別設定在不同單位"
            />
            {titleError && <div className="login-error">{titleError}</div>}
            <div className="form-grid">
              <div className="form-field">
                <label className="field-label">職稱名稱 *</label>
                <input
                  className="text-input"
                  value={titleForm.name}
                  placeholder="例如 護理長"
                  onChange={(e) =>
                    setTitleForm((prev) => ({ ...prev, name: e.target.value }))
                  }
                />
              </div>
              <div className="form-field">
                <label className="field-label">層級</label>
                <p className="settings-note" style={{ margin: 0 }}>單位（職稱層級固定為單位）</p>
              </div>
            </div>
            <div className="form-field" style={{ marginTop: 12 }}>
              <label className="field-label">適用範圍 *</label>
              <div className="select-wrap">
                <select
                  value={titleForm.scopeMode}
                  onChange={(e) =>
                    setTitleForm((prev) => ({
                      ...prev,
                      scopeMode: e.target.value === "units" ? "units" : "all",
                    }))
                  }
                >
                  <option value="all">不分單位（適用全部單位）</option>
                  <option value="units">分單位（只適用勾選單位）</option>
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
            {titleForm.scopeMode === "units" && (
              <div className="form-field" style={{ marginTop: 12 }}>
                <label className="field-label">適用單位 *</label>
                {units.length === 0 ? (
                  <p className="settings-note">尚未建立單位；請先建立單位後再設定職稱。</p>
                ) : (
                  <div className="form-grid">
                    {units.map((unit) => (
                      <label className="check-row" key={unit.code}>
                        <input
                          type="checkbox"
                          checked={titleForm.unitCodes.includes(unit.code)}
                          onChange={(event) => setTitleForm((prev) => ({
                            ...prev,
                            unitCodes: event.target.checked
                              ? [...new Set([...prev.unitCodes, unit.code])]
                              : prev.unitCodes.filter((code) => code !== unit.code),
                          }))}
                        />
                        <span>{unit.name}（{unit.code}）</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="form-actions">
              <button
                className="button button-primary"
                disabled={titleSaving}
                onClick={handleTitleSave}
              >
                {titleSaving ? "儲存中…" : isTitleEditing ? "儲存修改" : "建立職稱"}
              </button>
              <button
                className="button button-outline"
                onClick={() => setTitleView({ kind: "list" })}
              >
                取消
              </button>
            </div>
          </section>
        )
      ) : tab === "users" && !isAdmin ? (
        <section className="panel">
          <div className="empty-state-block">
            <b>僅系統管理員可管理人員</b>
            <p>如需新增或異動人員資料，請聯絡系統管理員。</p>
          </div>
        </section>
      ) : tab === "users" && userView.kind === "list" ? (
        usersLoading ? (
          <section className="panel">
            <p className="settings-note">讀取中…</p>
          </section>
        ) : users.length === 0 ? (
          <EmptyState
            title="尚無人員"
            description="使用右上角「新增人員」或「批次上傳」建立人員資料，職編即為登入帳號。"
          />
        ) : (
          <section className="panel data-panel">
            <div className="table-scroll">
              <table className="permission-table">
                <thead>
                  <tr>
                    <SortHeader label="職編" sortKey="user-id" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
                    <SortHeader label="姓名" sortKey="user-name" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
                    <SortHeader label="單位" sortKey="user-unit" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
                    <SortHeader label="職稱" sortKey="user-title" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
                    <SortHeader label="角色" sortKey="user-role" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
                    <SortHeader label="狀態" sortKey="user-status" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUsers.length === 0 ? (
                    <tr><td colSpan={7} className="muted-text">沒有符合篩選條件的人員</td></tr>
                  ) : visibleUsers.map((row) => (
                    <tr key={row.staffId}>
                      <td>
                        <b>{row.staffId}</b>
                      </td>
                      <td>{maskName(row.name)}</td>
                      <td>{row.unitCode || "—"}</td>
                      <td>{row.title || "—"}</td>
                      <td>
                        {row.roles.length > 0
                          ? row.roles.map((r) => (
                              <span
                                key={r}
                                className="status-pill muted"
                                style={{ marginRight: 4 }}
                              >
                                {r}
                              </span>
                            ))
                          : "—"}
                      </td>
                      <td>
                        <span
                          className={`status-pill ${row.status === "停用" ? "danger" : "success"}`}
                        >
                          {row.status}
                        </span>
                      </td>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => openUserEdit(row.staffId)}
                        >
                          <Pencil size={13} /> 編輯
                        </button>{" "}
                        <button
                          className="text-button"
                          onClick={() => handleToggleStatus(row)}
                        >
                          {row.status === "停用" ? "啟用" : "停用"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )
      ) : tab === "users" ? (
        <section className="panel data-panel indicator-form">
          <SectionTitle
            title={isUserEditing ? `編輯人員 ${userForm.staffId}` : "新增人員"}
            note={
              isUserEditing
                ? "職編不可變更"
                : "儲存後請再到 Firebase Console → Authentication 建立登入帳號"
            }
          />
          {userError && <div className="login-error">{userError}</div>}
          <div className="form-grid">
            <div className="form-field">
              <label className="field-label">職編 *</label>
              <input
                className="text-input"
                value={userForm.staffId}
                disabled={isUserEditing}
                placeholder="例如 A12345（即登入帳號）"
                onChange={(e) =>
                  setUserForm((prev) => ({ ...prev, staffId: e.target.value }))
                }
              />
            </div>
            <div className="form-field">
              <label className="field-label">姓名 *</label>
              <input
                className="text-input"
                value={userForm.name}
                placeholder="例如 王小明"
                onChange={(e) =>
                  setUserForm((prev) => ({ ...prev, name: e.target.value }))
                }
              />
            </div>
            <div className="form-field">
              <label className="field-label">單位</label>
              <div className="select-wrap">
                <select
                  value={userForm.unitCode}
                  onChange={(e) => {
                    const nextUnitCode = e.target.value;
                    setUserForm((prev) => {
                      const selectedTitle = titles.find((title) => title.id === prev.titleId);
                      if (prev.titleId && selectedTitle && !scopeAppliesToUnit(selectedTitle.scopeMode, selectedTitle.unitCodes, nextUnitCode)) {
                        return { ...prev, unitCode: nextUnitCode, title: "", titleId: "" };
                      }
                      if (!prev.titleId && prev.title && prev.unitCode !== nextUnitCode) {
                        return { ...prev, unitCode: nextUnitCode, title: "" };
                      }
                      return { ...prev, unitCode: nextUnitCode };
                    });
                  }}
                >
                  <option value="">— 未指定 —</option>
                  {units.map((u) => (
                    <option key={u.code} value={u.code}>
                      {u.code}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
            <div className="form-field">
              <label className="field-label">職稱 *</label>
              <div className="select-wrap">
                <select
                  value={userForm.titleId}
                  onChange={(e) => {
                    const title = titles.find((item) => item.id === e.target.value);
                    setUserForm((prev) => ({
                      ...prev,
                      titleId: title?.id ?? "",
                      title: title?.name ?? "",
                    }));
                  }}
                >
                  <option value="">— 請選擇職稱 —</option>
                  {titles.filter((t) => scopeAppliesToUnit(t.scopeMode, t.unitCodes, userForm.unitCode)).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}（{t.level}）
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
              {userForm.title && !userForm.titleId && (
                <p className="settings-note">現有職稱「{userForm.title}」尚未設定適用範圍；可至職稱管理補上範圍，補完前此職稱不會授予權限。</p>
              )}
            </div>
            <div className="form-field">
              <label className="field-label">到職日</label>
              <input
                className="text-input"
                type="date"
                value={userForm.hireDate}
                onChange={(e) =>
                  setUserForm((prev) => ({ ...prev, hireDate: e.target.value }))
                }
              />
            </div>
            <div className="form-field">
              <label className="field-label">Email</label>
              <input
                className="text-input"
                type="email"
                value={userForm.email}
                placeholder="例如 name@example.com（供通知與重設密碼）"
                onChange={(e) =>
                  setUserForm((prev) => ({ ...prev, email: e.target.value }))
                }
              />
            </div>
            <div className="form-field">
              <label className="field-label">電話</label>
              <input
                className="text-input"
                value={userForm.phone}
                placeholder="例如 0912-345-678"
                onChange={(e) =>
                  setUserForm((prev) => ({ ...prev, phone: e.target.value }))
                }
              />
            </div>
            {reviewerRoleSelected && (
              <div className="form-field">
                <label className="field-label" htmlFor="reviewer-access-expiry">審查員授權效期</label>
                <input
                  id="reviewer-access-expiry"
                  className="text-input"
                  type="date"
                  value={userForm.reviewerAccessExpiresAt}
                  onChange={(event) => setUserForm((prev) => ({
                    ...prev,
                    reviewerAccessExpiresAt: event.target.value,
                  }))}
                />
                <p className="settings-note">留白為永久有效（預設）；設定日期後，審查員權限於該日結束後失效。</p>
              </div>
            )}
            {!isUserEditing && (
              <div className="form-field">
                <label className="field-label">首次登入強制改密碼</label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={userForm.mustChangePassword}
                    onChange={(e) =>
                      setUserForm((prev) => ({
                        ...prev,
                        mustChangePassword: e.target.checked,
                      }))
                    }
                  />
                  <span>啟用（建議保持開啟）</span>
                </label>
              </div>
            )}
          </div>

          <SectionTitle
            title="群組＋角色"
            note="先選群組再選該群組角色；每個群組的角色與權限各自隔離。"
          />
          {userForm.memberships.map((m, i) => (
            <div
              key={i}
              className="panel"
              style={{ padding: 12, marginBottom: 8 }}
            >
              <div className="form-field">
                <label className="field-label">群組</label>
                <div className="select-wrap">
                  <select
                    value={m.groupId}
                    onChange={(e) => updateMembershipRow(i, { groupId: e.target.value, roles: [] })}
                  >
                    <option value="">請選擇群組</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={15} />
                </div>
              </div>
              <div className="form-grid">
                {roleOptions
                  .filter((r) => r.groupId
                    ? r.groupId === m.groupId
                    : isGroupScopedRole(r.name))
                  .map((r) => (
                    <label className="check-row" key={r.id}>
                      <input
                        type="checkbox"
                        checked={m.roles.includes(r.name)}
                        onChange={() => toggleMembershipRole(i, r.name)}
                      />
                      <span>{r.name}</span>
                    </label>
                  ))}
              </div>
              <button
                className="text-button"
                onClick={() => removeMembershipRow(i)}
              >
                <Trash2 size={13} /> 刪除此配對
              </button>
            </div>
          ))}
          <button
            className="button button-outline button-sm"
            onClick={addMembershipRow}
          >
            <Plus size={14} /> 新增群組＋角色配對
          </button>

          <SectionTitle title="其他角色" note="非群組限定角色可取聯集；仍須與適用單位職稱權限交集才生效。" />
          {roleOptions.length === 0 ? (
            <p className="settings-note">
              尚未建立角色，請先到「角色」頁籤建立角色。
            </p>
          ) : (
            <div className="form-grid">
              {roleOptions
                .filter((r) => !r.groupId && !isGroupScopedRole(r.name))
                .map((r) => (
                  <label className="check-row" key={r.id}>
                    <input
                      type="checkbox"
                      checked={userForm.otherRoles.includes(r.name)}
                      onChange={() => toggleOtherRole(r.name)}
                    />
                    <span>{r.name}</span>
                  </label>
                ))}
            </div>
          )}

          <SectionTitle
            title="督導轄區群組"
            note="只有督導需要填寫：勾選其負責的群組，督導儀表板依此顯示轄區單位"
          />
          {groups.length === 0 ? (
            <p className="settings-note">尚無群組資料。</p>
          ) : (
            <div className="form-grid">
              {groups.map((g) => (
                <label className="check-row" key={g.id}>
                  <input
                    type="checkbox"
                    checked={userForm.districtGroupIds.includes(g.id)}
                    onChange={() =>
                      setUserForm((prev) => ({
                        ...prev,
                        districtGroupIds:
                          prev.districtGroupIds.includes(g.id)
                            ? prev.districtGroupIds.filter((x) => x !== g.id)
                            : [...prev.districtGroupIds, g.id],
                      }))
                    }
                  />
                  <span>{g.name}</span>
                </label>
              ))}
            </div>
          )}

          <div className="form-actions">
            <button
              className="button button-primary"
              disabled={userSaving}
              onClick={handleUserSave}
            >
              {userSaving ? "儲存中…" : isUserEditing ? "儲存修改" : "建立人員"}
            </button>
            <button
              className="button button-outline"
              onClick={() => setUserView({ kind: "list" })}
            >
              取消
            </button>
          </div>
        </section>
      ) : tab === "roles" ? (
        !isAdmin ? (
          <section className="panel">
            <div className="empty-state-block">
              <b>僅系統管理員可建立或管理角色</b>
              <p>如需新增或異動角色成員，請聯絡系統管理員。</p>
            </div>
          </section>
        ) : roleCreateOpen ? (
          <section className="panel data-panel indicator-form">
            <SectionTitle title="新增角色" note="新角色預設無權限，建立後請至權限管理設定權限。群組角色預設不跨群組；單位角色的單位限制由職稱把關。" />
            {roleCreateError && <div className="login-error">{roleCreateError}</div>}
            <div className="form-field" style={{ maxWidth: 420 }}>
              <label className="field-label">角色類型 *</label>
              <div className="select-wrap">
                <select value={newRoleKind} onChange={(event) => setNewRoleKind(event.target.value === "unit" ? "unit" : "group")}>
                  <option value="group">群組角色</option>
                  <option value="unit">單位角色</option>
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
            {newRoleKind === "group" ? (
              <div className="form-field" style={{ maxWidth: 420 }}>
                <label className="field-label">所屬群組 *</label>
                <div className="select-wrap">
                  <select value={newRoleGroupId} onChange={(event) => setNewRoleGroupId(event.target.value)}>
                    <option value="">請先選擇群組</option>
                    {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                  </select>
                  <ChevronDown size={15} />
                </div>
              </div>
            ) : (
              <div className="form-field" style={{ maxWidth: 420 }}>
                <label className="field-label">所屬單位 *</label>
                <div className="select-wrap">
                  <select value={newRoleUnitCode} onChange={(event) => setNewRoleUnitCode(event.target.value)}>
                    <option value="">請先選擇單位</option>
                    {units.map((unit) => <option key={unit.code} value={unit.code}>{unit.name}（{unit.code}）</option>)}
                  </select>
                  <ChevronDown size={15} />
                </div>
              </div>
            )}
            <div className="form-field" style={{ maxWidth: 420 }}>
              <label className="field-label">角色名稱 *</label>
              <input
                className="text-input"
                value={newRoleName}
                placeholder="輸入角色名稱"
                onChange={(event) => setNewRoleName(event.target.value)}
              />
            </div>
            {newRoleKind === "group" && (
              <div className="form-field" style={{ maxWidth: 420 }}>
                <label className="field-label">跨群組 *</label>
                <div className="select-wrap">
                  <select value={newRoleGroupScopeMode} onChange={(event) => setNewRoleGroupScopeMode(event.target.value === "all" ? "all" : "group")}>
                    <option value="group">不跨群組（只在所屬群組生效）</option>
                    <option value="all">跨群組（任一群組持有即生效）</option>
                  </select>
                  <ChevronDown size={15} />
                </div>
              </div>
            )}
            <div className="form-actions">
              <button className="button button-primary" disabled={roleCreateSaving} onClick={handleRoleCreate}>
                {roleCreateSaving ? "建立中…" : "建立角色"}
              </button>
              <button className="button button-outline" onClick={() => setRoleCreateOpen(false)}>
                取消
              </button>
            </div>
          </section>
        ) : managingRole ? (
          <section className="panel data-panel">
            <MemberChecklist
              title={`角色「${managingRole.name}」的成員`}
              note="勾選＋全選可批次移除（同時從 memberships 移除該角色）"
              items={roleMembers.map((u) => ({
                id: u.staffId,
                label: maskName(u.name),
                sub: u.unitCode || undefined,
              }))}
              checked={roleMemberChecked}
              onToggle={(id, next) =>
                setRoleMemberChecked((prev) =>
                  next ? [...prev, id] : prev.filter((x) => x !== id),
                )
              }
              onToggleAll={(next) =>
                setRoleMemberChecked(
                  next ? roleMembers.map((u) => u.staffId) : [],
                )
              }
              onRemoveSelected={handleRoleMembersRemove}
              removeLabel="批次移出"
              busy={roleBusy}
            />
            <div style={{ marginTop: 16 }}>
              <SectionTitle title="角色設定" note="可改角色類型、所屬群組／單位與跨群組範圍。單位角色不設跨單位，單位限制由職稱把關。" />
              {roleEditError && <div className="login-error">{roleEditError}</div>}
              <div className="form-field" style={{ maxWidth: 320 }}>
                <label className="field-label">角色類型 *</label>
                <div className="select-wrap">
                  <select value={roleEditKind} onChange={(event) => setRoleEditKind(event.target.value === "unit" ? "unit" : "group")}>
                    <option value="group">群組角色</option>
                    <option value="unit">單位角色</option>
                  </select>
                  <ChevronDown size={15} />
                </div>
              </div>
              {roleEditKind === "group" ? (
                <>
                  <div className="form-field" style={{ maxWidth: 320 }}>
                    <label className="field-label">所屬群組 *</label>
                    <div className="select-wrap">
                      <select value={roleEditGroupId} onChange={(event) => setRoleEditGroupId(event.target.value)}>
                        <option value="">請選擇群組</option>
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>{g.name}</option>
                        ))}
                      </select>
                      <ChevronDown size={15} />
                    </div>
                  </div>
                  <div className="form-field" style={{ maxWidth: 320 }}>
                    <label className="field-label">跨群組 *</label>
                    <div className="select-wrap">
                      <select value={roleEditGroupScopeMode} onChange={(event) => setRoleEditGroupScopeMode(event.target.value === "all" ? "all" : "group")}>
                        <option value="group">不跨群組（只在所屬群組生效）</option>
                        <option value="all">跨群組（任一群組持有即生效）</option>
                      </select>
                      <ChevronDown size={15} />
                    </div>
                  </div>
                </>
              ) : (
                <div className="form-field" style={{ maxWidth: 320 }}>
                  <label className="field-label">所屬單位 *</label>
                  <div className="select-wrap">
                    <select value={roleEditUnitCode} onChange={(event) => setRoleEditUnitCode(event.target.value)}>
                      <option value="">請選擇單位</option>
                      {units.map((unit) => (
                        <option key={unit.code} value={unit.code}>{unit.name}（{unit.code}）</option>
                      ))}
                    </select>
                    <ChevronDown size={15} />
                  </div>
                </div>
              )}
              <div className="form-actions">
                <button
                  className="button button-primary"
                  disabled={roleEditSaving}
                  onClick={handleRoleSettingsSave}
                >
                  {roleEditSaving ? "儲存中…" : "儲存設定"}
                </button>
              </div>
            </div>
            <div className="form-field" style={{ maxWidth: 320 }}>
              <label className="field-label">加入人員（搜尋＋全選）</label>
              <input
                className="text-input"
                placeholder="輸入職編或姓名搜尋"
                value={roleAddSearch}
                onChange={(e) => setRoleAddSearch(e.target.value)}
              />
            </div>
            {!managingRole.groupId && isGroupScopedRole(managingRole.name) &&
              !isUnitLevelRole(managingRole.name) && (
                <div className="form-field" style={{ maxWidth: 320 }}>
                  <label className="field-label">適用群組 *</label>
                  <div className="select-wrap">
                    <select
                      value={roleAddGroupId}
                      onChange={(e) => setRoleAddGroupId(e.target.value)}
                    >
                      <option value="">請選擇群組</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={15} />
                  </div>
                </div>
              )}
            {isUnitLevelRole(managingRole.name) && (
              <p className="settings-note">
                單位級角色：加入時以各人所屬單位的群組計（無所屬單位群組者無法加入）。
              </p>
            )}
            {roleCandidates.length === 0 ? (
              <p className="settings-note">無可加入的在職人員。</p>
            ) : (
              <>
                <div className="table-scroll">
                  <table className="permission-table">
                    <thead>
                      <tr>
                        <th style={{ width: 36 }}>
                          <input
                            type="checkbox"
                            checked={
                              roleCandidates.length > 0 &&
                              roleCandidates.every((u) =>
                                roleAddChecked.includes(u.staffId),
                              )
                            }
                            onChange={(e) =>
                              setRoleAddChecked(
                                e.target.checked
                                  ? roleCandidates.map((u) => u.staffId)
                                  : [],
                              )
                            }
                            aria-label="全選"
                          />
                        </th>
                        <th>職編</th>
                        <th>姓名</th>
                        <th>所屬單位</th>
                      </tr>
                    </thead>
                    <tbody>
                      {roleCandidates.map((u) => (
                        <tr key={u.staffId}>
                          <td>
                            <input
                              type="checkbox"
                              checked={roleAddChecked.includes(u.staffId)}
                              onChange={(e) =>
                                setRoleAddChecked((prev) =>
                                  e.target.checked
                                    ? [...prev, u.staffId]
                                    : prev.filter((x) => x !== u.staffId),
                                )
                              }
                              aria-label={`選擇 ${u.staffId}`}
                            />
                          </td>
                          <td>{u.staffId}</td>
                          <td>{maskName(u.name)}</td>
                          <td>{u.unitCode || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="form-actions">
                  <button
                    className="button button-primary"
                    disabled={roleAddChecked.length === 0 || roleBusy}
                    onClick={handleRoleMembersAdd}
                  >
                    加入所選（{roleAddChecked.length}）
                  </button>
                </div>
              </>
            )}
            <div className="form-actions">
              <button
                className="button button-outline"
                onClick={() => setManagingRoleId("")}
              >
                返回角色清單
              </button>
            </div>
          </section>
        ) : roleRows.length === 0 ? (
          <EmptyState
            title="尚無角色"
            description="角色清單載入中，或請使用右上角「新增角色」建立角色。"
          />
        ) : (
          <section className="panel data-panel">
            <div className="table-scroll">
              <table className="permission-table">
                <thead>
                  <tr>
                      <SortHeader label="角色名稱" sortKey="role-name" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
                      <th>類型</th>
                      <th>所屬群組／單位</th>
                      <th>跨群組</th>
                      <SortHeader label="成員數" sortKey="role-count" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows(roleRows, sortState.key, (row, key) => key === "role-count" ? (row.memberCount ?? -1) : row.name).map((row) => (
                    <tr key={row.id}>
                      <td>
                        <b>{row.name}</b>
                      </td>
                      <td>{row.kind === "unit" ? "單位角色" : "群組角色"}</td>
                      <td>{row.kind === "unit"
                        ? (row.unitCode ? units.find((unit) => unit.code === row.unitCode)?.name ?? row.unitCode : "未設定")
                        : (row.groupId ? groups.find((group) => group.id === row.groupId)?.name ?? row.groupId : "未設定")}</td>
                      <td>{row.kind === "group"
                        ? (row.groupScopeMode === "all" ? "跨群組" : "不跨群組")
                        : "—"}</td>
                      <td>
                        {row.memberCount === null
                          ? "—"
                          : `${row.memberCount} 人`}
                      </td>
                      <td>
                        {isAdmin ? (
                          <>
                            <button
                              className="text-button"
                              onClick={() => openRoleMembers(row.id)}
                            >
                              成員管理
                            </button>{" "}
                            <button
                              className="text-button"
                              onClick={() => handleRoleDelete(row)}
                            >
                              <Trash2 size={13} /> 刪除
                            </button>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="settings-note">
              群組角色依所屬群組分開授權，單位角色依所屬單位管理；可在此新增角色、管理成員或刪除角色。成員管理與刪除限系統管理員。角色權限請到「組織與設定 → 權限管理」設定。
            </p>
          </section>
        )
      ) : null}
    </>
  );
}
