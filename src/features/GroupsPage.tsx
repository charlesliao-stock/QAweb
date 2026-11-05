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
import { useAuth } from "../lib/auth";
import { maskName } from "../lib/mask";
import { SEED_GROUP_NAMES, SEED_ROLES, SEED_TITLES } from "../lib/seed";
import { reviewerDocId, UNCATEGORIZED_GROUP_ID, shouldAutoLinkReviewer } from "../lib/scheduling";
import { emptyPermissions, parsePermissions } from "../lib/permissions";
import {
  deriveGroupIds,
  deriveRoles,
  isGroupScopedRole,
  isUnitLevelRole,
  parseMemberships,
  type Membership,
} from "../lib/roleIdentity";
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
  groupName: string;
  memberCount: number | null;
}

interface TitleRow {
  id: string;
  name: string;
  level: string;
  userCount: number | null;
  /** 功能權限（v1.12.0：與角色分開設定，目前僅儲存） */
  permissions: Record<string, boolean>;
}

interface UserRow {
  staffId: string;
  name: string;
  unitCode: string;
  title: string;
  roles: string[];
  /** 群組＋角色配對（v1.21；無則由舊 groupIds＋roles 推導） */
  memberships: Membership[];
  status: string;
}

interface RoleRow {
  id: string;
  name: string;
  memberCount: number | null;
}

interface OptionItem {
  id: string;
  name: string;
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
}

interface TitleForm {
  name: string;
  level: "群組" | "單位";
}

interface UserForm {
  staffId: string;
  name: string;
  unitCode: string;
  title: string;
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
  return { code: "", name: "", groupId: "" };
}

function emptyTitleForm(): TitleForm {
  return { name: "", level: "單位" };
}

