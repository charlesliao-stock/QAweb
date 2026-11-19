import { FilterPanel, FormSelect, FilterSearchField } from "../../../../components/ui";
import type { GroupsCtx } from "../../hooks/useGroupsCtx";

export function UnitFilterBar({ ctx }: { ctx: GroupsCtx }) {
  const { tab, unitView, unitGroupFilter, unitSearch, setUnitGroupFilter, setUnitSearch, setAppliedUnitGroupFilter, setAppliedUnitSearch, groups, setUnitsSearched } = ctx;

  return <>{tab === "units" && unitView.kind === "list" && (
        <FilterPanel
          actions={
            (unitGroupFilter || unitSearch) && (
              <button
                type="button"
                className="button button-outline button-sm"
                onClick={() => {
                  setUnitGroupFilter("");
                  setUnitSearch("");
                  setAppliedUnitGroupFilter("");
                  setAppliedUnitSearch("");
                }}
              >
                清除篩選
              </button>
            )
          }
        >
          <FormSelect label="組別" value={unitGroupFilter}
                aria-label="依組別篩選單位"
                onChange={(e) => setUnitGroupFilter(e.target.value)}>
                <option value="">全部組別</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </FormSelect>
          <FilterSearchField
            label="單位關鍵字"
            placeholder="搜尋單位代號／名稱"
            value={unitSearch}
            onChange={setUnitSearch}
            onSearch={() => {
              setAppliedUnitGroupFilter(unitGroupFilter);
              setAppliedUnitSearch(unitSearch);
              setUnitsSearched(true);
            }}
          />
        </FilterPanel>
      )}</>;
}
