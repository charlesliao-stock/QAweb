import { BatchImporter } from "../../components/BatchImporter";
import { UNIT_SAMPLE, UNIT_HEADER } from "../../importers/samples";
import type { GroupsCtx } from "../../hooks/useGroupsCtx";

export function UnitImportBar({ ctx }: { ctx: GroupsCtx }) {
  const { tab, unitView, isAdmin, validateUnitRows, importUnitRows, loadMaster, onAction } = ctx;

  return <>{tab === "units" && unitView.kind !== "edit" && isAdmin && (
        <div className="batch-toolbar">
          <BatchImporter
            sampleBaseName="單位範例"
            sampleRows={UNIT_SAMPLE}
            header={UNIT_HEADER}
            validateRows={validateUnitRows}
            importRows={importUnitRows}
            onDone={loadMaster}
            onAction={onAction}
          />
        </div>
      )}</>;
}