function emptyUserForm(): UserForm {
  return {
    staffId: "",
    name: "",
    unitCode: "",
    title: "",
    hireDate: "",
    email: "",
    phone: "",
    memberships: [],
    otherRoles: [],
    mustChangePassword: true,
    districtGroupIds: [],
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

/** Firestore batch 寫入，每批上限 500 */
async function commitInBatches(
  ops: Array<(b: WriteBatch) => void>,
): Promise<void> {
  const db = getFirebaseDb();
  for (let i = 0; i < ops.length; i += 500) {
    const b = writeBatch(db);
    ops.slice(i, i + 500).forEach((op) => op(b));
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
  ["召集人", "群組"],
  ["執行幹事", "群組"],
  ["組長", "群組"],
  ["主任", "單位"],
  ["副主任", "單位"],
  ["督導", "單位"],
  ["護理長", "單位"],
  ["副護理長", "單位"],
  ["執行幹事", "單位"],
];
const TITLE_HEADER = ["職稱名稱", "層級"];

const ROLE_SAMPLE: string[][] = [["角色名稱"], ["自訂角色"]];
const ROLE_HEADER = ["角色名稱"];

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
        onClick={() => downloadTemplate(sampleRows, "範本", sampleBaseName)}
      >
        <Download size={14} />
        下載範例檔
      </button>
      <button className="button button-outline" onClick={handlePick}>
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

  // ---- 角色（v1.21：種子 7 新角色＋成員管理） ----
  const [roleCreateOpen, setRoleCreateOpen] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
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
  const [managingTitleName, setManagingTitleName] = useState("");
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
        memberCount:
          users.length > 0
            ? users.filter((u) => u.roles.includes(r.name)).length
            : null,
      })),
    [roleOptions, users],
  );

  // ---- 各成員管理面板的衍生清單（v1.21） ----
  const managingRole = roleRows.find((r) => r.id === managingRoleId) ?? null;
  const roleMembers = useMemo(
    () =>
      managingRole
        ? users.filter((u) => u.roles.includes(managingRole.name))
        : [],
    [users, managingRole],
  );
  const roleCandidates = useMemo(() => {
    if (!managingRole) return [];
    const kw = roleAddSearch.trim().toLowerCase();
    return users.filter(
      (u) =>
        u.status === "在職" &&
        !u.roles.includes(managingRole.name) &&
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
    () =>
      managingTitleName
        ? users.filter((u) => u.title === managingTitleName)
        : [],
    [users, managingTitleName],
  );
  const titleCandidates = useMemo(() => {
    if (!managingTitleName) return [];
    const kw = titleAddSearch.trim().toLowerCase();
    return users
      .filter(
        (u) =>
          u.status === "在職" &&
          u.title !== managingTitleName &&
          (kw === "" ||
            u.staffId.toLowerCase().includes(kw) ||
            u.name.toLowerCase().includes(kw)),
      )
      .slice(0, 20);
  }, [users, managingTitleName, titleAddSearch]);

  const groupUnits = useMemo(
    () =>
      managingGroupId
        ? units.filter((u) => u.groupId === managingGroupId)
        : [],
    [units, managingGroupId],
  );

  const loadRoles = useCallback(async () => {
    try {
      const snap = await getDocs(collection(getFirebaseDb(), "roles"));
      setRoleOptions(
        snap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            name: typeof data.name === "string" ? data.name : d.id,
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
        getDocs(collection(db, "groups")),
        getDocs(collection(db, "units")),
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
        const usersSnap = await getDocs(collection(db, "users"));
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
      const snap = await getDocs(collection(db, "titles"));
      const list = snap.docs
        .map((d) => {
          const data = d.data();
          return {
            id: d.id,
            name: typeof data.name === "string" ? data.name : "",
            level: typeof data.level === "string" ? data.level : "",
            permissions: { ...parsePermissions(data.permissions) },
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
      // 各職稱使用人數（僅管理員可查 users）
      let titleCounts = new Map<string, number>();
      try {
        const usnap = await getDocs(collection(db, "users"));
        usnap.docs.forEach((d) => {
          const t = d.data().title;
          if (typeof t === "string" && t) {
            titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1);
          }
        });
      } catch {
        titleCounts = new Map();
      }
      setTitles(
        list.map((t) => ({
          ...t,
          userCount: titleCounts.has(t.name)
            ? (titleCounts.get(t.name) ?? 0)
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
      const snap = await getDocs(collection(getFirebaseDb(), "users"));
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
            roles,
            // v1.21：讀取以 memberships 為主，無則 fallback 舊 groupIds＋roles
            memberships: parseMemberships(data.memberships, {
              roles,
              groupIds: Array.isArray(data.groupIds)
                ? data.groupIds.map(String)
                : [],
            }),
            status: typeof data.status === "string" ? data.status : "在職",
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
   * v1.21 種子：角色（SEED_ROLES 含 7 新角色）、職稱（6 職稱）、
   * 群組（5 群組），不存在才建立。
   * 角色用固定 id；職稱文件 id＝`${level}-${name}`；群組以名稱判重。
   */
  const ensureSeeds = useCallback(async () => {
    // v1.21：種子寫入含 roles 集合（rules 限管理員寫入），僅管理員執行
    if (!isAdmin) return;
    try {
      const db = getFirebaseDb();
      const me = user?.staffId ?? "";
      const [rSnap, tSnap, gSnap] = await Promise.all([
        getDocs(collection(db, "roles")),
        getDocs(collection(db, "titles")),
        getDocs(collection(db, "groups")),
      ]);
      const roleNames = new Set(
        rSnap.docs.map((d) => String(d.data().name ?? "")),
      );
      const titleIds = new Set(tSnap.docs.map((d) => d.id));
      const groupNames = new Set(
        gSnap.docs.map((d) => String(d.data().name ?? "")),
      );
      const ops: Array<(b: WriteBatch) => void> = [];
      for (const role of SEED_ROLES) {
        if (!roleNames.has(role.name)) {
          ops.push((b) =>
            b.set(
              doc(db, "roles", role.id),
              {
                name: role.name,
                description: role.description,
                ...auditFields(me, true),
              },
              { merge: true },
            ),
          );
        }
      }
      for (const title of SEED_TITLES) {
        const id = `${title.level}-${title.name}`;
        if (!titleIds.has(id)) {
          ops.push((b) =>
            b.set(
              doc(db, "titles", id),
              {
                name: title.name,
                level: title.level,
                permissions: emptyPermissions(),
                ...auditFields(me, true),
              },
              { merge: true },
            ),
          );
        }
      }
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
      // v1.21：先補種子（新角色／職稱／群組，不存在才建立），再載入清單
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
    if (tab === "users" && isAdmin) {
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
    setUnitForm({ code: row.code, name: row.name, groupId: row.groupId });
    setUnitError("");
    setUnitView({ kind: "edit", code });
  }

  async function handleUnitSave() {
    const view = unitView;
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
    setUnitError("");
    setUnitSaving(true);
    try {
      const db = getFirebaseDb();
      const payload = {
        name: unitForm.name.trim(),
        groupId: unitForm.groupId,
        ...auditFields(user.staffId, false),
      };
      if (view.kind === "create") {
        const code = unitForm.code.trim();
        const ref = doc(db, "units", code);
        const exists = await getDoc(ref);
        if (exists.exists()) {
          setUnitError(`單位代號 ${code} 已存在`);
          setUnitSaving(false);
          return;
        }
        await setDoc(ref, {
          ...payload,
          ...auditFields(user.staffId, true),
        });
        onAction(`已新增單位 ${code}`);
      } else if (view.kind === "edit") {
        await updateDoc(doc(db, "units", view.code), payload);
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
      level: row.level === "群組" ? "群組" : "單位",
    });
    setTitleError("");
    setTitleView({ kind: "edit", id });
  }

  function titleKey(name: string, level: string) {
    return `${level}-${name}`;
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
    if (
      titles.some(
        (t) =>
          t.name === name &&
          t.level === titleForm.level &&
          (view.kind !== "edit" || t.id !== view.id),
      )
    ) {
      setTitleError(`職稱「${name}（${titleForm.level}）」已存在`);
      return;
    }
    setTitleError("");
    setTitleSaving(true);
    try {
      const db = getFirebaseDb();
      if (view.kind === "create") {
        await setDoc(doc(db, "titles", titleKey(name, titleForm.level)), {
          name,
          level: titleForm.level,
          permissions: emptyPermissions(),
          ...auditFields(user.staffId, true),
        });
        onAction(`已新增職稱 ${name}（${titleForm.level}）`);
      } else if (view.kind === "edit") {
        // 名稱或層級變更 → 換文件 ID（舊文件刪除）；權限一併搬移
        const old = titles.find((t) => t.id === view.id);
        const newId = titleKey(name, titleForm.level);
        if (old && old.id !== newId) {
          await setDoc(doc(db, "titles", newId), {
            name,
            level: titleForm.level,
            permissions: { ...old.permissions },
            ...auditFields(user.staffId, true),
          });
          await deleteDoc(doc(db, "titles", old.id));
        } else {
          await updateDoc(doc(db, "titles", view.id), {
            name,
            level: titleForm.level,
            ...auditFields(user.staffId, false),
          });
        }
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
      const usedSnap = await getDocs(
        query(collection(db, "users"), where("title", "==", row.name), limit(1)),
      );
      if (!usedSnap.empty) {
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
      await deleteDoc(doc(getFirebaseDb(), "titles", row.id));
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
      hireDate: "",
      email: "",
      phone: "",
      // v1.21：群組角色走 memberships 配對列；非群組角色另列勾選
      memberships: row.memberships.map((m) => ({
        groupId: m.groupId,
        roles: [...m.roles],
      })),
      otherRoles: row.roles.filter((r) => !isGroupScopedRole(r)),
      mustChangePassword: true,
      districtGroupIds: [],
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
    setUserError("");
    setUserSaving(true);
    try {
      const db = getFirebaseDb();
      // v1.21：memberships 為主；同步更新 groupIds（衍生）與 roles（聯集＋非群組角色）
      const memberships = userForm.memberships.filter((m) => m.groupId);
      const roles = [
        ...new Set([...deriveRoles(memberships), ...userForm.otherRoles]),
      ];
      const payload = {
        name: userForm.name.trim(),
        unitCode: userForm.unitCode,
        title: userForm.title,
        hireDate: userForm.hireDate,
        email: userForm.email.trim(),
        phone: userForm.phone.trim(),
        memberships,
        groupIds: deriveGroupIds(memberships),
        roles,
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
        await setDoc(ref, {
          ...payload,
          mustChangePassword: userForm.mustChangePassword,
          ...auditFields(user.staffId, true),
        });
        onAction(
          `已新增人員 ${staffId}。請再到 Firebase Console → Authentication 新增使用者，email 格式為 ${staffId}@nurseboard.internal`,
        );
      } else if (view.kind === "edit") {
        await updateDoc(doc(db, "users", view.staffId), payload);
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
      await updateDoc(doc(getFirebaseDb(), "users", row.staffId), {
        status: next,
        ...auditFields(user.staffId, false),
      });
      onAction(`人員 ${row.staffId} 已設為${next}`);
      await loadUsers();
    } catch (error) {
      onAction(`狀態變更失敗：${toErrorMessage(error)}`);
    }
  }

  // ================= 角色成員（v1.21） =================

  /** 從人員的 roles／memberships 移除指定角色（角色刪除／成員移除共用） */
  function removeRoleFromUser(row: UserRow, roleName: string) {
    return (b: WriteBatch) => {
      const memberships = row.memberships
        .map((m) => ({ ...m, roles: m.roles.filter((r) => r !== roleName) }))
        .filter((m) => m.roles.length > 0);
      b.update(doc(getFirebaseDb(), "users", row.staffId), {
        roles: row.roles.filter((r) => r !== roleName),
        memberships,
        groupIds: deriveGroupIds(memberships),
        ...auditFields(user?.staffId ?? "", false),
      });
    };
  }

  /** 將角色加入人員（群組範圍角色需指定群組；單位級以其單位所屬群組計） */
  function addRoleToUser(row: UserRow, roleName: string, groupId: string) {
    return (b: WriteBatch) => {
      const roles = [...new Set([...row.roles, roleName])];
      let memberships = row.memberships;
      if (isGroupScopedRole(roleName)) {
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
      b.update(doc(getFirebaseDb(), "users", row.staffId), {
        roles,
        memberships,
        groupIds: deriveGroupIds(memberships),
        ...auditFields(user?.staffId ?? "", false),
      });
    };
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
    } catch (error) {
      onAction(`移除失敗：${toErrorMessage(error)}`);
    } finally {
      setRoleBusy(false);
    }
  }

  async function handleRoleMembersAdd() {
    const role = roleRows.find((r) => r.id === managingRoleId);
    if (!role || roleAddChecked.length === 0) return;
    const groupScoped = isGroupScopedRole(role.name);
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
        gid = roleAddGroupId;
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
      const targets = users.filter((u) => u.roles.includes(row.name));
      await commitInBatches(
        targets.map((u) => removeRoleFromUser(u, row.name)),
      );
      await deleteDoc(doc(getFirebaseDb(), "roles", row.id));
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
    if (!name) {
      setRoleCreateError("請輸入角色名稱");
      return;
    }
    if (roleRows.some((role) => role.name === name)) {
      setRoleCreateError(`角色「${name}」已存在`);
      return;
    }
    setRoleCreateSaving(true);
    setRoleCreateError("");
    try {
      await setDoc(doc(collection(getFirebaseDb(), "roles")), {
        name,
        description: "",
        permissions: emptyPermissions(),
        ...auditFields(user?.staffId ?? "", true),
      });
      setNewRoleName("");
      setRoleCreateOpen(false);
      await loadRoles();
      onAction(`已新增角色「${name}」；請至系統管理設定其權限`);
    } catch (error) {
      setRoleCreateError(`新增失敗：${toErrorMessage(error)}`);
    } finally {
      setRoleCreateSaving(false);
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
      await commitInBatches(
        unitMemberChecked.map(
          (staffId) => (b: WriteBatch) =>
            b.update(doc(getFirebaseDb(), "users", staffId), {
              unitCode: "",
              ...auditFields(me, false),
            }),
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
    setUnitBusy(true);
    try {
      await updateDoc(doc(getFirebaseDb(), "users", staffId), {
        unitCode: managingUnitCode,
        ...auditFields(user?.staffId ?? "", false),
      });
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
    if (!managingTitleName || titleMemberChecked.length === 0) return;
    const ok = window.confirm(
      `確定將 ${titleMemberChecked.length} 位人員移出職稱「${managingTitleName}」？`,
    );
    if (!ok) return;
    setTitleBusy(true);
    try {
      const me = user?.staffId ?? "";
      await commitInBatches(
        titleMemberChecked.map(
          (staffId) => (b: WriteBatch) =>
            b.update(doc(getFirebaseDb(), "users", staffId), {
              title: "",
              ...auditFields(me, false),
            }),
        ),
      );
      onAction(
        `已將 ${titleMemberChecked.length} 位人員移出職稱「${managingTitleName}」`,
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
    if (!managingTitleName) return;
    setTitleBusy(true);
    try {
      await updateDoc(doc(getFirebaseDb(), "users", staffId), {
        title: managingTitleName,
        ...auditFields(user?.staffId ?? "", false),
      });
      onAction(`已將 ${staffId} 轉任「${managingTitleName}」`);
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
    const existing = new Set(roleRows.map((role) => role.name));
    const seen = new Set<string>();
    return Promise.resolve(
      rows.map((row, i) => {
        const name = (row[0] ?? "").trim();
        let error = "";
        if (!name) error = "角色名稱不可空白";
        else if (existing.has(name)) error = `「${name}」已存在`;
        else if (seen.has(name)) error = `檔案內重複：${name}`;
        seen.add(name);
        return { index: i + 1, values: row, ok: !error, error };
      }),
    );
  }

  async function importRoleRows(rows: PreviewRow[]): Promise<void> {
    const me = user?.staffId ?? "";
    await commitInBatches(
      rows.map((row) => (batch: WriteBatch) =>
        batch.set(doc(collection(getFirebaseDb(), "roles")), {
          name: row.values[0].trim(),
          description: "",
          permissions: emptyPermissions(),
          ...auditFields(me, true),
        }),
      ),
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
    const existing = new Set(titles.map((t) => titleKey(t.name, t.level)));
    const seen = new Set<string>();
    return Promise.resolve(
      rows.map((r, i) => {
        const index = i + 1;
        const name = (r[0] ?? "").trim();
        const level = (r[1] ?? "").trim();
        if (!name) return { index, values: r, ok: false, error: "職稱名稱不可空白" };
        if (level !== "群組" && level !== "單位")
          return { index, values: r, ok: false, error: "層級限填「群組」或「單位」" };
        const key = titleKey(name, level);
        if (existing.has(key))
          return { index, values: r, ok: false, error: `「${name}（${level}）」已存在` };
        if (seen.has(key))
          return { index, values: r, ok: false, error: `檔案內重複：${name}（${level}）` };
        seen.add(key);
        return { index, values: r, ok: true, error: "" };
      }),
    );
  }

  async function importTitleRows(rows: PreviewRow[]): Promise<void> {
    const me = user?.staffId ?? "";
    await commitInBatches(
      rows.map((r) => {
        const name = r.values[0].trim();
        const level = r.values[1].trim();
        return (b: WriteBatch) =>
          b.set(doc(getFirebaseDb(), "titles", titleKey(name, level)), {
            name,
            level,
            ...auditFields(me, true),
          });
      }),
    );
  }

  /** 人員匯入驗證（v1.21：舊資料匯入，未填忽略；職編已存在→更新） */
  function validateUserRows(rows: string[][]): Promise<PreviewRow[]> {
    const groupByName = new Map(groups.map((g) => [g.name, g.id]));
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
    const results = validateUserRowsLib(data, {
      existingStaffIds: new Set(users.map((u) => u.staffId)),
      groupByName,
      roleNames: new Set(roleOptions.map((r) => r.name)),
      titleNames: new Set(titles.map((t) => t.name)),
      unitCodes: new Set(units.map((u) => u.code)),
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

  async function importUserRows(rows: PreviewRow[]): Promise<string> {
    const me = user?.staffId ?? "";
    const groupByName = new Map(groups.map((g) => [g.name, g.id]));
    const { data } = parseUserSheet([
      USER_HEADER,
      ...rows.map((r) => r.values),
    ]);
    const results = validateUserRowsLib(data, {
      existingStaffIds: new Set(users.map((u) => u.staffId)),
      groupByName,
      roleNames: new Set(roleOptions.map((r) => r.name)),
      titleNames: new Set(titles.map((t) => t.name)),
      unitCodes: new Set(units.map((u) => u.code)),
    });
    let created = 0;
    let updated = 0;
    const ops = results
      .filter((r) => r.ok && r.values)
      .map((r) => {
        const v = r.values!;
        if (r.action === "update") updated += 1;
        else created += 1;
        const ref = doc(getFirebaseDb(), "users", v.staffId);
        if (r.action === "update") {
          const patch: Record<string, any> = {
            ...auditFields(me, false),
          };
          if (v.name !== null) patch.name = v.name;
          if (v.unitCode !== null) patch.unitCode = v.unitCode;
          if (v.title !== null) patch.title = v.title;
          if (v.memberships !== null) {
            // 更新 memberships 時保留既有非群組角色（匯入檔不含此欄）
            const existing = users.find((u) => u.staffId === v.staffId);
            const keep = (existing?.roles ?? []).filter(
              (x) => !isGroupScopedRole(x),
            );
            patch.memberships = v.memberships;
            patch.groupIds = deriveGroupIds(v.memberships);
            patch.roles = [
              ...new Set([...deriveRoles(v.memberships), ...keep]),
            ];
          }
          return (b: WriteBatch) => b.update(ref, patch);
        }
        return (b: WriteBatch) =>
          b.set(ref, {
            name: v.name ?? "",
            unitCode: v.unitCode ?? "",
            title: v.title ?? "",
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
      });
    await commitInBatches(ops);
    return `人員匯入完成：新增 ${created} 筆、更新 ${updated} 筆`;
  }

  // ================= 版面 =================

  const isGroupEditing = groupView.kind === "edit";
  const isUnitEditing = unitView.kind === "edit";
  const isTitleEditing = titleView.kind === "edit";
  const isUserEditing = userView.kind === "edit";

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
      return canManageMaster ? (
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
              description="使用右上角「新增職稱」或「批次上傳」建立職稱；或到「系統管理」執行系統初始化載入預設職稱。"
            />
          ) : (
            <section className="panel data-panel">
              <div className="table-scroll">
                <table className="permission-table">
                  <thead>
                    <tr>
                      <SortHeader label="職稱名稱" sortKey="title-name" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
                      <SortHeader label="層級" sortKey="title-level" activeKey={sortState.key} direction={sortState.dir} onSort={toggleListSort} />
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
                                  setManagingTitleName(
                                    managingTitleName === row.name
                                      ? ""
                                      : row.name,
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
              {managingTitleName && isAdmin && (
                <div style={{ marginTop: 12 }}>
                  <MemberChecklist
                    title={`職稱「${managingTitleName}」的成員`}
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
                      onClick={() => setManagingTitleName("")}
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
              note="同層級下職稱名稱不可重複"
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
                <label className="field-label">層級 *</label>
                <div className="select-wrap">
                  <select
                    value={titleForm.level}
                    onChange={(e) =>
                      setTitleForm((prev) => ({
                        ...prev,
                        level: e.target.value === "群組" ? "群組" : "單位",
                      }))
                    }
                  >
                    <option value="群組">群組（召集人／執行幹事／組長）</option>
                    <option value="單位">單位（主任／督導／護理長…）</option>
                  </select>
                  <ChevronDown size={15} />
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
                  onChange={(e) =>
                    setUserForm((prev) => ({ ...prev, unitCode: e.target.value }))
                  }
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
              <label className="field-label">職稱</label>
              <div className="select-wrap">
                <select
                  value={userForm.title}
                  onChange={(e) =>
                    setUserForm((prev) => ({ ...prev, title: e.target.value }))
                  }
                >
                  <option value="">— 未指定 —</option>
                  {titles.map((t) => (
                    <option key={t.id} value={t.name}>
                      {t.name}（{t.level}）
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
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
            note="可重複新增配對列：一人可屬多群組，各群組角色可不同；權限取聯集"
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
                    onChange={(e) =>
                      updateMembershipRow(i, { groupId: e.target.value })
                    }
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
                  .filter((r) => isGroupScopedRole(r.name))
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

          <SectionTitle title="其他角色" note="不屬特定群組的角色（權限取聯集）" />
          {roleOptions.length === 0 ? (
            <p className="settings-note">
              尚未載入角色清單（請先到「系統管理」執行系統初始化）。
            </p>
          ) : (
            <div className="form-grid">
              {roleOptions
                .filter((r) => !isGroupScopedRole(r.name))
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
        !canManageMaster ? (
          <section className="panel">
            <div className="empty-state-block">
              <b>僅品管執行幹事或系統管理員可管理角色</b>
              <p>如需新增或異動角色成員，請聯絡系統管理員。</p>
            </div>
          </section>
        ) : roleCreateOpen ? (
          <section className="panel data-panel indicator-form">
            <SectionTitle title="新增角色" note="新角色預設無功能權限，建立後請至系統管理設定權限" />
            {roleCreateError && <div className="login-error">{roleCreateError}</div>}
            <div className="form-field" style={{ maxWidth: 420 }}>
              <label className="field-label">角色名稱 *</label>
              <input
                className="text-input"
                value={newRoleName}
                placeholder="輸入角色名稱"
                onChange={(event) => setNewRoleName(event.target.value)}
              />
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
            {isGroupScopedRole(managingRole.name) &&
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
            description="角色清單載入中，或請到「系統管理」執行系統初始化載入預設角色。"
          />
        ) : (
          <section className="panel data-panel">
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
                  {sortedRows(roleRows, sortState.key, (row, key) => key === "role-count" ? (row.memberCount ?? -1) : row.name).map((row) => (
                    <tr key={row.id}>
                      <td>
                        <b>{row.name}</b>
                      </td>
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
              新角色（品管組／單位級）於開頁時自動建立（不存在才建立，限系統管理員）；舊角色亦可在此刪除（會同時從所有人員移除該角色）。成員管理與刪除限系統管理員（人員主檔寫入權限）。角色權限請到「系統管理」的角色權限矩陣設定。
            </p>
          </section>
        )
      ) : null}
    </>
  );
}
