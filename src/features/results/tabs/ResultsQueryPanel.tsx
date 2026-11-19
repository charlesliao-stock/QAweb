import { FilterPanel } from "../../../components/ui";
import { SelectField, ResultMonthPicker } from "../components/small";
import type { UnitMode } from "../model/types";
import type { AnalysisGranularity } from "../../../lib/analysisPeriod";
import { Search } from "lucide-react";
import type { ResultsView } from "../hooks/useResultsAnalysis";

export function ResultsQueryPanel({ ctx }: { ctx: ResultsView }) {
  const { tab, selGroup, setSelGroup, scopedGroups, groupUnit, setGroupUnit, errorUnit, setErrorUnit, scopedUnits, hasNaUnit, selGroupU, setSelGroupU, setSelIndU, selUnit, setSelUnit, unitUnit, setUnitUnit, selIndU, unitIndOptions, selGroup2, setSelGroup2, selIndicator, setSelIndicator, indTabIndicators, indUnit, setIndUnit, startMonth, setStartMonth, endMonth, setEndMonth, interval, handleIntervalChange, hideEmptyMonths, setHideEmptyMonths, handleQuery, loading, rangeValid } = ctx;

  return <>{tab !== "import" && tab !== "manage" && (
        <FilterPanel className="results-sticky-filter">
          {tab === "group" && (
            <>
              <SelectField
                label="組別"
                value={selGroup}
                onChange={setSelGroup}
                options={scopedGroups.map((g) => ({ value: g.id, label: g.name }))}
              />
              <SelectField
                label="單元"
                value={groupUnit}
                onChange={(value) => setGroupUnit(value as UnitMode)}
                options={[
                  { value: "person", label: "人次" },
                  { value: "unit", label: "單位" },
                ]}
              />
              <SelectField
                label="單位"
                value={errorUnit}
                onChange={setErrorUnit}
                options={[
                  { value: "all", label: "全部單位" },
                  ...scopedUnits.map((unit) => ({
                    value: unit.code,
                    label: `${unit.code}・${unit.name}`,
                  })),
                  ...(hasNaUnit
                    ? [{ value: "NA", label: "NA（不限單位）" }]
                    : []),
                ]}
              />
            </>
          )}
          {tab === "unit" && (
            <>
              <SelectField
                label="組別"
                value={selGroupU}
                onChange={(value) => {
                  setSelGroupU(value);
                  setSelIndU("all");
                }}
                options={[
                  { value: "all", label: "全部組別" },
                  ...scopedGroups.map((g) => ({ value: g.id, label: g.name })),
                ]}
              />
              <SelectField
                label="單位"
                value={selUnit}
                onChange={setSelUnit}
                options={[
                  ...scopedUnits.map((unit) => ({
                    value: unit.code,
                    label: `${unit.code}・${unit.name}`,
                  })),
                  ...(hasNaUnit
                    ? [{ value: "NA", label: "NA（不限單位）" }]
                    : []),
                ]}
              />
              <SelectField
                label="單元"
                value={unitUnit}
                onChange={(value) => setUnitUnit(value as UnitMode)}
                options={[
                  { value: "person", label: "人次" },
                  { value: "unit", label: "單位" },
                ]}
              />
              <SelectField
                label="指標"
                value={selIndU}
                onChange={setSelIndU}
                options={[
                  { value: "all", label: "全部指標" },
                  ...unitIndOptions.map((indicator) => ({
                    value: indicator.id,
                    label: `${indicator.code}・${indicator.name}`,
                  })),
                ]}
              />
            </>
          )}
          {tab === "indicator" && (
            <>
              <SelectField
                label="組別"
                value={selGroup2}
                onChange={setSelGroup2}
                options={scopedGroups.map((g) => ({ value: g.id, label: g.name }))}
              />
              <SelectField
                label="指標"
                value={selIndicator}
                onChange={setSelIndicator}
                options={indTabIndicators.map((indicator) => ({
                  value: indicator.id,
                  label: `${indicator.code}・${indicator.name}`,
                }))}
              />
              <SelectField
                label="單元"
                value={indUnit}
                onChange={(value) => setIndUnit(value as UnitMode)}
                options={[
                  { value: "person", label: "人次" },
                  { value: "unit", label: "單位" },
                ]}
              />
            </>
          )}
          <ResultMonthPicker
            label="西元年/月(起)"
            value={startMonth}
            onChange={setStartMonth}
            ariaLabel="起始西元年/月"
          />
          <span className="results-range-separator">~</span>
          <ResultMonthPicker
            label="西元年/月(訖)"
            value={endMonth}
            onChange={setEndMonth}
            ariaLabel="結束西元年/月"
          />
          <SelectField
            label="區間單位"
            value={interval}
            onChange={(value) => handleIntervalChange(value as AnalysisGranularity)}
            options={[
              { value: "month", label: "月" },
              { value: "year", label: "年" },
              { value: "academic", label: "學年" },
            ]}
          />
          <label className="check-row">
            <input
              type="checkbox"
              checked={hideEmptyMonths}
              onChange={(event) => setHideEmptyMonths(event.target.checked)}
            />
            未審月份不顯示
          </label>
          <div className="results-query-actions">
            <button
              type="button"
              className="button button-primary"
              onClick={handleQuery}
              disabled={loading || !rangeValid}
            >
              <Search size={16} />
              搜尋
            </button>
          </div>
          {!rangeValid && (
            <span className="results-range-error" role="alert">
              起始年月不可晚於結束年月。
            </span>
          )}
        </FilterPanel>
      )}</>;
}
