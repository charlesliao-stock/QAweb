/**
 * 結果分析共用篩選列（v1.88.33 結果分析介面修改）。
 * 三種查詢模式共用同一列篩選器：品管組、指標名稱（可下拉、可搜尋）、單位、
 * 西元年/月（起）、西元年/月（迄）、未審月份不顯示；另附結果列表上方的
 * 單位／人次切換開關（預設單位，三模式共用）。
 * 複合篩選（Q3）：品管組＋單位＋指標可同時選，交集過濾；
 * 優先順序：指標優先於單位優先於品管組。
 * 區間單位下拉已取消（Q6）：表頭固定一月一格，起迄年月就是全部。
 */
import { FilterPanel } from "../../../components/ui";
import { SelectField, SearchableSelect, ResultMonthPicker } from "../components/small";
import type { UnitMode } from "../model/types";
import { Search } from "lucide-react";
import type { ResultsView } from "../hooks/useResultsAnalysis";

export function ResultsQueryPanel({ ctx }: { ctx: ResultsView }) {
  const {
    section,
    tab,
    // 組別模式
    selGroup, setSelGroup,
    selIndG, setSelIndG,
    selUnitG, setSelUnitG,
    indicators,
    // 單位模式
    selGroupU, setSelGroupU,
    selUnit, setSelUnit,
    selIndU, setSelIndU,
    unitIndOptions,
    // 指標模式
    selGroup2, setSelGroup2,
    selIndicator, setSelIndicator,
    indTabIndicators,
    selUnitI, setSelUnitI,
    setErrorUnit,
    // 共用
    scopedGroups,
    scopedUnits,
    hasNaUnit,
    groupUnit,
    setUnitMode,
    startMonth, setStartMonth,
    endMonth, setEndMonth,
    hideEmptyMonths, setHideEmptyMonths,
    handleQuery, loading, rangeValid,
  } = ctx;

  if (section !== "analysis") return null;
  const unitOptions = [
    { value: "all", label: "全部單位" },
    ...scopedUnits.map((unit) => ({
      value: unit.code,
      label: `${unit.code}・${unit.name}`,
    })),
    ...(hasNaUnit ? [{ value: "NA", label: "NA（不限單位）" }] : []),
  ];
  const indicatorOptions = (list: { id: string; code: string; name: string }[]) =>
    list.map((indicator) => ({
      value: indicator.id,
      label: `${indicator.code}・${indicator.name}`,
    }));
  // 組別模式指標下拉選項＝該組全部指標（不用已依 selIndG 過濾的 groupIndicators，否則選過一次就選不到別支）。
  const groupAllIndicators = indicators.filter((i) => i.groupId === selGroup);

  return (
    <FilterPanel className="results-sticky-filter">
      {tab === "group" && (
        <>
          <SelectField
            label="品管組"
            value={selGroup}
            onChange={setSelGroup}
            options={scopedGroups.map((g) => ({ value: g.id, label: g.name }))}
          />
          <SearchableSelect
            label="指標名稱"
            value={selIndG}
            onChange={setSelIndG}
            options={[
              { value: "all", label: "全部指標" },
              ...indicatorOptions(groupAllIndicators),
            ]}
            placeholder="輸入編號或名稱搜尋"
          />
          <SelectField
            label="單位"
            value={selUnitG}
            onChange={setSelUnitG}
            options={unitOptions}
          />
        </>
      )}
      {tab === "unit" && (
        <>
          <SelectField
            label="品管組"
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
            options={scopedUnits.map((unit) => ({
              value: unit.code,
              label: `${unit.code}・${unit.name}`,
            })).concat(
              hasNaUnit ? [{ value: "NA", label: "NA（不限單位）" }] : [],
            )}
          />
          <SearchableSelect
            label="指標名稱"
            value={selIndU}
            onChange={setSelIndU}
            options={[
              { value: "all", label: "全部指標" },
              ...indicatorOptions(unitIndOptions),
            ]}
            placeholder="輸入編號或名稱搜尋"
          />
        </>
      )}
      {tab === "indicator" && (
        <>
          <SelectField
            label="品管組"
            value={selGroup2}
            onChange={setSelGroup2}
            options={scopedGroups.map((g) => ({ value: g.id, label: g.name }))}
          />
          <SearchableSelect
            label="指標名稱"
            value={selIndicator}
            onChange={setSelIndicator}
            options={indicatorOptions(indTabIndicators)}
            placeholder="輸入編號或名稱搜尋"
          />
          <SelectField
            label="單位"
            value={selUnitI}
            onChange={(value) => {
              setSelUnitI(value);
              // 錯誤分析與補充說明與摘要同看該單位（原 errorUnit 單獨篩選併入此欄）。
              setErrorUnit(value);
            }}
            options={unitOptions}
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
      {/* Q10：結果列表上方的單位／人次切換開關（預設單位；三模式共用，切換連動矩陣＋曲線＋細項＋下探）。 */}
      <div
        className="unit-mode-toggle"
        role="group"
        aria-label="單元切換：單位或人次"
      >
        <span className="unit-mode-toggle-label">單元</span>
        {(
          [
            ["unit", "單位"],
            ["person", "人次"],
          ] as [UnitMode, string][]
        ).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            aria-pressed={groupUnit === mode}
            className={groupUnit === mode ? "active" : ""}
            onClick={() => setUnitMode(mode)}
          >
            {label}
          </button>
        ))}
      </div>
    </FilterPanel>
  );
}
