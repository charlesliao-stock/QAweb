import { useAuth } from "../../../lib/auth";
import { usePermissions } from "../../../lib/usePermissions";
import { useState, useEffect } from "react";
import type { IndicatorOpt, GroupOpt, UnitOpt, TabId, UnitMode, SectionRef, ChartModalData, DocModalData, DrillState } from "../model/types";
import type { AnalysisRecord } from "../../../lib/analysisRates";
import type { AnalysisGranularity } from "../../../lib/analysisPeriod";
import { pad2 } from "../../../lib/ym";
import { listSchedules } from "../../../lib/scheduling";
import { type StoredSummary, loadAllSummaries } from "../../../lib/summaryStore";
import type { RowSpan } from "../../../lib/analysisSpans";
import { getFirebaseDb } from "../../../lib/firebase";
import { getDoc, doc } from "../../../lib/db";
import type { CapaCase } from "../../capa/model";
import { loadCapaCasesByIndicator } from "../../capa/store";

export function useResultsState() {
  const { user } = useAuth();
  const { can, catalog } = usePermissions();
  const now = new Date();
  const [indicators, setIndicators] = useState<IndicatorOpt[]>([]);
  /** 指標／組別／單位參考資料是否已載入完成（v1.43.1：匯入面板據此決定是否顯示指標下拉為空的診斷提示，載入中不顯示、避免閃爍）。 */
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [groups, setGroups] = useState<GroupOpt[]>([]);
  const [units, setUnits] = useState<UnitOpt[]>([]);
  const [records, setRecords] = useState<AnalysisRecord[]>([]);
  const [tasks, setTasks] = useState<
    {
      id: string;
      unitId: string;
      reviewerId: string;
      /** v1.59.0：曲線圖加審標註反查用（任務來源排程類別／期別） */
      indicatorId: string;
      year: number;
      month: number;
      scheduleCategory?: string;
      schedulePeriod?: string;
    }[]
  >([]);
  /**
   * v1.59.0：自審臨時排程鍵集合（`${indicatorId}|${period}`），
   * 曲線圖加審標註時排除自審任務；掛載時由 indicatorSchedules 載入一次。
   */
  const [selfReviewTempKeys, setSelfReviewTempKeys] = useState<
    Set<string>
  >(new Set());
  const [loading, setLoading] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  /**
   * 已生效的查詢條件（null＝尚未搜尋，顯示空白頁）。
   * 篩選器一變只改 live 值，不觸發查詢；按「查詢」才把當下條件生效。
   */
  const [applied, setApplied] = useState<{
    years: number[];
    startMonth: string;
    endMonth: string;
    interval: AnalysisGranularity;
  } | null>(null);
  /** 資料時間（本次顯示年份中最新的抓取時間；快取命中沿用原抓取時間） */
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  /**
   * v1.28 階段 7（B7）：上次查詢是否因複合索引未就緒而退化。
   * true 時畫面顯示一次性提示（結果與改前一致，只是沒省到讀取）。
   */
  const [indexFallback, setIndexFallback] = useState(false);
  const [indexFallbackDismissed, setIndexFallbackDismissed] = useState(false);
  const [tab, setTab] = useState<TabId>("group");
  const isAdmin = Boolean(user?.roles?.includes("系統管理員"));
  // 期間篩選（四個頁籤共用）
  const [startMonth, setStartMonth] = useState(
    `${now.getFullYear()}-01`,
  );
  const [endMonth, setEndMonth] = useState(
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`,
  );
  const [interval, setInterval] = useState<AnalysisGranularity>("month");
  /** v1.40.2「未審月份不顯示」：勾選時隱藏該期間欄內零審查的欄位；預設不勾選，全部顯示。純顯示切換，不觸發重新查詢。 */
  const [hideEmptyMonths, setHideEmptyMonths] = useState(false);
  // 組別分析
  const [selGroup, setSelGroup] = useState("");
  const [groupUnit, setGroupUnit] = useState<UnitMode>("unit");
  // 單位分析
  const [selUnit, setSelUnit] = useState("");
  const [unitUnit, setUnitUnit] = useState<UnitMode>("unit");
  const [selGroupU, setSelGroupU] = useState("");
  const [selIndU, setSelIndU] = useState("all");
  // 指標分析
  const [selGroup2, setSelGroup2] = useState("");
  const [selIndicator, setSelIndicator] = useState("");
  const [indUnit, setIndUnit] = useState<UnitMode>("unit");
  const [errorUnit, setErrorUnit] = useState("all");
  // v1.65.1：已結束超過一個月仍未封存的區間（結果分析提示「尚待確認封存」）
  const [archiveCtx, setArchiveCtx] = useState<{
    schedules: Awaited<ReturnType<typeof listSchedules>>;
    archiveIds: Set<string>;
    summaries: Map<string, StoredSummary>;
    deadlineDay: number;
  } | null>(null);
  // v1.66.0：封存摘要讀取是否已結束（指標分析要先知道哪些月份有摘要，才決定讀哪些原始紀錄）
  const [archiveReady, setArchiveReady] = useState(false);
  // 指標分析：使用者要求載入全部原始紀錄（選項明細、補充說明、下探）
  const [rawFull, setRawFull] = useState(false);
  const [rawHint, setRawHint] = useState("");
  /** v1.88.19：第一次點曲線圖時原始紀錄尚未載入，先記下待開的圖，載完自動彈出 */
  const [pendingChart, setPendingChart] = useState<{
    indicatorId: string;
    unitId: string | undefined;
    mode: UnitMode;
    scopeLabel: string;
    section?: SectionRef;
    spans?: RowSpan[];
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = getFirebaseDb();
        const [schedules, summaries, cfg] = await Promise.all([
          listSchedules(db),
          loadAllSummaries(db),
          getDoc(doc(db, "systemParams", "config")),
        ]);
        const dd = (cfg.data() as Record<string, unknown> | undefined)?.supplementDeadlineDay;
        if (!cancelled)
          setArchiveCtx({
            schedules,
            archiveIds: new Set(summaries.keys()),
            summaries,
            deadlineDay: typeof dd === "number" && dd >= 1 && dd <= 31 ? dd : 10,
          });
      } catch {
        // 讀不到就不顯示封存提示；指標分析退回全讀原始紀錄
      } finally {
        if (!cancelled) setArchiveReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  // Modal
  const [chartModal, setChartModal] = useState<ChartModalData | null>(null);
  // v1.88.14：曲線圖彈窗的 CAPA 案件（依彈窗指標一次查詢），供「C」標記使用。
  const [chartModalCapaCases, setChartModalCapaCases] = useState<CapaCase[]>([]);
  useEffect(() => {
    const indicatorId = chartModal?.indicatorId;
    if (!indicatorId) {
      setChartModalCapaCases([]);
      return;
    }
    let alive = true;
    loadCapaCasesByIndicator(indicatorId)
      .then((rows) => { if (alive) setChartModalCapaCases(rows); })
      .catch(() => { if (alive) setChartModalCapaCases([]); });
    return () => { alive = false; };
  }, [chartModal?.indicatorId]);
  const [docModal, setDocModal] = useState<DocModalData | null>(null);
  // v1.50.0：原因詞庫件數下探（勾選該原因的審查紀錄，跨指標）
  const [causeDrill, setCauseDrill] = useState<string | null>(null);
  // 下探（L1 單位矩陣／L2 人員各選項結果）
  const [drill, setDrill] = useState<DrillState | null>(null);

  return {
    user,
    units,
    catalog,
    tab,
    selIndicator,
    selIndU,
    setSelfReviewTempKeys,
    setIndicators,
    setGroups,
    setUnits,
    setMetaLoaded,
    startMonth,
    endMonth,
    interval,
    applied,
    rawFull,
    archiveCtx,
    indicators,
    selGroup,
    selGroupU,
    setRawHint,
    setRawFull,
    setPendingChart,
    archiveReady,
    setLoading,
    setRecords,
    setTasks,
    setIndexFallback,
    setIndexFallbackDismissed,
    setFetchedAt,
    reloadNonce,
    setInterval,
    now,
    setStartMonth,
    setEndMonth,
    setApplied,
    setReloadNonce,
    tasks,
    records,
    selfReviewTempKeys,
    selUnit,
    errorUnit,
    groups,
    setSelGroup,
    selGroup2,
    setSelGroup2,
    setSelUnit,
    setSelIndicator,
    setSelGroupU,
    setSelIndU,
    hideEmptyMonths,
    unitUnit,
    groupUnit,
    setChartModal,
    pendingChart,
    loading,
    setDrill,
    setDocModal,
    can,
    isAdmin,
    drill,
    indUnit,
    rawHint,
    setTab,
    setGroupUnit,
    setErrorUnit,
    setUnitUnit,
    setIndUnit,
    setHideEmptyMonths,
    fetchedAt,
    indexFallback,
    indexFallbackDismissed,
    setCauseDrill,
    metaLoaded,
    chartModal,
    chartModalCapaCases,
    docModal,
    causeDrill,
  };
}
