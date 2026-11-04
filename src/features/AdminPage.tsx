import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  Pencil,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "../lib/db";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { getFirebaseDb } from "../lib/firebase";
import { isDemoMode } from "../lib/demoMode";
import { useAuth } from "../lib/auth";
import { applyTheme } from "../lib/uiPrefs";
import { maskName } from "../lib/mask";
import { filterAuditRows } from "../lib/audit";
import {
  DEFAULT_SYSTEM_PARAMS,
  SEED_ROLES,
  SYSTEM_PARAM_LABELS,
  UI_THEMES,
  runSystemSeed,
  themeName,
  type SystemParams,
} from "../lib/seed";
import {
  PERM_KEYS,
  PERM_LABELS,
  emptyPermissions,
  parsePermissions,
  type PermKey,
} from "../lib/permissions";
import { usePermissions } from "../lib/usePermissions";

function formatParamValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return "—";
}

type ParamKind = "number" | "boolean" | "string";
function paramKindOf(key: keyof SystemParams): ParamKind {
  const v = DEFAULT_SYSTEM_PARAMS[key];
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  return "string";
}

function SystemInitSection({
  onAction,
  canManageRoles,
}: {
  onAction: (message: string) => void;
  canManageRoles: boolean;
}) {
  const { user } = useAuth();
  const [params, setParams] = useState<SystemParams | null | undefined>(undefined);
  const [seeding, setSeeding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getDoc(doc(getFirebaseDb(), "systemParams", "config"))
      .then((snap) => {
        if (!cancelled) setParams(snap.exists() ? (snap.data() as SystemParams) : null);
      })
      .catch(() => {
        if (!cancelled) setParams(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSeed() {
    if (!user || seeding) return;
    setSeeding(true);
    try {
      await runSystemSeed(getFirebaseDb(), user.staffId);
      const snap = await getDoc(doc(getFirebaseDb(), "systemParams", "config"));
      setParams(snap.exists() ? (snap.data() as SystemParams) : null);
      onAction("系統初始化完成：已寫入預設參數與 7 個角色");
    } catch {
      onAction("初始化失敗：權限不足或網路異常，請稍後再試");
    } finally {
      setSeeding(false);
    }
  }

  async function handleThemeChange(themeId: string) {
    if (!user) return;
    try {
      await updateDoc(doc(getFirebaseDb(), "systemParams", "config"), {
        uiTheme: themeId,
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      });
      setParams((prev) => (prev ? { ...prev, uiTheme: themeId } : prev));
      applyTheme(themeId);
      onAction(`主題配色已切換為「${themeName(themeId)}」（全院統一）`);
    } catch {
      onAction("主題切換失敗：權限不足或網路異常");
    }
  }

  function startEdit() {
    if (!params) return;
    const d: Record<string, string | boolean> = {};
    (Object.keys(SYSTEM_PARAM_LABELS) as (keyof SystemParams)[]).forEach(
      (key) => {
        if (key === "uiTheme") return;
        const v = params[key];
        d[key] = typeof v === "boolean" ? v : String(v ?? "");
      },
    );
    setDraft(d);
    setEditing(true);
  }

  async function handleSaveParams() {
    if (!user || !params || saving) return;
    setSaving(true);
    try {
      const updates: Record<string, unknown> = {};
      (Object.keys(draft) as (keyof SystemParams)[]).forEach((key) => {
        const cur = params[key];
        const d = draft[key as string];
        if (typeof cur === "number") {
          const n = Number(d);
          updates[key] = Number.isFinite(n) ? n : cur;
        } else if (typeof cur === "boolean") {
          updates[key] = d === true;
        } else {
          updates[key] = String(d ?? "");
        }
      });
      updates.updatedAt = serverTimestamp();
      updates.updatedBy = user.staffId;
      await updateDoc(doc(getFirebaseDb(), "systemParams", "config"), updates);
      const snap = await getDoc(doc(getFirebaseDb(), "systemParams", "config"));
      setParams(snap.exists() ? (snap.data() as SystemParams) : params);
      setEditing(false);
      onAction("系統參數已更新");
    } catch {
      onAction("參數儲存失敗：權限不足或網路異常");
    } finally {
      setSaving(false);
    }
  }

  const editableKeys = (Object.keys(SYSTEM_PARAM_LABELS) as (keyof SystemParams)[]).filter(
    (k) => k !== "uiTheme",
  );

  return (
    <section className="panel" id="system-init">
      <SectionTitle
        title="系統初始化"
        note={
          isDemoMode()
            ? "展示模式：系統參數、角色、職稱與展示資料已預載"
            : "首次啟用時寫入預設參數與角色"
        }
        action={
          params && canManageRoles && !editing ? (
            <button className="text-button" onClick={startEdit}>
              <Pencil size={13} /> 編輯參數
            </button>
          ) : undefined
        }
      />
      {params === undefined ? (
        <p className="settings-note">讀取中…</p>
      ) : params === null ? (
        canManageRoles ? (
          <div>
            <p className="settings-note">
              尚未初始化。將寫入 systemParams/config 預設參數（RAG
              黃燈區間、補審期限、草稿保留天數等）與 7 個預設角色定義。
            </p>
            <button
              className="button button-primary"
              disabled={seeding}
              onClick={handleSeed}
            >
              <Database size={15} />
              {seeding ? "寫入中…" : "一鍵初始化系統參數與角色"}
            </button>
          </div>
        ) : (
          <p className="settings-note">
            系統尚未初始化，請聯絡系統管理員執行初始化。
          </p>
        )
      ) : editing ? (
        <>
          <div className="form-grid">
            {editableKeys.map((key) => {
              const kind = paramKindOf(key);
              const val = draft[key as string];
              return (
                <div className="form-field" key={key}>
                  <label className="field-label">
                    {SYSTEM_PARAM_LABELS[key]}
                  </label>
                  {kind === "boolean" ? (
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={val === true}
                        onChange={(e) =>
                          setDraft((p) => ({ ...p, [key]: e.target.checked }))
                        }
                      />
                      <span>開啟</span>
                    </label>
                  ) : (
                    <input
                      className="text-input"
                      type={kind === "number" ? "number" : "text"}
                      value={typeof val === "string" ? val : ""}
                      onChange={(e) =>
                        setDraft((p) => ({ ...p, [key]: e.target.value }))
                      }
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div className="form-actions">
            <button
              className="button button-primary"
              disabled={saving}
              onClick={handleSaveParams}
            >
              {saving ? "儲存中…" : "儲存參數"}
            </button>
            <button
              className="button button-outline"
              onClick={() => setEditing(false)}
            >
              取消
            </button>
          </div>
        </>
      ) : (
        <dl className="param-list">
          {(Object.keys(SYSTEM_PARAM_LABELS) as (keyof SystemParams)[]).map(
            (key) =>
              key === "uiTheme" ? (
                <div key={key} className="param-row">
                  <dt>{SYSTEM_PARAM_LABELS[key]}</dt>
                  <dd>
                    {canManageRoles ? (
                      <div className="select-wrap">
                        <select
                          value={params.uiTheme || "green-2"}
                          onChange={(e) => void handleThemeChange(e.target.value)}
                          aria-label="主題配色"
                        >
                          {UI_THEMES.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                        <ChevronDown size={15} />
                      </div>
                    ) : (
                      themeName(params.uiTheme || "green-2")
                    )}
                  </dd>
                </div>
              ) : (
                <div key={key} className="param-row">
                  <dt>{SYSTEM_PARAM_LABELS[key]}</dt>
                  <dd>{formatParamValue(params[key])}</dd>
                </div>
              ),
          )}
        </dl>
      )}
    </section>
  );
}

/* ================= 角色與權限 ================= */

interface RoleRow {
  id: string;
  name: string;
  description: string;
  permissions: Record<PermKey, boolean>;
  isSeed: boolean;
}

interface TitleRow {
  id: string;
  name: string;
  level: string;
  permissions: Record<PermKey, boolean>;
  /** 該職稱是否曾儲存過權限矩陣（titles 文件有 permissions 欄位） */
  permConfigured: boolean;
}

function permCell(perms: Record<PermKey, boolean>, key: PermKey): boolean {
  return perms[key] === true;
}

function RolePermissionSection({ onAction }: { onAction: (message: string) => void }) {
  const { user } = useAuth();
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [titles, setTitles] = useState<TitleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const loadAll = async () => {
    setLoading(true);
    try {
      const db = getFirebaseDb();
      const [rsnap, tsnap] = await Promise.all([
        getDocs(collection(db, "roles")),
        getDocs(collection(db, "titles")),
      ]);
      const seedIds = new Set(SEED_ROLES.map((r) => r.id));
      setRoles(
        rsnap.docs
          .map((d) => {
            const data = d.data() as Record<string, unknown>;
            return {
              id: d.id,
              name: typeof data.name === "string" ? data.name : d.id,
              description:
                typeof data.description === "string" ? data.description : "",
              permissions: {
                ...emptyPermissions(),
                ...parsePermissions(data.permissions),
              },
              isSeed: seedIds.has(d.id),
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")),
      );
      setTitles(
        tsnap.docs
          .map((d) => {
            const data = d.data() as Record<string, unknown>;
            return {
              id: d.id,
              name: typeof data.name === "string" ? data.name : d.id,
              level: typeof data.level === "string" ? data.level : "",
              permissions: {
                ...emptyPermissions(),
                ...parsePermissions(data.permissions),
              },
              permConfigured:
                data.permissions !== undefined && data.permissions !== null,
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")),
      );
    } catch {
      onAction("讀取角色／職稱清單失敗");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openCreate() {
    setEditingId(null);
    setName("");
    setDescription("");
    setFormError("");
    setFormOpen(true);
  }

  function openEdit(row: RoleRow) {
    setEditingId(row.id);
    setName(row.name);
    setDescription(row.description);
    setFormError("");
    setFormOpen(true);
  }

  async function handleSaveRole() {
    const nm = name.trim();
    if (!nm) {
      setFormError("請填寫角色名稱");
      return;
    }
    if (!user) {
      setFormError("請先登入");
      return;
    }
    if (
      roles.some(
        (r) => r.name === nm && (editingId == null || r.id !== editingId),
      )
    ) {
      setFormError(`角色「${nm}」已存在`);
      return;
    }
    setSaving(true);
    try {
      const db = getFirebaseDb();
      if (editingId == null) {
        await setDoc(doc(collection(db, "roles")), {
          name: nm,
          description: description.trim(),
          permissions: emptyPermissions(),
          createdAt: serverTimestamp(),
          createdBy: user.staffId,
          updatedAt: serverTimestamp(),
          updatedBy: user.staffId,
        });
        onAction(`已新增角色「${nm}」，請在下方矩陣勾選其權限`);
      } else {
        await updateDoc(doc(db, "roles", editingId), {
          name: nm,
          description: description.trim(),
          updatedAt: serverTimestamp(),
          updatedBy: user.staffId,
        });
        onAction(`角色「${nm}」已更新`);
      }
      setFormOpen(false);
      await loadAll();
    } catch {
      setFormError("儲存失敗：權限不足或網路異常");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteRole(row: RoleRow) {
    if (!user) return;
    if (row.isSeed) {
      onAction(`「${row.name}」為系統預設角色，不可刪除`);
      return;
    }
    if (!window.confirm(`確定刪除角色「${row.name}」？`)) return;
    try {
      const db = getFirebaseDb();
      const used = await getDocs(
        query(
          collection(db, "users"),
          where("roles", "array-contains", row.name),
          limit(1),
        ),
      );
      if (!used.empty) {
        onAction(`角色「${row.name}」尚有人員使用，無法刪除`);
        return;
      }
      await deleteDoc(doc(db, "roles", row.id));
      onAction(`已刪除角色「${row.name}」`);
      await loadAll();
    } catch {
      onAction("刪除失敗：權限不足或網路異常");
    }
  }

  async function toggleRolePerm(row: RoleRow, key: PermKey) {
    if (!user) return;
    const next = { ...row.permissions, [key]: !permCell(row.permissions, key) };
    setRoles((prev) =>
      prev.map((r) => (r.id === row.id ? { ...r, permissions: next } : r)),
    );
    try {
      await updateDoc(doc(getFirebaseDb(), "roles", row.id), {
        permissions: next,
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      });
    } catch {
      onAction("權限儲存失敗：權限不足或網路異常");
      void loadAll();
    }
  }

  async function toggleTitlePerm(row: TitleRow, key: PermKey) {
    if (!user) return;
    const next = { ...row.permissions, [key]: !permCell(row.permissions, key) };
    // 一旦儲存過矩陣，該職稱即視為已設定（改走嚴格交集）
    setTitles((prev) =>
      prev.map((t) =>
        t.id === row.id ? { ...t, permissions: next, permConfigured: true } : t,
      ),
    );
    try {
      await updateDoc(doc(getFirebaseDb(), "titles", row.id), {
        permissions: next,
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      });
    } catch {
      onAction("權限儲存失敗：權限不足或網路異常");
      void loadAll();
    }
  }

  function permMatrix<
    T extends {
      id: string;
      name: string;
      permissions: Record<PermKey, boolean>;
      permConfigured?: boolean;
    },
  >(rows: T[], onToggle: (row: T, key: PermKey) => void) {
    return (
      <div className="table-scroll">
        <table className="permission-table">
          <thead>
            <tr>
              <th>名稱</th>
              {PERM_KEYS.map((k) => (
                <th key={k}>{PERM_LABELS[k]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <b>{r.name}</b>
                  {r.permConfigured === false && (
                    <span
                      className="status-pill warning"
                      style={{ marginLeft: 6 }}
                    >
                      尚未設定
                    </span>
                  )}
                </td>
                {PERM_KEYS.map((k) => (
                  <td key={k} style={{ textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={permCell(r.permissions, k)}
                      onChange={() => onToggle(r, k)}
                      aria-label={`${r.name}：${PERM_LABELS[k]}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <>
      <section className="panel data-panel permission-panel">
        <SectionTitle
          title="角色與權限"
          note="先新增角色，再於下方矩陣勾選其功能權限；一人多重角色時取聯集"
          action={
            <button className="button button-outline" onClick={openCreate}>
              <Plus size={14} /> 新增角色
            </button>
          }
        />
        {loading ? (
          <p className="settings-note">讀取中…</p>
        ) : (
          <>
            {formOpen && (
              <div className="panel" style={{ marginBottom: 12 }}>
                <div className="form-grid">
                  <div className="form-field">
                    <label className="field-label">角色名稱 *</label>
                    <input
                      className="text-input"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="例如 稽核員"
                    />
                  </div>
                  <div className="form-field">
                    <label className="field-label">說明</label>
                    <input
                      className="text-input"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="此角色的職責說明"
                    />
                  </div>
                </div>
                {formError && <div className="login-error">{formError}</div>}
                <div className="form-actions">
                  <button
                    className="button button-primary"
                    disabled={saving}
                    onClick={handleSaveRole}
                  >
                    {saving ? "儲存中…" : editingId ? "儲存修改" : "新增角色"}
                  </button>
                  <button
                    className="button button-outline"
                    onClick={() => setFormOpen(false)}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>角色</th>
                    <th>說明</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {roles.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <b>{r.name}</b>
                        {r.isSeed && (
                          <span className="muted-text">（預設）</span>
                        )}
                      </td>
                      <td>{r.description || "—"}</td>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => openEdit(r)}
                        >
                          <Pencil size={13} /> 編輯
                        </button>{" "}
                        {!r.isSeed && (
                          <button
                            className="text-button"
                            onClick={() => void handleDeleteRole(r)}
                          >
                            <Trash2 size={13} /> 刪除
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 16 }}>
              <SectionTitle
                title="角色功能權限矩陣"
                note="勾選即生效；多重角色取聯集"
              />
              {permMatrix(roles, toggleRolePerm)}
            </div>
          </>
        )}
      </section>

      <section className="panel data-panel">
        <SectionTitle
          title="職稱功能權限"
          note="尚未設定的職稱只看角色權限；儲存後改為角色＋職稱都要有才生效（無職稱者視為無權限）"
        />
        {loading ? (
          <p className="settings-note">讀取中…</p>
        ) : titles.length === 0 ? (
          <p className="settings-note">
            尚無職稱，請先到「人員管理 → 職稱」新增。
          </p>
        ) : (
          <>
            {titles.some((t) => !t.permConfigured) && (
              <p className="settings-note" style={{ marginBottom: 8 }}>
                未設定前只看角色權限；儲存後改為角色＋職稱都要有。
              </p>
            )}
            {permMatrix(titles, toggleTitlePerm)}
          </>
        )}
      </section>
    </>
  );
}

/* ================= 稽核軌跡 ================= */

interface AuditRow {
  id: string;
  timeText: string;
  dateKey: string;
  actorLabel: string;
  action: string;
  target: string;
  detail: string;
}

/** 稽核軌跡紀錄（唯讀列表；查詢限系統管理員，見 firestore.rules） */
function AuditLogSection({ canManageRoles }: { canManageRoles: boolean }) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [dateFilter, setDateFilter] = useState("");

  useEffect(() => {
    if (!canManageRoles || !open || rows !== null) return;
    let cancelled = false;
    getDocs(
      query(
        collection(getFirebaseDb(), "auditLogs"),
        orderBy("createdAt", "desc"),
        limit(50),
      ),
    )
      .then((snap) => {
        if (cancelled) return;
        setRows(
          snap.docs.map((d) => {
            const data = d.data();
            const createdAt = (
              data.createdAt as { toDate?: () => Date } | undefined
            )?.toDate?.();
            const actor =
              typeof data.actor === "string" ? data.actor : "";
            const actorName =
              typeof data.actorName === "string" ? data.actorName : "";
            const targetId =
              typeof data.targetId === "string" ? data.targetId : "";
            const y = createdAt ? createdAt.getFullYear() : 0;
            const m = createdAt
              ? String(createdAt.getMonth() + 1).padStart(2, "0")
              : "00";
            const day = createdAt
              ? String(createdAt.getDate()).padStart(2, "0")
              : "00";
            return {
              id: d.id,
              timeText: createdAt ? createdAt.toLocaleString("zh-Hant") : "—",
              dateKey: `${y}-${m}-${day}`,
              actorLabel:
                actorName && actorName !== actor
                  ? `${maskName(actorName)}（${actor}）`
                  : actor || "—",
              action: typeof data.action === "string" ? data.action : "",
              target: targetId,
              detail: typeof data.detail === "string" ? data.detail : "",
            };
          }),
        );
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [canManageRoles, open, rows]);

  const filtered = useMemo(
    () => (rows ? filterAuditRows(rows, keyword, dateFilter) : []),
    [rows, keyword, dateFilter],
  );

  return (
    <section className="panel data-panel">
      <SectionTitle
        title="稽核軌跡紀錄"
        note="最近 50 筆，僅系統管理員可查閱"
        action={
          canManageRoles ? (
            <button
              className="text-button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
            >
              {open ? "收合" : "展開"}{" "}
              <ChevronRight
                size={14}
                style={{
                  transform: open ? "rotate(90deg)" : undefined,
                  verticalAlign: "-2px",
                }}
              />
            </button>
          ) : undefined
        }
      />
      {!canManageRoles ? (
        <p className="settings-note">稽核軌跡僅開放系統管理員查閱。</p>
      ) : !open ? (
        <p className="settings-note">
          平時隱藏，需要時點右上「展開」查看，可關鍵字搜尋與日期篩選。
        </p>
      ) : rows === null ? (
        <p className="settings-note">讀取中…</p>
      ) : (
        <>
          <div className="form-grid" style={{ marginBottom: 12 }}>
            <div className="form-field">
              <label className="field-label">關鍵字搜尋</label>
              <input
                className="text-input"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="人員／動作／對象／說明"
              />
            </div>
            <div className="form-field">
              <label className="field-label">日期篩選</label>
              <input
                className="text-input"
                type="date"
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value)}
              />
            </div>
          </div>
          {filtered.length === 0 ? (
            <EmptyState
              title={rows.length === 0 ? "尚無稽核紀錄" : "沒有符合的紀錄"}
              description={
                rows.length === 0
                  ? "建立、編輯或停用指標後，系統會自動寫入操作紀錄。"
                  : "請調整關鍵字或日期條件。"
              }
            />
          ) : (
            <div className="table-scroll">
              <table className="permission-table">
                <thead>
                  <tr>
                    <th>時間</th>
                    <th>人員</th>
                    <th>動作</th>
                    <th>對象</th>
                    <th>說明</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.id}>
                      <td>{r.timeText}</td>
                      <td>{r.actorLabel}</td>
                      <td>
                        <b>{r.action}</b>
                      </td>
                      <td>{r.target || "—"}</td>
                      <td>{r.detail || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(keyword.trim() || dateFilter) && (
            <p className="settings-note">
              篩選結果 {filtered.length}／{rows.length} 筆
              <button
                className="text-button"
                style={{ marginLeft: 8 }}
                onClick={() => {
                  setKeyword("");
                  setDateFilter("");
                }}
              >
                <X size={13} /> 清除篩選
              </button>
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function AdminPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  const { can } = usePermissions();
  const canManageRoles = can("manageRoles");
  return (
    <>
      <PageHeading
        page="admin"
        action={
          <button
            className="button button-outline"
            onClick={() =>
              document
                .getElementById("system-init")
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          >
            <SlidersHorizontal size={15} />
            系統參數
          </button>
        }
      />
      <div className="admin-alert">
        <ShieldCheck size={17} />
        <span>
          <b>權限矩陣</b> ·
          角色可由系統管理員動態建立，不需修改程式；正式授權以系統管理員設定為準。
        </span>
      </div>
      <SystemInitSection onAction={onAction} canManageRoles={canManageRoles} />
      {canManageRoles && <RolePermissionSection onAction={onAction} />}
      <AuditLogSection canManageRoles={canManageRoles} />
      <div className="admin-settings-grid">
        <section className="panel settings-panel">
          <SectionTitle title="稽核軌跡" note="不可關閉的必要紀錄" />
          <div className="audit-logs">
            {[
              "登入、登出與失敗",
              "角色與權限變更",
              "資料修改前後內容",
              "結果、照片與匯出查閱",
            ].map((line) => (
              <div key={line}>
                <span className="log-check">
                  <Check size={13} />
                </span>
                <span>{line}</span>
                <span className="log-required">必開</span>
              </div>
            ))}
          </div>
          <p className="settings-note">
            審查資料與稽核紀錄保存 3 年（可於系統參數調整）。
          </p>
        </section>
      </div>
    </>
  );
}
