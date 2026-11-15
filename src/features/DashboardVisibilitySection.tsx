import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { SectionTitle } from "../components/ui";
import { useAuth } from "../lib/auth";
import { doc, serverTimestamp, updateDoc } from "../lib/db";
import { getCachedRef, SYSTEM_CONFIG_KEY } from "../lib/refCache";
import { getDocCacheFirst } from "../lib/cacheFirst";
import { getFirebaseDb } from "../lib/firebase";
import { useOrgMeta } from "../lib/useOrgMeta";
import { usePermissions } from "../lib/usePermissions";
import {
  DASHBOARD_SECTION_DESCRIPTIONS,
  DASHBOARD_SECTION_KEYS_BY_VARIANT,
  DASHBOARD_SECTION_LABELS,
  dashboardVariantForRole,
  dashboardVariantForTitle,
  parseDashboardSectionOverrides,
  setDashboardSectionOverride,
  type DashboardSectionOverrides,
  type DashboardTargetKind,
} from "../lib/dashboardVisibility";
import { parseDashboardSections, resolveDashboardSections } from "../lib/dashboardSections";
import { VARIANT_LABELS } from "../lib/dashboardVariant";

export function DashboardVisibilitySection({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  const { user } = useAuth();
  const { isAdmin } = usePermissions();
  const orgMeta = useOrgMeta();
  const [targetKind, setTargetKind] = useState<DashboardTargetKind>("role");
  const [targetId, setTargetId] = useState("");
  const [baseSections, setBaseSections] = useState<Record<string, unknown>>({});
  const [savedOverrides, setSavedOverrides] = useState<DashboardSectionOverrides>({ roles: {}, titles: {} });
  const [draftOverrides, setDraftOverrides] = useState<DashboardSectionOverrides>({ roles: {}, titles: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (!isAdmin) {
      setLoading(false);
      return () => { cancelled = true; };
    }
    setLoading(true);
    setLoadError("");
    void getCachedRef(SYSTEM_CONFIG_KEY, () =>
      getDocCacheFirst(doc(getFirebaseDb(), "systemParams", "config")),
    )
      .then((snapshot) => {
        if (cancelled) return;
        if (!snapshot.exists()) {
          setLoadError("系統參數尚未初始化，請先至「系統參數」完成初始化後再設定儀表板顯示。");
          return;
        }
        const data = snapshot.data() as Record<string, unknown> | undefined;
        const base = parseDashboardSections(data?.dashboardSections);
        const overrides = parseDashboardSectionOverrides(data?.dashboardSectionOverrides);
        setBaseSections(base as Record<string, unknown>);
        setSavedOverrides(overrides);
        setDraftOverrides(overrides);
      })
      .catch(() => {
        if (!cancelled) setLoadError("無法讀取儀表板顯示設定，請確認系統參數存取權限後重試。");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [isAdmin]);

  const roles = useMemo(
    () => orgMeta.roleTargets.filter((target) => target.name !== "系統管理員"),
    [orgMeta.roleTargets],
  );
  const titles = orgMeta.titleTargets;
  const targets = targetKind === "role" ? roles : titles;
  const dirty = JSON.stringify(savedOverrides) !== JSON.stringify(draftOverrides);

  useEffect(() => {
    if (targetKind === "role" && roles.length === 0 && titles.length > 0) {
      setTargetKind("title");
      setTargetId(titles[0].id);
      return;
    }
    if (!targets.some((target) => target.id === targetId)) {
      setTargetId(targets[0]?.id ?? "");
    }
  }, [targetKind, targetId, roles, titles, targets]);

  const selectedRole = targetKind === "role" ? roles.find((target) => target.id === targetId) : undefined;
  const selectedTitle = targetKind === "title" ? titles.find((target) => target.id === targetId) : undefined;
  const variant = selectedRole
    ? dashboardVariantForRole(selectedRole.name, orgMeta.roleMeta)
    : selectedTitle
      ? dashboardVariantForTitle(selectedTitle.flags)
      : null;
  const sectionKeys = variant ? DASHBOARD_SECTION_KEYS_BY_VARIANT[variant] : [];
  const selectedOverrides = targetKind === "role"
    ? draftOverrides.roles[targetId] ?? {}
    : draftOverrides.titles[targetId] ?? {};
  const inherited = useMemo(() => resolveDashboardSections(baseSections), [baseSections]);

  const changeOverride = (key: (typeof sectionKeys)[number], value: boolean | undefined) => {
    setDraftOverrides((current) => setDashboardSectionOverride(current, targetKind, targetId, key, value));
    setSaveError("");
    setSavedMessage("");
  };

  const clearSelectedTarget = () => {
    if (!targetId) return;
    setDraftOverrides((current) => {
    const next = parseDashboardSectionOverrides(current);
      delete (targetKind === "role" ? next.roles : next.titles)[targetId];
      return next;
    });
    setSaveError("");
    setSavedMessage("");
  };

  const save = async () => {
    if (!user || !isAdmin || saving || !dirty) return;
    setSaving(true);
    setSaveError("");
    setSavedMessage("");
    try {
      const safeOverrides = parseDashboardSectionOverrides(draftOverrides);
      await updateDoc(doc(getFirebaseDb(), "systemParams", "config"), {
        dashboardSectionOverrides: safeOverrides,
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      });
      setSavedOverrides(safeOverrides);
      setDraftOverrides(safeOverrides);
      setSavedMessage("儀表板顯示設定已儲存。");
      onAction("儀表板顯示設定已儲存");
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "儲存失敗，請稍後再試。");
    } finally {
      setSaving(false);
    }
  };

  if (!isAdmin) {
    return (
      <section className="panel dashboard-visibility-panel">
        <SectionTitle title="儀表板顯示設定" />
        <p className="settings-note">此設定僅供系統管理員使用。</p>
      </section>
    );
  }

  return (
    <div className="dashboard-visibility-settings">
      <section className="panel dashboard-visibility-panel">
        <SectionTitle
          title="依角色／職稱管理儀表板項目"
          note="只控制畫面顯示，不變更資料範圍、頁面權限或操作權限。"
        />
        <div className="dashboard-visibility-notice">
          <ShieldCheck size={17} />
          <span>設定儲存於 systemParams/config。角色以角色主檔 ID、職稱以職稱主檔 ID 對應；職稱覆寫優先於角色設定，多個相同視角角色衝突時以「隱藏」優先。</span>
        </div>

        <div className="dashboard-visibility-target-tabs" role="tablist" aria-label="設定對象類型">
          <button type="button" role="tab" aria-selected={targetKind === "role"} className={targetKind === "role" ? "active" : ""} onClick={() => { setTargetKind("role"); setTargetId(roles[0]?.id ?? ""); setSavedMessage(""); }}>
            角色
          </button>
          <button type="button" role="tab" aria-selected={targetKind === "title"} className={targetKind === "title" ? "active" : ""} onClick={() => { setTargetKind("title"); setTargetId(titles[0]?.id ?? ""); setSavedMessage(""); }}>
            職稱
          </button>
        </div>

        <div className="dashboard-visibility-toolbar">
          <label>
            <span>{targetKind === "role" ? "選擇角色" : "選擇職稱"}</span>
            <select value={targetId} onChange={(event) => { setTargetId(event.target.value); setSavedMessage(""); }} disabled={loading || orgMeta.loading || targets.length === 0}>
              {targets.length === 0 && <option value="">目前沒有可設定的{targetKind === "role" ? "角色" : "職稱"}</option>}
              {targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
            </select>
          </label>
          {variant && <span className="dashboard-visibility-variant">對應儀表板：{VARIANT_LABELS[variant]}</span>}
        </div>

        {loading || orgMeta.loading ? (
          <p className="settings-note">讀取角色、職稱與既有設定中…</p>
        ) : loadError ? (
          <p className="dashboard-visibility-error" role="alert">{loadError}</p>
        ) : !targetId || !variant ? (
          <p className="settings-note">請先建立角色或職稱主檔，再設定其儀表板項目。</p>
        ) : (
          <>
            <p className="dashboard-visibility-help">
              {targetKind === "title"
                ? "職稱設定會在角色設定之後套用；選擇「繼承」時沿用基礎值與該使用者符合視角的角色設定。"
                : "選擇「繼承」使用目前基礎值；若同一使用者有多個相同視角角色，任何一個角色設為隱藏時該項目即隱藏。"}
            </p>
            <div className="dashboard-visibility-list">
              {sectionKeys.map((key) => {
                const override = selectedOverrides[key];
                const value = typeof override === "boolean" ? (override ? "show" : "hide") : "inherit";
                const inheritedVisible = inherited[key];
                return (
                  <div className="dashboard-visibility-row" key={key}>
                    <div className="dashboard-visibility-copy">
                      <strong>{DASHBOARD_SECTION_LABELS[key]}</strong>
                      <small>{DASHBOARD_SECTION_DESCRIPTIONS[key] ?? (typeof override === "boolean" ? `目前明確設定為${override ? "顯示" : "隱藏"}。` : selectedTitle ? `未另設；沿用基礎值（目前${inheritedVisible ? "顯示" : "隱藏"}），並先套用使用者符合的角色設定。` : `目前繼承基礎設定：${inheritedVisible ? "顯示" : "隱藏"}。`)}</small>
                    </div>
                    <label className="dashboard-visibility-select">
                      <span className="sr-only">{DASHBOARD_SECTION_LABELS[key]}顯示方式</span>
                      <select value={value} onChange={(event) => changeOverride(key, event.target.value === "inherit" ? undefined : event.target.value === "show")} aria-label={`${DASHBOARD_SECTION_LABELS[key]}顯示方式`}>
                        <option value="inherit">{selectedTitle ? "繼承（先套角色／基礎設定）" : `繼承（${inheritedVisible ? "顯示" : "隱藏"}）`}</option>
                        <option value="show">顯示</option>
                        <option value="hide">隱藏</option>
                      </select>
                    </label>
                  </div>
                );
              })}
            </div>
            <div className="dashboard-visibility-actions">
              <button type="button" className="button button-outline" onClick={clearSelectedTarget} disabled={saving || !selectedOverrides || Object.keys(selectedOverrides).length === 0}>
                <RotateCcw size={15} />此{targetKind === "role" ? "角色" : "職稱"}全部改為繼承
              </button>
              <button type="button" className="button button-primary" onClick={() => void save()} disabled={saving || !dirty}>
                {saving ? <><Save size={15} />儲存中…</> : <><Save size={15} />儲存設定</>}
              </button>
            </div>
          </>
        )}
        {saveError && <p className="dashboard-visibility-error" role="alert">{saveError}</p>}
        {savedMessage && <p className="dashboard-visibility-success" role="status">{savedMessage}</p>}
      </section>
      <section className="panel dashboard-visibility-panel dashboard-visibility-legend">
        <SectionTitle title="設定原則" />
        <div><Eye size={15} /><span>顯示：此角色／職稱固定顯示該項目。</span></div>
        <div><EyeOff size={15} /><span>隱藏：此角色／職稱不顯示該項目。</span></div>
        <div><RotateCcw size={15} /><span>繼承：依系統預設與既有全域基礎設定；不寫入額外覆寫。</span></div>
        <p className="settings-note">一般使用者只會看到一個依身分優先序決定的儀表板；系統管理員可在首頁選擇角色／職稱預覽。預覽不會切換登入身分或代替權限檢查。</p>
      </section>
    </div>
  );
}
