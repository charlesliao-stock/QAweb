import { ReviewResultManager } from "../components/ReviewResultManager";
import { invalidateCachedYears } from "../../../lib/resultsCache";
import type { ResultsView } from "../hooks/useResultsAnalysis";

export function ResultsManageTab({ ctx }: { ctx: ResultsView }) {
  const { tab, isAdmin, units, groups, indicators, user, onAction, cacheScope, applied, setReloadNonce } = ctx;

  return <>{tab === "manage" && isAdmin && (
        <ReviewResultManager
          units={units}
          groups={groups}
          indicators={indicators}
          user={user ? { staffId: user.staffId, name: user.name } : null}
          onAction={onAction}
          onDone={(years) => {
            invalidateCachedYears("reviewRecords", years, cacheScope);
            if (applied) setReloadNonce((nonce) => nonce + 1);
          }}
        />
      )}</>;
}
