import { Download } from "lucide-react";
import { EmptyState, PageHeading } from "../components/ui";
import type { Role } from "../types";

export function DashboardPage({
  role,
  onAction,
}: {
  role: Role;
  onAction: (message: string) => void;
}) {
  const isIndividual = role === "一般人員";
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
          <h2>
            {isIndividual
              ? "照顧品質，從每一次查核累積"
              : "本月品質查核進度總覽"}
          </h2>
          <p>指標進度、審查任務與單位達標狀況，將在資料串接後顯示。</p>
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
      <EmptyState
        title="尚未串接資料"
        description="儀表板數據將在指標、排程與審查紀錄串接完成後顯示。"
      />
    </>
  );
}
