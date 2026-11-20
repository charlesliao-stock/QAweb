/**
 * 結果分析共用篩選列（v1.88.33 結果分析介面修改；其後改為篩選器決定檢視）。
 * 單一組篩選器：品管組、指標名稱（原生下拉）、單位、
 * 西元年/月（起）、西元年/月（迄）、未審月份不顯示。
 * 三者皆可「未選」——檢視由篩選決定，不再有組別／單位／指標模式標籤：
 * 指標有選 → 單一指標分析；未選指標、單位有選 → 單位分析；
 * 未選指標與單位、品管組有選 → 品管組分析（判定在 handleQuery，
 * 優先順序指標＞單位＞品管組；三者皆未選時按搜尋只顯示提示、不查詢）。
 * 複合篩選（Q3）：品管組＋單位＋指標可同時選，交集過濾。
 * 區間單位下拉已取消（Q6）：表頭固定一月一格，起迄年月就是全部。
 * 單位／人次切換開關已移出篩選列（搜尋後才出現在結果矩陣區，見 UnitModeToggle）。
 */
import { FilterPanel } from "../../../components/ui";
import { SelectField, ResultMonthPicker } from "../components/small";
import { Search } from "lucide-react";
import type { ResultsView } from "../hooks/useResultsAnalysis";

export function ResultsQueryPanel({ ctx }: { ctx: ResultsView }) {
  const {
    section,
    indicators,
    selGroup, setSelGroup,
    setSelGroupU,
    setSelGroup2,
    selIndicator, setSelIndicator,
    setSelIndG,
    setSelIndU,
    selUnit, setSelUnit,
    setSelUnitG,
    setSelUnitI,
    setErrorUnit,
    scopedGroups,
    scopedUnits,
    hasNaUnit,
    searchPrompt,
    startMonth, setStartMonth,
    endMonth, setEndMonth,
    hideEmptyMonths, setHideEmptyMonths,
    handleQuery, loading, rangeValid,
  } = ctx;

  if (section !== "analysis") return null;

  // 單一篩選列同時寫回三套舊 state（組別／單位／指標模式各一套），
  // 下游矩陣／曲線／細項／下探皆讀它們；檢視（tab）由 handleQuery 推導。
  const onGroupChange = (value: string) => {
    setSelGroup(value);
    setSelGroupU(value || "all");
    setSelGroup2(value);
    // 換組別時，若已選指標不在該組，清空指標（改回品管組分析）；
    // 清空組別（未選）時不清空指標，指標可單獨決定檢視。
    if (value) {
      const ind = indicators.find((i) => i.id === selIndicator);
      if (ind && ind.groupId !== value) {
        setSelIndicator("");
        setSelIndG("all");
        setSelIndU("all");
      }
    }
  };
  const onIndicatorChange = (value: string) => {
    setSelIndicator(value);
    setSelIndG(value || "all");
    setSelIndU(value || "all");
    if (value) {
      const ind = indicators.find((i) => i.id === value);
      if (ind) setSelGroup2(ind.groupId);
    }
  };
  const onUnitChange = (value: string) => {
    setSelUnit(value);
    setSelUnitG(value || "all");
    setSelUnitI(value || "all");
    // 錯誤分析與補充說明與摘要同看該單位（原 errorUnit 單獨篩選併入此欄）。
    setErrorUnit(value || "all");
  };

  const unitOptions = [
    { value: "", label: "未選" },
    ...scopedUnits.map((unit) => ({
      value: unit.code,
      label: `${unit.code}・${unit.name}`,
    })),
    ...(hasNaUnit ? [{ value: "NA", label: "NA（不限單位）" }] : []),
  ];
  // 指標選項：有選品管組時只列該組指標；未選組別時列全部指標。
  const indicatorList = selGroup
    ? indicators.filter((i) => i.groupId === selGroup)
    : indicators;
  const nothingSelected = !selGroup && !selIndicator && !selUnit;

  return (
    <FilterPanel className="results-sticky-filter">
      <SelectField
        label="品管組"
        value={selGroup}
        onChange={onGroupChange}
        options={[
          { value: "", label: "未選" },
          ...scopedGroups.map((g) => ({ value: g.id, label: g.name })),
        ]}
      />
      <SelectField
        label="指標名稱"
        value={selIndicator}
        onChange={onIndicatorChange}
        options={[
          { value: "", label: "全部指標" },
          ...indicatorList.map((indicator) => ({
            value: indicator.id,
            label: `${indicator.code} ${indicator.name}`,
          })),
        ]}
      />
      <SelectField
        label="單位"
        value={selUnit}
        onChange={onUnitChange}
        options={unitOptions}
      />
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
      {searchPrompt && nothingSelected && (
        <span className="results-range-error" role="alert">
          {searchPrompt}
        </span>
      )}
    </FilterPanel>
  );
}
