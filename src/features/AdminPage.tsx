import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  Pencil,
  Plus,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "../lib/db";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { getFirebaseDb } from "../lib/firebase";
import {
  getCachedRef,
  getCachedRefCollection,
  SYSTEM_CONFIG_KEY,
} from "../lib/refCache";
import { getDocCacheFirst, getDocsCacheFirst } from "../lib/cacheFirst";
import { isDemoMode } from "../lib/demoMode";
import { useAuth } from "../lib/auth";
import { applyTheme } from "../lib/uiPrefs";
import { maskName } from "../lib/mask";
import { filterAuditRows } from "../lib/audit";
import {
  DEFAULT_SYSTEM_PARAMS,
  SEED_ROLES,
  SYSTEM_PARAM_LABELS,
  SYSTEM_PARAM_SELECT_OPTIONS,
  runSystemSeed,
  themeName,
  type SystemParams,
  type UiThemeDef,
} from "../lib/seed";
import {
  clearThemeRegistry,
  ensureBuiltIns,
  loadThemes,
  themeToCssVars,
} from "../lib/themeRegistry";
import { isHexColor, validateThemeContrast } from "../lib/colorContrast";
import {
  PERM_KEYS,
  PERM_LABELS,
  emptyPermissions,
  parsePermissions,
  type PermKey,
} from "../lib/permissions";
import { usePermissions } from "../lib/usePermissions";

function formatParamValue(key: keyof SystemParams, value: unknown): string {
  const opts = SYSTEM_PARAM_SELECT_OPTIONS[key];
  if (opts) {
    const s = String(value ?? "");
    return opts.find((o) => o.value === s)?.label ?? s;
  }
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return "—";
}

type ParamKind = "number" | "boolean" | "string" | "select";
function paramKindOf(key: keyof SystemParams): ParamKind {
  if (SYSTEM_PARAM_SELECT_OPTIONS[key]) return "select";
  const v = DEFAULT_SYSTEM_PARAMS[key];
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  return "string";
}

