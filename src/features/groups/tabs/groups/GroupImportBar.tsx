import { BatchImporter } from "../../components/BatchImporter";
import { GROUP_SAMPLE, GROUP_HEADER } from "../../importers/samples";
import type { GroupsCtx } from "../../hooks/useGroupsCtx";

export function GroupImportBar({ ctx }: { ctx: GroupsCtx }) {
  const { tab, groupView, isAdmin, validateGroupRows, importGroupRows, loadMaster, onAction } = ctx;

  return <>{tab === "groups" && groupView.kind !== "edit" && isAdmin && (
        <div className="batch-toolbar">
          <BatchImporter
            sampleBaseName="品管組範例"
            sampleRows={GROUP_SAMPLE}
            header={GROUP_HEADER}
            validateRows={validateGroupRows}
            importRows={importGroupRows}
            onDone={loadMaster}
            onAction={onAction}
          />
        </div>
      )}</>;
}
