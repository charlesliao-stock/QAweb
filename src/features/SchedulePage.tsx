import { Plus } from "lucide-react";
import { EmptyState, PageHeading } from "../components/ui";

export function SchedulePage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  return (
    <>
      <PageHeading
        page="schedule"
        action={
          <button
            className="button button-primary"
            onClick={() => onAction("資料串接完成後才能建立排程")}
          >
            <Plus size={16} />
            建立排程
          </button>
        }
      />
      <EmptyState
        title="尚未串接資料"
        description="審查排程、任務指派與逾期項目將在 Firestore 串接完成後顯示。"
      />
    </>
  );
}
