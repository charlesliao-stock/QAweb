import { FilterPanel, FormSelect, FilterSearchField } from "../../../../components/ui";
import type { GroupsCtx } from "../../hooks/useGroupsCtx";

export function UserFilterBar({ ctx }: { ctx: GroupsCtx }) {
  const { tab, userView, isAdmin, userUnitFilter, userSearch, setUserUnitFilter, setUserSearch, setAppliedUserUnitFilter, setAppliedUserSearch, units, setUsersSearched, backfilling, handleBackfillReviewers } = ctx;

  return <>{tab === "users" && userView.kind === "list" && isAdmin && (
        <FilterPanel
          actions={
            (userUnitFilter || userSearch) && (
              <button
                type="button"
                className="button button-outline button-sm"
                onClick={() => {
                  setUserUnitFilter("");
                  setUserSearch("");
                  setAppliedUserUnitFilter("");
                  setAppliedUserSearch("");
                }}
              >
                清除篩選
              </button>
            )
          }
        >
          <FormSelect label="單位" value={userUnitFilter}
                aria-label="依單位篩選人員"
                onChange={(e) => setUserUnitFilter(e.target.value)}>
                <option value="">全部單位</option>
                {units.map((unit) => (
                  <option key={unit.code} value={unit.code}>
                    {unit.name}（{unit.code}）
                  </option>
                ))}
              </FormSelect>
          <FilterSearchField
            label="人員關鍵字"
            placeholder="搜尋職編／姓名"
            value={userSearch}
            onChange={setUserSearch}
            onSearch={() => {
              setAppliedUserUnitFilter(userUnitFilter);
              setAppliedUserSearch(userSearch);
              setUsersSearched(true);
            }}
          />
          <button
            className="button button-outline button-sm"
            disabled={backfilling}
            onClick={handleBackfillReviewers}
            title="為現有具審查員角色但不在審查員名單內的人員補建名單文件（未分類）"
          >
            {backfilling ? "補建中…" : "補建審查員名單"}
          </button>
        </FilterPanel>
      )}</>;
}
