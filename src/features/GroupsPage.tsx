import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
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
import { SYSTEM_ROLE_NAMES } from "../lib/seed";
import { downloadCSV, parseCSV } from "../lib/csv";
import { reviewerDocId } from "../lib/scheduling";

type Tab = "groups" | "units" | "titles" | "users" | "reviewers";

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
}

interface UserRow {
  staffId: string;
  name: string;
  unitCode: string;
  title: string;
  roles: string[];
  status: string;
}

interface OptionItem {
  id: string;
  name: string;
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
  roles: string[];
  mustChangePassword: boolean;
}

interface PreviewRow {
  index: number;
  values: string[];
  ok: boolean;
  error: string;
}

interface ReviewerRow {
  personId: string;
  name: string;
  unitCode: string;
  groupId: string;
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
    roles: [],
    mustChangePassword: true,
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

/** 系統角色以 、；，, 分隔 */
function splitRoles(raw: string): string[] {
  const parts = raw
    .split(/[、;；,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(parts)];
}

// ================= 範例檔 =================

const GROUP_SAMPLE: string[][] = [["群組名稱"], ["病房組"], ["加護組"]];
const GROUP_HEADER = ["群組名稱"];

const UNIT_SAMPLE: string[][] = [
  ["單位代號", "單位名稱", "所屬群組"],
  ["9A", "9A病房", "病房組"],
  ["9B", "9B病房", "病房組"],
];
const UNIT_HEADER = ["單位代號", "單位名稱", "所屬群組"];

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

const USER_SAMPLE: string[][] = [
  ["職編", "姓名", "單位代號", "職稱", "系統角色"],
  ["A12345", "王小明", "9A", "護理師", "審查員"],
  ["B67890", "陳大華", "9A", "護理長", "護理長"],
];
const USER_HEADER = ["職編", "姓名", "單位代號", "職稱", "系統角色"];

// ================= 批次上傳共用元件 =================

function BatchImporter({
  sampleFilename,
  sampleRows,
  header,
  validateRows,
  importRows,
  postImportNote,
  onDone,
  onAction,
}: {
  sampleFilename: string;
  sampleRows: string[][];
  header: string[];
  validateRows: (rows: string[][]) => Promise<PreviewRow[]>;
  importRows: (rows: PreviewRow[]) => Promise<void>;
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
      const rows = parseCSV(await f.text());
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
      await importRows(valid);
      const skipped = preview.length - valid.length;
      const message = `匯入完成：成功 ${valid.length} 筆${skipped > 0 ? `，跳過 ${skipped} 筆（資料有誤）` : ""}`;
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
        onClick={() => downloadCSV(sampleFilename, sampleRows)}
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
        accept=".csv,text/csv"
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

  const [tab, setTab] = useState<Tab>("groups");

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

  // ---- 審查員（v1.8.0：依指標分類組別分組） ----
  const [reviewerGroupId, setReviewerGroupId] = useState("");
  const [reviewers, setReviewers] = useState<ReviewerRow[]>([]);
  const [reviewersLoading, setReviewersLoading] = useState(false);
  const [reviewerSearch, setReviewerSearch] = useState("");
  const [reviewerSaving, setReviewerSaving] = useState(false);

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
          return {
            staffId: d.id,
            name: typeof data.name === "string" ? data.name : "",
            unitCode: typeof data.unitCode === "string" ? data.unitCode : "",
            title: typeof data.title === "string" ? data.title : "",
            roles: Array.isArray(data.roles) ? data.roles.map(String) : [],
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

  useEffect(() => {
    loadMaster();
    loadRoles();
    loadTitles();
  }, [loadMaster, loadRoles, loadTitles]);

  useEffect(() => {
    if (tab === "users" && isAdmin) {
      loadUsers();
    }
  }, [tab, isAdmin, loadUsers]);

  /** 審查員（v1.8.0）：讀取 reviewReviewers，並以 users 主檔補姓名/單位 */
  const loadReviewers = useCallback(async () => {
    setReviewersLoading(true);
    try {
      const db = getFirebaseDb();
      const snap = await getDocs(collection(db, "reviewReviewers"));
      const userMap = new Map(users.map((u) => [u.staffId, u]));
      const list: ReviewerRow[] = snap.docs
        .map((d) => {
          const data = d.data();
          const personId =
            typeof data.personId === "string" ? data.personId : d.id;
          const u = userMap.get(personId);
          return {
            personId,
            name: u?.name ?? "",
            unitCode: u?.unitCode ?? "",
            groupId: typeof data.groupId === "string" ? data.groupId : "",
          };
        })
        .filter((r) => !reviewerGroupId || r.groupId === reviewerGroupId)
        .sort((a, b) => a.personId.localeCompare(b.personId, "zh-Hant"));
      setReviewers(list);
    } catch (error) {
      onAction(`讀取審查員清單失敗：${toErrorMessage(error)}`);
    } finally {
      setReviewersLoading(false);
    }
  }, [onAction, users, reviewerGroupId]);

  useEffect(() => {
    if (tab === "reviewers") {
      if (canManageMaster && users.length === 0) loadUsers();
      loadReviewers();
    }
  }, [tab, canManageMaster, users.length, loadUsers, loadReviewers]);

  async function handleReviewerAdd(personId: string) {
    if (!reviewerGroupId) {
      onAction("請先選擇組別");
      return;
    }
    setReviewerSaving(true);
    try {
      const db = getFirebaseDb();
      await setDoc(
        doc(db, "reviewReviewers", reviewerDocId(reviewerGroupId, personId)),
        { groupId: reviewerGroupId, personId, createdAt: serverTimestamp() },
      );
      setReviewerSearch("");
      onAction(`已將 ${personId} 加入審查員`);
      loadReviewers();
    } catch (error) {
      onAction(`加入審查員失敗：${toErrorMessage(error)}`);
    } finally {
      setReviewerSaving(false);
    }
  }

  async function handleReviewerRemove(personId: string) {
    const ok = window.confirm(`確定將 ${personId} 移出審查員名單？`);
    if (!ok) return;
    try {
      const db = getFirebaseDb();
      await deleteDoc(
        doc(db, "reviewReviewers", reviewerDocId(reviewerGroupId, personId)),
      );
      onAction(`已將 ${personId} 移出審查員名單`);
      loadReviewers();
    } catch (error) {
      onAction(`移除審查員失敗：${toErrorMessage(error)}`);
    }
  }

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
          ...auditFields(user.staffId, true),
        });
        onAction(`已新增職稱 ${name}（${titleForm.level}）`);
      } else if (view.kind === "edit") {
        // 名稱或層級變更 → 換文件 ID（舊文件刪除）
        const old = titles.find((t) => t.id === view.id);
        const newId = titleKey(name, titleForm.level);
        if (old && old.id !== newId) {
          await setDoc(doc(db, "titles", newId), {
            name,
            level: titleForm.level,
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
      roles: [...row.roles],
      mustChangePassword: true,
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
          }));
        }
      } catch {
        // 讀不到細節欄位不阻擋編輯
      }
    })();
    setUserView({ kind: "edit", staffId });
  }

  function toggleRole(roleName: string) {
    setUserForm((prev) => ({
      ...prev,
      roles: prev.roles.includes(roleName)
        ? prev.roles.filter((r) => r !== roleName)
        : [...prev.roles, roleName],
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
      const payload = {
        name: userForm.name.trim(),
        unitCode: userForm.unitCode,
        title: userForm.title,
        hireDate: userForm.hireDate,
        email: userForm.email.trim(),
        phone: userForm.phone.trim(),
        roles: userForm.roles,
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

  function validateUnitRows(rows: string[][]): Promise<PreviewRow[]> {
    const existing = new Set(units.map((u) => u.code));
    const seen = new Set<string>();
    const groupNameToId = new Map(groups.map((g) => [g.name, g.id]));
    return Promise.resolve(
      rows.map((r, i) => {
        const index = i + 1;
        const code = (r[0] ?? "").trim();
        const name = (r[1] ?? "").trim();
        const groupName = (r[2] ?? "").trim();
        if (!code) return { index, values: r, ok: false, error: "單位代號不可空白" };
        if (!name) return { index, values: r, ok: false, error: "單位名稱不可空白" };
        if (existing.has(code))
          return { index, values: r, ok: false, error: `單位代號 ${code} 已存在` };
        if (seen.has(code))
          return { index, values: r, ok: false, error: `檔案內重複：${code}` };
        if (groupName && !groupNameToId.has(groupName))
          return {
            index,
            values: r,
            ok: false,
            error: `群組「${groupName}」不存在，請先匯入群組`,
          };
        seen.add(code);
        return { index, values: r, ok: true, error: "" };
      }),
    );
  }

  async function importUnitRows(rows: PreviewRow[]): Promise<void> {
    const me = user?.staffId ?? "";
    const groupNameToId = new Map(groups.map((g) => [g.name, g.id]));
    await commitInBatches(
      rows.map((r) => {
        const code = r.values[0].trim();
        const name = r.values[1].trim();
        const groupName = (r.values[2] ?? "").trim();
        const groupId = groupName ? (groupNameToId.get(groupName) ?? "") : "";
        return (b: WriteBatch) =>
          b.set(doc(getFirebaseDb(), "units", code), {
            name,
            groupId,
            ...auditFields(me, true),
          });
      }),
    );
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

  function validateUserRows(rows: string[][]): Promise<PreviewRow[]> {
    const existing = new Set(users.map((u) => u.staffId));
    const seen = new Set<string>();
    const unitCodes = new Set(units.map((u) => u.code));
    const titleNames = new Set(titles.map((t) => t.name));
    return Promise.resolve(
      rows.map((r, i) => {
        const index = i + 1;
        const staffId = (r[0] ?? "").trim();
        const name = (r[1] ?? "").trim();
        const unitCode = (r[2] ?? "").trim();
        const title = (r[3] ?? "").trim();
        const roles = splitRoles(r[4] ?? "");
        if (!staffId)
          return { index, values: r, ok: false, error: "職編不可空白" };
        if (!name) return { index, values: r, ok: false, error: "姓名不可空白" };
        if (existing.has(staffId))
          return { index, values: r, ok: false, error: `職編 ${staffId} 已存在` };
        if (seen.has(staffId))
          return { index, values: r, ok: false, error: `檔案內重複：${staffId}` };
        if (unitCode && !unitCodes.has(unitCode))
          return {
            index,
            values: r,
            ok: false,
            error: `單位代號 ${unitCode} 不存在，請先匯入單位`,
          };
        if (title && !titleNames.has(title))
          return {
            index,
            values: r,
            ok: false,
            error: `職稱「${title}」不存在，請先在「職稱」頁籤新增或匯入`,
          };
        const unknown = roles.filter((x) => !SYSTEM_ROLE_NAMES.includes(x));
        if (unknown.length > 0)
          return {
            index,
            values: r,
            ok: false,
            error: `未知系統角色：${unknown.join("、")}（限：${SYSTEM_ROLE_NAMES.join("、")}）`,
          };
        seen.add(staffId);
        return { index, values: r, ok: true, error: "" };
      }),
    );
  }

  async function importUserRows(rows: PreviewRow[]): Promise<void> {
    const me = user?.staffId ?? "";
    await commitInBatches(
      rows.map((r) => {
        const staffId = r.values[0].trim();
        const roles = splitRoles(r.values[4] ?? "");
        return (b: WriteBatch) =>
          b.set(doc(getFirebaseDb(), "users", staffId), {
            name: r.values[1].trim(),
            unitCode: (r.values[2] ?? "").trim(),
            title: (r.values[3] ?? "").trim(),
            hireDate: "",
            email: "",
            phone: "",
            roles: roles.length > 0 ? roles : ["一般人員"],
            mustChangePassword: true,
            status: "在職",
            ...auditFields(me, true),
          });
      }),
    );
  }

  // ================= 版面 =================

  const isGroupEditing = groupView.kind === "edit";
  const isUnitEditing = unitView.kind === "edit";
  const isTitleEditing = titleView.kind === "edit";
  const isUserEditing = userView.kind === "edit";
  const unitNameOf = (code: string) =>
    units.find((u) => u.code === code)?.name ?? code;

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
    if (userView.kind === "list")
      return isAdmin ? (
        <button className="button button-primary" onClick={openUserCreate}>
          <Plus size={16} />
          新增人員
        </button>
      ) : undefined;
    return back(() => setUserView({ kind: "list" }));
  })();

  return (
    <>
      <PageHeading page="groups" action={headingAction} />

      <div className="tabs" style={{ marginBottom: 12 }}>
        <button
          className={`tab${tab === "groups" ? " active" : ""}`}
          onClick={() => setTab("groups")}
        >
          群組<span>{groups.length}</span>
        </button>
        <button
          className={`tab${tab === "units" ? " active" : ""}`}
          onClick={() => setTab("units")}
        >
          單位<span>{units.length}</span>
        </button>
        <button
          className={`tab${tab === "titles" ? " active" : ""}`}
          onClick={() => setTab("titles")}
        >
          職稱<span>{titles.length}</span>
        </button>
        <button
          className={`tab${tab === "users" ? " active" : ""}`}
          onClick={() => setTab("users")}
        >
          人員{isAdmin && <span>{users.length}</span>}
        </button>
        <button
          className={`tab${tab === "reviewers" ? " active" : ""}`}
          onClick={() => setTab("reviewers")}
        >
          審查員
        </button>
      </div>

      {/* 批次上傳工具列（僅清單檢視） */}
      {tab === "groups" && groupView.kind === "list" && canManageMaster && (
        <div className="batch-toolbar">
          <BatchImporter
            sampleFilename="群組範例.csv"
            sampleRows={GROUP_SAMPLE}
            header={GROUP_HEADER}
            validateRows={validateGroupRows}
            importRows={importGroupRows}
            onDone={loadMaster}
            onAction={onAction}
          />
        </div>
      )}
      {tab === "units" && unitView.kind === "list" && canManageMaster && (
        <div className="batch-toolbar">
          <BatchImporter
            sampleFilename="單位範例.csv"
            sampleRows={UNIT_SAMPLE}
            header={UNIT_HEADER}
            validateRows={validateUnitRows}
            importRows={importUnitRows}
            onDone={loadMaster}
            onAction={onAction}
          />
        </div>
      )}
      {tab === "titles" && titleView.kind === "list" && canManageMaster && (
        <div className="batch-toolbar">
          <BatchImporter
            sampleFilename="職稱範例.csv"
            sampleRows={TITLE_SAMPLE}
            header={TITLE_HEADER}
            validateRows={validateTitleRows}
            importRows={importTitleRows}
            onDone={loadTitles}
            onAction={onAction}
          />
        </div>
      )}
      {tab === "users" && userView.kind === "list" && isAdmin && (
        <div className="batch-toolbar">
          <BatchImporter
            sampleFilename="人員範例.csv"
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
                      <th>群組名稱</th>
                      <th>所屬單位數</th>
                      {canManageMaster && <th>操作</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((row) => (
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
                      <th>單位代號</th>
                      <th>單位名稱</th>
                      <th>所屬群組</th>
                      <th>所屬人員數</th>
                      {canManageMaster && <th>操作</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {units.map((row) => (
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
                      <th>職稱名稱</th>
                      <th>層級</th>
                      <th>使用人數</th>
                      {canManageMaster && <th>操作</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {titles.map((row) => (
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
                    <th>職編</th>
                    <th>姓名</th>
                    <th>單位</th>
                    <th>職稱</th>
                    <th>角色</th>
                    <th>狀態</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((row) => (
                    <tr key={row.staffId}>
                      <td>
                        <b>{row.staffId}</b>
                      </td>
                      <td>{maskName(row.name)}</td>
                      <td>
                        {row.unitCode
                          ? `${row.unitCode}${unitNameOf(row.unitCode) !== row.unitCode ? ` ${unitNameOf(row.unitCode)}` : ""}`
                          : "—"}
                      </td>
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
                      {u.code} {u.name}
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

          <SectionTitle title="角色" note="一人可兼任多角色，權限取聯集" />
          {roleOptions.length === 0 ? (
            <p className="settings-note">
              尚未載入角色清單（請先到「系統管理」執行系統初始化）。
            </p>
          ) : (
            <div className="form-grid">
              {roleOptions.map((r) => (
                <label className="check-row" key={r.id}>
                  <input
                    type="checkbox"
                    checked={userForm.roles.includes(r.name)}
                    onChange={() => toggleRole(r.name)}
                  />
                  <span>{r.name}</span>
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
      ) : tab === "reviewers" ? (
        <section className="panel">
          <SectionTitle
            title="審查員"
            note="依指標分類組別設定審查員名單，供「指標排程」的單位／審查員設定選用"
          />
          <div className="form-field" style={{ maxWidth: 320 }}>
            <label className="field-label">組別</label>
            <div className="select-wrap">
              <select
                value={reviewerGroupId}
                onChange={(e) => setReviewerGroupId(e.target.value)}
              >
                <option value="">請選擇組別</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} />
            </div>
          </div>

          {!reviewerGroupId ? (
            <p className="settings-note">請先選擇組別。</p>
          ) : reviewersLoading ? (
            <p className="settings-note">讀取中…</p>
          ) : (
            <>
              {reviewers.length === 0 ? (
                <p className="settings-note">
                  此組別尚無審查員
                  {canManageMaster ? "，請由下方加入。" : "。"}
                </p>
              ) : (
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>職編</th>
                        <th>姓名</th>
                        <th>所屬單位</th>
                        {canManageMaster && <th>操作</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {reviewers.map((r) => (
                        <tr key={r.personId}>
                          <td>{r.personId}</td>
                          <td>{r.name ? maskName(r.name) : "—"}</td>
                          <td>{r.unitCode || "—"}</td>
                          {canManageMaster && (
                            <td>
                              <button
                                className="text-button"
                                onClick={() => handleReviewerRemove(r.personId)}
                              >
                                <Trash2 size={13} /> 移除
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {canManageMaster && (
                <>
                  <SectionTitle
                    title="加入審查員"
                    note="從在職人員中搜尋（職編／姓名）"
                  />
                  <div className="form-field" style={{ maxWidth: 320 }}>
                    <input
                      className="text-input"
                      placeholder="輸入職編或姓名搜尋"
                      value={reviewerSearch}
                      onChange={(e) => setReviewerSearch(e.target.value)}
                    />
                  </div>
                  {reviewerSearch.trim() === "" ? (
                    <p className="settings-note">
                      輸入關鍵字後，從下方結果加入。
                    </p>
                  ) : (
                    (() => {
                      const kw = reviewerSearch.trim().toLowerCase();
                      const existed = new Set(
                        reviewers.map((r) => r.personId),
                      );
                      const hits = users
                        .filter(
                          (u) =>
                            u.status === "在職" &&
                            !existed.has(u.staffId) &&
                            (u.staffId.toLowerCase().includes(kw) ||
                              u.name.toLowerCase().includes(kw)),
                        )
                        .slice(0, 20);
                      return hits.length === 0 ? (
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
                              {hits.map((u) => (
                                <tr key={u.staffId}>
                                  <td>{u.staffId}</td>
                                  <td>{maskName(u.name)}</td>
                                  <td>{u.unitCode || "—"}</td>
                                  <td>
                                    <button
                                      className="text-button"
                                      disabled={reviewerSaving}
                                      onClick={() =>
                                        handleReviewerAdd(u.staffId)
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
                      );
                    })()
                  )}
                </>
              )}
            </>
          )}
        </section>
      ) : null}
    </>
  );
}
