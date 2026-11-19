import { LoadingState, ErrorState, EmptyState } from "../../../../components/ui";
import type { GroupsCtx } from "../../hooks/useGroupsCtx";

export function TitlesListTab({ ctx }: { ctx: GroupsCtx }) {
  const { titlesLoading, levelsLoading, titlesLoadError, levelsLoadError, loadTitles, loadLevels, titles, renderLevelCreate, titleSections, renderLevelHead, renderTitleTable } = ctx;

  return (
    (
            titlesLoading || levelsLoading ? (
              <LoadingState label="職稱與層級資料載入中…" />
            ) : titlesLoadError || levelsLoadError ? (
              <ErrorState
                title="職稱資料載入失敗"
                description={titlesLoadError || levelsLoadError}
                onRetry={() => { void Promise.all([loadTitles(), loadLevels()]); }}
              />
            ) : titles.length === 0 ? (
              <EmptyState
                title="尚無職稱"
                description="使用右上角「新增職稱」或「批次上傳」建立職稱。"
              />
            ) : (
              <section className="panel data-panel">
                {renderLevelCreate("title")}
                {titleSections.map((section) => (
                  <div className="level-section" key={section.level?.id ?? "ungrouped"}>
                    {renderLevelHead(
                      "title",
                      section.level,
                      section.items.reduce((n, r) => n + (r.userCount ?? 0), 0),
                    )}
                    {renderTitleTable(section.items)}
                  </div>
                ))}
                <div className="panel-inset">
                  <p className="settings-note">
                    職稱以名稱唯一；可在此新增職稱、管理成員或刪除職稱。職稱權限請到「組織與設定 → 權限管理」設定（按名稱共用）。
                  </p>
                </div>
              </section>
            )
          )
  );
}
