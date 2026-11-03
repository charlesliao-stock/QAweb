import { Plus } from "lucide-react";
import { EmptyState, PageHeading } from "../components/ui";

export function IndicatorsPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  return (
    <>
      <PageHeading
        page="indicators"
        action={
          <button
            className="button button-primary"
            onClick={() => onAction("資料串接完成後才能新增指標")}
          >
            <Plus size={16} />
            新增指標
          </button>
        }
      />
      <EmptyState
        title="尚未串接資料"
        description="指標清單、版本與閾值將在 Firestore 串接完成後顯示。"
      />
    </>
  );
}
