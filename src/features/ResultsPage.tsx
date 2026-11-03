import { Download } from "lucide-react";
import { EmptyState, PageHeading } from "../components/ui";

export function ResultsPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  return (
    <>
      <PageHeading
        page="results"
        action={
          <button
            className="button button-outline"
            onClick={() => onAction("資料串接完成後才能匯出報表")}
          >
            <Download size={16} />
            匯出報表
          </button>
        }
      />
      <EmptyState
        title="尚未串接資料"
        description="指標趨勢、達標統計與結果明細將在審查紀錄串接完成後顯示。資料歸屬依排程月份與單位代號。"
      />
    </>
  );
}
