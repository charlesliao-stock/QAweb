/**
 * 結果分析頁（v1.25.0：取代舊畫面；v1.44.0：分組計分改 1A／2B 口徑，不再讀預存摘要）。
 * 四個分析／匯入頁籤；系統管理員另可使用審查結果管理。
 * 期間模型：年別／年份（起算年）／年數（往後數）／區間（月／季／年）／子選項
 * （月→只有全部；季→第一～四季／全部；年→半年／一年／全部），矩陣欄＝期間欄。
 * 達閾值＝紀錄 rate ≥ 指標閾值（逐筆優先用排程快照 thresholdAtSchedule，
 * 匯入紀錄無快照才用現行指標閾值）；人次率＝合併計算，單位彙總率＝各單位率平均。
 * 分組／逐題明細只在指標「啟用分組計分」開啟時顯示；人次模式分子分母與主格
 * 同口徑（分組達標人次／總人次），單位模式 v1.49.0 起亦與主格同口徑；一律讀原始
 * reviewRecords 即時算，不讀 reviewSummaries。
 * 權限：can("resultQuery")；資料範圍：管理員全部、審查員只看負責單位、
 * 一般人員只看自己單位（沿用舊頁規則）。
 */
import { useMemo } from "react";
import { FileText, Plus, Search, TrendingUp, X } from "lucide-react";
import { cellsInMonths, columnThresholdFromCells, passRateFromCells, personScoringRowsFromCells, questionSummariesFromCells, unitPassRateFromCells, unitPeriodPassRateFromCells, unitScoringRowsFromCells } from "../lib/reviewSummary";
import { stripInternalIdPrefix } from "../lib/indicators";
import { staffLabel } from "../lib/mask";
import { EmptyState, FilterPanel, PageHeading, SectionTitle, SummaryCell } from "../components/ui";
import { TrendChart } from "../components/TrendChart";
import { type AnalysisGranularity } from "../lib/analysisPeriod";
import { type RowSpan } from "../lib/analysisSpans";
import { formatPassRate, collectConsolidatedRecordNotes, optionDetailRows, questionErrorRows, questionErrorRowsFromSummaries, columnThresholdOf, passRateOf, personScoringBreakdownRows, recordsInMonths, unitPassRate, unitPeriodPassRate, unitScoringBreakdownRows, type PassRate } from "../lib/analysisRates";
import { invalidateCachedYears } from "../lib/resultsCache";
import { recordsForIndex } from "../lib/resultsMatrix";
import { columnTempNote } from "../lib/tempChartNote";
import { fmtDateTime, fmtYm } from "../lib/ym";
import { type TabId, type UnitMode } from "./results/model/types";
import { capaInColumn } from "./results/model/format";
import { ResultMonthPicker, SelectField, RateMatrix, UnitBelowPanel, SpanMonthPicker, CauseDrillModal, OptionDetailTable, QuestionErrorTable } from "./results/components/small";
import { DrillModal } from "./results/components/DrillModal";
import { ReviewResultManager } from "./results/components/ReviewResultManager";
import { ResultImportPanel } from "./results/components/ResultImportPanel";
import { useResultsState } from "./results/hooks/useResultsState";
import { useResultsScope } from "./results/hooks/useResultsScope";
import { useResultsQuery } from "./results/hooks/useResultsQuery";
import { useResultsCompute } from "./results/hooks/useResultsCompute";
import { useResultsActions } from "./results/hooks/useResultsActions";
import type { ResultsPageProps } from "./results/model/pageProps";