function SystemInitSection({
  onAction,
  canManageRoles,
  themeTick,
}: {
  onAction: (message: string) => void;
  canManageRoles: boolean;
  /** 主題在模板管理區變更後遞增，觸發參數重讀（顯示目前主題名稱）。 */
  themeTick: number;
}) {
  const { user } = useAuth();
  const [params, setParams] = useState<SystemParams | null | undefined>(undefined);
  const [seeding, setSeeding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getCachedRef(SYSTEM_CONFIG_KEY, () =>
        getDocCacheFirst(doc(getFirebaseDb(), "systemParams", "config")),
      )
      .then((snap) => {
        if (!cancelled) setParams(snap.exists() ? (snap.data() as SystemParams) : null);
      })
      .catch(() => {
        if (!cancelled) setParams(null);
      });
    return () => {
      cancelled = true;
    };
  }, [themeTick]);

  async function handleSeed() {
    if (!user || seeding) return;
    setSeeding(true);
    try {
      await runSystemSeed(getFirebaseDb(), user.staffId);
      const snap = await getCachedRef(SYSTEM_CONFIG_KEY, () =>
        getDocCacheFirst(doc(getFirebaseDb(), "systemParams", "config")),
      );
      setParams(snap.exists() ? (snap.data() as SystemParams) : null);
      onAction("系統初始化完成：已寫入預設參數與 7 個角色");
    } catch {
      onAction("初始化失敗：權限不足或網路異常，請稍後再試");
    } finally {
      setSeeding(false);
    }
  }

  function startEdit() {
    if (!params) return;
    const d: Record<string, string | boolean> = {};
    (Object.keys(SYSTEM_PARAM_LABELS) as (keyof SystemParams)[]).forEach(
      (key) => {
        if (key === "uiTheme") return;
        const v = params[key];
        // 下拉欄位：舊資料缺值時退回預設值（如 statsCycle 預設 "year"）
        const fallback = SYSTEM_PARAM_SELECT_OPTIONS[key]
          ? DEFAULT_SYSTEM_PARAMS[key]
          : "";
        d[key] = typeof v === "boolean" ? v : String(v ?? fallback);
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
        } else if (SYSTEM_PARAM_SELECT_OPTIONS[key]) {
          // 下拉欄位：只接受選項內的值，否則保留原值
          const opts = SYSTEM_PARAM_SELECT_OPTIONS[key]!;
          const s = String(d ?? "");
          updates[key] = opts.some((o) => o.value === s) ? s : cur;
        } else {
          updates[key] = String(d ?? "");
        }
      });
      updates.updatedAt = serverTimestamp();
      updates.updatedBy = user.staffId;
      await updateDoc(doc(getFirebaseDb(), "systemParams", "config"), updates);
      const snap = await getCachedRef(SYSTEM_CONFIG_KEY, () =>
        getDocCacheFirst(doc(getFirebaseDb(), "systemParams", "config")),
      );
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
                  {kind === "select" ? (
                    <div className="select-wrap">
                      <select
                        value={typeof val === "string" ? val : ""}
                        onChange={(e) =>
                          setDraft((p) => ({ ...p, [key]: e.target.value }))
                        }
                        aria-label={SYSTEM_PARAM_LABELS[key]}
                      >
                        {SYSTEM_PARAM_SELECT_OPTIONS[key]!.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={15} />
                    </div>
                  ) : kind === "boolean" ? (
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
                    {themeName(params.uiTheme || "green-2")}
                    <span className="muted-text">
                      （請至下方「模板管理」切換）
                    </span>
                  </dd>
                </div>
              ) : (
                <div key={key} className="param-row">
                  <dt>{SYSTEM_PARAM_LABELS[key]}</dt>
                  <dd>{formatParamValue(key, params[key])}</dd>
                </div>
              ),
          )}
        </dl>
      )}
    </section>
  );
}

/* ================= 模板管理（v1.32.0，資料驅動） =================
   主題定義在 Firestore uiThemes 集合（見 src/lib/themeRegistry.ts），
   新增一套模板不需發版。刪除自訂模板＝真刪；內建模板只能隱藏／還原。
   防呆：green-2 不可隱藏／刪／改；內建線上不改色；自訂 id 不可撞內建；
   至少留 1 套可見；刪使用中主題自動切回 green-2。 */

const THEME_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

type ThemeDraft = UiThemeDef;

const THEME_HEX_KEYS = [
  "teal",
  "tealDeep",
  "tealSoft",
  "accent",
  "accentDeep",
  "accentSoft",
  "accent2",
  "accent2Deep",
  "accent2Soft",
  "bg",
  "btnHoverBg",
  "btnHoverColor",
  "rowHover",
  "navHover",
] as const;
type ThemeHexKey = (typeof THEME_HEX_KEYS)[number];

const THEME_HEX_LABELS: Record<ThemeHexKey, string> = {
  teal: "主色",
  tealDeep: "主色深版",
  tealSoft: "主色淡底",
  accent: "輔色",
  accentDeep: "輔色深版",
  accentSoft: "輔色淡底",
  accent2: "點綴色",
  accent2Deep: "點綴色深版",
  accent2Soft: "點綴色淡底",
  bg: "頁面底色",
  btnHoverBg: "主按鈕 hover 底",
  btnHoverColor: "主按鈕 hover 文字",
  rowHover: "表格列 hover 底",
  navHover: "導覽 hover 底",
};

