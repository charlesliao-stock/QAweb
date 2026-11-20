import { ResultImportPanel } from "../components/ResultImportPanel";
import { invalidateCachedYears } from "../../../lib/resultsCache";
import type { ResultsView } from "../hooks/useResultsAnalysis";

export function ResultsImportTab({ ctx }: { ctx: ResultsView }) {
  const { section, isAdmin, indicators, metaLoaded, user, onAction, applied, cacheScope, setReloadNonce } = ctx;

  // v1.88.33 Q12：結果匯入僅系統管理員可見可用。
  return <>{section === "import" && isAdmin && (
        <ResultImportPanel
          indicators={indicators}
          indicatorsLoaded={metaLoaded}
          user={user ? { staffId: user.staffId, name: user.name } : null}
          onAction={onAction}
          onDone={(years) => {
            // 尚未搜尋：不觸發重拉，否則匯入完又把整年紀錄拉回來、閘門白做。
            // 已查過：只失效匯入年份的快取，下次 effect 只補查該年。
            if (!applied) return;
            invalidateCachedYears("reviewRecords", years, cacheScope);
            setReloadNonce((n) => n + 1);
          }}
        />
      )}</>;
}
