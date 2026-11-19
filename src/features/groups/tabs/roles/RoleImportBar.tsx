import { BatchImporter } from "../../components/BatchImporter";
import { ROLE_SAMPLE, ROLE_HEADER } from "../../importers/samples";
import type { GroupsCtx } from "../../hooks/useGroupsCtx";

export function RoleImportBar({ ctx }: { ctx: GroupsCtx }) {
  const { tab, managingRole, isAdmin, validateRoleRows, importRoleRows, loadRoles, onAction } = ctx;

  return <>{tab === "roles" && !managingRole && isAdmin && (
        <div className="batch-toolbar">
          <BatchImporter
            sampleBaseName="角色範例"
            sampleRows={ROLE_SAMPLE}
            header={ROLE_HEADER}
            validateRows={validateRoleRows}
            importRows={importRoleRows}
            onDone={loadRoles}
            onAction={onAction}
          />
        </div>
      )}</>;
}
