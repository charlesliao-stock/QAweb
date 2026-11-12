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
import { EmptyState, Modal, PageHeading, SectionTitle } from "../components/ui";
import { getFirebaseDb } from "../lib/firebase";
import { getCachedRefCollection } from "../lib/refCache";
import { getDocsCacheFirst } from "../lib/cacheFirst";
import { useAuth } from "../lib/auth";
import { maskName } from "../lib/mask";
import { syncReviewerDoc, backfillReviewerDocs } from "../lib/reviewerSync";
import { templateDocId } from "../lib/permissions";
import {
  applyMembershipEdit,
  deriveGroupIds,
  deriveRoles,
  deriveStoredRoles,
  groupedRolesLabel,
  groupedRolesSegments,
  isReviewerRole,
  mergeMembership,
  parseMemberships,
  removeMembership,
  type Membership,
} from "../lib/roleIdentity";
import {
  buildRoleMetaMap,
  legacyTitleFlags,
  type RoleMetaMap,
  type RoleScope,
  type TitleFlags,
} from "../lib/orgMeta";
import { deriveRoleScope } from "../lib/roleDerivation";
import {
  canDeleteLevel,
  groupByLevel,
  levelIdByName,
  nextLevelOrder,
  sortedLevels,
  type OrgLevel,
} from "../lib/orgLevels";
import { migrateOrgLevels } from "../lib/levelMigration";
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

interface TitleRow extends TitleFlags {
  id: string;
  name: string;
  /** v1.55.0：所屬層級 id（空＝未分層級） */
  levelId: string;
  userCount: number | null;
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
  /** v1.55.0：所屬層級 id（空＝未分層級） */
  levelId: string;
  /** 適用範圍（由層級推導：group＝群組角色；unit＝單位角色，v1.57.0 A3） */
  scope: RoleScope;
  memberCount: number | null;
}

interface OptionItem {
  id: string;
  name: string;
  scope?: RoleScope;
  /** v1.55.0：所屬層級 id（空＝未分層級） */
  levelId?: string;
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

/** 職稱：名稱之外，勾選主管層級旗標供身分判斷（儀表板／結果範圍）使用。 */
interface TitleForm extends TitleFlags {
  name: string;
  /** v1.55.0：所屬層級 id（空＝未分層級） */
  levelId: string;
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
  mustChangePassword: boolean;
  /** v1.58.0：督導負責的單位代碼（僅部級職稱為督導時設定；承接舊督導轄區群組） */
  titleUnitCodes: string[];
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
  return {
    name: "",
    levelId: "",
    isUnitHead: false,
    isDistrictHead: false,
    isHospitalHead: false,
    isOfficer: false,
    isConvener: false,
  };
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
    mustChangePassword: true,
    titleUnitCodes: [],
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
  ["職稱名稱", "層級"],
  ["護理長", "單位"],
  ["副護理長", "單位"],
  ["督導", "部級"],
  ["護理師", "單位"],
];
const TITLE_HEADER = ["職稱名稱", "層級"];

const ROLE_SAMPLE: string[][] = [
  ["角色名稱", "層級"],
  ["召集人", ""],
  ["執行幹事", ""],
];
const ROLE_HEADER = ["角色名稱", "層級"];

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
          <div className="panel-inset">
            <SectionTitle
              title={`匯入預覽（共 ${preview.length} 筆，可匯入 ${okCount} 筆）`}
              note="僅「通過」的資料列會被匯入"
            />
          </div>
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
          <div className="panel-inset">
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
  // v1.56.0：組織與設定整區塊只限系統管理員（原管理員或品管執行幹事可維護已收掉）。
  const isAdmin = (user?.roles ?? []).includes("系統管理員");

  const [tab, setTab] = useState<Tab>("users");
  const [sortState, setSortState] = useState<{ key: string; dir: 1 | -1 }>({
    key: "",
    dir: 1,
  });
  const [userUnitFilter, setUserUnitFilter] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [unitGroupFilter, setUnitGroupFilter] = useState("");
  const [unitSearch, setUnitSearch] = useState("");
  /** v1.57.0 A1／A2：清單只在按「查詢」後顯示；輸入框改篩選條件不即時過濾，按查詢才套用 */
  const [appliedUserUnitFilter, setAppliedUserUnitFilter] = useState("");
  const [appliedUserSearch, setAppliedUserSearch] = useState("");
  const [usersSearched, setUsersSearched] = useState(false);
  const [appliedUnitGroupFilter, setAppliedUnitGroupFilter] = useState("");
  const [appliedUnitSearch, setAppliedUnitSearch] = useState("");
  const [unitsSearched, setUnitsSearched] = useState(false);

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

  // ---- 層級（v1.55.0 方案 A：層級做成可管理資料） ----
  const [titleLevels, setTitleLevels] = useState<OrgLevel[]>([]);
  const [roleLevels, setRoleLevels] = useState<OrgLevel[]>([]);
  const [levelsLoading, setLevelsLoading] = useState(true);
  const [levelEdit, setLevelEdit] = useState<{
    target: "title" | "role";
    id: string;
    name: string;
  } | null>(null);
  const [levelCreateTarget, setLevelCreateTarget] = useState<"title" | "role" | null>(null);
  const [newLevelName, setNewLevelName] = useState("");
  const [levelError, setLevelError] = useState("");
  const [levelBusy, setLevelBusy] = useState(false);
  const migrationRanRef = useRef(false);

  // ---- 人員 ----
  const [users, setUsers] = useState<UserRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [userView, setUserView] = useState<
    { kind: "list" } | { kind: "create" } | { kind: "edit"; staffId: string }
  >({ kind: "list" });
  const [userForm, setUserForm] = useState<UserForm>(emptyUserForm());
  const [userError, setUserError] = useState("");
  /** 群組＋角色加入區（v1.52.0 分工表式）：群組下拉＋角色勾選＋加入／更新 */
  const [membershipAddGroupId, setMembershipAddGroupId] = useState("");
  const [membershipAddRoles, setMembershipAddRoles] = useState<string[]>([]);
  /** v1.57.0 A6：群組→層級→角色三層下拉（層級與角色為加入區的暫存選擇，選後進已選角色） */
  const [membershipAddLevelId, setMembershipAddLevelId] = useState("");
  const [membershipAddRoleName, setMembershipAddRoleName] = useState("");
  /** v1.57.0 A7：職稱改層級→職稱兩層下拉（""＝未選層級，"__ungrouped__"＝未分層級） */
  const [userTitleLevelId, setUserTitleLevelId] = useState("");
  /** v1.58.0：督導負責單位多選的搜尋關鍵字（搜尋優先，不主動列清單） */
  const [titleUnitSearch, setTitleUnitSearch] = useState("");
  /** 正在編輯的列（群組 id）；null＝加入模式 */
  const [membershipEditingGroupId, setMembershipEditingGroupId] = useState<string | null>(null);
  const [membershipError, setMembershipError] = useState("");

  const groupNameOf = (groupId: string): string =>
    groups.find((g) => g.id === groupId)?.name ?? groupId;
  const [userSaving, setUserSaving] = useState(false);
  // v1.51.0：一次性補建審查員名單（管理員手動觸發）
  const [backfilling, setBackfilling] = useState(false);
  const [roleOptions, setRoleOptions] = useState<OptionItem[]>([]);

  // ---- 角色（v1.39.0：一名一檔，只寫名稱；建立後請至權限管理設定權限） ----
  const [rolesLoading, setRolesLoading] = useState(true);
  const [roleCreateOpen, setRoleCreateOpen] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
  /** v1.55.0：新角色所屬層級（空＝未分層級）；v1.57.0 A3：身分由名稱關鍵字、範圍由層級推導，不再選類別／範圍 */
  const [newRoleLevelId, setNewRoleLevelId] = useState("");
  const [roleCreateError, setRoleCreateError] = useState("");
  const [roleCreateSaving, setRoleCreateSaving] = useState(false);
  /** 正在管理成員的角色 id（""＝未開啟） */
  const [managingRoleId, setManagingRoleId] = useState("");
  /** v1.57.0 A4：正在編輯的角色 id（""＝彈窗未開啟；與成員管理面板分開） */
  const [editingRoleId, setEditingRoleId] = useState("");
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
  const [titleAddChecked, setTitleAddChecked] = useState<string[]>([]);
  const [titleBusy, setTitleBusy] = useState(false);

  // ---- 群組單位管理（v1.21） ----
  const [managingGroupId, setManagingGroupId] = useState("");
  const [groupUnitChecked, setGroupUnitChecked] = useState<string[]>([]);
  const [groupUnitAddSearch, setGroupUnitAddSearch] = useState("");
  const [groupBusy, setGroupBusy] = useState(false);

