import { Plus } from "lucide-react";
import { EmptyState, PageHeading } from "../components/ui";

export function GroupsPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  return (
    <>
      <PageHeading
        page="groups"
        action={
          <button
            className="button button-primary"
            onClick={() => onAction("資料串接完成後才能新增群組")}
          >
            <Plus size={16} />
            新增群組
          </button>
        }
      />
      <EmptyState
        title="尚未串接資料"
        description="組織群組階層、成員與授權範圍將在人員主檔串接完成後顯示。"
      />
    </>
  );
}
