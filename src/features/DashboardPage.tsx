import { useEffect, useMemo, useState } from "react";
import { Download, Eye, RotateCcw } from "lucide-react";
import { PageHeading } from "../components/ui";
import { useAuth } from "../lib/auth";
import { useOrgMeta } from "../lib/useOrgMeta";
import { getFirebaseDb } from "../lib/firebase";
import { doc } from "../lib/db";
import { getCachedRef, SYSTEM_CONFIG_KEY } from "../lib/refCache";
import { getDocCacheFirst } from "../lib/cacheFirst";
import { sortByLevel } from "../lib/orgLevels";
import {
  getDashboardVariants,
  VARIANT_LABELS,
  VARIANT_ORDER,
  type DashboardVariant,
} from "../lib/dashboardVariant";
import {
  parseDashboardSectionOverrides,
  dashboardVariantForRole,
  dashboardVariantForTitle,
  resolveDashboardSectionsForTarget,
  type DashboardSectionOverrides,
} from "../lib/dashboardVisibility";
import {
  parseDashboardSections,
  type DashboardSections,
} from "../lib/dashboardSections";
import { useDashboardData } from "./dashboard/useDashboardData";
import {
  ReviewExecutePage,
  type ExecuteTarget,
} from "./ReviewExecutePage";
import { ReviewerTab } from "./dashboard/ReviewerTab";
import { NurseTab } from "./dashboard/NurseTab";
import { HeadNurseTab } from "./dashboard/HeadNurseTab";
import { OfficerTab } from "./dashboard/OfficerTab";
import { ConvenerTab } from "./dashboard/ConvenerTab";
import { SupervisorTab } from "./dashboard/SupervisorTab";
import { DirectorTab } from "./dashboard/DirectorTab";
import type { StatsCycle } from "../lib/resultAnalysis";

interface DashboardPreview {
  kind: "role" | "title";
  id: string;
  name: string;
  variant: DashboardVariant;
}

const EMPTY_OVERRIDES: DashboardSectionOverrides = { roles: {}, titles: {} };