  const visibleUnits = sortedRows(
    units.filter((row) => {
      const keyword = appliedUnitSearch.trim().toLocaleLowerCase();
      return (
        (!appliedUnitGroupFilter || row.groupId === appliedUnitGroupFilter) &&
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
      const keyword = appliedUserSearch.trim().toLocaleLowerCase();
      return (
        (!appliedUserUnitFilter || row.unitCode === appliedUserUnitFilter) &&
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
              ? groupedRolesLabel(row.memberships, groupNameOf)
              : key === "user-status"
                ? row.status
                : row.staffId,
  );

  /** 角色清單＋成員數（由 roleOptions 與人員清單衍生；一名一檔，成員＝roles 含該名或任一 membership 含該名） */
  const roleRows: RoleRow[] = useMemo(
    () =>
      roleOptions.map((r) => ({
        id: r.id,
        name: r.name,
        scope: r.scope ?? "group",
        levelId: r.levelId ?? "",
        memberCount:
          users.length > 0
            ? users.filter(
                (u) =>
                  u.roles.includes(r.name) ||
                  u.memberships.some((m) => m.roles.includes(r.name)),
              ).length
            : null,
      })),
    [roleOptions, users],
  );

  // ---- 各成員管理面板的衍生清單（v1.21） ----
  const managingRole = roleRows.find((r) => r.id === managingRoleId) ?? null;
  const editingRole = roleRows.find((r) => r.id === editingRoleId) ?? null;
  const managingTitle = titles.find((item) => item.id === managingTitleId) ?? null;
  const roleMembers = useMemo(
    () =>
      managingRole
        ? users.filter(
            (u) =>
              u.roles.includes(managingRole.name) ||
              u.memberships.some((m) => m.roles.includes(managingRole.name)),
          )
        : [],
    [users, managingRole],
  );
  const roleCandidates = useMemo(() => {
    if (!managingRole) return [];
    const kw = roleAddSearch.trim().toLowerCase();
    // v1.57.0 A5：比照職稱／單位成員面板，搜尋框為空不列候選、候選上限 20 筆
    if (kw === "") return [];
    return users
      .filter(
        (u) =>
          u.status === "在職" &&
          !u.roles.includes(managingRole.name) &&
          !u.memberships.some((m) => m.roles.includes(managingRole.name)) &&
          (u.staffId.toLowerCase().includes(kw) ||
            u.name.toLowerCase().includes(kw)),
      )
      .slice(0, 20);
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
        !u.titleId && u.title === title.name
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
          u.titleId !== title.id &&
          !(u.titleId === "" && u.title === title.name) &&
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

  /** v1.57.0 A5：群組加入單位改搜尋優先（搜尋框為空不列候選） */
  const groupUnitCandidates = useMemo(() => {
    if (!managingGroupId) return [];
    const kw = groupUnitAddSearch.trim().toLowerCase();
    if (kw === "") return [];
    return units.filter(
      (u) =>
        u.groupId !== managingGroupId &&
        (u.code.toLowerCase().includes(kw) ||
          u.name.toLowerCase().includes(kw)),
    );
  }, [units, managingGroupId, groupUnitAddSearch]);

  const usersLoadedRef = useRef(false);

  const loadRoles = useCallback(async () => {
    setRolesLoading(true);
    try {
      const snap = await getCachedRefCollection("roles", () =>
        getDocsCacheFirst(collection(getFirebaseDb(), "roles")),
      );
      const meta = buildRoleMetaMap(
        snap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>;
          return {
            name: typeof data.name === "string" ? data.name : d.id,
            levelId: data.levelId,
          };
        }),
      );
      setRoleOptions(
        snap.docs.map((d) => {
          const data = d.data();
          const name = typeof data.name === "string" ? data.name : d.id;
          const m = meta.get(name);
          return {
            id: d.id,
            name,
            scope: m?.scope,
            levelId:
              typeof data.levelId === "string" ? data.levelId : "",
          };
        }),
      );
    } catch {
      setRoleOptions([]);
    } finally {
      setRolesLoading(false);
    }
  }, []);

  /** 角色詮釋資料對照（名稱→類別／範圍），身分判斷不再比對名稱。 */
  const roleMeta: RoleMetaMap = useMemo(
    () => buildRoleMetaMap(roleOptions),
    [roleOptions],
  );

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

  /** 層級清單（v1.55.0）：titleLevels／roleLevels 各讀一次 */
  const loadLevels = useCallback(async () => {
    setLevelsLoading(true);
    try {
      const db = getFirebaseDb();
      const [tSnap, rSnap] = await Promise.all([
        getDocsFromServer(collection(db, "titleLevels")),
        getDocsFromServer(collection(db, "roleLevels")),
      ]);
      const read = (snap: { docs: Array<{ id: string; data: () => Record<string, unknown> }> }) =>
        snap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            name: typeof data.name === "string" ? data.name : "",
            order: typeof data.order === "number" ? data.order : 0,
          };
        });
      setTitleLevels(sortedLevels(read(tSnap)));
      setRoleLevels(sortedLevels(read(rSnap)));
    } catch (error) {
      onAction(`讀取層級清單失敗：${toErrorMessage(error)}`);
    } finally {
      setLevelsLoading(false);
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
          return {
            id: d.id,
            name: typeof data.name === "string" ? data.name : "",
            levelId:
              typeof data.levelId === "string" ? data.levelId : "",
            // 職稱主管層級旗標（有欄位時以欄位為準；舊資料無欄位時以名稱推導）
            ...legacyTitleFlags(
              typeof data.name === "string" ? data.name : "",
            ),
            ...(typeof data.isUnitHead === "boolean"
              ? { isUnitHead: data.isUnitHead }
              : {}),
            ...(typeof data.isDistrictHead === "boolean"
              ? { isDistrictHead: data.isDistrictHead }
              : {}),
            ...(typeof data.isHospitalHead === "boolean"
              ? { isHospitalHead: data.isHospitalHead }
              : {}),
            ...(typeof data.isOfficer === "boolean"
              ? { isOfficer: data.isOfficer }
              : {}),
            ...(typeof data.isConvener === "boolean"
              ? { isConvener: data.isConvener }
              : {}),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
      // 各職稱使用人數（僅管理員可查 users；舊人員無 titleId 者以職稱名稱比對）
      const titleCounts = new Map<string, number>();
      const legacyTitleCounts = new Map<string, number>();
      let usersReadable = false;
      try {
        const usnap = await getCachedRefCollection("users", () =>
          getDocsFromServer(collection(getFirebaseDb(), "users")),
        );
        usersReadable = true;
        usnap.docs.forEach((d) => {
          const data = d.data();
          const titleId = typeof data.titleId === "string" ? data.titleId : "";
          const titleName = typeof data.title === "string" ? data.title : "";
          if (titleId) {
            titleCounts.set(titleId, (titleCounts.get(titleId) ?? 0) + 1);
          } else if (titleName) {
            legacyTitleCounts.set(titleName, (legacyTitleCounts.get(titleName) ?? 0) + 1);
          }
        });
      } catch {
        titleCounts.clear();
        legacyTitleCounts.clear();
      }
      setTitles(
        list.map((t) => ({
          ...t,
          userCount: usersReadable
            ? (titleCounts.get(t.id) ?? 0) + (legacyTitleCounts.get(t.name) ?? 0)
            : null,
        })),
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

  // v1.40.5：開頁不再自動補種固定名稱群組。群組／單位／角色／職稱
  // 皆由系統管理員在本頁自行建立；各醫院名稱不同，不得寫死。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      loadMaster();
      loadRoles();
      loadTitles();
      loadLevels();
      // v1.55.0：一次性層級遷移（管理員開頁執行；旗標防重跑）
      if (isAdmin && user?.staffId && !migrationRanRef.current) {
        migrationRanRef.current = true;
        (async () => {
          try {
            const res = await migrateOrgLevels(
              getFirebaseDb(),
              user.staffId,
              user.name,
            );
            const parts: string[] = [];
            if (res.levelsCreated.length > 0)
              parts.push(`建立層級 ${res.levelsCreated.length} 個`);
            if (res.titlesBackfilled > 0)
              parts.push(`職稱回填 ${res.titlesBackfilled} 筆`);
            if (res.rolesBackfilled > 0)
              parts.push(`角色回填 ${res.rolesBackfilled} 筆`);
            if (res.rolesCreated.length > 0)
              parts.push(`新增角色 ${res.rolesCreated.length} 個`);
            if (res.oldRole === "migrated")
              parts.push(
                `舊角色「品管執行幹事」已遷移 ${res.oldRoleHolders} 人後刪除`,
              );
            else if (res.oldRole === "deleted-empty")
              parts.push("舊角色「品管執行幹事」已刪除");
            if (parts.length > 0)
              onAction(`層級遷移完成：${parts.join("、")}`);
            await loadLevels();
            await loadTitles();
            await loadRoles();
          } catch (error) {
            onAction(`層級遷移失敗：${toErrorMessage(error)}`);
          }
        })();
      }
      // v1.12.0：掛載時即預載人員（修頁籤 badge 初始顯示 0 的問題）
      if (isAdmin) loadUsers();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadMaster, loadRoles, loadTitles, loadLevels, isAdmin, user]);

  useEffect(() => {
    // v1.27.2：掛載時已預載人員，切回頁籤不重拉（存檔後各 handler 會自行 loadUsers）
    if (tab === "users" && isAdmin && !usersLoadedRef.current) {
      loadUsers();
    }
  }, [tab, isAdmin, loadUsers]);

  useEffect(() => {
    if (tab === "roles" && isAdmin && users.length === 0) {
      loadUsers();
    }
  }, [tab, isAdmin, users.length, loadUsers]);

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
      levelId: row.levelId ?? "",
      isUnitHead: row.isUnitHead,
      isDistrictHead: row.isDistrictHead,
      isHospitalHead: row.isHospitalHead,
      isOfficer: row.isOfficer,
      isConvener: row.isConvener,
    });
    setTitleError("");
    setTitleView({ kind: "edit", id });
  }

  async function handleTitleSave() {
    const view = titleView;
    const name = titleForm.name.trim();
    if (!name) {
      setTitleError("請填寫職稱名稱");
      return;
    }
    if (!user) {
      setTitleError("請先登入");
      return;
    }
    // v1.39.0：一名一檔，同名已有文件時擋下
    if (
      titles.some(
        (t) => t.name === name && (view.kind !== "edit" || t.id !== view.id),
      )
    ) {
      setTitleError(`職稱「${name}」已存在`);
      return;
    }
    setTitleError("");
    setTitleSaving(true);
    try {
      const db = getFirebaseDb();
      if (view.kind === "create") {
        const titleRef = doc(collection(db, "titles"));
        const batch = writeBatch(db);
        batch.set(titleRef, {
          name,
          levelId: titleForm.levelId,
          // v1.40.5：職稱建立即寫入主管層級旗標，身分判斷不再比對名稱
          isUnitHead: titleForm.isUnitHead,
          isDistrictHead: titleForm.isDistrictHead,
          isHospitalHead: titleForm.isHospitalHead,
          isOfficer: titleForm.isOfficer,
          isConvener: titleForm.isConvener,
          ...auditFields(user.staffId, true),
        });
        batch.set(doc(collection(db, "auditLogs")), {
          actor: user.staffId,
          actorName: user.name,
          action: "職稱建立",
          targetType: "title",
          targetId: titleRef.id,
          detail: `新增職稱「${name}」`,
          before: null,
          after: { name },
          createdAt: serverTimestamp(),
        });
        await batch.commit();
        onAction(`已新增職稱 ${name}；請至權限管理設定權限`);
      } else if (view.kind === "edit") {
        const old = titles.find((title) => title.id === view.id);
        const oldName = old?.name ?? "";
        const nameChanged = oldName !== name;
        // v1.40.5：即使名稱不變，主管層級旗標變動也要能儲存
        const flagsChanged =
          old?.isUnitHead !== titleForm.isUnitHead ||
          old?.isDistrictHead !== titleForm.isDistrictHead ||
          old?.isHospitalHead !== titleForm.isHospitalHead ||
          old?.isOfficer !== titleForm.isOfficer ||
          old?.isConvener !== titleForm.isConvener;
        // v1.55.0：層級變動也要能儲存
        const levelChanged = (old?.levelId ?? "") !== titleForm.levelId;
        if (!nameChanged && !flagsChanged && !levelChanged) {
          setTitleView({ kind: "list" });
          return;
        }
        // 更名同步：持有此職稱的人員 title 字串＋權限範本一併改名
        const templateRef = doc(db, "permissionTemplates", templateDocId("unit", oldName));
        const [templateSnap, newTemplateSnap] = await Promise.all([
          getDoc(templateRef),
          nameChanged
            ? getDoc(doc(db, "permissionTemplates", templateDocId("unit", name)))
            : Promise.resolve(null),
        ]);
        if (newTemplateSnap?.exists()) {
          setTitleError(`新名稱「${name}」已有權限範本，請先處理該範本再更名`);
          return;
        }
        if (nameChanged) {
          const ops: Array<(b: WriteBatch) => void> = [];
          users.forEach((u) => {
            if (u.titleId === view.id || (!u.titleId && u.title === oldName)) {
              ops.push((b) => {
                b.update(doc(db, "users", u.staffId), {
                  title: name,
                  ...auditFields(user.staffId, false),
                });
                b.set(doc(collection(db, "auditLogs")), {
                  actor: user.staffId,
                  actorName: user.name,
                  action: "人員職稱異動",
                  targetType: "user",
                  targetId: u.staffId,
                  detail: `職稱更名：職編 ${u.staffId} 職稱「${oldName}」→「${name}」`,
                  before: { titleId: u.titleId, title: u.title },
                  after: { titleId: u.titleId, title: name },
                  createdAt: serverTimestamp(),
                });
              });
            }
          });
          await commitInBatches(ops);
        }
        const batch = writeBatch(db);
        batch.update(doc(db, "titles", view.id), {
          name,
          levelId: titleForm.levelId,
          isUnitHead: titleForm.isUnitHead,
          isDistrictHead: titleForm.isDistrictHead,
          isHospitalHead: titleForm.isHospitalHead,
          isOfficer: titleForm.isOfficer,
          isConvener: titleForm.isConvener,
          ...auditFields(user.staffId, false),
        });
        if (nameChanged && templateSnap.exists()) {
          batch.set(doc(db, "permissionTemplates", templateDocId("unit", name)), {
            ...templateSnap.data(),
            name,
          });
          batch.delete(templateRef);
        }
        batch.set(doc(collection(db, "auditLogs")), {
          actor: user.staffId,
          actorName: user.name,
          action: "職稱更名",
          targetType: "title",
          targetId: view.id,
          detail: nameChanged
            ? `職稱「${oldName}」更名為「${name}」`
            : `職稱「${name}」主管層級更新`,
          before: old ? { name: old.name } : null,
          after: { name },
          createdAt: serverTimestamp(),
        });
        await batch.commit();
        onAction(nameChanged ? `職稱已更名為 ${name}` : `職稱「${name}」已更新`);
        await loadUsers();
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
        return !data.titleId && titleName === row.name;
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
      `確定刪除職稱「${row.name}」？此動作無法復原。`,
    );
    if (!ok) return;
    try {
      const db = getFirebaseDb();
      const batch = writeBatch(db);
      batch.delete(doc(db, "titles", row.id));
      // v1.39.2：刪除職稱一併刪除其權限範本（單位類同名文件）
      batch.delete(doc(db, "permissionTemplates", templateDocId("unit", row.name)));
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user.staffId,
        actorName: user.name,
        action: "職稱刪除",
        targetType: "title",
        targetId: row.id,
        detail: `刪除職稱「${row.name}」`,
        before: { name: row.name },
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


  // ================= 層級（v1.55.0） =================

  async function handleLevelCreate() {
    const target = levelCreateTarget;
    if (!target || !user) return;
    const name = newLevelName.trim();
    if (!name) {
      setLevelError("請輸入層級名稱");
      return;
    }
    const levels = target === "title" ? titleLevels : roleLevels;
    if (levels.some((l) => l.name === name)) {
      setLevelError(`層級「${name}」已存在`);
      return;
    }
    setLevelError("");
    setLevelBusy(true);
    try {
      const db = getFirebaseDb();
      const coll = target === "title" ? "titleLevels" : "roleLevels";
      const ref = doc(collection(db, coll));
      const batch = writeBatch(db);
      batch.set(ref, {
        name,
        order: nextLevelOrder(levels),
        ...auditFields(user.staffId, true),
      });
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user.staffId,
        actorName: user.name,
        action: "層級建立",
        targetType: "level",
        targetId: ref.id,
        detail: `新增${target === "title" ? "職稱" : "角色"}層級「${name}」`,
        before: null,
        after: { name },
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      setNewLevelName("");
      setLevelCreateTarget(null);
      await loadLevels();
      onAction(`已新增層級「${name}」`);
    } catch (error) {
      setLevelError(`新增失敗：${toErrorMessage(error)}`);
    } finally {
      setLevelBusy(false);
    }
  }

  /** 層級更名只改層級文件（項目以 levelId 參照，人員與權限不動） */
  async function handleLevelRename() {
    if (!levelEdit || !user) return;
    const name = levelEdit.name.trim();
    if (!name) {
      setLevelError("請輸入層級名稱");
      return;
    }
    const levels = levelEdit.target === "title" ? titleLevels : roleLevels;
    if (levels.some((l) => l.name === name && l.id !== levelEdit.id)) {
      setLevelError(`層級「${name}」已存在`);
      return;
    }
    setLevelError("");
    setLevelBusy(true);
    try {
      const db = getFirebaseDb();
      const coll = levelEdit.target === "title" ? "titleLevels" : "roleLevels";
      await updateDoc(doc(db, coll, levelEdit.id), {
        name,
        ...auditFields(user.staffId, false),
      });
      setLevelEdit(null);
      await loadLevels();
      onAction(`層級已更名為「${name}」`);
    } catch (error) {
      setLevelError(`更名失敗：${toErrorMessage(error)}`);
    } finally {
      setLevelBusy(false);
    }
  }

  /** 層級刪除：底下還有項目就擋下 */
  async function handleLevelDelete(target: "title" | "role", level: OrgLevel) {
    if (!user) return;
    const items = target === "title" ? titles : roleRows;
    if (!canDeleteLevel(items, level.id)) {
      onAction(
        `層級「${level.name}」底下還有項目，請先移出或刪除項目再刪除層級`,
      );
      return;
    }
    const ok = window.confirm(
      `確定刪除層級「${level.name}」？此動作無法復原。`,
    );
    if (!ok) return;
    try {
      const db = getFirebaseDb();
      const coll = target === "title" ? "titleLevels" : "roleLevels";
      const batch = writeBatch(db);
      batch.delete(doc(db, coll, level.id));
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user.staffId,
        actorName: user.name,
        action: "層級刪除",
        targetType: "level",
        targetId: level.id,
        detail: `刪除${target === "title" ? "職稱" : "角色"}層級「${level.name}」`,
        before: { name: level.name },
        after: null,
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      onAction(`層級「${level.name}」已刪除`);
      await loadLevels();
    } catch (error) {
      onAction(`刪除失敗：${toErrorMessage(error)}`);
    }
  }

  /** 層級排序：與相鄰層級交換 order */
  async function handleLevelMove(
    target: "title" | "role",
    levelId: string,
    dir: 1 | -1,
  ) {
    if (!user) return;
    const levels = target === "title" ? titleLevels : roleLevels;
    const sorted = sortedLevels(levels);
    const idx = sorted.findIndex((l) => l.id === levelId);
    const swapIdx = idx + dir;
    if (idx < 0 || swapIdx < 0 || swapIdx >= sorted.length) return;
    try {
      const db = getFirebaseDb();
      const coll = target === "title" ? "titleLevels" : "roleLevels";
      const batch = writeBatch(db);
      batch.update(doc(db, coll, sorted[idx].id), {
        order: sorted[swapIdx].order,
        ...auditFields(user.staffId, false),
      });
      batch.update(doc(db, coll, sorted[swapIdx].id), {
        order: sorted[idx].order,
        ...auditFields(user.staffId, false),
      });
      await batch.commit();
      await loadLevels();
    } catch (error) {
      onAction(`排序失敗：${toErrorMessage(error)}`);
    }
  }

  // ================= 人員 =================

  function openUserCreate() {
    setUserForm(emptyUserForm());
    setUserError("");
    resetMembershipAddArea();
    setUserTitleLevelId("");
    setUserView({ kind: "create" });
  }

  function openUserEdit(staffId: string) {
    const row = users.find((u) => u.staffId === staffId);
    if (!row) return;
    const resolvedTitleId =
      row.titleId ||
      (() => {
        const matches = titles.filter((title) => title.name === row.title);
        return matches.length === 1 ? matches[0].id : "";
      })();
    const resolvedTitle = titles.find((item) => item.id === resolvedTitleId);
    setUserForm({
      staffId: row.staffId,
      name: row.name,
      unitCode: row.unitCode,
      title: row.title,
      titleId: resolvedTitleId,
      hireDate: "",
      email: "",
      phone: "",
      // v1.21：群組角色走 memberships 配對列
      // v1.52.0：無角色的列不載入表單（列表不呈現；儲存後跟著消失，
      // 群組歸屬可依單位設定。見 VERIFICATION_1.52.0.md 的 Q6 檢查）
      // v1.58.0：「其他角色」已刪除，roles 聯集一律由分工表衍生
      memberships: row.memberships
        .filter((m) => m.roles.length > 0)
        .map((m) => ({
          groupId: m.groupId,
          roles: [...m.roles],
        })),
      mustChangePassword: true,
      titleUnitCodes: [],
      reviewerAccessExpiresAt: row.reviewerAccessExpiresAt,
    });
    setUserError("");
    resetMembershipAddArea();
    // v1.57.0 A7：編輯時職稱層級由現職稱帶入（未分層級職稱帶入 "__ungrouped__"）
    setUserTitleLevelId(
      resolvedTitle ? resolvedTitle.levelId || "__ungrouped__" : "",
    );
    // v1.57.0 A6：人員已歸類群組時，群組自動帶入（先取已有角色的第一個群組，否則取所屬單位的群組）
    const autoGroupId =
      row.memberships.find((m) => m.roles.length > 0)?.groupId ||
      units.find((u) => u.code === row.unitCode)?.groupId ||
      "";
    if (autoGroupId) setMembershipAddGroupId(autoGroupId);
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
            titleUnitCodes: Array.isArray(data.titleUnitCodes)
              ? data.titleUnitCodes.map(String)
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

  /** 群組＋角色加入區（v1.52.0 分工表式）：清空加入區、回到加入模式 */
  function resetMembershipAddArea() {
    setMembershipAddGroupId("");
    setMembershipAddRoles([]);
    setMembershipAddLevelId("");
    setMembershipAddRoleName("");
    setMembershipEditingGroupId(null);
    setMembershipError("");
  }

  function toggleMembershipAddRole(roleName: string) {
    setMembershipAddRoles((prev) =>
      prev.includes(roleName)
        ? prev.filter((r) => r !== roleName)
        : [...prev, roleName],
    );
  }

  /** 點[編輯]：該列群組＋角色帶回上方加入區改 */
  function startMembershipEdit(groupId: string) {
    const row = userForm.memberships.find((m) => m.groupId === groupId);
    if (!row) return;
    setMembershipAddGroupId(row.groupId);
    setMembershipAddRoles([...row.roles]);
    setMembershipEditingGroupId(groupId);
    setMembershipError("");
  }

  function cancelMembershipEdit() {
    resetMembershipAddArea();
  }

  /** [加入]／[更新]：加入時同群組合併、零勾選擋下；編輯到零角色刪列 */
  function handleMembershipAddOrUpdate() {
    if (!membershipAddGroupId) {
      setMembershipError("請先選擇群組");
      return;
    }
    if (membershipEditingGroupId === null && membershipAddRoles.length === 0) {
      setMembershipError("請至少選擇一個角色");
      return;
    }
    setUserForm((prev) => ({
      ...prev,
      memberships:
        membershipEditingGroupId === null
          ? mergeMembership(prev.memberships, membershipAddGroupId, membershipAddRoles)
          : applyMembershipEdit(
              prev.memberships,
              membershipEditingGroupId,
              membershipAddGroupId,
              membershipAddRoles,
            ),
    }));
    resetMembershipAddArea();
  }

  /** 點[刪除]：直接刪列，無確認；只改表單 state，儲存才生效 */
  function removeMembershipByGroup(groupId: string) {
    setUserForm((prev) => ({
      ...prev,
      memberships: removeMembership(prev.memberships, groupId),
    }));
    if (membershipEditingGroupId === groupId) resetMembershipAddArea();
  }

  /** v1.58.0：督導負責單位勾選切換（單位代碼） */
  function toggleTitleUnit(unitCode: string) {
    setUserForm((prev) => ({
      ...prev,
      titleUnitCodes: prev.titleUnitCodes.includes(unitCode)
        ? prev.titleUnitCodes.filter((x) => x !== unitCode)
        : [...prev.titleUnitCodes, unitCode],
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
    // v1.55.0：新帳號預設為一般使用者，職稱可留白、之後再賦予。
    const selectedTitle = userForm.titleId
      ? titles.find((title) => title.id === userForm.titleId)
      : undefined;
    // v1.58.0：roles 聯集一律由分工表衍生，不再併其他角色；
    // 僅保留「系統管理員」與「一般人員」兩個例外（見 deriveStoredRoles）。
    // 編輯時以前次 roles 為準保留例外；新建時無前次 roles。
    const previousRoles =
      view.kind === "edit"
        ? (users.find((u) => u.staffId === view.staffId)?.roles ?? [])
        : [];
    const roles = deriveStoredRoles(
      userForm.memberships.filter((m) => m.groupId),
      previousRoles,
    );
    // v1.58.0：負責單位只在部級職稱為督導時設定，其餘情況清空，避免舊值殘留。
    // 部級以層級 id（tl-dept）或層級名稱（部級）認定，層級可由管理員更名。
    const selectedTitleLevel = selectedTitle
      ? titleLevels.find((l) => l.id === selectedTitle.levelId)
      : undefined;
    const isDeptLevelTitle =
      selectedTitle?.levelId === "tl-dept" ||
      selectedTitleLevel?.name === "部級";
    const isDistrictHeadTitle =
      isDeptLevelTitle && selectedTitle?.isDistrictHead === true;
    const titleUnitCodes = isDistrictHeadTitle
      ? [...new Set(userForm.titleUnitCodes)]
      : [];
    const reviewerAccessExpiresAt = isReviewerRole(roles, roleMeta)
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
      // v1.21：memberships 為主；同步更新 groupIds（衍生）與 roles（聯集一律由分工表衍生，v1.58.0）
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
        titleUnitCodes,
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
          `已新增人員 ${staffId}。請再到 Firebase Console → Authentication 新增使用者，email 為 ${staffId}@nurseboard.internal，初始密碼請設為職編 ${staffId}（首次登入須更改）`,
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
          titleUnitCodes: Array.isArray(previous.titleUnitCodes) ? previous.titleUnitCodes : [],
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
          titleUnitCodes,
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
      resetMembershipAddArea();
      await loadUsers();
      // 審查員連動（v1.12.0；v1.51.0 改由 reviewerSync 統一處理）
      const savedStaffId =
        view.kind === "edit" ? view.staffId : userForm.staffId.trim();
      try {
        const result = await syncReviewerDoc(db, savedStaffId, roles, roleMeta);
        if (result === "linked") {
          onAction(`已將 ${savedStaffId} 自動加入審查員名單（未分類）`);
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

  /** v1.51.0：一次性補建審查員名單（管理員手動觸發；具審查員角色且效期有效、但無名單文件者補建未分類文件） */
  async function handleBackfillReviewers() {
    if (!user) return;
    setBackfilling(true);
    try {
      const db = getFirebaseDb();
      const n = await backfillReviewerDocs(db, roleMeta);
      onAction(
        n > 0
          ? `已補建 ${n} 位審查員名單`
          : "審查員名單已是最新，無需補建",
      );
      await loadUsers();
    } catch (error) {
      onAction(`補建審查員名單失敗：${toErrorMessage(error)}`);
    } finally {
      setBackfilling(false);
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

  /** 從人員的 roles／memberships 移除指定角色（角色刪除／成員移除共用；一名一檔，全群組一起移除） */
  function removeRoleFromUser(row: UserRow, roleName: string) {
    return (b: WriteBatch) => {
      const memberships = row.memberships
        .map((m) => ({
          ...m,
          roles: m.roles.filter((r) => r !== roleName),
        }))
        .filter((m) => m.roles.length > 0);
      // v1.58.0：roles 一律由分工表重算（僅保留系統管理員／一般人員例外）
      const roles = deriveStoredRoles(memberships, row.roles);
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
        detail: `移除職編 ${row.staffId} 的角色「${roleName}」`,
        before: { roles: row.roles, memberships: row.memberships },
        after: { roles, memberships },
        createdAt: serverTimestamp(),
      });
    };
  }

  /** 將角色加入人員（指定群組 → 寫入該群組 membership；單位級以其單位所屬群組計）
   * v1.58.0：roles 一律由分工表重算，不再有無群組的全域指派。 */
  function addRoleToUser(row: UserRow, roleName: string, groupId: string) {
    return (b: WriteBatch) => {
      let memberships = row.memberships;
      if (groupId) {
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
      const roles = deriveStoredRoles(memberships, row.roles);
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

  /** v1.57.0 A4：角色編輯改彈窗（名稱＋層級；成員管理維持內嵌面板） */
  function openRoleEdit(roleId: string) {
    const role = roleRows.find((item) => item.id === roleId);
    if (!role) return;
    setEditingRoleId(roleId);
    setRoleEditName(role.name);
    setRoleEditLevelId(role.levelId ?? "");
    setRoleEditError("");
  }

  function openRoleMembers(roleId: string) {
    setManagingRoleId(roleId);
    setRoleMemberChecked([]);
    setRoleAddSearch("");
    setRoleAddGroupId("");
    setRoleAddChecked([]);
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
        targets.map((u) => removeRoleFromUser(u, role.name)),
      );
      onAction(`已將 ${targets.length} 位人員移出角色「${role.name}」`);
      setRoleMemberChecked([]);
      await loadUsers();
      // v1.51.0：移出成員後同步審查員名單（不再具審查員身分者移除未分類文件）
      try {
        const db = getFirebaseDb();
        for (const u of targets) {
          // v1.58.0：roles 一律由移除後的分工表重算
          await syncReviewerDoc(
            db,
            u.staffId,
            deriveStoredRoles(
              u.memberships
                .map((m) => ({
                  ...m,
                  roles: m.roles.filter((r) => r !== role.name),
                }))
                .filter((m) => m.roles.length > 0),
              u.roles,
            ),
            roleMeta,
          );
        }
      } catch {
        onAction("審查員名單連動失敗，請聯絡系統管理員手動調整");
      }
    } catch (error) {
      onAction(`移除失敗：${toErrorMessage(error)}`);
    } finally {
      setRoleBusy(false);
    }
  }

  async function handleRoleMembersAdd() {
    const role = roleRows.find((r) => r.id === managingRoleId);
    if (!role || roleAddChecked.length === 0) return;
    const unitLevel = role.scope === "unit";
    const unitGroupOf = (unitCode: string) =>
      units.find((u) => u.code === unitCode)?.groupId ?? "";
    const targets = users.filter((u) => roleAddChecked.includes(u.staffId));
    const noUnit: string[] = [];
    const added: UserRow[] = [];
    const ops: Array<(b: WriteBatch) => void> = [];
    for (const u of targets) {
      let gid = "";
      if (unitLevel) {
        gid = unitGroupOf(u.unitCode);
        if (!gid) {
          noUnit.push(u.staffId);
          continue;
        }
      } else {
        // v1.40.3：非單位級角色一律指定群組加入（角色分類建立的角色皆可按群組指派）
        gid = roleAddGroupId;
        if (!gid) {
          onAction("請先選擇此角色適用的群組");
          return;
        }
      }
      ops.push(addRoleToUser(u, role.name, gid));
      added.push(u);
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
      // v1.51.0：加入成員後同步審查員名單
      try {
        const db = getFirebaseDb();
        let linked = 0;
        for (const u of added) {
          // v1.58.0：roles 一律由加入後的分工表重算
          const gid = unitLevel ? unitGroupOf(u.unitCode) : roleAddGroupId;
          const result = await syncReviewerDoc(
            db,
            u.staffId,
            deriveStoredRoles(
              gid ? mergeMembership(u.memberships, gid, [role.name]) : u.memberships,
              u.roles,
            ),
            roleMeta,
          );
          if (result === "linked") linked += 1;
        }
        if (linked > 0) {
          onAction(`已將 ${linked} 位自動加入審查員名單（未分類）`);
        }
      } catch {
        onAction("審查員名單連動失敗，請聯絡系統管理員手動調整");
      }
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
      const targets = users.filter(
        (u) =>
          u.roles.includes(row.name) ||
          u.memberships.some((m) => m.roles.includes(row.name)),
      );
      await commitInBatches(
        targets.map((u) => removeRoleFromUser(u, row.name)),
      );
      const db = getFirebaseDb();
      const batch = writeBatch(db);
      batch.delete(doc(db, "roles", row.id));
      // v1.39.2：刪除角色一併刪除其權限範本；新文件無 kind、分類由名稱決定，
      // 群組／單位角色兩類都刪（與更名搬移兩類的做法一致，刪不存在的文件無作用）
      for (const category of ["group", "unitRole"] as const) {
        batch.delete(
          doc(db, "permissionTemplates", templateDocId(category, row.name)),
        );
      }
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user.staffId,
        actorName: user.name,
        action: "角色刪除",
        targetType: "role",
        targetId: row.id,
        detail: `刪除角色「${row.name}」`,
        before: { name: row.name, memberCount: targets.length },
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
      // v1.51.0：刪除角色後同步審查員名單
      try {
        for (const u of targets) {
          // v1.58.0：roles 一律由移除後的分工表重算
          await syncReviewerDoc(
            db,
            u.staffId,
            deriveStoredRoles(
              u.memberships
                .map((m) => ({
                  ...m,
                  roles: m.roles.filter((r) => r !== row.name),
                }))
                .filter((m) => m.roles.length > 0),
              u.roles,
            ),
            roleMeta,
          );
        }
      } catch {
        onAction("審查員名單連動失敗，請聯絡系統管理員手動調整");
      }
    } catch (error) {
      onAction(`刪除失敗：${toErrorMessage(error)}`);
    } finally {
      setRoleBusy(false);
    }
  }

  async function handleRoleCreate() {
    const name = newRoleName.trim();
    if (!name) {
      setRoleCreateError("請輸入角色名稱");
      return;
    }
    // v1.39.0：一名一檔，同名已有文件時擋下
    if (roleRows.some((role) => role.name === name)) {
      setRoleCreateError(`角色「${name}」已存在`);
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
        description: "",
        // v1.57.0 A3：不再寫入 category／kind；身分由名稱關鍵字、範圍由層級推導
        levelId: newRoleLevelId,
        ...auditFields(user?.staffId ?? "", true),
      });
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user?.staffId ?? "",
        actorName: user?.name ?? "",
        action: "角色建立",
        targetType: "role",
        targetId: roleRef.id,
        detail: `建立角色「${name}」`,
        before: null,
        after: {
          name,
          levelId: newRoleLevelId,
        },
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      setNewRoleName("");
      setNewRoleLevelId("");
      setRoleCreateOpen(false);
      await loadRoles();
      onAction(`已新增角色「${name}」；請至權限管理設定權限`);
    } catch (error) {
      setRoleCreateError(`新增失敗：${toErrorMessage(error)}`);
    } finally {
      setRoleCreateSaving(false);
    }
  }

  /** 既有角色更名／改層級（v1.39.0 更名；v1.57.0 A3：類別／範圍改由名稱關鍵字／層級推導，不再手動設定）：
   * 只改名稱時同步更新持有此角色的人員與權限範本；改層級致範圍變動時遷移範本
   * group↔unitRole（範本文件 id 含類別）；更名後對應不斷（以文件 id 計）。
   * 舊文件上的 category／kind 欄位留著不動、不刪除、不遷移。 */
  const [roleEditName, setRoleEditName] = useState("");
  const [roleEditLevelId, setRoleEditLevelId] = useState("");
  const [roleEditError, setRoleEditError] = useState("");
  const [roleEditSaving, setRoleEditSaving] = useState(false);
  async function handleRoleRename() {
    const role = roleRows.find((r) => r.id === editingRoleId);
    if (!role || !user) return;
    const name = roleEditName.trim();
    if (!name) {
      setRoleEditError("請輸入角色名稱");
      return;
    }
    const nameChanged = name !== role.name;
    // 新範圍由改名後名稱＋新層級推導；範圍變動才遷移權限範本
    const newScope = deriveRoleScope({ levelId: roleEditLevelId, name });
    const scopeChanged = newScope !== role.scope;
    const levelChanged = (role.levelId ?? "") !== roleEditLevelId;
    if (!nameChanged && !scopeChanged && !levelChanged) {
      setRoleEditError("");
      setEditingRoleId("");
      return;
    }
    if (nameChanged && roleRows.some((r) => r.id !== role.id && r.name === name)) {
      setRoleEditError(`角色「${name}」已存在`);
      return;
    }
    setRoleEditError("");
    setRoleEditSaving(true);
    try {
      const db = getFirebaseDb();
      const oldName = role.name;
      const oldCategory = role.scope === "unit" ? "unitRole" : "group";
      const newCategory = newScope === "unit" ? "unitRole" : "group";
      if (nameChanged) {
        // 新名稱已有權限範本時擋下，避免覆蓋別的範本
        const [groupTpl, unitRoleTpl] = await Promise.all([
          getDoc(doc(db, "permissionTemplates", templateDocId("group", name))),
          getDoc(doc(db, "permissionTemplates", templateDocId("unitRole", name))),
        ]);
        if (groupTpl.exists() || unitRoleTpl.exists()) {
          setRoleEditError(`新名稱「${name}」已有權限範本，請先處理該範本再更名`);
          return;
        }
      }
      if (nameChanged) {
        const targets = users.filter(
          (u) =>
            u.roles.includes(oldName) ||
            u.memberships.some((m) => m.roles.includes(oldName)),
        );
        await commitInBatches(
          targets.map((u) => (b: WriteBatch) => {
            const roles = u.roles.map((r) => (r === oldName ? name : r));
            const memberships = u.memberships.map((m) => ({
              ...m,
              roles: m.roles.map((r) => (r === oldName ? name : r)),
            }));
            b.update(doc(db, "users", u.staffId), {
              roles,
              memberships,
              ...auditFields(user.staffId, false),
            });
            b.set(doc(collection(db, "auditLogs")), {
              actor: user.staffId,
              actorName: user.name,
              action: "人員角色異動",
              targetType: "user",
              targetId: u.staffId,
              detail: `角色更名：職編 ${u.staffId} 角色「${oldName}」→「${name}」`,
              before: { roles: u.roles, memberships: u.memberships },
              after: { roles, memberships },
              createdAt: serverTimestamp(),
            });
          }),
        );
      }
      const batch = writeBatch(db);
      batch.update(doc(db, "roles", role.id), {
        name,
        levelId: roleEditLevelId,
        ...auditFields(user.staffId, false),
      });
      // 權限範本遷移：舊（類別，舊名）→ 新（類別，新名）；類別或名稱其一變動皆遷移
      {
        const oldRef = doc(db, "permissionTemplates", templateDocId(oldCategory, oldName));
        const snap = await getDoc(oldRef);
        if (snap.exists()) {
          batch.set(doc(db, "permissionTemplates", templateDocId(newCategory, name)), {
            ...snap.data(),
            name,
            category: newCategory,
          });
          if (oldCategory !== newCategory || oldName !== name) batch.delete(oldRef);
        }
      }
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user.staffId,
        actorName: user.name,
        action: "角色更名",
        targetType: "role",
        targetId: role.id,
        detail: `角色「${oldName}」更新為「${name}」`,
        before: {
          name: oldName,
          scope: role.scope,
          levelId: role.levelId ?? "",
        },
        after: {
          name,
          scope: newScope,
          levelId: roleEditLevelId,
        },
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      await loadRoles();
      await loadUsers();
      setEditingRoleId("");
      onAction(`角色已更新為「${name}」`);
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
              action: "人員單位異動",
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
    // v1.39.0：職稱只剩名稱，調單位時職稱一律保留
    const retainedTitle = target.titleId
      ? titles.find((title) => title.id === target.titleId)
      : titles.find((title) => title.name === target.title);
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
        action: "人員單位異動",
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

  /** v1.56.0：職稱加入成員改勾選批次加入，與角色頁同一流程（每人寫入內容與單筆加入相同）。 */
  async function handleTitleMembersAdd() {
    const title = titles.find((item) => item.id === managingTitleId);
    if (!title || titleAddChecked.length === 0) return;
    const targets = users.filter((item) => titleAddChecked.includes(item.staffId));
    setTitleBusy(true);
    try {
      const me = user?.staffId ?? "";
      await commitInBatches(
        targets.map(
          (target) => (b: WriteBatch) => {
            b.update(doc(getFirebaseDb(), "users", target.staffId), {
              title: title.name,
              titleId: title.id,
              ...auditFields(me, false),
            });
            b.set(doc(collection(getFirebaseDb(), "auditLogs")), {
              actor: me,
              actorName: user?.name ?? "",
              action: "人員職稱異動",
              targetType: "user",
              targetId: target.staffId,
              detail: `職編 ${target.staffId} 職稱「${target.title}」→「${title.name}」`,
              before: { titleId: target.titleId, title: target.title, unitCode: target.unitCode },
              after: { titleId: title.id, title: title.name, unitCode: target.unitCode },
              createdAt: serverTimestamp(),
            });
          },
        ),
      );
      onAction(`已將 ${targets.length} 位人員轉任「${title.name}」`);
      setTitleAddChecked([]);
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
      setGroupUnitAddSearch("");
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
    const seen = new Set<string>();
    return Promise.resolve(
      rows.map((row, i) => {
        const name = (row[0] ?? "").trim();
        let error = "";
        if (!name) error = "角色名稱不可空白";
        else if (roleRows.some((role) => role.name === name) || seen.has(name))
          error = `角色「${name}」已存在`;
        else {
          const levelName = (row[1] ?? "").trim();
          if (levelName && !levelIdByName(roleLevels, levelName))
            error = `層級「${levelName}」不存在，請先建立層級`;
        }
        seen.add(name);
        return { index: i + 1, values: row, ok: !error, error };
      }),
    );
  }

  async function importRoleRows(rows: PreviewRow[]): Promise<void> {
    const me = user?.staffId ?? "";
    await commitInBatches(
      rows.map((row) => {
        const name = row.values[0].trim();
        const levelId = levelIdByName(roleLevels, (row.values[1] ?? "").trim());
        const roleRef = doc(collection(getFirebaseDb(), "roles"));
        return (batch: WriteBatch) => {
          batch.set(roleRef, {
            name,
            description: "",
            levelId,
            ...auditFields(me, true),
          });
          batch.set(doc(collection(getFirebaseDb(), "auditLogs")), {
            actor: me,
            actorName: user?.name ?? "",
            action: "角色建立",
            targetType: "role",
            targetId: roleRef.id,
            detail: `批次建立角色「${name}」`,
            before: null,
            after: { name },
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
    const existing = new Set(titles.map((title) => title.name));
    const seen = new Set<string>();
    return Promise.resolve(
      rows.map((r, i) => {
        const index = i + 1;
        const name = (r[0] ?? "").trim();
        if (!name) return { index, values: r, ok: false, error: "職稱名稱不可空白" };
        if (existing.has(name) || seen.has(name))
          return { index, values: r, ok: false, error: `職稱「${name}」已存在` };
        const levelName = (r[1] ?? "").trim();
        if (levelName && !levelIdByName(titleLevels, levelName))
          return { index, values: r, ok: false, error: `層級「${levelName}」不存在，請先建立層級` };
        seen.add(name);
        return { index, values: r, ok: true, error: "" };
      }),
    );
  }

  async function importTitleRows(rows: PreviewRow[]): Promise<void> {
    const me = user?.staffId ?? "";
    await commitInBatches(
      rows.map((r) => {
        const name = r.values[0].trim();
        const levelId = levelIdByName(titleLevels, (r.values[1] ?? "").trim());
        const titleRef = doc(collection(getFirebaseDb(), "titles"));
        return (b: WriteBatch) => {
          b.set(titleRef, {
            name,
            levelId,
            ...auditFields(me, true),
          });
          b.set(doc(collection(getFirebaseDb(), "auditLogs")), {
            actor: me,
            actorName: user?.name ?? "",
            action: "職稱建立",
            targetType: "title",
            targetId: titleRef.id,
            detail: `批次建立職稱「${name}」`,
            before: null,
            after: { name },
            createdAt: serverTimestamp(),
          });
        };
      }),
    );
  }

  function validateUserImportData(data: ReturnType<typeof parseUserSheet>["data"]) {
    const base = validateUserRowsLib(data, {
      existingStaffIds: new Set(users.map((u) => u.staffId)),
      groupByName: new Map(groups.map((g) => [g.name, g.id])),
      roleNames: new Set(roleOptions.map((r) => r.name)),
      roleMetaByName: roleMeta,
      titleNames: new Set(titles.map((t) => t.name)),
      unitCodes: new Set(units.map((u) => u.code)),
    });
    return base.map((result) => {
      if (!result.ok || !result.values) return result;
      const existing = users.find((item) => item.staffId === result.values?.staffId);
      const titleName = result.values.title ?? existing?.title ?? "";
      // v1.55.0：新帳號預設為一般使用者，職稱可留白、之後再賦予；
      // 更新時未填則沿用既有職稱。（舊 v1.36.0 擋下已移除。）
      if (!titleName) return result;
      // v1.39.0：職稱一名一檔，只認名稱存在與否，不再比對適用單位
      if (titles.some((title) => title.name === titleName)) return result;
      return {
        ...result,
        ok: false,
        errors: [...result.errors, `職稱「${titleName}」不存在，請先建立職稱`],
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
    // v1.51.0：批次匯入後同步審查員名單（收集每人匯入後的最終角色）
    const finalRoles: { staffId: string; roles: string[] }[] = [];
    const ops = results
      .filter((r) => r.ok && r.values)
      .map((r) => {
        const v = r.values!;
        const existing = users.find((item) => item.staffId === v.staffId);
        const nextUnitCode = v.unitCode ?? existing?.unitCode ?? "";
        const nextTitleName = v.title ?? existing?.title ?? "";
        const matchedTitle = nextTitleName
          ? titles.filter((title) => title.name === nextTitleName)
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
            // v1.58.0：roles 一律由分工表重算，不再保留既有全域角色
            patch.memberships = v.memberships;
            patch.groupIds = deriveGroupIds(v.memberships);
            patch.roles = deriveStoredRoles(v.memberships, existing?.roles ?? []);
          }
          const nextRoles = patch.roles ?? existing?.roles ?? [];
          const nextMemberships = patch.memberships ?? existing?.memberships ?? [];
          finalRoles.push({ staffId: v.staffId, roles: nextRoles });
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
        finalRoles.push({
          staffId: v.staffId,
          roles:
            v.memberships && v.memberships.length > 0
              ? deriveRoles(v.memberships)
              : ["一般人員"],
        });
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
            titleUnitCodes: [],
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
    // v1.51.0：批次匯入後同步審查員名單
    try {
      const db = getFirebaseDb();
      let linked = 0;
      for (const { staffId, roles } of finalRoles) {
        const result = await syncReviewerDoc(db, staffId, roles, roleMeta);
        if (result === "linked") linked += 1;
      }
      if (linked > 0) {
        onAction(`已將 ${linked} 位匯入人員自動加入審查員名單（未分類）`);
      }
    } catch {
      onAction("審查員名單連動失敗，請聯絡系統管理員手動調整");
    }
    return `人員匯入完成：新增 ${created} 筆、更新 ${updated} 筆`;
  }


  // ---- v1.55.0：職稱／角色按層級分組 ----
  const sortedTitleRows = sortedRows(
    titles,
    sortState.key,
    (row, key) => (key === "title-count" ? (row.userCount ?? -1) : row.name),
  );
  const titleSections = groupByLevel(sortedTitleRows, titleLevels);
  const sortedRoleRows = sortedRows(
    roleRows,
    sortState.key,
    (row, key) => (key === "role-count" ? (row.memberCount ?? -1) : row.name),
  );
  const roleSections = groupByLevel(sortedRoleRows, roleLevels);

  /** 層級區段標題（層級名＋人數小計＋更名／排序／刪除；未分層級不顯示操作） */
  function renderLevelHead(
    target: "title" | "role",
    level: OrgLevel | null,
    memberCount: number,
  ) {
    const levels = target === "title" ? titleLevels : roleLevels;
    const sorted = sortedLevels(levels);
    const idx = level ? sorted.findIndex((l) => l.id === level.id) : -1;
    const isEditing =
      levelEdit?.target === target && levelEdit?.id === level?.id;
    const canEdit = target === "title" ? isAdmin : isAdmin;
    return (
      <div className="level-section-head">
        {isEditing ? (
          <>
            <input
              className="text-input"
              style={{ maxWidth: 200 }}
              value={levelEdit.name}
              onChange={(e) =>
                setLevelEdit((prev) =>
                  prev ? { ...prev, name: e.target.value } : prev,
                )
              }
            />
            <button
              className="button button-primary button-sm"
              disabled={levelBusy}
              onClick={handleLevelRename}
            >
              儲存
            </button>
            <button
              className="button button-outline button-sm"
              onClick={() => setLevelEdit(null)}
            >
              取消
            </button>
          </>
        ) : (
          <>
            <b>{level ? level.name : "未分層級"}</b>
            <span className="settings-note">{memberCount} 人</span>
            {level && canEdit && (
              <>
                <button
                  className="text-button"
                  onClick={() =>
                    setLevelEdit({ target, id: level.id, name: level.name })
                  }
                >
                  <Pencil size={13} /> 更名
                </button>
                <button
                  className="text-button"
                  disabled={idx <= 0}
                  onClick={() => handleLevelMove(target, level.id, -1)}
                >
                  上移
                </button>
                <button
                  className="text-button"
                  disabled={idx < 0 || idx >= sorted.length - 1}
                  onClick={() => handleLevelMove(target, level.id, 1)}
                >
                  下移
                </button>
                <button
                  className="text-button"
                  onClick={() => handleLevelDelete(target, level)}
                >
                  <Trash2 size={13} /> 刪除
                </button>
              </>
            )}
          </>
        )}
      </div>
    );
  }

  /** 新增層級（區段上方的小按鈕＋展開表單） */
  function renderLevelCreate(target: "title" | "role") {
    const canEdit = target === "title" ? isAdmin : isAdmin;
    if (!canEdit) return null;
    if (levelCreateTarget !== target) {
      return (
        <div className="panel-inset">
          <button
            className="button button-outline button-sm"
            onClick={() => {
              setLevelCreateTarget(target);
              setNewLevelName("");
              setLevelError("");
            }}
          >
            <Plus size={14} /> 新增層級
          </button>
        </div>
      );
    }
    return (
      <div className="panel-inset">
        <div className="form-field" style={{ maxWidth: 320 }}>
          <label className="field-label">新層級名稱</label>
          <input
            className="text-input"
            value={newLevelName}
            placeholder="例如 部級"
            onChange={(e) => setNewLevelName(e.target.value)}
          />
        </div>
        {levelError && <div className="login-error">{levelError}</div>}
        <div className="form-actions">
          <button
            className="button button-primary button-sm"
            disabled={levelBusy}
            onClick={handleLevelCreate}
          >
            建立層級
          </button>
          <button
            className="button button-outline button-sm"
            onClick={() => {
              setLevelCreateTarget(null);
              setLevelError("");
            }}
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  function renderTitleTable(rows: TitleRow[]) {
    return (
      <div className="table-scroll">
        <table className="permission-table">
          <thead>
            <tr>
              <SortHeader label="職稱名稱" sortKey="title-name" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
              <SortHeader label="使用人數" sortKey="title-count" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
              {isAdmin && <th>操作</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <b>{row.name}</b>
                </td>
                <td>
                  {row.userCount === null ? "—" : `${row.userCount} 人`}
                </td>
                {isAdmin && (
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
                            managingTitleId === row.id ? "" : row.id,
                          );
                          setTitleMemberChecked([]);
                          setTitleAddSearch("");
                          setTitleAddChecked([]);
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
    );
  }

  function renderRoleTable(rows: RoleRow[]) {
    return (
      <div className="table-scroll">
        <table className="permission-table">
          <thead>
            <tr>
              <SortHeader label="角色名稱" sortKey="role-name" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
              <SortHeader label="成員數" sortKey="role-count" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <b>{row.name}</b>
                </td>
                <td>
                  {row.memberCount === null ? "—" : `${row.memberCount} 人`}
                </td>
                <td>
                  {isAdmin ? (
                    <>
                      <button
                        className="text-button"
                        onClick={() => openRoleEdit(row.id)}
                      >
                        <Pencil size={13} /> 編輯
                      </button>{" "}
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
    );
  }

  // ================= 版面 =================

  const isGroupEditing = groupView.kind === "edit";
  const isUnitEditing = unitView.kind === "edit";
  const isTitleEditing = titleView.kind === "edit";
  const isUserEditing = userView.kind === "edit";
  const reviewerRoleSelected = isReviewerRole(
    deriveRoles(userForm.memberships.filter((membership) => membership.groupId)),
    roleMeta,
  );

  // v1.58.0：負責單位只在部級職稱為督導時設定（部級以層級 id tl-dept 或名稱「部級」認定）
  const formSelectedTitle = userForm.titleId
    ? titles.find((t) => t.id === userForm.titleId)
    : undefined;
  const formTitleLevel = formSelectedTitle
    ? titleLevels.find((l) => l.id === formSelectedTitle.levelId)
    : undefined;
  const showTitleUnits =
    (formSelectedTitle?.levelId === "tl-dept" ||
      formTitleLevel?.name === "部級") &&
    formSelectedTitle?.isDistrictHead === true;
  // v1.58.0：負責單位候選（搜尋優先：搜尋框為空不列候選、上限 20 筆、已選者不列）
  const titleUnitCandidates = useMemo(() => {
    const kw = titleUnitSearch.trim().toLowerCase();
    if (kw === "") return [];
    return units
      .filter(
        (u) =>
          !userForm.titleUnitCodes.includes(u.code) &&
          (u.code.toLowerCase().includes(kw) ||
            u.name.toLowerCase().includes(kw)),
      )
      .slice(0, 20);
  }, [titleUnitSearch, units, userForm.titleUnitCodes]);

  const headingAction = (() => {
    const back = (reset: () => void) => (
      <button className="button button-outline" onClick={reset}>
        <X size={15} />
        返回清單
      </button>
    );
    if (tab === "groups") {
      if (groupView.kind === "list")
        return isAdmin ? (
          <button className="button button-primary" onClick={openGroupCreate}>
            <Plus size={16} />
            新增群組
          </button>
        ) : undefined;
      return back(() => setGroupView({ kind: "list" }));
    }
    if (tab === "units") {
      if (unitView.kind === "list")
        return isAdmin ? (
          <button className="button button-primary" onClick={openUnitCreate}>
            <Plus size={16} />
            新增單位
          </button>
        ) : undefined;
      return back(() => setUnitView({ kind: "list" }));
    }
    if (tab === "titles") {
      if (titleView.kind === "list")
        return isAdmin ? (
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
          <button
            className="button button-primary button-sm"
            onClick={() => {
              setAppliedUserUnitFilter(userUnitFilter);
              setAppliedUserSearch(userSearch);
              setUsersSearched(true);
            }}
          >
            查詢
          </button>
          <button
            className="button button-outline button-sm"
            disabled={backfilling}
            onClick={handleBackfillReviewers}
            title="為現有具審查員角色但不在審查員名單內的人員補建名單文件（未分類）"
          >
            {backfilling ? "補建中…" : "補建審查員名單"}
          </button>
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
          <button
            className="button button-primary button-sm"
            onClick={() => {
              setAppliedUnitGroupFilter(unitGroupFilter);
              setAppliedUnitSearch(unitSearch);
              setUnitsSearched(true);
            }}
          >
            查詢
          </button>
        </div>
      )}

      {/* 批次上傳工具列（僅清單檢視） */}
      {tab === "groups" && groupView.kind !== "edit" && isAdmin && (
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
      {tab === "units" && unitView.kind !== "edit" && isAdmin && (
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
      {tab === "titles" && titleView.kind !== "edit" && isAdmin && (
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
            postImportNote="提醒：匯入的人員仍需到 Firebase Console → Authentication 手動建立登入帳號（email 格式為「職編@nurseboard.internal」，初始密碼請設為該員職編，首次登入須更改）。"
            onDone={loadUsers}
            onAction={onAction}
          />
        </div>
      )}
      {tab === "roles" && !managingRole && isAdmin && (
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
                    {isAdmin && <th>操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {sortedRows(groups, sortState.key, (row, key) => key === "group-count" ? row.unitCount : row.name).map((row) => (
                    <tr key={row.id}>
                      <td>
                        <b>{row.name}</b>
                      </td>
                      <td>{row.unitCount} 個</td>
                      {isAdmin && (
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
                              setGroupUnitAddSearch("");
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
            {managingGroupId && isAdmin && (
              <div className="panel-inset divided">
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
                  <input
                    className="text-input"
                    placeholder="輸入單位代號或名稱搜尋"
                    value={groupUnitAddSearch}
                    onChange={(e) => setGroupUnitAddSearch(e.target.value)}
                  />
                </div>
                {groupUnitAddSearch.trim() !== "" &&
                  (groupUnitCandidates.length === 0 ? (
                    <p className="settings-note">無符合的單位。</p>
                  ) : (
                    <div className="table-scroll">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>單位代號</th>
                            <th>單位名稱</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {groupUnitCandidates.map((u) => (
                            <tr key={u.code}>
                              <td>{u.code}</td>
                              <td>{u.name}</td>
                              <td>
                                <button
                                  className="text-button"
                                  disabled={groupBusy}
                                  onClick={() => handleGroupUnitAdd(u.code)}
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
                    onClick={() => setManagingGroupId("")}
                  >
                    關閉
                  </button>
                </div>
              </div>
            )}

          </section>
        )
      ) : tab === "units" ? (
        masterLoading ? (
          <section className="panel">
            <p className="settings-note">讀取中…</p>
          </section>
        ) : !unitsSearched ? (
          <EmptyState
            title="尚未查詢"
            description="請設定篩選條件後按「查詢」，即可列出符合條件的單位。"
          />
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
                    {isAdmin && <th>操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {visibleUnits.length === 0 ? (
                    <tr><td colSpan={isAdmin ? 5 : 4} className="muted-text">沒有符合篩選條件的單位</td></tr>
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
                      {isAdmin && (
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
              <div className="panel-inset divided">
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

          </section>
        )
      ) : tab === "titles" ? (
        titlesLoading || levelsLoading ? (
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
            {renderLevelCreate("title")}
            {titleSections.map((section) => (
              <div className="level-section" key={section.level?.id ?? "ungrouped"}>
                {renderLevelHead(
                  "title",
                  section.level,
                  section.items.reduce((n, r) => n + (r.userCount ?? 0), 0),
                )}
                {renderTitleTable(section.items)}
              </div>
            ))}
            {managingTitle && isAdmin && (
              <div className="panel-inset divided">
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
                  <label className="field-label">加入人員（搜尋＋全選）</label>
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
                    <>
                      <div className="table-scroll">
                        <table className="permission-table">
                          <thead>
                            <tr>
                              <th style={{ width: 36 }}>
                                <input
                                  type="checkbox"
                                  checked={
                                    titleCandidates.length > 0 &&
                                    titleCandidates.every((u) =>
                                      titleAddChecked.includes(u.staffId),
                                    )
                                  }
                                  onChange={(e) =>
                                    setTitleAddChecked(
                                      e.target.checked
                                        ? titleCandidates.map((u) => u.staffId)
                                        : [],
                                    )
                                  }
                                  aria-label="全選"
                                />
                              </th>
                              <th>職編</th>
                              <th>姓名</th>
                              <th>現職稱</th>
                            </tr>
                          </thead>
                          <tbody>
                            {titleCandidates.map((u) => (
                              <tr key={u.staffId}>
                                <td>
                                  <input
                                    type="checkbox"
                                    checked={titleAddChecked.includes(u.staffId)}
                                    onChange={(e) =>
                                      setTitleAddChecked((prev) =>
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
                                <td>{u.title || "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="form-actions">
                        <button
                          className="button button-primary"
                          disabled={titleAddChecked.length === 0 || titleBusy}
                          onClick={handleTitleMembersAdd}
                        >
                          加入所選（{titleAddChecked.length}）
                        </button>
                      </div>
                    </>
                  ))}
                <div className="form-actions">
                  <button
                    className="button button-outline"
                    onClick={() => setManagingTitleId("")}
                  >
                    返回職稱清單
                  </button>
                </div>
              </div>
            )}
            <div className="panel-inset">
              <p className="settings-note">
                職稱以名稱唯一；可在此新增職稱、管理成員或刪除職稱。職稱權限請到「組織與設定 → 權限管理」設定（按名稱共用）。
              </p>
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
      ) : tab === "users" ? (
        usersLoading ? (
          <section className="panel">
            <p className="settings-note">讀取中…</p>
          </section>
        ) : !usersSearched ? (
          <EmptyState
            title="尚未查詢"
            description="請設定篩選條件後按「查詢」，即可列出符合條件的人員。"
          />
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
                        {(() => {
                          // v1.52.0：角色欄按群組分組顯示，例如「病房組：品管組審查員、召集人」
                          const segments = groupedRolesSegments(
                            row.memberships,
                            groupNameOf,
                          );
                          return segments.length > 0
                            ? segments.map((s) => (
                                <div key={s.label || "other"}>
                                  {s.label ? <b>{s.label}：</b> : null}
                                  {s.roles.join("、")}
                                </div>
                              ))
                            : "—";
                        })()}
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
            <SectionTitle title="新增角色" note="新角色預設無權限，建立後請至權限管理設定權限。角色以名稱唯一；跨群組／跨單位設定請到權限管理。" />
            {roleCreateError && <div className="login-error">{roleCreateError}</div>}
            <div className="form-field" style={{ maxWidth: 420 }}>
              <label className="field-label">角色名稱 *</label>
              <input
                className="text-input"
                value={newRoleName}
                placeholder="輸入角色名稱"
                onChange={(event) => setNewRoleName(event.target.value)}
              />
              <p className="settings-note">身分（審查員／召集人／執行幹事）由名稱關鍵字推導，範圍由層級決定。</p>
            </div>
            <div className="form-field" style={{ maxWidth: 420 }}>
              <label className="field-label">層級</label>
              <div className="select-wrap">
                <select
                  value={newRoleLevelId}
                  onChange={(event) => setNewRoleLevelId(event.target.value)}
                >
                  <option value="">— 未分層級 —</option>
                  {roleLevels.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
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
            <div className="panel-inset">
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
            <div className="form-field" style={{ maxWidth: 320 }}>
              <label className="field-label">加入人員（搜尋＋全選）</label>
              <input
                className="text-input"
                placeholder="輸入職編或姓名搜尋"
                value={roleAddSearch}
                onChange={(e) => setRoleAddSearch(e.target.value)}
              />
            </div>
            {/* v1.40.3：非單位級角色一律可指定群組加入，不再只對寫死名單顯示群組選單 */}
            {managingRole.scope !== "unit" && (
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
            {managingRole.scope === "unit" && (
              <p className="settings-note">
                單位級角色：加入時以各人所屬單位的群組計（無所屬單位群組者無法加入）。
              </p>
            )}
            {roleAddSearch.trim() !== "" &&
              (roleCandidates.length === 0 ? (
                <p className="settings-note">無符合的在職人員。</p>
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
            ))}
            <div className="form-actions">
              <button
                className="button button-outline"
                onClick={() => setManagingRoleId("")}
              >
                返回角色清單
              </button>
            </div>
            </div>
          </section>
        ) : rolesLoading || levelsLoading ? (
          <section className="panel">
            <p className="settings-note">讀取中…</p>
          </section>
        ) : roleRows.length === 0 ? (
          <EmptyState
            title="尚無角色"
            description="使用右上角「新增角色」或「批次上傳」建立角色。"
          />
        ) : (
          <section className="panel data-panel">
            {renderLevelCreate("role")}
            {roleSections.map((section) => (
              <div className="level-section" key={section.level?.id ?? "ungrouped"}>
                {renderLevelHead(
                  "role",
                  section.level,
                  section.items.reduce((n, r) => n + (r.memberCount ?? 0), 0),
                )}
                {renderRoleTable(section.items)}
              </div>
            ))}
            <div className="panel-inset">
              <p className="settings-note">
                角色以名稱唯一；可在此新增角色、管理成員或刪除角色。成員管理與刪除限系統管理員。角色權限請到「組織與設定 → 權限管理」設定（按名稱共用）。
              </p>
            </div>
          </section>
        )
      ) : null}

      {tab === "groups" && groupView.kind !== "list" && (
        <Modal
          title={isGroupEditing ? "編輯群組" : "新增群組"}
          note="群組名稱不可重複（例如：病房組）"
          onClose={() => setGroupView({ kind: "list" })}
        >
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
        </Modal>
      )}
      {tab === "units" && unitView.kind !== "list" && (
        <Modal
          title={isUnitEditing ? `編輯單位 ${unitForm.code}` : "新增單位"}
          note={isUnitEditing ? "單位代號不可變更（更名時代號不變）" : undefined}
          onClose={() => setUnitView({ kind: "list" })}
        >
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
        </Modal>
      )}
      {tab === "titles" && titleView.kind !== "list" && (
        <Modal
          title={isTitleEditing ? "編輯職稱" : "新增職稱"}
          note="職稱以名稱唯一；跨單位設定請到權限管理。"
          onClose={() => setTitleView({ kind: "list" })}
        >
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
              <div className="select-wrap">
                <select
                  value={titleForm.levelId}
                  onChange={(e) =>
                    setTitleForm((prev) => ({ ...prev, levelId: e.target.value }))
                  }
                >
                  <option value="">— 未分層級 —</option>
                  {titleLevels.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
            <div className="form-field">
              <label className="field-label">主管層級（決定儀表板與結果範圍；不以名稱判斷）</label>
              <div className="form-grid">
                {(
                  [
                    ["isUnitHead", "單位主管"],
                    ["isDistrictHead", "轄區主管"],
                    ["isHospitalHead", "院級主管"],
                    ["isOfficer", "執行幹事"],
                    ["isConvener", "召集人"],
                  ] as const
                ).map(([key, label]) => (
                  <label className="check-row" key={key}>
                    <input
                      type="checkbox"
                      checked={titleForm[key]}
                      onChange={(e) =>
                        setTitleForm((prev) => ({
                          ...prev,
                          [key]: e.target.checked,
                        }))
                      }
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
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
        </Modal>
      )}
      {tab === "users" && userView.kind !== "list" && (
        <Modal
          title={isUserEditing ? `編輯人員 ${userForm.staffId}` : "新增人員"}
          note={isUserEditing ? "職編不可變更" : "儲存後請再到 Firebase Console → Authentication 建立登入帳號"}
          onClose={() => {
            resetMembershipAddArea();
            setUserView({ kind: "list" });
          }}
          wide
        >
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
                  setUserForm((prev) => ({ ...prev, unitCode: nextUnitCode }));
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
            <label className="field-label">職稱層級</label>
            <div className="select-wrap">
              <select
                value={userTitleLevelId}
                onChange={(e) => {
                  setUserTitleLevelId(e.target.value);
                  setUserForm((prev) => ({ ...prev, titleId: "", title: "", titleUnitCodes: [] }));
                }}
              >
                <option value="">請選擇層級</option>
                {titleLevels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
                <option value="__ungrouped__">未分層級</option>
              </select>
              <ChevronDown size={15} />
            </div>
          </div>
          <div className="form-field">
            <label className="field-label">職稱</label>
            <div className="select-wrap">
              <select
                value={userForm.titleId}
                disabled={!userTitleLevelId}
                onChange={(e) => {
                  const title = titles.find((item) => item.id === e.target.value);
                  setUserForm((prev) => ({
                    ...prev,
                    titleId: title?.id ?? "",
                    title: title?.name ?? "",
                    // v1.58.0：換職稱時清空負責單位，改由新職稱的條件決定
                    titleUnitCodes: [],
                  }));
                }}
              >
                <option value="">
                  {userTitleLevelId ? "請選擇職稱" : "請先選擇層級"}
                </option>
                {titles
                  .filter((t) =>
                    userTitleLevelId === "__ungrouped__"
                      ? !t.levelId
                      : t.levelId === userTitleLevelId,
                  )
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
              <ChevronDown size={15} />
            </div>
            {userForm.titleId ? (
              <p className="settings-note">
                已選：{userForm.title}{" "}
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    setUserForm((prev) => ({ ...prev, titleId: "", title: "", titleUnitCodes: [] }))
                  }
                >
                  移除重選
                </button>
              </p>
            ) : (
              <p className="settings-note">可留白：新帳號預設為一般使用者，職稱與角色之後再賦予。</p>
            )}
          </div>
          {/* v1.58.0：部級職稱為督導時才顯示負責單位（搜尋優先，不主動列清單） */}
          {showTitleUnits ? (
            <div className="form-field">
              <label className="field-label">負責單位</label>
              <input
                className="text-input"
                type="search"
                placeholder="輸入單位代號或名稱搜尋"
                value={titleUnitSearch}
                onChange={(e) => setTitleUnitSearch(e.target.value)}
              />
              {titleUnitSearch.trim() === "" ? (
                <p className="settings-note">輸入單位代號或名稱搜尋後勾選。</p>
              ) : titleUnitCandidates.length === 0 ? (
                <p className="settings-note">找不到符合的單位。</p>
              ) : (
                <div className="form-grid">
                  {titleUnitCandidates.map((u) => (
                    <label className="check-row" key={u.code}>
                      <input
                        type="checkbox"
                        checked={userForm.titleUnitCodes.includes(u.code)}
                        onChange={() => toggleTitleUnit(u.code)}
                      />
                      <span>
                        {u.code} {u.name}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {userForm.titleUnitCodes.length > 0 ? (
                <div className="form-grid" style={{ marginTop: 8 }}>
                  {userForm.titleUnitCodes.map((code) => {
                    const u = units.find((x) => x.code === code);
                    return (
                      <span key={code}>
                        {code} {u?.name ?? ""}{" "}
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => toggleTitleUnit(code)}
                        >
                          移除
                        </button>
                      </span>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
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
              <p className="settings-note">帳號與初始密碼統一為職編：登入帳號為「職編@nurseboard.internal」，在 Firebase Console 建立使用者時初始密碼請設為該員職編；首次登入須更改密碼。</p>
            </div>
          )}
        </div>

        <SectionTitle
          title="群組＋角色"
          note="上方加入、下方列表；每個群組的角色與權限各自隔離，加入後即顯示於列表，按「儲存修改」才生效。"
        />
        {/* v1.52.0：分工表式——上方加入區＋下方角色列表（每群組一列，可編輯／刪除） */}
        <div className="panel" style={{ padding: 12, marginBottom: 8 }}>
          <div className="form-field">
            <label className="field-label">群組</label>
            <div className="select-wrap">
              <select
                value={membershipAddGroupId}
                onChange={(e) => {
                  // v1.51.0：切換群組不得清空已勾角色（加入區群組與角色為獨立 state）
                  setMembershipAddGroupId(e.target.value);
                  setMembershipError("");
                }}
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
          {/* v1.57.0 A6：群組→層級→角色三層下拉；選角色後進下方已選列，可多重 */}
          <div className="form-grid">
            <div className="form-field">
              <label className="field-label">層級</label>
              <div className="select-wrap">
                <select
                  value={membershipAddLevelId}
                  onChange={(e) => {
                    setMembershipAddLevelId(e.target.value);
                    setMembershipAddRoleName("");
                  }}
                >
                  <option value="">請選擇層級</option>
                  {roleLevels.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                  <option value="__ungrouped__">未分層級</option>
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
            <div className="form-field">
              <label className="field-label">角色</label>
              <div className="select-wrap">
                <select
                  value={membershipAddRoleName}
                  disabled={!membershipAddLevelId}
                  onChange={(e) => {
                    const name = e.target.value;
                    if (name) {
                      setMembershipAddRoles((prev) =>
                        prev.includes(name) ? prev : [...prev, name],
                      );
                      setMembershipAddRoleName("");
                    }
                  }}
                >
                  <option value="">
                    {membershipAddLevelId ? "請選擇角色" : "請先選擇層級"}
                  </option>
                  {roleOptions
                    .filter(
                      (r) =>
                        (membershipAddLevelId === "__ungrouped__"
                          ? !r.levelId
                          : r.levelId === membershipAddLevelId) &&
                        !membershipAddRoles.includes(r.name),
                    )
                    .map((r) => (
                      <option key={r.id} value={r.name}>
                        {r.name}
                      </option>
                    ))}
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
          </div>
          {membershipAddRoles.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                alignItems: "center",
                margin: "4px 0",
              }}
            >
              <span className="settings-note">已選：</span>
              {membershipAddRoles.map((r) => (
                <span key={r} className="status-pill muted">
                  {r}{" "}
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`移除 ${r}`}
                    onClick={() => toggleMembershipAddRole(r)}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {membershipEditingGroupId !== null && (
            <p className="settings-note">
              正在編輯：{groupNameOf(membershipEditingGroupId)}
              （按「更新」寫回原列；角色全取消會刪除該群組）
            </p>
          )}
          {membershipError && <div className="login-error">{membershipError}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              className="button button-primary button-sm"
              onClick={handleMembershipAddOrUpdate}
            >
              {membershipEditingGroupId === null ? (
                <>
                  <Plus size={14} /> 加入
                </>
              ) : (
                "更新"
              )}
            </button>
            {membershipEditingGroupId !== null && (
              <button
                className="button button-outline button-sm"
                onClick={cancelMembershipEdit}
              >
                取消編輯
              </button>
            )}
          </div>
        </div>
        <div className="panel" style={{ padding: 12 }}>
          <p className="settings-note" style={{ marginTop: 0 }}>
            {userForm.memberships.length} 個群組・
            {userForm.memberships.reduce((n, m) => n + m.roles.length, 0)} 個角色
          </p>
          {userForm.memberships.length === 0 ? (
            <p className="settings-note">尚無群組＋角色，請由上方加入。</p>
          ) : (
            <div className="table-scroll">
              <table className="permission-table">
                <thead>
                  <tr>
                    <th>群組</th>
                    <th>角色</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {userForm.memberships.map((m) => (
                    <tr key={m.groupId}>
                      <td>
                        <b>{groupNameOf(m.groupId)}</b>
                      </td>
                      <td>
                        {m.roles.map((r) => (
                          <span
                            key={r}
                            className="status-pill muted"
                            style={{ marginRight: 4 }}
                          >
                            {r}
                          </span>
                        ))}
                      </td>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => startMembershipEdit(m.groupId)}
                        >
                          <Pencil size={13} /> 編輯
                        </button>{" "}
                        <button
                          className="text-button"
                          onClick={() => removeMembershipByGroup(m.groupId)}
                        >
                          <Trash2 size={13} /> 刪除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

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
            onClick={() => {
              resetMembershipAddArea();
              setUserView({ kind: "list" });
            }}
          >
            取消
          </button>
        </div>
        </Modal>
      )}
      {editingRole && (
        <Modal
          title={`編輯角色「${editingRole.name}」`}
          note="角色以名稱唯一；改名會同步更新所有持有此角色的人員與權限範本。改層級影響範圍時權限範本一併遷移。身分由名稱關鍵字推導。跨設定請到權限管理。"
          onClose={() => setEditingRoleId("")}
        >
          {roleEditError && <div className="login-error">{roleEditError}</div>}
          <div className="form-field" style={{ maxWidth: 320 }}>
            <label className="field-label">角色名稱 *</label>
            <input
              className="text-input"
              value={roleEditName}
              placeholder="輸入角色名稱"
              onChange={(event) => setRoleEditName(event.target.value)}
            />
          </div>
          <div className="form-field" style={{ maxWidth: 320 }}>
            <label className="field-label">層級</label>
            <div className="select-wrap">
              <select
                value={roleEditLevelId}
                onChange={(event) => setRoleEditLevelId(event.target.value)}
              >
                <option value="">— 未分層級 —</option>
                {roleLevels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} />
            </div>
          </div>
          <div className="form-actions">
            <button
              className="button button-primary"
              disabled={roleEditSaving}
              onClick={handleRoleRename}
            >
              {roleEditSaving ? "儲存中…" : "儲存修改"}
            </button>
            <button
              className="button button-outline"
              onClick={() => setEditingRoleId("")}
            >
              取消
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
