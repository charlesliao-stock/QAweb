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
import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { stripInternalIdPrefix } from "../lib/indicators";
import { overviewResultRange } from "../lib/indicatorOverview";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { recordsInMonths } from "../lib/analysisRates";
import { fmtDateTime } from "../lib/ym";
import { type TabId } from "./results/model/types";
import { CauseDrillModal } from "./results/components/small";
import type { ResultsPageProps } from "./results/model/pageProps";
import { useResultsCtx } from "./results/hooks/useResultsCtx";
import { useResultsAnalysis } from "./results/hooks/useResultsAnalysis";
import { ResultsQueryPanel } from "./results/tabs/ResultsQueryPanel";
import { ResultsManageTab } from "./results/tabs/ResultsManageTab";
import { GroupTab } from "./results/tabs/GroupTab";
import { UnitTab } from "./results/tabs/UnitTab";
import { IndicatorTab } from "./results/tabs/IndicatorTab";
import { ResultsImportTab } from "./results/tabs/ResultsImportTab";
import { ChartModalBlock } from "./results/tabs/ChartModalBlock";
import { DocModalBlock } from "./results/tabs/DocModalBlock";
import { DrillPickMonthsBlock } from "./results/tabs/DrillPickMonthsBlock";
import { DrillViewBlock } from "./results/tabs/DrillViewBlock";

export function ResultsPage(props: ResultsPageProps) {
  const ctx = useResultsCtx(props);
  const { can, isAdmin, allMonths, indOf, indUnit, tab, applied, perIndMode, rawHint, summaryPlan, summaryPlans, staleSummaryLabels, unconfirmed, setTab, loading, fetchedAt, indexFallback, indexFallbackDismissed, setIndexFallbackDismissed, setRawHint, setRawFull, causeCountRows, setCauseDrill, unitNameOf, causeDrill, scopedRecords } = ctx;

  // 指標總覽帶入：切「指標分析」頁籤、預選該指標、查詢該年 1～12 月。
  // 查詢仍走現行 handleQuery 與 dataScope 過濾（scopedRecords），不繞過權限。
  const initialRef = useRef(props.initial ?? null);
  const [initialReady, setInitialReady] = useState(false);
  useEffect(() => {
    const init = initialRef.current;
    if (!init || initialReady || !ctx.metaLoaded) return;
    const ind = ctx.indicators.find((item) => item.id === init.indicatorId);
    const range = overviewResultRange(init.year);
    ctx.setTab("indicator");
    if (ind) ctx.setSelGroup2(ind.groupId);
    ctx.setSelIndicator(init.indicatorId);
    ctx.setStartMonth(range.startMonth);
    ctx.setEndMonth(range.endMonth);
    setInitialReady(true);
  }, [ctx, initialReady]);
  useEffect(() => {
    if (!initialReady || applied) return;
    ctx.handleQuery();
  }, [initialReady, applied, ctx]);

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
  const analysis = useResultsAnalysis(ctx);
  const { indSel, indSummary } = analysis;

  const view = { ...ctx, ...analysis };
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

      <ResultsQueryPanel ctx={view} />
      <ResultsManageTab ctx={view} />
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

      <GroupTab ctx={view} />

      <UnitTab ctx={view} />

      <IndicatorTab ctx={view} />

      <ResultsImportTab ctx={view} />

      <ChartModalBlock ctx={view} />

      <DocModalBlock ctx={view} />

      <DrillPickMonthsBlock ctx={view} />

      <DrillViewBlock ctx={view} />

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