function TemplateManagementSection({
  onAction,
  onThemeChanged,
}: {
  onAction: (message: string) => void;
  onThemeChanged: () => void;
}) {
  const { user } = useAuth();
  const [themes, setThemes] = useState<UiThemeDef[] | null>(null);
  const [currentId, setCurrentId] = useState("green-2");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ThemeDraft | null>(null);
  const [copyFromId, setCopyFromId] = useState("printmax-green");
  const [formError, setFormError] = useState("");
  const [formWarnings, setFormWarnings] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const visible = useMemo(
    () => (themes ?? []).filter((t) => !t.hidden),
    [themes],
  );
  const hidden = useMemo(
    () => (themes ?? []).filter((t) => t.hidden),
    [themes],
  );

  async function loadAll() {
    try {
      const db = getFirebaseDb();
      if (user) await ensureBuiltIns(user.staffId);
      clearThemeRegistry();
      const defs = await loadThemes();
      setThemes(defs);
      const snap = await getCachedRef(SYSTEM_CONFIG_KEY, () =>
        getDocCacheFirst(doc(db, "systemParams", "config")),
      );
      if (snap.exists()) {
        const t = (snap.data() as { uiTheme?: unknown }).uiTheme;
        if (typeof t === "string" && t) setCurrentId(t);
      }
    } catch {
      onAction("讀取模板清單失敗");
      setThemes([]);
    }
  }

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function reloadThemes() {
    clearThemeRegistry();
    setThemes(await loadThemes());
  }

  async function handleSetActive(def: UiThemeDef) {
    if (!user || busyId) return;
    setBusyId(def.id);
    try {
      await updateDoc(doc(getFirebaseDb(), "systemParams", "config"), {
        uiTheme: def.id,
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      });
      setCurrentId(def.id);
      applyTheme(def.id);
      setPreviewId(null);
      onThemeChanged();
      onAction(`主題配色已切換為「${def.name}」（全院統一）`);
    } catch {
      onAction("主題切換失敗：權限不足或網路異常");
    } finally {
      setBusyId(null);
    }
  }

  function handlePreview(def: UiThemeDef) {
    applyTheme(def.id);
    setPreviewId(def.id);
  }

  function cancelPreview() {
    applyTheme(currentId);
    setPreviewId(null);
  }

  async function handleHide(def: UiThemeDef) {
    if (!user || busyId) return;
    if (def.id === "green-2") {
      onAction("「雅致綠」為預設主題，不可隱藏");
      return;
    }
    if (visible.length <= 1) {
      onAction("至少保留一套可見主題");
      return;
    }
    const active = def.id === currentId;
    if (
      active &&
      !window.confirm(
        `「${def.name}」目前使用中，隱藏後全院主題將切回「雅致綠」。確定隱藏？`,
      )
    )
      return;
    if (!active && !window.confirm(`確定隱藏模板「${def.name}」？`)) return;
    setBusyId(def.id);
    try {
      const db = getFirebaseDb();
      if (active) {
        const batch = writeBatch(db);
        batch.update(doc(db, "uiThemes", def.id), {
          hidden: true,
          updatedAt: serverTimestamp(),
          updatedBy: user.staffId,
        });
        batch.update(doc(db, "systemParams", "config"), {
          uiTheme: "green-2",
          updatedAt: serverTimestamp(),
          updatedBy: user.staffId,
        });
        await batch.commit();
        setCurrentId("green-2");
        applyTheme("green-2");
        onThemeChanged();
        onAction(`已隱藏「${def.name}」，全院主題已切回「雅致綠」`);
      } else {
        await updateDoc(doc(db, "uiThemes", def.id), {
          hidden: true,
          updatedAt: serverTimestamp(),
          updatedBy: user.staffId,
        });
        onAction(`已隱藏模板「${def.name}」`);
      }
      await reloadThemes();
    } catch {
      onAction("隱藏失敗：權限不足或網路異常");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRestore(def: UiThemeDef) {
    if (!user || busyId) return;
    setBusyId(def.id);
    try {
      await updateDoc(doc(getFirebaseDb(), "uiThemes", def.id), {
        hidden: false,
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      });
      await reloadThemes();
      onAction(`已還原模板「${def.name}」`);
    } catch {
      onAction("還原失敗：權限不足或網路異常");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(def: UiThemeDef) {
    if (!user || busyId) return;
    if (def.builtIn) {
      onAction("內建模板不可刪除，只能隱藏");
      return;
    }
    const active = def.id === currentId;
    if (
      !window.confirm(
        active
          ? `「${def.name}」目前使用中，刪除後全院主題將切回「雅致綠」。確定刪除？此動作無法復原。`
          : `確定刪除自訂模板「${def.name}」？此動作無法復原。`,
      )
    )
      return;
    setBusyId(def.id);
    try {
      const db = getFirebaseDb();
      if (active) {
        const batch = writeBatch(db);
        batch.delete(doc(db, "uiThemes", def.id));
        batch.update(doc(db, "systemParams", "config"), {
          uiTheme: "green-2",
          updatedAt: serverTimestamp(),
          updatedBy: user.staffId,
        });
        await batch.commit();
        setCurrentId("green-2");
        applyTheme("green-2");
        onThemeChanged();
        onAction(`已刪除「${def.name}」，全院主題已切回「雅致綠」`);
      } else {
        await deleteDoc(doc(db, "uiThemes", def.id));
        onAction(`已刪除自訂模板「${def.name}」`);
      }
      await reloadThemes();
    } catch {
      onAction("刪除失敗：權限不足或網路異常");
    } finally {
      setBusyId(null);
    }
  }

  async function handleEnsure() {
    if (!user || busyId) return;
    setBusyId("__ensure");
    try {
      await ensureBuiltIns(user.staffId);
      await reloadThemes();
      onAction("已補齊內建模板");
    } catch {
      onAction("補齊失敗：權限不足或網路異常");
    } finally {
      setBusyId(null);
    }
  }

  function openCreate() {
    const src =
      (themes ?? []).find((t) => t.id === copyFromId) ??
      (themes ?? [])[0];
    if (!src) return;
    const order = Math.max(0, ...(themes ?? []).map((t) => t.order)) + 1;
    setDraft({
      ...src,
      id: "",
      name: "",
      source: "管理員自訂",
      builtIn: false,
      hidden: false,
      order,
    });
    setEditingId(null);
    setFormError("");
    setFormWarnings([]);
    setFormOpen(true);
  }

  function openEdit(def: UiThemeDef) {
    setDraft({ ...def });
    setEditingId(def.id);
    setFormError("");
    setFormWarnings([]);
    setFormOpen(true);
  }

  function handleCopyFromChange(nextId: string) {
    setCopyFromId(nextId);
    if (editingId != null) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const src = (themes ?? []).find((t) => t.id === nextId);
      if (!src) return prev;
      return {
        ...src,
        id: prev.id,
        name: prev.name,
        source: "管理員自訂",
        builtIn: false,
        hidden: false,
        order: prev.order,
      };
    });
  }

  async function handleSaveTheme() {
    if (!draft || !user) return;
    const name = draft.name.trim();
    if (!name) {
      setFormError("請填寫模板名稱");
      return;
    }
    if (editingId == null) {
      if (!THEME_ID_PATTERN.test(draft.id)) {
        setFormError(
          "模板 id 須為小寫英文／數字／連字號（kebab-case），例如 edu-blue",
        );
        return;
      }
      if ((themes ?? []).some((t) => t.id === draft.id)) {
        setFormError(`模板 id「${draft.id}」已存在`);
        return;
      }
    }
    for (const key of THEME_HEX_KEYS) {
      if (!isHexColor(draft[key])) {
        setFormError(`欄位「${THEME_HEX_LABELS[key]}」須為 #rrggbb 格式`);
        return;
      }
    }
    if (
      !Number.isInteger(draft.radiusBtn) ||
      draft.radiusBtn < 0 ||
      draft.radiusBtn > 999 ||
      !Number.isInteger(draft.radiusCard) ||
      draft.radiusCard < 0 ||
      draft.radiusCard > 999 ||
      !Number.isInteger(draft.lift) ||
      draft.lift < 0 ||
      draft.lift > 10
    ) {
      setFormError("圓角須為 0–999 整數，上浮須為 0–10 整數");
      return;
    }
    if (draft.grad !== "none" && draft.grad.trim() === "") {
      setFormError("卡片頂條漸層請填 CSS 字串或 none");
      return;
    }
    const { errors, warnings } = validateThemeContrast(draft);
    if (errors.length > 0) {
      setFormError(errors.join("；"));
      return;
    }
    setFormWarnings(warnings);
    setSaving(true);
    try {
      const db = getFirebaseDb();
      const payload = {
        ...draft,
        name,
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      };
      if (editingId == null) {
        await setDoc(doc(db, "uiThemes", draft.id), payload);
        onAction(`已新增模板「${name}」，不需發版，各裝置下次載入即出現`);
      } else {
        await updateDoc(doc(db, "uiThemes", editingId), payload);
        onAction(`模板「${name}」已更新`);
      }
      setFormOpen(false);
      setDraft(null);
      await reloadThemes();
    } catch {
      setFormError("儲存失敗：權限不足或網路異常");
    } finally {
      setSaving(false);
    }
  }

  const setDraftField = <K extends keyof ThemeDraft>(
    key: K,
    value: ThemeDraft[K],
  ) => setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));

  function colorField(key: ThemeHexKey) {
    if (!draft) return null;
    return (
      <div className="form-field" key={key}>
        <label className="field-label">{THEME_HEX_LABELS[key]}</label>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="color"
            value={draft[key]}
            onChange={(e) => setDraftField(key, e.target.value)}
            aria-label={THEME_HEX_LABELS[key]}
          />
          <input
            className="text-input"
            value={draft[key]}
            onChange={(e) => setDraftField(key, e.target.value)}
          />
        </div>
      </div>
    );
  }

  function numField(
    label: string,
    key: "radiusBtn" | "radiusCard" | "lift" | "order",
  ) {
    if (!draft) return null;
    return (
      <div className="form-field" key={key}>
        <label className="field-label">{label}</label>
        <input
          className="text-input"
          type="number"
          value={draft[key]}
          onChange={(e) =>
            setDraftField(key, Number(e.target.value) || 0)
          }
        />
      </div>
    );
  }

  function themeCard(def: UiThemeDef) {
    const previewVars = themeToCssVars(def) as CSSProperties;
    const isActive = def.id === currentId;
    const isDefault = def.id === "green-2";
    return (
      <div
        key={def.id}
        className="panel"
        style={{ ...previewVars, padding: 16 }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 8,
          }}
        >
          <b>{def.name}</b>
          <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {isActive && (
              <span className="status-pill success">使用中</span>
            )}
            {def.hidden && (
              <span className="status-pill warning">已隱藏</span>
            )}
            {def.builtIn ? (
              <span className="muted-text">內建</span>
            ) : (
              <span className="muted-text">自訂</span>
            )}
          </span>
        </div>
        <div className="muted-text" style={{ fontSize: 12, marginTop: 2 }}>
          <code>{def.id}</code> · {def.source}
        </div>
        <div style={{ display: "flex", gap: 6, margin: "10px 0" }}>
          {[def.teal, def.accent, def.accent2].map((c) => (
            <span
              key={c}
              title={c}
              style={{
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: c,
                border: "1px solid #e8edef",
              }}
            />
          ))}
        </div>
        <div
          style={{
            background: "var(--teal-soft)",
            borderRadius: "var(--radius-card)",
            padding: 10,
            marginBottom: 10,
          }}
        >
          <span
            className="button button-primary"
            style={{ pointerEvents: "none" }}
          >
            主按鈕
          </span>{" "}
          <span style={{ color: "var(--teal-deep)", fontWeight: 700 }}>
            預覽文字
          </span>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            className="text-button"
            disabled={busyId === def.id}
            onClick={() => handlePreview(def)}
          >
            <Eye size={13} /> 預覽
          </button>
          {!def.hidden && !isActive && (
            <button
              className="text-button"
              disabled={busyId === def.id}
              onClick={() => void handleSetActive(def)}
            >
              <Check size={13} /> 設為使用中
            </button>
          )}
          {def.builtIn ? (
            def.hidden ? (
              <button
                className="text-button"
                disabled={busyId === def.id}
                onClick={() => void handleRestore(def)}
              >
                <RotateCcw size={13} /> 還原
              </button>
            ) : (
              !isDefault && (
                <button
                  className="text-button"
                  disabled={busyId === def.id || visible.length <= 1}
                  onClick={() => void handleHide(def)}
                >
                  <X size={13} /> 隱藏
                </button>
              )
            )
          ) : (
            <>
              <button
                className="text-button"
                onClick={() => openEdit(def)}
              >
                <Pencil size={13} /> 編輯
              </button>
              <button
                className="text-button"
                disabled={busyId === def.id}
                onClick={() => void handleDelete(def)}
              >
                <Trash2 size={13} /> 刪除
              </button>
            </>
          )}
          {isDefault && <span className="muted-text">預設主題</span>}
        </div>
      </div>
    );
  }

  const gridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(min(240px, 100%), 1fr))",
    gap: 12,
  };

  return (
    <section className="panel" id="template-management">
      <SectionTitle
        title="模板管理"
        note="新增模板不需發版；內建模板只能隱藏，改色請複製成自訂模板再改"
        action={
          <button
            className="button button-outline"
            disabled={busyId === "__ensure"}
            onClick={() => void handleEnsure()}
          >
            補齊內建模板
          </button>
        }
      />
      {previewId && (
        <div
          className="admin-alert"
          style={{ marginBottom: 12 }}
          role="status"
        >
          <Eye size={17} />
          <span>
            預覽中：
            <b>{(themes ?? []).find((t) => t.id === previewId)?.name ?? previewId}</b>
            （尚未套用全院）
          </span>
          <button
            className="button button-primary"
            style={{ marginLeft: "auto" }}
            onClick={() => {
              const def = (themes ?? []).find((t) => t.id === previewId);
              if (def) void handleSetActive(def);
            }}
          >
            套用為全院主題
          </button>
          <button className="button button-outline" onClick={cancelPreview}>
            取消預覽
          </button>
        </div>
      )}
      {themes === null ? (
        <p className="settings-note">讀取中…</p>
      ) : (
        <>
          <div style={gridStyle}>{visible.map((t) => themeCard(t))}</div>
          {hidden.length > 0 && (
            <>
              <div style={{ marginTop: 16 }}>
                <SectionTitle
                  title="已隱藏"
                  note="還原後可再設為使用中"
                />
              </div>
              <div style={gridStyle}>{hidden.map((t) => themeCard(t))}</div>
            </>
          )}
          <div className="form-actions" style={{ marginTop: 12 }}>
            <button
              className="button button-outline"
              onClick={openCreate}
            >
              <Plus size={14} /> 新增模板
            </button>
          </div>
          {formOpen && draft && (
            <div className="panel" style={{ marginTop: 12 }}>
              <SectionTitle
                title={editingId ? `編輯模板「${draft.name || editingId}」` : "新增模板"}
                note={
                  editingId
                    ? "僅自訂模板可編輯；id 建立後不可改"
                    : "先選複製來源，再改名稱與顏色；儲存後不需發版"
                }
              />
              <div className="form-grid">
                {editingId == null && (
                  <>
                    <div className="form-field">
                      <label className="field-label">複製來源</label>
                      <div className="select-wrap">
                        <select
                          value={copyFromId}
                          onChange={(e) =>
                            handleCopyFromChange(e.target.value)
                          }
                          aria-label="複製來源"
                        >
                          {(themes ?? []).map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}（{t.id}）
                            </option>
                          ))}
                        </select>
                        <ChevronDown size={15} />
                      </div>
                    </div>
                    <div className="form-field">
                      <label className="field-label">模板 id *</label>
                      <input
                        className="text-input"
                        value={draft.id}
                        onChange={(e) =>
                          setDraftField("id", e.target.value.trim())
                        }
                        placeholder="例如 edu-blue"
                      />
                    </div>
                  </>
                )}
                <div className="form-field">
                  <label className="field-label">模板名稱 *</label>
                  <input
                    className="text-input"
                    value={draft.name}
                    onChange={(e) => setDraftField("name", e.target.value)}
                    placeholder="例如 教育寶藍"
                  />
                </div>
                {colorField("teal")}
                {colorField("accent")}
                {colorField("accent2")}
                {colorField("bg")}
              </div>
              <details style={{ marginTop: 4 }}>
                <summary style={{ cursor: "pointer", fontWeight: 700 }}>
                  進階：淡底、hover 與殼層
                </summary>
                <div className="form-grid" style={{ marginTop: 12 }}>
                  {colorField("tealDeep")}
                  {colorField("tealSoft")}
                  {colorField("accentDeep")}
                  {colorField("accentSoft")}
                  {colorField("accent2Deep")}
                  {colorField("accent2Soft")}
                  {colorField("btnHoverBg")}
                  {colorField("btnHoverColor")}
                  {colorField("rowHover")}
                  {colorField("navHover")}
                  <div className="form-field">
                    <label className="field-label">卡片頂條漸層（或 none）</label>
                    <input
                      className="text-input"
                      value={draft.grad}
                      onChange={(e) => setDraftField("grad", e.target.value)}
                    />
                  </div>
                  <div className="form-field">
                    <label className="field-label">主按鈕 hover 陰影（或 none）</label>
                    <input
                      className="text-input"
                      value={draft.shadowHover}
                      onChange={(e) =>
                        setDraftField("shadowHover", e.target.value)
                      }
                    />
                  </div>
                  <div className="form-field">
                    <label className="field-label">卡片 hover 陰影（或 none）</label>
                    <input
                      className="text-input"
                      value={draft.shadowCardHover}
                      onChange={(e) =>
                        setDraftField("shadowCardHover", e.target.value)
                      }
                    />
                  </div>
                  {numField("按鈕圓角 px（999＝膠囊）", "radiusBtn")}
                  {numField("卡片圓角 px", "radiusCard")}
                  {numField("卡片 hover 上浮 px", "lift")}
                  {numField("排序", "order")}
                </div>
              </details>
              {formError && <div className="login-error">{formError}</div>}
              {formWarnings.length > 0 && (
                <p className="settings-note">
                  提醒：{formWarnings.join("；")}
                </p>
              )}
              <div className="form-actions">
                <button
                  className="button button-primary"
                  disabled={saving}
                  onClick={() => void handleSaveTheme()}
                >
                  {saving ? "儲存中…" : editingId ? "儲存修改" : "新增模板"}
                </button>
                <button
                  className="button button-outline"
                  onClick={() => {
                    setFormOpen(false);
                    setDraft(null);
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </>
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
        getCachedRefCollection("roles", () =>
          getDocsCacheFirst(collection(db, "roles")),
        ),
        getCachedRefCollection("titles", () =>
          getDocsCacheFirst(collection(db, "titles")),
        ),
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
  // 主題在模板管理區變更後遞增，觸發 SystemInitSection 重讀參數（顯示目前主題）
  const [themeTick, setThemeTick] = useState(0);
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
      <SystemInitSection
        onAction={onAction}
        canManageRoles={canManageRoles}
        themeTick={themeTick}
      />
      {canManageRoles && (
        <TemplateManagementSection
          onAction={onAction}
          onThemeChanged={() => setThemeTick((t) => t + 1)}
        />
      )}
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
