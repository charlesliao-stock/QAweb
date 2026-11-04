import { Plus } from "lucide-react";
import { EmptyState, PageHeading } from "../components/ui";

export function CapaPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  return (
    <>
      <PageHeading
        page="capa"
        action={
          <button
            className="button button-primary"
            onClick={() => onAction("資料串接完成後才能開立改善追蹤")}
          >
            <Plus size={16} />
            開立改善追蹤
          </button>
        }
      />
      <EmptyState
        title="尚未串接資料"
        description="CAPA 改善追蹤單將在 Firestore 串接完成後顯示。"
      />
    </>
  );
}