export function ResultsPage(props: ResultsPageProps) {
  const { onAction } = props;
  const s0 = useResultsState();
  const { user, units, tab, selIndicator, selIndU, startMonth, endMonth, interval, applied, archiveCtx, indicators, selGroup, selGroupU, setRawHint, setRawFull, setIndexFallbackDismissed, setStartMonth, setEndMonth, setReloadNonce, selUnit, errorUnit, groups, setSelGroup, selGroup2, setSelGroup2, setSelUnit, setSelIndicator, setSelGroupU, setSelIndU, hideEmptyMonths, unitUnit, groupUnit, setChartModal, loading, setDrill, setDocModal, can, isAdmin, drill, indUnit, rawHint, setTab, setGroupUnit, setErrorUnit, setUnitUnit, setIndUnit, setHideEmptyMonths, fetchedAt, indexFallback, indexFallbackDismissed, setCauseDrill, metaLoaded, chartModal, chartModalCapaCases, docModal, causeDrill } = s0;
  const s1 = useResultsScope(s0);
  const { cacheScope, isNurseLeader, setUnitPanel, unitPanel } = s1;
  const s2 = useResultsQuery({ ...s0, ...s1 });
  const { tempTaskIds, tempTaskKeys, appliedColumns, scopedRecords, allMonths, summaryPlans, requireRaw, perIndMode, summaryPlan, handleIntervalChange, handleQuery, rangeValid } = s2;
  const s3 = useResultsCompute({ ...s0, ...s1, ...s2 });
  const { indOf, spansForIndicator, visibleColumns, sectionChartSeries, chartSeries, periodDesc, cellValue, recordIndex, sectionOptionRows, hybridByInd, capaSpansForIndicator, errorUnitCode, staleSummaryLabels, unconfirmed, scopedGroups, scopedUnits, hasNaUnit, unitIndOptions, indTabIndicators, causeCountRows, ownUnitUngrouped, groupIndicators, groupNameOf, matrixRows, rowIndOf, hasTempReview, rowSpansOf, unitIndicators, unitNameOf, selUnitCode, unitCapaCases, indCapaCases, ensureHistory, ensureMonths, cellsOfInd, historyBusy, historyNote } = s3;
  const s4 = useResultsActions({ ...s0, ...s1, ...s2, ...s3 });
  const { openDrill, openChart, openDoc, allPeriodColumn } = s4;

  if (!can("resultQuery") && !isAdmin) {
    return (
      <>
        <PageHeading page="results" />
        <EmptyState
          title="沒有權限"
          description="結果分析需要「結果查詢」權限，請聯絡系統管理員。"
        />
      </>
    );
  }

  // 指標分析：所選期間內有使用該指標審查的人員、單位皆列入
  const indRecs = useMemo(() => {
    if (!selIndicator) return [];
    // A3：查表取該指標全部期間的紀錄。
    return recordsForIndex(recordIndex, selIndicator, allMonths);
  }, [recordIndex, selIndicator, allMonths]);
  const indSel = indOf.get(selIndicator);
  const hybridCells = (selIndicator ? hybridByInd.get(selIndicator) : undefined) ?? null;
  /** 指標分析頁籤該指標的合併格（曲線圖一點一格、unit-period 計分用；與矩陣列同 spans）。 */
  const indSpans = useMemo<RowSpan[]>(
    () =>
      selIndicator
        ? spansForIndicator(
            selIndicator,
            visibleColumns.flatMap((c) => c.months),
            undefined,
          )
        : [],
    // spansForIndicator 為當次 render 的閉包；deps 列其全部反應式輸入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      selIndicator,
      visibleColumns,
      archiveCtx,
      appliedColumns,
      recordIndex,
      tempTaskIds,
      tempTaskKeys,
      hybridByInd,
    ],
  );
  /** 下探 CAPA 偵測用 spans（v1.88.18）：一個區間算一次審查，加審歸併原區間。 */
  const drillCapaSpans = useMemo<RowSpan[]>(
    () =>
      drill
        ? capaSpansForIndicator(
            drill.indicatorId,
            visibleColumns.flatMap((c) => c.months),
          )
        : [],
    // capaSpansForIndicator 為當次 render 的閉包；deps 列其全部反應式輸入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      drill,
      visibleColumns,
      archiveCtx,
      appliedColumns,
      recordIndex,
      tempTaskIds,
      tempTaskKeys,
      hybridByInd,
    ],
  );
  const indSummary = useMemo(() => {
    if (!indSel) return null;
    const th = indSel.threshold;
    if (hybridCells) {
      const cells = hybridCells;
      const unitPr = unitPeriodPassRateFromCells(cells, indSpans, th);
      const merged = passRateFromCells(cells);
      const perColumn = indSpans.map((column) => {
        const cs = cellsInMonths(cells, column.months);
        return {
          column,
          cs,
          pr: indUnit === "unit" ? unitPassRateFromCells(cs, th) : passRateFromCells(cs),
        };
      });
      const pts = perColumn.filter((point) => point.pr.rate != null);
      const chartNotes = pts.map((point) =>
        columnTempNote(
          point.cs.map((c) => ({ indicatorId: indSel.id, year: c.year, month: c.month, unitId: c.unitId })),
          tempTaskKeys,
          point.column.months.length,
        ),
      );
      return {
        unitCount: new Set(cells.map((c) => c.unitId)).size,
        total: merged.total,
        unitPr,
        personPr: merged,
        ownPersonPr: merged,
        ownTotal: merged.total,
        chartValues: pts.map((point) => point.pr.rate as number),
        chartLabels: pts.map((point) => point.column.label),
        chartTips: pts.map((point, i) => `${point.column.label}${chartNotes[i] ?? ""}：${formatPassRate(point.pr, true)}`),
        chartNotes,
        chartThresholds: pts.map((point) =>
          indUnit === "person" ? columnThresholdFromCells(point.cs, th) : th > 0 ? th : null,
        ),
        chartCols: pts.map((point) => point.column),
        optionRows: [] as ReturnType<typeof optionDetailRows>,
        scoringRows: !indSel.groupScoring
          ? []
          : indUnit === "unit"
            ? unitScoringRowsFromCells(cells, indSel.questions, indSpans, th)
            : personScoringRowsFromCells(cells, indSel.questions),
      };
    }
    const unitIds = new Set(indRecs.map((record) => record.unitId));
    const unitPr = unitPeriodPassRate(indRecs, indSpans, th);
    const merged = passRateOf(indRecs, th);
    const perColumn =
      indUnit === "unit"
        ? indSpans.map((column) => ({ column, pr: unitPassRate(recordsInMonths(indRecs, column.months), th) }))
        : indSpans.map((column) => ({ column, pr: passRateOf(recordsInMonths(indRecs, column.months), th) }));
    const pts = perColumn.filter(
      (point): point is { column: RowSpan; pr: PassRate } & { pr: { rate: number } } => point.pr.rate != null,
    );
    const optionRows = optionDetailRows(indRecs, indSel.questions);
    // v1.59.0：曲線圖加審標註（與 chartSeries 同一判別：該欄紀錄對上加審任務月鍵）
    const chartNotes = pts.map((point) =>
      columnTempNote(
        recordsInMonths(indRecs, point.column.months),
        tempTaskKeys,
        point.column.months.length,
      ),
    );
    return {
      unitCount: unitIds.size, total: indRecs.length, unitPr, personPr: merged,
      // v1.44.0：結果分析不再讀預存摘要；明細只含本人單位範圍，不提供全院彙總。
      ownPersonPr: merged, ownTotal: indRecs.length,
      chartValues: pts.map((point) => point.pr.rate as number),
      chartLabels: pts.map((point) => point.column.label),
      chartTips: pts.map((point, i) => `${point.column.label}${chartNotes[i] ?? ""}：${formatPassRate(point.pr, true)}`),
      chartNotes,
      chartThresholds: pts.map((point) =>
        indUnit === "person"
          ? columnThresholdOf(recordsInMonths(indRecs, point.column.months), th)
          : th > 0 ? th : null,
      ),
      chartCols: pts.map((point) => point.column),
      optionRows,
      // 分組計分只在指標開啟 groupScoring 時顯示（v1.44.0）。
      scoringRows: !indSel.groupScoring
        ? []
        : indUnit === "unit"
          ? unitScoringBreakdownRows(indRecs, indSel.questions, indSpans, th)
          : personScoringBreakdownRows(indRecs, indSel.questions, th),
    };
  }, [indRecs, indSel, indUnit, indSpans, tempTaskKeys, hybridCells]);

  const errorAnalysisRows = hybridCells
    ? questionErrorRowsFromSummaries(
        questionSummariesFromCells(
          errorUnit === "all" ? hybridCells : hybridCells.filter((c) => c.unitId === errorUnitCode),
        ),
      )
    : questionErrorRows(
        errorUnit === "all"
          ? indRecs
          : indRecs.filter((record) => record.unitId === errorUnitCode),
      );

  /**
   * 指標分析補充說明（v1.43.0）：取即時明細（indRecs）中有備註的紀錄，
   * 每筆彙整為一則（單則為備註原文、多則每則附題號）。只收有備註者。
   */
  const indNotes = useMemo(() => {
    if (!indSel || hybridCells) return [];
    const source =
      errorUnit === "all"
        ? indRecs
        : indRecs.filter((record) => record.unitId === errorUnitCode);
    return collectConsolidatedRecordNotes(source, indSel.questions);
  }, [indRecs, indSel, errorUnit, errorUnitCode, hybridCells]);
  return (
    <div className="results-page">
      <PageHeading
        page="results"
        action={tab === "indicator" && indSel ? (
          <button
            className="button button-primary"
            onClick={() => {
              const rate = indUnit === "unit" ? indSummary?.unitPr.rate : indSummary?.personPr.rate;
              window.dispatchEvent(new CustomEvent("capa:open", { detail: {
                indicatorId: indSel.id,
                indicatorCode: indSel.code,
                indicatorName: indSel.name,
                threshold: indSel.threshold,
                period: applied?.endMonth ?? "",
                periodKeys: allMonths,
                ...(typeof rate === "number" ? { rate } : {}),
              } }));
            }}
          >
            <Plus size={15} />由此建立 CAPA
          </button>
        ) : undefined}
      />

      {tab !== "import" && tab !== "manage" && applied && (perIndMode || rawHint) && (
        <p className="settings-note" role="status">
          {perIndMode
            ? tab === "indicator" && summaryPlan
              ? `資料來源：${summaryPlan.coveredKeys.length} 個月讀取封存摘要，${summaryPlan.uncovered.length} 個月讀取原始紀錄（未封存／進行中）。`
              : `資料來源：${summaryPlans.size} 支指標已封存的月份讀取摘要，其餘月份讀取原始紀錄；選項明細、下探與原因詞庫需載入原始紀錄。`
            : rawHint}
        </p>
      )}
      {staleSummaryLabels.length > 0 && (
        <p className="settings-note" style={{ color: "#b3372f", fontWeight: 600 }} role="alert">
          封存摘要已過期：以下摘要封存後指標閾值已變更，目前顯示的是封存當時的結果，請召集人／執行幹事至品管審查稽核重新封存：
          {staleSummaryLabels.slice(0, 8).join("、")}
          {staleSummaryLabels.length > 8 ? `…等 ${staleSummaryLabels.length} 個摘要` : ""}
        </p>
      )}
      {unconfirmed.length > 0 && (
        <p className="settings-note" style={{ color: "#b3372f", fontWeight: 600 }}>
          尚待確認封存：以下審查區間已結束超過一個月，結果尚待召集人／執行幹事確認封存，數字可能再變動：
          {[...new Set(unconfirmed.map((e) => `${indOf.get(e.indicatorId)?.name ?? stripInternalIdPrefix(e.indicatorId)}（${e.label}）`))]
            .slice(0, 8)
            .join("、")}
          {unconfirmed.length > 8 ? `…等 ${unconfirmed.length} 個區間` : ""}
        </p>
      )}

      <div className="results-tabs" role="tablist" aria-label="結果分析檢視">
        {(
          [
            ["group", "組別分析"],
            ["unit", "單位分析"],
            ["indicator", "指標分析"],
            ["import", "結果匯入"],
            ...(isAdmin ? [["manage", "審查結果管理"] as [TabId, string]] : []),
          ] as [TabId, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab !== "import" && tab !== "manage" && (
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
      )}
      {tab === "manage" && isAdmin && (
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
      )}
      {tab !== "import" && tab !== "manage" && applied && fetchedAt != null && !loading && (
        <p className="results-data-time">
          資料時間：
          {fmtDateTime(new Date(fetchedAt))}
        </p>
      )}
      {tab !== "import" && tab !== "manage" &&
        applied &&
        indexFallback &&
        !indexFallbackDismissed &&
        !loading && (
          <p className="results-data-time">
            提示：複合索引 (indicatorId, year)
            尚未就緒，本次查詢已自動改用舊方式（結果一致）。請管理員至 Firebase
            Console → Firestore → 索引建立該索引，之後查詢會更快。
            <button
              type="button"
              onClick={() => setIndexFallbackDismissed(true)}
            >
              知道了
            </button>
          </p>
        )}

      {tab !== "import" && tab !== "manage" && applied && !loading && perIndMode && (
        <p className="settings-note">
          原因詞庫統計需讀取原始紀錄（封存摘要不含原因詞）。
          <button type="button" className="text-button" onClick={() => { setRawHint("已載入原始紀錄。"); setRawFull(true); }}>
            載入原始紀錄
          </button>
          後顯示。
        </p>
      )}
      {tab !== "import" && tab !== "manage" && applied && !loading && !perIndMode && causeCountRows.length > 0 && (
        <section className="panel results-cause-summary">
          <SectionTitle title="原因詞庫件數" note="依目前使用者可見資料及已查詢期間統計；只計入題目原因詞庫中已勾選的項目。點選列下探到勾選該原因的個人審查結果。" />
          <div className="table-scroll"><table className="data-table"><thead><tr><th>原因詞庫項目</th><th>勾選件數</th></tr></thead><tbody>{causeCountRows.map((row) => <tr key={row.cause} className="clickable" title="點選下探到勾選該原因的個人審查結果" onClick={() => setCauseDrill(row.cause)}><td>{row.cause}</td><td>{row.count}</td></tr>)}</tbody></table></div>
        </section>
      )}

      {tab === "group" && (
        <>
          {!applied ? (
            <EmptyState
              title="尚未搜尋"
              description="請先選擇期間，再按「搜尋」開始分析。只想匯入結果，可直接切換至「結果匯入」頁籤，不需查詢。"
            />
          ) : loading ? (
            <EmptyState title="載入中" description="正在讀取審查紀錄…" />
          ) : ownUnitUngrouped ? (
            <EmptyState
              title="所屬單位尚未歸屬品管組"
              description="所屬單位尚未歸屬品管組，請先至「品管組與人員」→「品管組」頁籤設定，再查詢結果分析。"
            />
          ) : groupIndicators.length === 0 ? (
            <EmptyState
              title="無指標"
              description="該組別尚無指標。"
            />
          ) : (
            <section className="panel">
              <SectionTitle
                title={`${groupNameOf.get(selGroup) ?? selGroup}・達閾值率`}
                note={`${periodDesc}・單元：${groupUnit === "unit" ? "單位（達閾值單位數／總單位數）" : "人次（合併）"}`}
              />
              <RateMatrix
                rows={matrixRows}
                columns={visibleColumns}
                cellOf={(rowId, col) =>
                  cellValue(rowIndOf(rowId), col, undefined, groupUnit)
                }
                hasExtraReview={(rowId, col) => hasTempReview(rowIndOf(rowId), col)}
                onCell={(rowId, col) => openDrill(rowIndOf(rowId), col, groupUnit)}
                onDetailCell={(rowId, detailKey, col) =>
                  openDrill(rowIndOf(rowId), col, groupUnit, undefined, { sectionKey: detailKey })
                }
                onChart={(rowId) =>
                  openChart(rowIndOf(rowId), undefined, groupUnit, "全部單位", undefined, rowSpansOf(rowId))
                }
                onDoc={(rowId) => openDoc(rowIndOf(rowId), undefined, "全部單位", groupUnit)}
                onDetailChart={(rowId, detailKey, detailLabel) =>
                  openChart(rowIndOf(rowId), undefined, groupUnit, "全部單位", {
                    key: detailKey,
                    label: detailLabel,
                  }, rowSpansOf(rowId))
                }
                onDetailDoc={(rowId, detailKey, detailLabel) =>
                  openDoc(rowIndOf(rowId), undefined, "全部單位", groupUnit, {
                    key: detailKey,
                    label: detailLabel,
                  })
                }
              />
            </section>
          )}
        </>
      )}

      {tab === "unit" && (
        <>
          {!applied ? (
            <EmptyState
              title="尚未搜尋"
              description="請先選擇期間，再按「搜尋」開始分析。只想匯入結果，可直接切換至「結果匯入」頁籤，不需查詢。"
            />
          ) : loading ? (
            <EmptyState title="載入中" description="正在讀取審查紀錄…" />
          ) : unitIndicators.length === 0 ? (
            <EmptyState
              title="無資料"
              description="該單位在所選期間尚無審查紀錄。"
            />
          ) : (
            <section className="panel">
              <SectionTitle
                title={`${selUnit}・${unitNameOf.get(selUnit) ?? ""} 達閾值率`}
                note={`${periodDesc}・單元：${unitUnit === "unit" ? "單位（達閾值單位數／總單位數）" : "人次（合併）"}`}
              />
              <RateMatrix
                rows={matrixRows}
                columns={visibleColumns}
                cellOf={(rowId, col) =>
                  cellValue(rowIndOf(rowId), col, selUnitCode, unitUnit)
                }
                hasExtraReview={(rowId, col) => hasTempReview(rowIndOf(rowId), col, selUnitCode)}
                thresholdOf={(rowId) => indOf.get(rowIndOf(rowId))?.threshold ?? 0}
                capaMarkOf={(rowId, col) =>
                  unitCapaCases.find((c) => c.indicatorId === rowIndOf(rowId) && c.stage !== "已撤案" && capaInColumn(c, col.months))
                }
                onCell={(rowId, col) =>
                  openDrill(rowIndOf(rowId), col, unitUnit, selUnitCode)
                }
                onDetailCell={(rowId, detailKey, col) =>
                  openDrill(rowIndOf(rowId), col, unitUnit, selUnitCode, { sectionKey: detailKey })
                }
                onChart={(rowId) =>
                  setUnitPanel((p) =>
                    p?.kind === "chart" && p.rowId === rowId
                      ? null
                      : { kind: "chart", indicatorId: rowIndOf(rowId), rowId },
                  )
                }
                onDoc={(rowId) =>
                  requireRaw(rowIndOf(rowId)) ||
                  setUnitPanel((p) =>
                    p?.kind === "doc" && p.rowId === rowId
                      ? null
                      : { kind: "doc", indicatorId: rowIndOf(rowId), rowId },
                  )
                }
                onDetailChart={(rowId, detailKey, detailLabel) =>
                  setUnitPanel((p) =>
                    p?.kind === "chart" &&
                    p.rowId === rowId &&
                    p.sectionKey === detailKey
                      ? null
                      : {
                          kind: "chart",
                          indicatorId: rowIndOf(rowId),
                          rowId,
                          sectionKey: detailKey,
                          sectionLabel: detailLabel,
                        },
                  )
                }
                onDetailDoc={(rowId, detailKey, detailLabel) =>
                  requireRaw(rowIndOf(rowId)) ||
                  setUnitPanel((p) =>
                    p?.kind === "doc" &&
                    p.rowId === rowId &&
                    p.sectionKey === detailKey
                      ? null
                      : {
                          kind: "doc",
                          indicatorId: rowIndOf(rowId),
                          rowId,
                          sectionKey: detailKey,
                          sectionLabel: detailLabel,
                        },
                  )
                }
              />
              {unitPanel &&
                (() => {
                  const ind = indOf.get(unitPanel.indicatorId);
                  if (!ind) return null;
                  if (unitPanel.kind === "chart") {
                    // v1.88.17：曲線圖一點一合併格，取開啟面板那一列的 spans；找不到列時退回該指標聯集 spans。
                    const panelSpans = unitPanel.rowId ? rowSpansOf(unitPanel.rowId) : [];
                    const chartSpans =
                      panelSpans.length > 0
                        ? panelSpans
                        : spansForIndicator(ind.id, visibleColumns.flatMap((c) => c.months), selUnitCode);
                    const s = unitPanel.sectionKey
                      ? sectionChartSeries(
                          ind.id,
                          selUnitCode,
                          unitUnit,
                          unitPanel.sectionKey,
                          chartSpans,
                        )
                      : chartSeries(ind.id, selUnitCode, unitUnit, chartSpans);
                    return (
                      <UnitBelowPanel
                        title={
                          unitPanel.sectionKey
                            ? `${ind.code}・${ind.name}・${unitPanel.sectionLabel} 達閾值率曲線`
                            : `${ind.code}・${ind.name} 達閾值率曲線`
                        }
                        subtitle={`${periodDesc}・單位：${selUnit}・${unitUnit === "unit" ? "單位（達閾值單位數／總單位數）" : "人次（合併）"}${unitPanel.sectionKey ? `・分組：${unitPanel.sectionLabel}` : ""}`}
                        onClose={() => setUnitPanel(null)}
                      >
                        {s.values.length === 0 ? (
                          <div className="chart-empty">尚無資料</div>
                        ) : (
                          <TrendChart
                            values={s.values}
                            labels={s.labels}
                            tooltips={s.tips}
                            notes={s.notes}
                            threshold={
                              ind.threshold > 0 ? ind.threshold : null
                            }
                            thresholds={s.thresholds}
                            legend="達閾值率"
                            capaMarks={s.cols.map((col) => {
                              const hit = unitCapaCases.find((c) => c.indicatorId === ind.id && c.stage !== "已撤案" && capaInColumn(c, col.months));
                              return hit ? { id: hit.id, label: hit.caseNumber, actions: hit.actions.map((a) => a.title) } : null;
                            })}
                            onCapaClick={(i) => {
                              const hit = unitCapaCases.find((c) => c.indicatorId === ind.id && c.stage !== "已撤案" && capaInColumn(c, s.cols[i].months));
                              if (hit) window.dispatchEvent(new CustomEvent("capa:open", { detail: { caseId: hit.id } }));
                            }}
                            onPointClick={(i) =>
                              openDrill(ind.id, s.cols[i], unitUnit, selUnitCode, unitPanel.sectionKey
                                ? { sectionKey: unitPanel.sectionKey }
                                : undefined)
                            }
                          />
                        )}
                      </UnitBelowPanel>
                    );
                  }
                  // A3：查表取該指標該單位全部期間的紀錄（取代 JSX 內即時 IIFE 過濾）。
                  const recs = recordsForIndex(
                    recordIndex,
                    ind.id,
                    allMonths,
                    selUnitCode,
                  );
                  return (
                    <UnitBelowPanel
                      title={
                        unitPanel.sectionKey
                          ? `${ind.code}・${ind.name}・${unitPanel.sectionLabel} 各選項得分狀況`
                          : `${ind.code}・${ind.name} 各選項得分狀況`
                      }
                      subtitle={`${periodDesc}・單位：${selUnit}・共 ${recs.length} 人次${unitPanel.sectionKey ? `・分組：${unitPanel.sectionLabel}` : ""}`}
                      onClose={() => setUnitPanel(null)}
                    >
                      <OptionDetailTable
                        rows={
                          unitPanel.sectionKey
                            ? sectionOptionRows(
                                optionDetailRows(recs, ind.questions),
                                ind.questions,
                                unitPanel.sectionKey,
                                recs,
                              )
                            : optionDetailRows(recs, ind.questions)
                        }
                        threshold={ind.threshold}
                        onQuestionClick={(questionId) =>
                          openDrill(ind.id, allPeriodColumn, unitUnit, selUnitCode, {
                            questionId,
                            l2All: true,
                          })
                        }
                      />
                    </UnitBelowPanel>
                  );
                })()}
            </section>
          )}
        </>
      )}

      {tab === "indicator" && (
        <>
          {!applied ? (
            <EmptyState
              title="尚未搜尋"
              description="請先選擇期間，再按「搜尋」開始分析。只想匯入結果，可直接切換至「結果匯入」頁籤，不需查詢。"
            />
          ) : loading ? (
            <EmptyState title="載入中" description="正在讀取審查紀錄…" />
          ) : !indSel || !indSummary ? (
            <EmptyState
              title="無指標"
              description="請先選擇組別與指標。"
            />
          ) : (
            <>
              <div className="analysis-stats">
                <SummaryCell
                  label={isNurseLeader ? "本單位受審" : "受審單位數"}
                  value={String(indSummary.unitCount)}
                  note={isNurseLeader ? "僅顯示本人所屬單位；不列其他單位" : "所選期間內有紀錄的單位"}
                  onClick={
                    indSummary.total > 0
                      ? () => openDrill(selIndicator, allPeriodColumn, indUnit)
                      : undefined
                  }
                />
                {isNurseLeader ? (
                  <>
                    <SummaryCell
                      label="本單位受審人次"
                      value={String(indSummary.ownTotal)}
                      note="所選期間內本單位總人次數"
                      onClick={
                        indSummary.total > 0
                          ? () => openDrill(selIndicator, allPeriodColumn, indUnit, undefined, { l2All: true })
                          : undefined
                      }
                    />
                    <SummaryCell
                      label="單位正確率"
                      value={formatPassRate(indSummary.unitPr, true)}
                      note="達閾值單位數／審查單位數（unit-period 計）"
                      onClick={
                        indSummary.unitPr.rate != null
                          ? () => openDrill(selIndicator, allPeriodColumn, indUnit)
                          : undefined
                      }
                    />
                    <SummaryCell
                      label="本單位人員正確率"
                      value={formatPassRate(indSummary.ownPersonPr, true)}
                      note="本單位達閾值人次／本單位總人次"
                      onClick={
                        indSummary.ownPersonPr.rate != null
                          ? () => openDrill(selIndicator, allPeriodColumn, indUnit, undefined, { l2All: true })
                          : undefined
                      }
                    />
                    <SummaryCell
                      label="全院人員正確率"
                      value="—"
                      note="僅顯示本單位資料，不提供全院彙總比較"
                    />
                  </>
                ) : (
                  <>
                    <SummaryCell
                      label="受審總人次"
                      value={String(indSummary.total)}
                      note="所選期間內總人次數"
                      onClick={
                        indSummary.total > 0
                          ? () => openDrill(selIndicator, allPeriodColumn, indUnit, undefined, { l2All: true })
                          : undefined
                      }
                    />
                    <SummaryCell
                      label="單位正確率"
                      value={formatPassRate(indSummary.unitPr, true)}
                      note="達閾值單位數／審查單位數（unit-period 計）"
                      onClick={
                        indSummary.unitPr.rate != null
                          ? () => openDrill(selIndicator, allPeriodColumn, indUnit)
                          : undefined
                      }
                    />
                    <SummaryCell
                      label="人員正確率"
                      value={formatPassRate(indSummary.personPr, true)}
                      note="達閾值人次／總人次"
                      onClick={
                        indSummary.personPr.rate != null
                          ? () => openDrill(selIndicator, allPeriodColumn, indUnit, undefined, { l2All: true })
                          : undefined
                      }
                    />
                  </>
                )}
              </div>
              {indSummary.total > 0 && (
                <p className="settings-note" role="status">
                  {isNurseLeader ? "目前僅顯示本單位資料，無法提供全院彙總。" : "明細中的閾值快照優先於指標現行閾值。"}錯題排行依完全相同題目文字跨版本彙總，僅作排行、不代表版本等價或趨勢合併。
                </p>
              )}
              {indSummary.scoringRows.length > 0 && (
                <section className="panel score-breakdown-panel" aria-label="指標計分明細">
                  <div className="score-breakdown">
                    {indSummary.scoringRows.map((row) => {
                      const clickable = row.rate != null;
                      return (
                        <div
                          key={row.key}
                          className={`score-breakdown-row${row.isTotal ? " score-breakdown-total" : " score-breakdown-detail"}${clickable ? " clickable" : ""}`}
                          title={clickable ? "點選下探到個人審查結果" : undefined}
                          onClick={
                            clickable
                              ? () =>
                                  openDrill(selIndicator, allPeriodColumn, indUnit, undefined, {
                                    sectionKey: row.isTotal ? undefined : row.key,
                                  })
                              : undefined
                          }
                          role={clickable ? "button" : undefined}
                          tabIndex={clickable ? 0 : undefined}
                          onKeyDown={
                            clickable
                              ? (e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    openDrill(selIndicator, allPeriodColumn, indUnit, undefined, {
                                      sectionKey: row.isTotal ? undefined : row.key,
                                    });
                                  }
                                }
                              : undefined
                          }
                        >
                          <span>{row.isTotal ? indSel.name : row.label}</span>
                          {!row.isTotal && (
                            <span className="analysis-indicator-actions">
                              <button
                                type="button"
                                className="icon-button"
                                title="曲線圖"
                                aria-label={`${row.label} 曲線圖`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openChart(selIndicator, undefined, indUnit, isNurseLeader ? "本單位" : "全部單位", {
                                    key: row.key,
                                    label: row.label,
                                  });
                                }}
                              >
                                <TrendingUp size={16} />
                              </button>
                              {/* v1.53.0：歷史分組無現行題目，選項明細為空列，故不顯示文件圖示 */}
                              {!row.key.startsWith("historical-") && (
                                <button
                                  type="button"
                                  className="icon-button"
                                  title="各選項得分狀況"
                                  aria-label={`${row.label} 各選項得分狀況`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openDoc(selIndicator, undefined, isNurseLeader ? "本單位" : "全部單位", indUnit, {
                                      key: row.key,
                                      label: row.label,
                                    });
                                  }}
                                >
                                  <FileText size={16} />
                                </button>
                              )}
                            </span>
                          )}
                          <strong>
                            {formatPassRate({ pass: row.yes, total: row.valid, rate: row.rate })}
                          </strong>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}
              <section className="panel">
                <SectionTitle
                  title="通過率"
                  note={`${indSel.code}・${indSel.name}・${periodDesc}・單元：${indUnit === "unit" ? "單位（達閾值單位數／總單位數）" : "人次（合併）"}${isNurseLeader && indUnit !== "unit" ? "・僅顯示本單位資料" : ""}`}
                />
                {indSummary.chartValues.length === 0 ? (
                  <div className="chart-empty">尚無資料</div>
                ) : (
                  <TrendChart
                    values={indSummary.chartValues}
                    labels={indSummary.chartLabels}
                    tooltips={indSummary.chartTips}
                    notes={indSummary.chartNotes}
                    threshold={indSel.threshold > 0 ? indSel.threshold : null}
                    thresholds={indSummary.chartThresholds}
                    legend="正確率"
                    capaMarks={indSummary.chartCols.map((col) => {
                      const hit = indCapaCases.find((c) => c.stage !== "已撤案" && capaInColumn(c, col.months));
                      return hit ? { id: hit.id, label: hit.caseNumber, actions: hit.actions.map((a) => a.title) } : null;
                    })}
                    onCapaClick={(i) => {
                      const hit = indCapaCases.find((c) => c.stage !== "已撤案" && capaInColumn(c, indSummary.chartCols[i].months));
                      if (hit) window.dispatchEvent(new CustomEvent("capa:open", { detail: { caseId: hit.id } }));
                    }}
                    onPointClick={(i) =>
                      openDrill(selIndicator, indSummary.chartCols[i], indUnit)
                    }
                  />
                )}
              </section>
              <section className="panel">
                <SectionTitle
                  title="指標選項審查明細"
                  note={`${indSel.code}・${indSel.name}・${periodDesc}・共 ${indSummary.total} 人次`}
                />
                {summaryPlan ? (
                  <p className="settings-note">
                    已封存月份只保留彙總數字。
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        setRawHint("已載入原始紀錄。");
                        setRawFull(true);
                      }}
                    >
                      載入原始紀錄
                    </button>
                    後可顯示各選項明細、補充說明並下探。
                  </p>
                ) : (
                <OptionDetailTable
                  rows={indSummary.optionRows}
                  threshold={indSel.threshold}
                  onQuestionClick={(questionId) =>
                    openDrill(selIndicator, allPeriodColumn, indUnit, undefined, {
                      questionId,
                      l2All: true,
                    })
                  }
                />
                )}
              </section>
              <section className="panel">
                <SectionTitle
                  title="指標錯誤分析・題目排行"
                  note={`${indSel.code}・${indSel.name}・${periodDesc}・${errorUnit === "all" ? "全部單位" : `單位 ${errorUnit}`}；「否」為錯誤，「不適用」不列入錯誤率分母`}
                />
                <QuestionErrorTable
                  rows={errorAnalysisRows}
                  onQuestionClick={(questionId) =>
                    openDrill(
                      selIndicator,
                      allPeriodColumn,
                      indUnit,
                      errorUnit === "all" ? undefined : errorUnit,
                      { questionId, optionLabel: "否", l2All: true },
                    )
                  }
                />
              </section>
              {indNotes.length > 0 && (
                <section className="panel">
                  <SectionTitle
                    title="補充說明"
                    note={`${indSel.code}・${indSel.name}・${periodDesc}・審查員備註未通過原因；每筆紀錄彙整為一則，只列有填寫備註的紀錄。`}
                  />
                  <div className="analysis-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>被審人員</th>
                          <th>補充說明</th>
                        </tr>
                      </thead>
                      <tbody>
                        {indNotes.map((entry, i) => (
                          <tr
                            key={`${entry.personEmpNo}-${entry.year}-${entry.month}-${i}`}
                          >
                            <td>
                              {staffLabel(entry.personEmpNo, entry.personName)}
                            </td>
                            <td className="supp-note-cell">{entry.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </>
          )}
        </>
      )}

      {tab === "import" && (
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
      )}

      {chartModal && (
        <div
          className="reviewer-modal-backdrop"
          onClick={() => setChartModal(null)}
        >
          <div
            className="reviewer-modal wide panel"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={chartModal.title}
          >
            <div className="reviewer-modal-head">
              <div>
                <h2>{chartModal.title}</h2>
                <p>{chartModal.subtitle}</p>
              </div>
              <button
                className="button button-ghost"
                onClick={() => setChartModal(null)}
                aria-label="關閉"
              >
                <X size={16} />
              </button>
            </div>
            {chartModal.values.length === 0 ? (
              <div className="chart-empty">尚無資料</div>
            ) : (
              <TrendChart
                values={chartModal.values}
                labels={chartModal.labels}
                tooltips={chartModal.tips}
                notes={chartModal.notes}
                threshold={chartModal.threshold}
                thresholds={chartModal.thresholds}
                legend="達閾值率"
                capaMarks={chartModal.cols.map((col) => {
                  const hit = chartModalCapaCases.find((c) => c.stage !== "已撤案" && (!chartModal.unitId || c.unitCode === chartModal.unitId) && capaInColumn(c, col.months));
                  return hit ? { id: hit.id, label: hit.caseNumber, actions: hit.actions.map((a) => a.title) } : null;
                })}
                onCapaClick={(i) => {
                  const hit = chartModalCapaCases.find((c) => c.stage !== "已撤案" && (!chartModal.unitId || c.unitCode === chartModal.unitId) && capaInColumn(c, chartModal.cols[i].months));
                  if (hit) window.dispatchEvent(new CustomEvent("capa:open", { detail: { caseId: hit.id } }));
                }}
                onPointClick={(i) => {
                  const cm = chartModal;
                  setChartModal(null);
                  openDrill(cm.indicatorId, cm.cols[i], cm.mode, cm.unitId, cm.sectionKey
                    ? { sectionKey: cm.sectionKey }
                    : undefined);
                }}
              />
            )}
          </div>
        </div>
      )}

      {docModal && (
        <div
          className="reviewer-modal-backdrop"
          onClick={() => setDocModal(null)}
        >
          <div
            className="reviewer-modal wide panel"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={docModal.title}
          >
            <div className="reviewer-modal-head">
              <div>
                <h2>{docModal.title}</h2>
                <p>{docModal.subtitle}</p>
              </div>
              <button
                className="button button-ghost"
                onClick={() => setDocModal(null)}
                aria-label="關閉"
              >
                <X size={16} />
              </button>
            </div>
            <OptionDetailTable
              rows={docModal.rows}
              threshold={indOf.get(docModal.indicatorId)?.threshold}
              onQuestionClick={(questionId) => {
                const dm = docModal;
                setDocModal(null);
                openDrill(dm.indicatorId, allPeriodColumn, dm.mode, dm.unitId, {
                  questionId,
                  l2All: true,
                });
              }}
            />
          </div>
        </div>
      )}

      {drill?.pickMonths && (
        <SpanMonthPicker
          title={`${indOf.get(drill.indicatorId)?.code ?? ""}・${indOf.get(drill.indicatorId)?.name ?? drill.indicatorId}`}
          subtitle={`${drill.column.label}・各月明細（點選月份看該月各單位審查結果）`}
          months={drill.column.months}
          cellOf={(m) =>
            cellValue(
              drill.indicatorId,
              { key: `${m.year}-${m.month}`, label: fmtYm(m.year, m.month), months: [m] },
              drill.scopeUnitId,
              drill.mode,
            )
          }
          extraOf={(m) =>
            hasTempReview(
              drill.indicatorId,
              { key: `${m.year}-${m.month}`, label: fmtYm(m.year, m.month), months: [m] },
              drill.scopeUnitId,
            )
          }
          onPick={(m) =>
            setDrill((d) =>
              d
                ? {
                    ...d,
                    column: {
                      key: `${m.year}-${m.month}`,
                      label: fmtYm(m.year, m.month),
                      months: [m],
                    },
                    pickMonths: false,
                  }
                : d,
            )
          }
          onClose={() => setDrill(null)}
        />
      )}

      {drill && !drill.pickMonths && (
        <DrillModal
          drill={drill}
          onClose={() => setDrill(null)}
          onBackToL1={() =>
            setDrill({
              ...drill,
              l2UnitId: null,
              l2Months: undefined,
              l2All: false,
              sectionKey: undefined,
              questionId: undefined,
              optionLabel: undefined,
            })
          }
          onSelectUnit={(unitId, month) =>
            setDrill({ ...drill, l2UnitId: unitId, l2Months: month ? [month] : undefined })
          }
          onNeedHistory={ensureHistory}
          onNeedMonths={ensureMonths}
          summaryCellsFor={cellsOfInd}
          historyBusy={historyBusy}
          historyNote={historyNote}
          recordIndex={recordIndex}
          indOf={indOf}
          unitNameOf={unitNameOf}
          capaSpans={drillCapaSpans}
          tempReviewOf={(months, unitId) =>
            hasTempReview(
              drill.indicatorId,
              { key: "", label: "", months },
              unitId,
            )
          }
        />
      )}

      {causeDrill && (
        <CauseDrillModal
          cause={causeDrill}
          onClose={() => setCauseDrill(null)}
          records={recordsInMonths(scopedRecords, allMonths)}
          indOf={indOf}
          unitNameOf={unitNameOf}
        />
      )}
    </div>
  );
}
