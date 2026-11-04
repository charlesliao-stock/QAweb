/**
 * 儀表板（v1.15.0）：多角色頁籤。
 * 依登入者職稱／角色決定顯示哪些變體（主任＞督導＞護理長＞執行幹事＞
 * 召集人＞審查員＞護理師；系統管理員七種全開），預設停在優先序最高者。
 */
import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { PageHeading } from "../components/ui";
import { useAuth } from "../lib/auth";
import { getFirebaseDb } from "../lib/firebase";
import { doc, getDoc } from "../lib/db";
import {
  getDashboardVariants,
  VARIANT_LABELS,
  type DashboardVariant,
} from "../lib/dashboardVariant";
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

export function DashboardPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  const { user } = useAuth();
  const data = useDashboardData();
  const [executing, setExecuting] = useState<ExecuteTarget | null>(null);
  const [vtab, setVtab] = useState<DashboardVariant | null>(null);
  /** 統計週期（系統參數 systemParams.statsCycle；缺值預設 'year'） */
  const [statsCycle, setStatsCycle] = useState<StatsCycle>("year");

  useEffect(() => {
    (async () => {
      try {
        const snap = await getDoc(
          doc(getFirebaseDb(), "systemParams", "config"),
        );
        const v = snap.data()?.statsCycle;
        setStatsCycle(v === "academic" ? "academic" : "year");
      } catch {
        setStatsCycle("year");
      }
    })();
  }, []);

  const variants = useMemo(
    () =>
      getDashboardVariants({
        roles: user?.roles ?? [],
        title: user?.title ?? "",
        isAdmin: (user?.roles ?? []).includes("系統管理員"),
      }),
    [user],
  );
  const active: DashboardVariant = vtab ?? variants[0] ?? "nurse";

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

  return (
    <>
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
          <p>
            {user?.name ? `${user.name}，` : ""}以下為您身分的儀表板
            {variants.length > 1 ? "（可切換頁籤）" : ""}。
          </p>
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

      {variants.length > 1 && (
        <div className="tabs" style={{ marginBottom: 12 }} role="tablist">
          {variants.map((v) => (
            <button
              key={v}
              className={`tab${active === v ? " active" : ""}`}
              role="tab"
              aria-selected={active === v}
              onClick={() => setVtab(v)}
            >
              {VARIANT_LABELS[v]}
            </button>
          ))}
        </div>
      )}

      {data.loading ? (
        <p className="settings-note">讀取儀表板資料中…</p>
      ) : (
        <>
          {active === "reviewer" && (
            <ReviewerTab
              data={data}
              staffId={user?.staffId ?? ""}
              onExecute={setExecuting}
            />
          )}
          {active === "nurse" && (
            <NurseTab
              data={data}
              staffId={user?.staffId ?? ""}
              unitCode={user?.unitCode ?? ""}
            />
          )}
          {active === "headNurse" && (
            <HeadNurseTab data={data} unitCode={user?.unitCode ?? ""} />
          )}
          {active === "officer" && (
            <OfficerTab
              data={data}
              staffId={user?.staffId ?? ""}
              onAction={onAction}
            />
          )}
          {active === "convener" && <ConvenerTab data={data} />}
          {active === "supervisor" && (
            <SupervisorTab
              data={data}
              districtGroupIds={user?.districtGroupIds ?? []}
              cycle={statsCycle}
            />
          )}
          {active === "director" && <DirectorTab data={data} />}
        </>
      )}
    </>
  );
}
