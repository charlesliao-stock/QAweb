import { useEffect, useMemo, useState } from "react";
import { SectionTitle } from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { usePermissions } from "../../lib/usePermissions";
import {
  COMMITTEE_GROUP_ID,
  UNGROUPED_GROUP_ID,
  isConvenerRole,
} from "../../lib/roleIdentity";
import type { DashboardVariant } from "../../lib/dashboardVariant";
import { countCapaPendingReview } from "../../lib/dashboardVisibility";
import { loadCapaPendingApprovalCases } from "../capa/store";

export function CapaPendingReviewCard({ variant }: { variant: Extract<DashboardVariant, "headNurse" | "supervisor" | "director" | "convener"> }) {
  const { user } = useAuth();
  const { can, isAdmin, ready, catalog } = usePermissions();
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const allowed = can("page.capa");
  const unitCodes = useMemo(() => {
    if (isAdmin || variant === "director") return null;
    if (variant === "headNurse") return user?.unitCode ? [user.unitCode] : [];
    if (variant === "convener") {
      // v1.88.28：召集人頁籤補 CAPA 待審核卡，範圍＝其品管組內全部單位
      //（dataScope A5 口徑：memberships 的召集人角色所屬群組 → 該組全部單位；
      // 單位→群組對照來自 catalog.unitGroups，鍵為單位代碼）。
      const groupIds = new Set(
        (user?.memberships ?? [])
          .filter(
            (m) =>
              m.groupId &&
              m.groupId !== COMMITTEE_GROUP_ID &&
              m.groupId !== UNGROUPED_GROUP_ID &&
              isConvenerRole(m.roles),
          )
          .map((m) => m.groupId),
      );
      return Object.entries(catalog.unitGroups)
        .filter(([, gid]) => groupIds.has(gid))
        .map(([code]) => code);
    }
    return user?.titleUnitCodes ?? [];
  }, [isAdmin, user?.unitCode, user?.titleUnitCodes, user?.memberships, catalog, variant]);
  const unitKey = unitCodes === null ? "all" : unitCodes.join("|");

  useEffect(() => {
    let cancelled = false;
    setCount(null);
    setFailed(false);
    if (!ready || !allowed || (unitCodes !== null && unitCodes.length === 0)) return () => { cancelled = true; };
    setLoading(true);
    void loadCapaPendingApprovalCases()
      .then((cases) => {
        if (cancelled) return;
        const scoped = unitCodes === null
          ? cases
          : cases.filter((item) => unitCodes.includes(item.unitCode));
        setCount(countCapaPendingReview(scoped));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [allowed, ready, unitCodes, unitKey]);

  const scopeLabel = unitCodes === null
    ? "全院摘要"
    : variant === "headNurse"
      ? "所屬單位摘要"
      : variant === "convener"
        ? "所屬品管組摘要"
        : "負責轄區摘要";

  return (
    <section className="panel dashboard-capa-summary" aria-live="polite">
      <SectionTitle title="CAPA 待審核" note={`${scopeLabel} · 只顯示件數，不列案件或人員資料`} />
      {!ready ? (
        <p className="settings-note">確認 CAPA 檢視權限中…</p>
      ) : !allowed ? (
        <p className="settings-note">此帳號尚未取得 CAPA 案件檢視權限；儀表板設定不會授予此權限。</p>
      ) : loading ? (
        <p className="settings-note">讀取待核准件數中…</p>
      ) : failed ? (
        <p className="settings-note">CAPA 摘要暫時無法載入，案件資料未受影響。</p>
      ) : unitCodes !== null && unitCodes.length === 0 ? (
        <p className="settings-note">
          {variant === "convener"
            ? "尚未設定所屬品管組，無法計算品管組摘要。"
            : "尚未設定負責單位，無法計算轄區摘要。"}
        </p>
      ) : (
        <div className="dashboard-capa-count">
          <strong>{count ?? 0}</strong>
          <span>件待審</span>
          {count === 0 && <small>目前沒有待審核案件。</small>}
        </div>
      )}
    </section>
  );
}
