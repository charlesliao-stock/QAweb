import { BatchImporter } from "../../components/BatchImporter";
import { TITLE_SAMPLE, TITLE_HEADER } from "../../importers/samples";
import type { GroupsCtx } from "../../hooks/useGroupsCtx";

export function TitleImportBar({ ctx }: { ctx: GroupsCtx }) {
  const { tab, titleView, isAdmin, validateTitleRows, importTitleRows, loadTitles, onAction } = ctx;

  return <>{tab === "titles" && titleView.kind !== "edit" && isAdmin && (
        <div className="batch-toolbar">
          <BatchImporter
            sampleBaseName="職稱範例"
            sampleRows={TITLE_SAMPLE}
            header={TITLE_HEADER}
            validateRows={validateTitleRows}
            importRows={importTitleRows}
            onDone={loadTitles}
            onAction={onAction}
          />
        </div>
      )}</>;
}
