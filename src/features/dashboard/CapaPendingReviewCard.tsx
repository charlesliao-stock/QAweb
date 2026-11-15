import { useEffect, useMemo, useState } from "react";
import { SectionTitle } from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { usePermissions } from "../../lib/usePermissions";
import type { DashboardVariant } from "../../lib/dashboardVariant";
import { countCapaPendingReview } from "../../lib/dashboardVisibility";
import { loadCapaCases } from "../capa/store";

export function CapaPendingReviewCard({ variant }: { variant: Extract<DashboardVariant, "headNurse" | "supervisor" | "director"> }) {
  const { user } = useAuth();
  const { can, isAdmin, ready } = usePermissions();
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const allowed = can("page.capa");
  const unitCodes = useMemo(() => {
    if (isAdmin || variant === "director") return null;
    if (variant === "headNurse") return user?.unitCode ? [user.unitCode] : [];
    return user?.titleUnitCodes ?? [];
  }, [isAdmin, user?.unitCode, user?.titleUnitCodes, variant]);
  const unitKey = unitCodes === null ? "all" : unitCodes.join("|");

  useEffect(() => {
    let cancelled = false;
    setCount(null);
    setFailed(false);
    if (!ready || !allowed || (unitCodes !== null && unitCodes.length === 0)) return () => { cancelled = true; };
    setLoading(true);
    void loadCapaCases()
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
      : "負責轄區摘要";

  return (
    <section className="panel dashboard-capa-summary" aria-live="polite">
      <SectionTitle title="CAPA 待結案核准" note={`${scopeLabel} · 只顯示件數，不列案件或人員資料`} />
      {!ready ? (
        <p className="settings-note">確認 CAPA 檢視權限中…</p>
      ) : !allowed ? (
        <p className="settings-note">此帳號尚未取得 CAPA 案件檢視權限；儀表板設定不會授予此權限。</p>
      ) : loading ? (
        <p className="settings-note">讀取待核准件數中…</p>
      ) : failed ? (
        <p className="settings-note">CAPA 摘要暫時無法載入，案件資料未受影響。</p>
      ) : unitCodes !== null && unitCodes.length === 0 ? (
        <p className="settings-note">尚未設定負責單位，無法計算轄區摘要。</p>
      ) : (
        <div className="dashboard-capa-count">
          <strong>{count ?? 0}</strong>
          <span>件待審</span>
          {count === 0 && <small>目前沒有待結案核准案件。</small>}
        </div>
      )}
    </section>
  );
}