export function DashboardPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  const { user } = useAuth();
  const data = useDashboardData();
  const orgMeta = useOrgMeta();
  const [executing, setExecuting] = useState<ExecuteTarget | null>(null);
  const [previewValue, setPreviewValue] = useState("");
  /** 統計週期（systemParams/config.statsCycle；缺值預設 year） */
  const [statsCycle, setStatsCycle] = useState<StatsCycle>("year");
  const [adminSections, setAdminSections] = useState<Partial<DashboardSections>>({});
  const [sectionOverrides, setSectionOverrides] = useState<DashboardSectionOverrides>(EMPTY_OVERRIDES);
  const isAdmin = (user?.roles ?? []).includes("系統管理員");
  // 預覽下拉：依層級順序排列（層級 order → 儀表板優先序 → 名稱），無層級者排最後
  const roleOptions = useMemo(
    () => sortByLevel(
      orgMeta.roleTargets.filter((target) => target.name !== "系統管理員"),
      orgMeta.roleLevels,
      (target) => VARIANT_ORDER.indexOf(dashboardVariantForRole(target.name, orgMeta.roleMeta)),
    ),
    [orgMeta.roleTargets, orgMeta.roleLevels, orgMeta.roleMeta],
  );
  const titleOptions = useMemo(
    () => sortByLevel(
      orgMeta.titleTargets,
      orgMeta.titleLevels,
      (target) => VARIANT_ORDER.indexOf(dashboardVariantForTitle(target.flags)),
    ),
    [orgMeta.titleTargets, orgMeta.titleLevels],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snap = await getCachedRef(SYSTEM_CONFIG_KEY, () =>
          getDocCacheFirst(doc(getFirebaseDb(), "systemParams", "config")),
        );
        if (cancelled) return;
        const config = snap.data() as Record<string, unknown> | undefined;
        setStatsCycle(config?.statsCycle === "academic" ? "academic" : "year");
        setAdminSections(parseDashboardSections(config?.dashboardSections));
        setSectionOverrides(parseDashboardSectionOverrides(config?.dashboardSectionOverrides));
      } catch {
        if (!cancelled) setStatsCycle("year");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const variants = useMemo(
    () => getDashboardVariants(
      {
        roles: user?.roles ?? [],
        title: user?.title ?? "",
        titleId: user?.titleId,
        isAdmin,
      },
      {
        roleMeta: orgMeta.roleMeta,
        titleMeta: orgMeta.titleMeta,
        titleMetaById: orgMeta.titleMetaById,
      },
    ),
    [user, isAdmin, orgMeta.roleMeta, orgMeta.titleMeta, orgMeta.titleMetaById],
  );

  const preview = useMemo<DashboardPreview | null>(() => {
    if (!isAdmin || !previewValue) return null;
    if (previewValue.startsWith("role:")) {
      const id = previewValue.slice("role:".length);
      const target = roleOptions.find((item) => item.id === id);
      return target
        ? { kind: "role", id, name: target.name, variant: dashboardVariantForRole(target.name, orgMeta.roleMeta) }
        : null;
    }
    if (previewValue.startsWith("title:")) {
      const id = previewValue.slice("title:".length);
      const target = titleOptions.find((item) => item.id === id);
      return target
        ? { kind: "title", id, name: target.name, variant: dashboardVariantForTitle(target.flags) }
        : null;
    }
    return null;
  }, [isAdmin, previewValue, roleOptions, titleOptions, orgMeta.roleMeta]);

  useEffect(() => {
    if (isAdmin && previewValue && !preview) setPreviewValue("");
    if (!isAdmin && previewValue) setPreviewValue("");
  }, [isAdmin, previewValue, preview]);

  const active: DashboardVariant = isAdmin
    ? preview?.variant ?? "director"
    : variants[0] ?? "nurse";
  const roleIdsForPolicy = useMemo(() => {
    if (isAdmin) return preview?.kind === "role" ? [preview.id] : [];
    const assigned = new Set(user?.roles ?? []);
    return orgMeta.roleTargets
      .filter((target) => assigned.has(target.name) && dashboardVariantForRole(target.name, orgMeta.roleMeta) === active)
      .map((target) => target.id);
  }, [active, isAdmin, preview, user?.roles, orgMeta.roleTargets, orgMeta.roleMeta]);
  const titleIdForPolicy = useMemo(() => {
    if (isAdmin) return preview?.kind === "title" ? preview.id : "";
    const profileTitleId = user?.titleId ?? "";
    if (profileTitleId && orgMeta.titleTargets.some((target) => target.id === profileTitleId)) return profileTitleId;
    return orgMeta.titleTargets.find((target) => target.name === user?.title)?.id ?? "";
  }, [isAdmin, preview, user?.titleId, user?.title, orgMeta.titleTargets]);
  const sections = useMemo(
    () => resolveDashboardSectionsForTarget({
      base: adminSections,
      overrides: sectionOverrides,
      roleIds: roleIdsForPolicy,
      titleId: titleIdForPolicy,
    }),
    [adminSections, sectionOverrides, roleIdsForPolicy, titleIdForPolicy],
  );

  // 審查表單／查詢執行中 → 顯示執行頁（返回時重讀資料）
  if (executing) {
    return (
      <ReviewExecutePage
        target={executing}
        onBack={() => {
          setExecuting(null);
          data.reload();
        }}
        onAction={onAction}
      />
    );
  }

  const welcomeText = isAdmin
    ? preview
      ? `目前以「${preview.name}」的${VARIANT_LABELS[active]}儀表板版型預覽；實際資料與權限仍依系統管理員登入身分。`
      : "目前為系統管理者視角；您可預覽其他角色／職稱的儀表板呈現。"
    : `以下為您唯一的${VARIANT_LABELS[active]}儀表板；頁面與資料權限仍依系統實際授權。`;

  return (
    <div className="dashboard-page" data-dashboard-variant={active}>
      <PageHeading
        page="dashboard"
        action={
          <button
            className="button button-outline"
            onClick={() => onAction("資料串接完成後才能匯出摘要")}
          >
            <Download size={16} />
            匯出摘要
          </button>
        }
      />
      <div className="dashboard-welcome">
        <div>
          <span className="welcome-kicker">QUALITY SNAPSHOT</span>
          <h2>本月品質查核進度總覽</h2>
          <p>{user?.name ? `${user.name}，` : ""}{welcomeText}</p>
        </div>
        <div className="welcome-art" aria-hidden="true">
          <div className="art-ring ring-one" />
          <div className="art-ring ring-two" />
          <div className="art-cross">
            <span />
            <i />
          </div>
          <div className="art-dot dot-a" />
          <div className="art-dot dot-b" />
          <div className="art-dot dot-c" />
        </div>
      </div>

      {isAdmin && (
        <section className="dashboard-preview-bar" aria-label="系統管理者儀表板預覽">
          <div className="dashboard-preview-copy">
            <span className="dashboard-preview-kicker"><Eye size={14} />系統管理者專用</span>
            <strong>角色／職稱畫面預覽</strong>
            <p>僅預覽版面與顯示項目，不會切換登入身分、資料範圍或頁面權限。</p>
          </div>
          <div className="dashboard-preview-controls">
            <label>
              <span className="sr-only">選擇要預覽的角色或職稱</span>
              <select value={previewValue} onChange={(event) => setPreviewValue(event.target.value)} aria-label="選擇要預覽的角色或職稱">
                <option value="">系統管理者視角</option>
                {titleOptions.length > 0 && <optgroup label="依職稱預覽">{titleOptions.map((target) => <option key={`title:${target.id}`} value={`title:${target.id}`}>{target.name} · {VARIANT_LABELS[dashboardVariantForTitle(target.flags)]}</option>)}</optgroup>}
                {roleOptions.length > 0 && <optgroup label="依角色預覽">{roleOptions.map((target) => <option key={`role:${target.id}`} value={`role:${target.id}`}>{target.name} · {VARIANT_LABELS[dashboardVariantForRole(target.name, orgMeta.roleMeta)]}</option>)}</optgroup>}
              </select>
            </label>
            {preview && <button className="button button-outline" type="button" onClick={() => setPreviewValue("")}><RotateCcw size={14} />返回管理者視角</button>}
          </div>
        </section>
      )}

      {data.loading ? (
        <p className="settings-note">讀取儀表板資料中…</p>
      ) : (
        <>
          {data.correctionSkipped && (
            <p className="settings-note" style={{ color: "#b3372f", fontWeight: 600 }}>
              逾期任務自動校正暫時無法執行（索引建立中），請稍後重新整理；其他內容不受影響。
            </p>
          )}
          {data.correctionFailed && (
            <p className="settings-note" style={{ color: "#b3372f", fontWeight: 600 }}>
              部分任務狀態自動校正寫入失敗，下次載入會再試；若持續出現請通知系統管理員。
            </p>
          )}
          {active === "reviewer" && <ReviewerTab data={data} staffId={user?.staffId ?? ""} onExecute={setExecuting} sections={sections} />}
          {active === "nurse" && <NurseTab data={data} staffId={user?.staffId ?? ""} unitCode={user?.unitCode ?? ""} sections={sections} />}
          {active === "headNurse" && <HeadNurseTab data={data} unitCode={user?.unitCode ?? ""} sections={sections} />}
          {active === "officer" && <OfficerTab data={data} staffId={user?.staffId ?? ""} onAction={onAction} sections={sections} />}
          {active === "convener" && <ConvenerTab data={data} sections={sections} />}
          {active === "supervisor" && <SupervisorTab data={data} titleUnitCodes={user?.titleUnitCodes ?? []} cycle={statsCycle} sections={sections} />}
          {active === "director" && <DirectorTab data={data} sections={sections} />}
        </>
      )}
    </div>
  );
}
