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
import { loadRefCollection } from "../lib/refLoad";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Plus,
  Search,
  TrendingUp,
  Upload,
  X,
} from "lucide-react";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getDocsFromServer,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from "../lib/db";
import { getFirebaseDb } from "../lib/firebase";
import { unarchivedOverdue } from "../lib/archiveReminder";
import { listSchedules, scheduleDocId } from "../lib/scheduling";
import { loadAllSummaries, recordDocToAnalysis, type StoredSummary } from "../lib/summaryStore";
import {
  buildReviewSummary,
  cellsInMonths,
  columnThresholdFromCells,
  isSummaryStale,
  SUMMARY_SCHEMA_VERSION,
  passRateFromCells,
  personScoringRowsFromCells,
  questionSummariesFromCells,
  unitPassRateFromCells,
  unitPeriodPassRateFromCells,
  unitScoringRowsFromCells,
  type SummaryCell as ArchiveCell,
} from "../lib/reviewSummary";
import { fetchIndicatorMonths } from "../lib/indexedRecords";
import { useAuth } from "../lib/auth";
import { usePermissions } from "../lib/usePermissions";
import {
  effectiveThreshold,
  indicatorCodeOf,
  stripInternalIdPrefix,
  normalizeQuestions,
  type AuditQuestion,
} from "../lib/indicators";
import { isReviewerRole } from "../lib/roleIdentity";
import { useOrgMeta } from "../lib/useOrgMeta";
import { hasRoleCategory, titleFlagsOf } from "../lib/orgMeta";
import { staffLabel } from "../lib/mask";
import { computeOptionSetScore } from "../lib/reviewRecords";
import { logAudit } from "../lib/audit";
import {
  filterImportIndicators,
  importIdentityDocId,
  importIndicatorEmptyHint,
  mergeNoteParts,
  parseResultSheet,
  resultTemplateRows,
  validateResultSheet,
  type ResultImportRowResult,
} from "../lib/import";
import { downloadTemplate, readSheetFile } from "../lib/sheetFile";
import {
  EmptyState,
  FilterPanel,
  ListPanel,
  PageHeading,
  SectionTitle,
  SortableTh,
  SummaryCell,
  useTableSort,
  FormSelect,
} from "../components/ui";
import { TrendChart } from "../components/TrendChart";
import {
  calendarYearsOf,
  expandMonthRangeColumns,
  type AnalysisGranularity,
  type AnalysisPeriodColumn,
  type CalendarMonth,
} from "../lib/analysisPeriod";
import {
  buildRowSpans,
  groupSchedulesForRows,
  scheduleIntervalsInRange,
  singleMonthSpan,
  type RowSpan,
  type ScheduleSpanGroup,
} from "../lib/analysisSpans";
import {
  formatPassRate,
  belowClass,
  causeRecordEntries,
  collectConsolidatedRecordNotes,
  optionDetailRows,
  questionErrorRows,
  questionErrorRowsFromSummaries,
  columnThresholdOf,
  passRateOf,
  personScoringBreakdownRows,
  personOptionRows,
  recordsInMonths,
  resolveDrillSection,
  sectionPassRateOf,
  sectionUnitPassRateOf,
  transposePersonOptionRows,
  unitMonthsForDrill,
  unitPassRate,
  unitPeriodPassRate,
  unitScoringBreakdownRows,
  unitsForDrill,
  type AnalysisRecord,
  type OptionDetailRow,
  type PassRate,
  type QuestionErrorRow,
} from "../lib/analysisRates";
import { canOpenDrill } from "../lib/drillScope";
import { loadCapaCasesByIndicator, loadCapaCasesByUnit, loadCapaSettings } from "./capa/store";
import type { CapaCase, CapaSettings } from "./capa/model";
import {
  getCachedYears,
  invalidateCachedYears,
  mergeYearDocs,
  setCachedYear,
  type CachedYears,
  type ResultsCacheScope,
} from "../lib/resultsCache";
import { getDocsCacheFirst } from "../lib/cacheFirst";
import {
  dbIndexedQueryApi,
  fetchYearDocs,
} from "../lib/indexedRecords";
import {
  buildRecordIndex,
  columnRecordCount,
  recordsForIndex,
  type RecordIndex,
} from "../lib/resultsMatrix";
import { deriveCrossFlags, resolveDataScope } from "../lib/dataScope";
import {
  buildTempTaskKeys,
  columnTempNote,
} from "../lib/tempChartNote";
import { fmtDateTime, fmtTsDate, fmtYm, fmtYmd, pad2, shiftYm, ymKeyOf } from "../lib/ym";
import { toErrorMessage } from "../lib/errors";

interface IndicatorOpt {
  id: string;
  code: string;
  name: string;
  groupId: string;
  status: string;
  version: string;
  threshold: number;
  /** 指標設定頁「啟用分組計分」開關；關閉時結果分析不顯示任何分組／逐題明細列 */
  groupScoring: boolean;
  /** 指標設定的審核項目清單（v1.48.0）：非空時匯入範本多一欄「審核項目」 */
  auditItems: string[];
  questions: AuditQuestion[];
}

interface GroupOpt {
  id: string;
  name: string;
}

interface UnitOpt {
  code: string;
  name: string;
  groupId: string;
  mergedFromUnitCodes: string[];
}

type TabId = "group" | "unit" | "indicator" | "import" | "manage";
type UnitMode = "person" | "unit";

interface CellValue extends PassRate {
  title: string;
}

interface ChartModalData {
  title: string;
  subtitle: string;
  values: number[];
  labels: string[];
  /** hover 提示（與 values 對齊）：期間＋正確率＋（正確數／審查數） */
  tips: string[];
  /** v1.59.0：x 軸標籤附註（與 values 對齊）：「（加審）」／「（有加審）」／null */
  notes: (string | null)[];
  /** 閾值（紅色虛線）；null 表示不畫 */
  threshold: number | null;
  /** v1.64.0：逐點閾值（與 values 對齊）；有變動時圖上畫階梯式虛線 */
  thresholds?: (number | null)[];
  /** v1.50.0：曲線圖上的點可點下探，須帶回指標／單元／期間欄／單位 */
  indicatorId: string;
  mode: UnitMode;
  cols: AnalysisPeriodColumn[];
  unitId?: string;
  /** v1.53.0：分組曲線（sectionKey：group-…／question-…／historical-…）；無值＝整支指標 */
  sectionKey?: string;
  sectionLabel?: string;
}

/** v1.53.0：分組參照（分組子列／分組明細列的 key＋顯示名稱） */
interface SectionRef {
  key: string;
  label: string;
}

interface DocModalData {
  title: string;
  subtitle: string;
  rows: OptionDetailRow[];
  /** v1.50.0：選項明細列可點下探，須帶回指標／單位 */
  indicatorId: string;
  unitId?: string;
  /** 下探單元（組別／單位分析當時的單元） */
  mode: UnitMode;
  /** v1.53.0：分組選項明細（只列該組題目）；無值＝整支指標 */
  sectionKey?: string;
  sectionLabel?: string;
}

/** 下探狀態：L1 單位矩陣（l2UnitId 為 null）；L2 人員各選項結果（l2UnitId 有值） */
interface DrillState {
  indicatorId: string;
  column: AnalysisPeriodColumn;
  mode: UnitMode;
  /** 單位分析限定該單位；組別／指標分析為 undefined（全部單位） */
  scopeUnitId?: string;
  l2UnitId: string | null;
  /** v1.73.0：「顯示近 N 次」點歷史月份格子下探時，L2 只看該月（未設＝點選的期間欄） */
  l2Months?: { year: number; month: number }[];
  /** v1.50.0：直接開 L2 人員層級（全部單位），不經 L1 單位列表 */
  l2All?: boolean;
  /** v1.50.0：分組／逐題篩選（section key：group-…／question-…／historical-…），只顯示該分組／該題的個人結果 */
  sectionKey?: string;
  /** v1.50.0：單題篩選（選項明細／錯題排行用） */
  questionId?: string;
  /** v1.50.0：只顯示答此選項的人員（與 questionId 併用） */
  optionLabel?: string;
  /**
   * v1.88.17 Q5=C：點多月合併格時先展開區間內各月明細（SpanMonthPicker），
   * 再由使用者選單月進入 L1／L2；true 時不渲染 DrillModal，改渲染選月彈窗。
   */
  pickMonths?: boolean;
}

/** 矩陣下方展開面板（僅單位分析）：曲線圖／選項明細 */
interface UnitPanel {
  kind: "chart" | "doc";
  indicatorId: string;
  /** v1.88.17：開啟面板的那一列 id（同一指標分列時，用來取該列的 spans 畫曲線） */
  rowId?: string;
  /** v1.53.0：分組版（只看該組）；無值＝整支指標 */
  sectionKey?: string;
  sectionLabel?: string;
}

function fmtRate(rate: number | null): string {
  return rate == null ? "—" : `${rate.toFixed(1)}%`;
}

function ResultMonthPicker({
  label,
  value,
  onChange,
  ariaLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [displayYear, setDisplayYear] = useState(() => Number(value.slice(0, 4)));
  const pickerRef = useRef<HTMLDivElement>(null);
  const [year, month] = value.split("-").map(Number);
  const months = Array.from({ length: 12 }, (_, index) => index + 1);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  return (
    <div className="results-month-field" ref={pickerRef}>
      <span>{label}</span>
      <span className="results-month-picker">
        <button
          type="button"
          className="results-month-trigger"
          aria-label={ariaLabel}
          aria-expanded={open}
          onClick={() => {
            setDisplayYear(year || new Date().getFullYear());
            setOpen((current) => !current);
          }}
        >
          {year}年{month}月
          <ChevronDown size={15} />
        </button>
        {open && (
          <div className="results-month-popover" role="dialog" aria-label={`${ariaLabel}選擇器`}>
            <span className="results-month-year">
              <button
                type="button"
                aria-label="前一年"
                onClick={() => setDisplayYear((current) => current - 1)}
              >
                <ChevronLeft size={17} />
              </button>
              <strong>{displayYear}年</strong>
              <button
                type="button"
                aria-label="下一年"
                onClick={() => setDisplayYear((current) => current + 1)}
              >
                <ChevronRight size={17} />
              </button>
            </span>
            <span className="results-month-grid">
              {months.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={year === displayYear && month === item ? "active" : ""}
                  onClick={() => {
                    onChange(`${displayYear}-${pad2(item)}`);
                    setOpen(false);
                  }}
                >
                  {item}月
                </button>
              ))}
            </span>
          </div>
        )}
      </span>
    </div>
  );
}

/** 低於閾值時回傳 " below"（紅字樣式），否則空字串；閾值未設定（<=0）不標示 */
function isBelow(rate: number | null | undefined, threshold: number | undefined): string {
  return belowClass(rate, threshold);
}

/** CAPA 案件的來源月份（periodKeys 最後一筆，YYYY-MM）是否落在該欄的月份內 */
function capaInColumn(item: CapaCase, months: { year: number; month: number }[]): boolean {
  const last = item.periodKeys[item.periodKeys.length - 1];
  const m = /^(\d{4})-(\d{1,2})$/.exec(last ?? "");
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return months.some((x) => x.year === y && x.month === mo);
}

/**
 * 矩陣格內容（v1.76.5）：百分比在上、(分子/分母) 在下以縮減欄寬；
 * 加審字樣置於右側垂直置中。無紀錄顯示「未審核」（v1.88.17 Q4=A：
 * 不看排程／任務，無紀錄即未審核）。
 */
function RateCellBody({ cell, extra, capa }: { cell: PassRate; extra?: boolean; capa?: CapaCase }) {
  if (cell.rate == null) return <>未審核</>;
  const pct = Number.isInteger(cell.rate) ? String(cell.rate) : cell.rate.toFixed(1);
  return (
    <span className="rate-stack">
      <span className="rate-stack-main">
        <span className="rate-pct">{pct}%</span>
        <span className="rate-count">({cell.pass}/{cell.total})</span>
      </span>
      {extra ? <small className="extra-review-note rate-stack-extra">加審</small> : null}
      {capa ? (
        <button
          type="button"
          className="capa-mark"
          title={`本期已啟動 CAPA（${capa.caseNumber}），點選前往`}
          aria-label={`前往 CAPA 案件 ${capa.caseNumber}`}
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent("capa:open", { detail: { caseId: capa.id } }));
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          C
        </button>
      ) : null}
    </span>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string | number;
  onChange: (v: string) => void;
  options: { value: string | number; label: string }[];
}) {
  return (
    <label className="field-label">
      {label}
      <div className="select-wrap">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={String(o.value)} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown size={15} />
      </div>
    </label>
  );
}

export function ResultsPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
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
  // 單位分析矩陣下方展開面板（曲線圖／選項明細）
  const [unitPanel, setUnitPanel] = useState<UnitPanel | null>(null);

  // 資料範圍（v1.88.4：改走共用 dataScope——縱向從屬＋橫向 cross 取聯集，
  // 取代原先寫死的推導；護理長仍優先 staff 分支，沿用舊順序，保留摘要模式）
  const orgMeta = useOrgMeta();
  const isNurseLeader = !!user && (
    titleFlagsOf(user.title ?? "", user.titleId, orgMeta.titleMeta, orgMeta.titleMetaById).isUnitHead ||
    hasRoleCategory(user.roles ?? [], "unitHead", orgMeta.roleMeta)
  );
  const isReviewer = !!user && isReviewerRole(user?.roles ?? [], orgMeta.roleMeta);
  const dataScope = useMemo(() => {
    if (!user) return null;
    return resolveDataScope({
      isAdmin: (user.roles ?? []).includes("系統管理員"),
      roles: user.roles ?? [],
      title: user.title ?? "",
      titleFlags: titleFlagsOf(user.title ?? "", user.titleId, orgMeta.titleMeta, orgMeta.titleMetaById),
      memberships: user.memberships ?? [],
      unitCode: user.unitCode ?? "",
      titleUnitCodes: user.titleUnitCodes ?? [],
      units,
      unitGroups: catalog.unitGroups,
      cross: deriveCrossFlags(catalog.templates, user.roles ?? [], user.title ?? ""),
      isReviewer,
    });
  }, [user, units, catalog, orgMeta.titleMeta, orgMeta.titleMetaById, isReviewer]);

  const scope = useMemo(() => {
    const roles = user?.roles ?? [];
    if (roles.includes("系統管理員")) return { kind: "admin" as const };
    if (!user) return { kind: "admin" as const };
    if (dataScope?.kind === "all") return { kind: "admin" as const };
    if (isNurseLeader)
      return { kind: "staff" as const, unitCode: user.unitCode };
    if (isReviewer)
      return { kind: "reviewer" as const, staffId: user.staffId };
    return { kind: "staff" as const, unitCode: user.unitCode };
  }, [user, isNurseLeader, isReviewer, dataScope]);

  /**
   * 靜態可見單位集合（dataScope 口徑；管理員沿用舊行為回空集合，
   * 各過濾處對 admin 另有全量分支，不受影響）。
   */
  const visibleUnitCodes = useMemo(() => {
    if (scope.kind === "admin") return new Set<string>();
    if (!dataScope || dataScope.kind === "all") return new Set<string>();
    return dataScope.unitCodes;
  }, [scope.kind, dataScope]);

  /** 按年份快取的權限範圍鍵（與 scope 同義，格式見 resultsCache） */
  const cacheScope: ResultsCacheScope = useMemo(() => {
    if (scope.kind === "reviewer")
      return { kind: "reviewer", staffId: scope.staffId };
    if (scope.kind === "staff")
      return {
        kind: "staff",
        unitCode: scope.unitCode,
        unitCodes: [...visibleUnitCodes].sort(),
      };
    return { kind: "admin" };
  }, [scope, visibleUnitCodes]);

  /**
   * v1.28 階段 7（B7）：單一指標限縮查詢的指標。
   * - 指標分析頁籤：永遠只看一支指標（selIndicator）。
   * - 單位分析頁籤：選了特定指標（selIndU ≠ "all"）時限縮；選「全部」時不加條件。
   * - 組別分析／匯入頁籤：矩陣要看整組指標，不限縮，維持按年查詢。
   * 限縮只影響「查回哪些紀錄」，不影響權限範圍（scopedRecords 照舊過濾）。
   */
  const singleIndicatorId = useMemo(() => {
    if (tab === "indicator") return selIndicator || null;
    if (tab === "unit" && selIndU !== "all") return selIndU;
    return null;
  }, [tab, selIndicator, selIndU]);

  // 指標／組別／單位（掛載時載入一次）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = getFirebaseDb();
        const [isnap, gsnap, usnap, ssnap] = await Promise.all([
          loadRefCollection("indicators"),
          loadRefCollection("groups"),
          loadRefCollection("units"),
          // v1.59.0：臨時排程自審旗標（曲線圖加審標註排除自審任務用）
          getDocsCacheFirst(collection(db, "indicatorSchedules")),
        ]);
        if (cancelled) return;
        const selfKeys = new Set<string>();
        ssnap.docs.forEach((d) => {
          const data = d.data() as Record<string, unknown>;
          if (
            data.category === "temp" &&
            data.selfReview === true &&
            typeof data.indicatorId === "string" &&
            typeof data.period === "string"
          ) {
            selfKeys.add(`${data.indicatorId}|${data.period}`);
          }
        });
        setSelfReviewTempKeys(selfKeys);
        const list: IndicatorOpt[] = [];
        isnap.docs.forEach((d) => {
          const data = d.data() as Record<string, unknown>;
          list.push({
            id: d.id,
            code: indicatorCodeOf(d.id),
            name:
              typeof data.name === "string" && data.name ? data.name : d.id,
            groupId: typeof data.groupId === "string" ? data.groupId : "",
            status: typeof data.status === "string" ? data.status : "",
            version: typeof data.version === "string" ? data.version : "v1.0",
            threshold: effectiveThreshold(data),
            groupScoring: data.groupScoring === true,
            auditItems: Array.isArray(data.auditItems)
              ? data.auditItems.map(String).map((x) => x.trim()).filter(Boolean)
              : [],
            questions: normalizeQuestions(data.questions).questions,
          });
        });
        list.sort((a, b) => a.code.localeCompare(b.code, "zh-Hant"));
        setIndicators(list);
        setGroups(
          gsnap.docs
            .map((d) => ({
              id: d.id,
              name:
                typeof d.data().name === "string" ? d.data().name : d.id,
            }))
            .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")),
        );
        setUnits(
          usnap.docs
            .map((d) => {
              const data = d.data();
              return {
                code: d.id,
                name: typeof data.name === "string" ? data.name : d.id,
                groupId:
                  typeof data.groupId === "string" ? data.groupId : "",
                mergedFromUnitCodes: Array.isArray(data.mergedFromUnitCodes)
                  ? data.mergedFromUnitCodes.map(String).filter(Boolean)
                  : [],
              };
            })
            .sort((a, b) => a.code.localeCompare(b.code, "zh-Hant")),
        );
      } catch {
        if (!cancelled) {
          setIndicators([]);
          setGroups([]);
          setUnits([]);
        }
      } finally {
        if (!cancelled) setMetaLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rangeValid = Boolean(startMonth && endMonth && startMonth <= endMonth);
  /**
   * v1.88.17：期間欄一律一月一欄（月／年／學年三種模式皆然），
   * 資料格的合併改由每列自己的排程區間決定（見 buildRowSpans），
   * 欄位不再由排程區間聯集產生。區間單位只影響預設起訖範圍
   * （見 handleIntervalChange），不決定欄位切法。
   */
  const buildColumns = useCallback(
    (
      s: string,
      e: string,
      _g: AnalysisGranularity,
    ): AnalysisPeriodColumn[] => expandMonthRangeColumns(s, e, "month"),
    [],
  );
  // 期間欄只取所選年月範圍內的月份，再依月／年／學年分組。
  const columns = useMemo(
    () => buildColumns(startMonth, endMonth, interval),
    [buildColumns, startMonth, endMonth, interval],
  );
  const queryYears = useMemo(() => calendarYearsOf(columns), [columns]);
  const queryLoadYears = useMemo(
    () => queryYears.length > 0
      ? [...new Set([...queryYears, Math.min(...queryYears) - 1])].sort((a, b) => a - b)
      : queryYears,
    [queryYears],
  );
  /** 已生效的期間欄：未查詢前沿用 live 值（畫面為空白頁，不渲染矩陣） */
  const appliedColumns = useMemo(
    () =>
      applied
        ? buildColumns(
            applied.startMonth,
            applied.endMonth,
            applied.interval,
          )
        : columns,
    [applied, columns, buildColumns],
  );
  const appliedYearsKey = applied ? applied.years.join(",") : "";
  const allMonths = useMemo(
    () => appliedColumns.flatMap((c) => c.months),
    [appliedColumns],
  );

  /**
   * v1.66.0：指標分析摘要模式。該指標有可用封存摘要的月份讀摘要格（每月只採
   * 一份摘要，避免重疊區間重複計），其餘月份才讀原始紀錄。審查員範圍不走摘要。
   */
  /** 本頁籤要載入的指標（審查員範圍或尚未載入封存資訊時為空＝沿用舊讀法） */
  const planTargets = useMemo<string[]>(() => {
    if (!applied || rawFull || scope.kind === "reviewer" || !archiveCtx) return [];
    if (tab === "indicator") return selIndicator ? [selIndicator] : [];
    if (tab === "group")
      return indicators.filter((i) => i.groupId === selGroup).map((i) => i.id);
    if (tab === "unit")
      return indicators
        .filter(
          (i) =>
            (selGroupU === "all" || i.groupId === selGroupU) &&
            (selIndU === "all" || i.id === selIndU),
        )
        .map((i) => i.id);
    return [];
  }, [tab, selIndicator, selGroup, selGroupU, selIndU, applied, rawFull, scope.kind, archiveCtx, indicators]);
  const summaryPlans = useMemo(() => {
    const out = new Map<
      string,
      {
        coveredKeys: string[];
        uncovered: { year: number; month: number }[];
        archivedCells: ArchiveCell[];
        staleLabels: string[];
      }
    >();
    if (planTargets.length === 0 || !archiveCtx) return out;
    const wantedList: string[] = allMonths.map((x) => `${x.year}-${x.month}`);
    const wanted = new Set<string>(wantedList);
    for (const id of planTargets) {
      const opt = indicators.find((i) => i.id === id);
      if (!opt) continue;
      const owner = new Map<string, string>();
      const list = [...archiveCtx.summaries.values()]
        .filter((sm) => sm.indicatorId === id && sm.schemaVersion === SUMMARY_SCHEMA_VERSION)
        .sort((a, b) => a.id.localeCompare(b.id));
      for (const sm of list) {
        let cur = { year: sm.start.year, month: sm.start.month };
        while (cur.year * 12 + cur.month <= sm.end.year * 12 + sm.end.month) {
          const k = ymKeyOf(cur.year, cur.month);
          if (!owner.has(k)) owner.set(k, sm.id);
          cur = shiftYm(cur.year, cur.month, 1);
        }
      }
      const coveredKeys: string[] = wantedList.filter(
        (k, i) => wantedList.indexOf(k) === i && owner.has(k),
      );
      if (coveredKeys.length === 0) continue;
      const archivedCells: ArchiveCell[] = [];
      for (const sm of list)
        for (const c of sm.cells) {
          const k = `${c.year}-${c.month}`;
          if (!wanted.has(k) || owner.get(k) !== sm.id) continue;
          if (scope.kind === "staff" && !visibleUnitCodes.has(c.unitId)) continue;
          archivedCells.push(c);
        }
      out.set(id, {
        coveredKeys,
        uncovered: allMonths.filter((x) => !owner.has(`${x.year}-${x.month}`)),
        archivedCells,
        staleLabels: list
          .filter((sm) => isSummaryStale(sm, opt.threshold))
          .filter((sm) => [...owner.values()].includes(sm.id))
          .map(
            (sm) =>
              `${opt.name}（${sm.start.year}/${sm.start.month}~${sm.end.year}/${sm.end.month}）`,
          ),
      });
    }
    return out;
  }, [planTargets, archiveCtx, indicators, allMonths, scope.kind, visibleUnitCodes]);
  const perIndMode = summaryPlans.size > 0;
  const plansKey = useMemo(
    () =>
      perIndMode
        ? `${tab}|${planTargets.join(",")}|${[...summaryPlans]
            .map(([id, p]) => `${id}:${[...p.coveredKeys].sort().join(",")}`)
            .join(";")}`
        : "",
    [perIndMode, tab, planTargets, summaryPlans],
  );
  /** 指標分析頁用（單一指標） */
  const summaryPlan = tab === "indicator" && selIndicator ? summaryPlans.get(selIndicator) ?? null : null;
  /** 需要原始紀錄的操作（選項明細、下探、原因詞庫）：先載入全部原始紀錄，請使用者再點一次。 */
  function requireRaw(indicatorId?: string): boolean {
    if (!perIndMode) return false;
    if (indicatorId && !summaryPlans.has(indicatorId)) return false;
    setRawHint("此操作需原始紀錄，已開始載入，載入完成後請再點一次。");
    setRawFull(true);
    return true;
  }
  useEffect(() => {
    setRawFull(false);
    setRawHint("");
  }, [selIndicator, selGroup, selGroupU, selIndU, applied, tab]);

  // 審查紀錄（查詢閘門＋按年份快取）：
  // 未按「查詢」不觸發（applied 為 null）；已查過的年份直接吃記憶體快取，
  // 缺的年份才按年發查詢，併回後畫面永遠從合併後的快取渲染。
  // 快取鍵含權限範圍（見 resultsCache），不同範圍不共用。
  useEffect(() => {
    if (!applied || tab === "manage" || tab === "import") return;
    if ((tab === "indicator" || tab === "group" || tab === "unit") && scope.kind !== "reviewer" && !archiveReady) {
      setLoading(true);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const db = getFirebaseDb();
        const years = applied.years;
        // v1.28 階段 7（B7）：單一指標限縮時改走 indicatorId＋year 複合索引
        // 查詢；索引未就緒時 fetchYearDocs 自動退回舊查詢＋前端過濾。
        const indFilter = singleIndicatorId ?? undefined;
        const perInd = summaryPlans.size > 0;
        let rlSummary: AnalysisRecord[] | null = null;
        let recCached: CachedYears<AnalysisRecord> = {
          hits: new Map(),
          missing: [],
          fetchedAt: null,
        };
        const recFresh = new Map<number, AnalysisRecord[]>();
        let fellBack = false;
        if (perInd) {
          // 摘要模式：每支指標只讀未封存月份的原始紀錄（不寫年份快取，避免半份資料被當整年）
          const jobs: Promise<Awaited<ReturnType<typeof fetchIndicatorMonths>>>[] = [];
          for (const id of planTargets) {
            const months = summaryPlans.get(id)?.uncovered ?? allMonths;
            const byYear = new Map<number, number[]>();
            for (const m of months) {
              const arr = byYear.get(m.year) ?? [];
              arr.push(m.month);
              byYear.set(m.year, arr);
            }
            for (const [y, ms] of byYear)
              jobs.push(
                fetchIndicatorMonths(dbIndexedQueryApi, collection(db, "reviewRecords"), {
                  indicatorId: id,
                  year: y,
                  months: ms,
                }),
              );
          }
          const got = await Promise.all(jobs);
          rlSummary = [];
          got.forEach((snap) => {
            if (snap.fellBack) fellBack = true;
            snap.docs.forEach((d) => {
              const v = d.data() as Record<string, unknown>;
              const rec = recordDocToAnalysis(d.id, v);
              rec.taskId = typeof v.taskId === "string" ? v.taskId : undefined;
              rlSummary!.push(rec);
            });
          });
        } else {
        recCached = getCachedYears<AnalysisRecord>(
          "reviewRecords",
          years,
          cacheScope,
          indFilter,
        );
        if (recCached.missing.length > 0) {
          const snaps = await Promise.all(
            recCached.missing.map((y) =>
              fetchYearDocs(
                dbIndexedQueryApi,
                collection(db, "reviewRecords"),
                { indicatorId: indFilter, year: y },
              ),
            ),
          );
          snaps.forEach((snap, i) => {
            if (snap.fellBack) fellBack = true;
            const y = recCached.missing[i];
            const docs: AnalysisRecord[] = [];
            snap.docs.forEach((d) => {
              const v = d.data() as Record<string, unknown>;
              const answers = Array.isArray(v.answers)
                ? v.answers.map((a) => {
                    const r = (a ?? {}) as Record<string, unknown>;
                    return {
                      questionId:
                        typeof r.questionId === "string" ? r.questionId : "",
                      itemText:
                        typeof r.itemText === "string" ? r.itemText : "",
                      optionLabel:
                        typeof r.optionLabel === "string" ? r.optionLabel : "",
                      score: typeof r.score === "number" ? r.score : 0,
                      excluded: r.excluded === true,
                      commonErrors: Array.isArray(r.commonErrors)
                        ? r.commonErrors.filter((word): word is string => typeof word === "string")
                        : [],
                      note: typeof r.note === "string" ? r.note : "",
                    };
                  })
                : [];
              docs.push({
                indicatorId: String(v.indicatorId ?? ""),
                taskId: typeof v.taskId === "string" ? v.taskId : undefined,
                unitId: String(v.unitId ?? ""),
                year: Number(v.year ?? 0),
                month: Number(v.month ?? 0),
                rate: typeof v.rate === "number" ? v.rate : null,
                thresholdAtSchedule:
                  typeof v.thresholdAtSchedule === "number" ? v.thresholdAtSchedule : undefined,
                indicatorVersion:
                  typeof v.indicatorVersionAtSchedule === "string"
                    ? v.indicatorVersionAtSchedule
                    : undefined,
                answers,
                personEmpNo: String(v.reviewedPersonEmpNo ?? ""),
                personName: String(v.reviewedPersonName ?? ""),
                bedNo: typeof v.bedNo === "string" ? v.bedNo : "",
              });
            });
            setCachedYear("reviewRecords", y, cacheScope, docs, indFilter);
            recFresh.set(y, docs);
          });
        }
        }
        const rl = rlSummary ?? mergeYearDocs(recCached.hits, recFresh);
        // v1.59.0：任務表改為全部身分皆載入（原只限審查員範圍過濾用），
        // 曲線圖加審標註需反查 reviewTasks.scheduleCategory。
        let tl: {
          id: string;
          unitId: string;
          reviewerId: string;
          indicatorId: string;
          year: number;
          month: number;
          scheduleCategory?: string;
          schedulePeriod?: string;
        }[] = [];
        let taskFetchedAt: number | null = null;
        if (perInd) {
          // 摘要模式：任務表只讀本頁籤的指標（不寫年份快取）
          const tsn = await Promise.all(
            planTargets.flatMap((id) =>
              years.map((y) =>
                fetchYearDocs(dbIndexedQueryApi, collection(db, "reviewTasks"), {
                  indicatorId: id,
                  year: y,
                }),
              ),
            ),
          );
          tsn.forEach((snap) => {
            snap.docs.forEach((d) => {
              const v = d.data() as Record<string, unknown>;
              tl.push({
                id: d.id,
                unitId: String(v.unitId ?? ""),
                reviewerId: String(v.reviewerId ?? ""),
                indicatorId: String(v.indicatorId ?? ""),
                year: Number(v.year ?? 0),
                month: Number(v.month ?? 0),
                scheduleCategory:
                  typeof v.scheduleCategory === "string" ? v.scheduleCategory : undefined,
                schedulePeriod:
                  typeof v.schedulePeriod === "string" ? v.schedulePeriod : undefined,
              });
            });
          });
        } else {
          const taskCached = getCachedYears<{
            id: string;
            unitId: string;
            reviewerId: string;
            indicatorId: string;
            year: number;
            month: number;
            scheduleCategory?: string;
            schedulePeriod?: string;
          }>("reviewTasks", years, cacheScope);
          const taskFresh = new Map<
            number,
            {
              id: string;
              unitId: string;
              reviewerId: string;
              indicatorId: string;
              year: number;
              month: number;
              scheduleCategory?: string;
              schedulePeriod?: string;
            }[]
          >();
          if (taskCached.missing.length > 0) {
            const tsnaps = await Promise.all(
              taskCached.missing.map((y) =>
                getDocs(
                  query(
                    collection(db, "reviewTasks"),
                    where("year", "==", y),
                  ),
                ),
              ),
            );
            tsnaps.forEach((snap, i) => {
              const y = taskCached.missing[i];
              const docs: {
                id: string;
                unitId: string;
                reviewerId: string;
                indicatorId: string;
                year: number;
                month: number;
                scheduleCategory?: string;
                schedulePeriod?: string;
              }[] = [];
              snap.docs.forEach((d) => {
                const v = d.data() as Record<string, unknown>;
                docs.push({
                  id: d.id,
                  unitId: String(v.unitId ?? ""),
                  reviewerId: String(v.reviewerId ?? ""),
                  indicatorId: String(v.indicatorId ?? ""),
                  year: Number(v.year ?? 0),
                  month: Number(v.month ?? 0),
                  scheduleCategory:
                    typeof v.scheduleCategory === "string"
                      ? v.scheduleCategory
                      : undefined,
                  schedulePeriod:
                    typeof v.schedulePeriod === "string"
                      ? v.schedulePeriod
                      : undefined,
                });
              });
              setCachedYear("reviewTasks", y, cacheScope, docs);
              taskFresh.set(y, docs);
            });
          }
          tl = mergeYearDocs(taskCached.hits, taskFresh);
          taskFetchedAt = taskCached.fetchedAt;
        }
        if (cancelled) return;
        setRecords(rl);
        setTasks(tl);
        if (fellBack) {
          console.warn(
            "結果分析：複合索引 (indicatorId, year) 尚未就緒，已自動退回按年查詢＋前端過濾（結果一致）。請至 Firebase Console → Firestore → 索引建立該索引，之後查詢會更快。",
          );
          setIndexFallback(true);
          setIndexFallbackDismissed(false);
        } else {
          setIndexFallback(false);
        }
        const at = Math.max(recCached.fetchedAt ?? 0, taskFetchedAt ?? 0);
        setFetchedAt(at > 0 ? at : Date.now());
      } catch {
        if (!cancelled) {
            setRecords([]);
          setTasks([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedYearsKey, reloadNonce, archiveReady, plansKey, rawFull, scope.kind, scope.kind === "reviewer" ? scope.staffId : "", scope.kind === "staff" ? scope.unitCode : "", tab, singleIndicatorId, isNurseLeader, visibleUnitCodes]);

  /** 每次查詢皆失效所選年份，避免再次查詢命中過期快取。 */
  /**
   * v1.88.17：區間單位下拉只影響預設起訖範圍（切換時重設起訖月份；
   * 欄位切法已與下拉脫鉤，三種模式都一月一格）。
   * 月＝今年 1 月～本月；年＝今年 1～12 月；學年＝當學年 8 月～隔年 7 月。
   */
  function handleIntervalChange(g: AnalysisGranularity) {
    setInterval(g);
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    if (g === "year") {
      setStartMonth(`${y}-01`);
      setEndMonth(`${y}-12`);
    } else if (g === "academic") {
      const startYear = m >= 8 ? y : y - 1;
      setStartMonth(`${startYear}-08`);
      setEndMonth(`${startYear + 1}-07`);
    } else {
      setStartMonth(`${y}-01`);
      setEndMonth(`${y}-${pad2(m)}`);
    }
  }
  function handleQuery() {
    if (!rangeValid || tab === "manage") return;
    invalidateCachedYears("reviewRecords", queryLoadYears, cacheScope);
    invalidateCachedYears("reviewTasks", queryLoadYears, cacheScope);
    setApplied({ years: queryLoadYears, startMonth, endMonth, interval });
    setReloadNonce((n) => n + 1);
  }
  // 範圍內紀錄（依權限範圍過濾）
  // v1.88.4：reviewer 分支保留，但與靜態範圍（dataScope）取聯集——
  // 審查員除了自己負責任務的單位，也看得到其他身分放寬的單位。
  const reviewerTaskUnitCodes = useMemo(() => {
    if (scope.kind !== "reviewer") return new Set<string>();
    return new Set(
      tasks.filter((t) => t.reviewerId === scope.staffId).map((t) => t.unitId),
    );
  }, [tasks, scope]);

  const scopedRecords = useMemo(() => {
    if (scope.kind === "admin") return records;
    if (scope.kind === "staff")
      return records.filter((r) => visibleUnitCodes.has(r.unitId));
    return records.filter(
      (r) =>
        reviewerTaskUnitCodes.has(r.unitId) || visibleUnitCodes.has(r.unitId),
    );
  }, [records, tasks, scope, visibleUnitCodes, reviewerTaskUnitCodes]);

  /**
   * v1.59.0：加審任務月鍵集合（曲線圖標註反查用）。
   * 任務表以查詢年份載入（全部身分）；自審任務以 indicatorSchedules
   * 的 selfReview 排除。注意：任務不分權限範圍載入，標註只看任務
   * 存在與否，實際顯示的紀錄仍受 scopedRecords 權限過濾。
   */
  const tempTaskKeys = useMemo(
    () => buildTempTaskKeys(tasks, selfReviewTempKeys),
    [tasks, selfReviewTempKeys],
  );
  const tempTaskIds = useMemo(
    () => new Set(tasks.filter((task) =>
      task.scheduleCategory === "temp" &&
      !(task.schedulePeriod && selfReviewTempKeys.has(`${task.indicatorId}|${task.schedulePeriod}`)),
    ).map((task) => task.id)),
    [tasks, selfReviewTempKeys],
  );
  const hasTempReview = (
    indicatorId: string,
    col: AnalysisPeriodColumn,
    unitId?: string,
  ) => {
    const hcs = cellsOfInd(indicatorId, col.months, unitId);
    if (hcs) {
      const extra = recordsForIndex(recordIndex, indicatorId, col.months, unitId);
      return (
        extra.some((record) => Boolean(record.taskId && tempTaskIds.has(record.taskId))) ||
        columnTempNote(pseudoRecs(indicatorId, hcs), tempTaskKeys, col.months.length) != null
      );
    }
    const periodRecords = recordsForIndex(recordIndex, indicatorId, col.months, unitId);
    return periodRecords.some((record) => Boolean(record.taskId && tempTaskIds.has(record.taskId))) ||
      columnTempNote(periodRecords, tempTaskKeys, col.months.length) != null;
  };

  /**
   * v1.88.17：每列合併格（RowSpan）建構。
   * 表頭固定一月一格；每列的資料格按該指標自己的排程區間 colspan 合併。
   * 加審月份不併入合併格：有加審紀錄的月份從區間中切出、獨立成一格
   * （temp: true，格面顯示該月全部紀錄並標「加審」），區間其餘月份仍合併。
   */
  interface MatrixRow {
    id: string;
    indicatorId: string;
    label: string;
    spans: RowSpan[];
    details: { key: string; label: string; cells: Record<string, PassRate> }[];
  }

  /** 該指標在指定月份內有加審紀錄的月份鍵集合（原始紀錄 taskId 或封存摘要反查任務鍵）。 */
  function tempMonthKeysOf(
    indicatorId: string,
    months: CalendarMonth[],
    unitId: string | undefined,
  ): Set<string> {
    const keys = new Set<string>();
    for (const m of months) {
      const col: AnalysisPeriodColumn = {
        key: `${m.year}-${m.month}`,
        label: fmtYm(m.year, m.month),
        months: [m],
      };
      if (hasTempReview(indicatorId, col, unitId)) keys.add(`${m.year}-${m.month}`);
    }
    return keys;
  }

  /**
   * 該指標的非臨時排程分組（區間已裁切到 applied 範圍；重疊排程分組，
   * 見 groupSchedulesForRows）。無排程／範圍內無區間時回一組空區間（全單月格）。
   */
  function scheduleGroupsOf(indicatorId: string): ScheduleSpanGroup[] {
    const rangeMonths = appliedColumns.flatMap((c) => c.months);
    const inputs = (archiveCtx?.schedules ?? [])
      .filter((sc) => sc.category !== "temp" && sc.indicatorId === indicatorId)
      .map((sc) => ({
        key: scheduleDocId(sc.indicatorId, sc.category, sc.period),
        periodLabel: sc.periodLabel,
        intervals: scheduleIntervalsInRange(sc, rangeMonths),
      }))
      .filter((g) => g.intervals.length > 0);
    const groups = groupSchedulesForRows(inputs);
    return groups.length > 0
      ? groups
      : [{ key: "__none__", periodLabels: [], intervals: [] }];
  }

  /**
   * 該指標在指定月份範圍、指定單位範圍內的 spans（全部排程聯集；
   * 重疊區間以起始月較早者優先，僅為防禦性 fallback——矩陣列應走
   * buildMatrixRows 的分組 spans）。指標分析曲線圖／openChart 備援用。
   */
  function spansForIndicator(
    indicatorId: string,
    months: CalendarMonth[],
    unitId: string | undefined,
  ): RowSpan[] {
    const groups = scheduleGroupsOf(indicatorId);
    const intervals = groups.flatMap((g) => g.intervals);
    return buildRowSpans(
      months,
      intervals,
      tempMonthKeysOf(indicatorId, months, unitId),
    );
  }

  /** 建矩陣列：每支指標依排程分組分列（重疊才分列，否則一列）；每列 spans＋分組明細列。 */
  function buildMatrixRows(
    inds: IndicatorOpt[],
    months: CalendarMonth[],
    unitId: string | undefined,
    mode: UnitMode,
    withDetails: boolean,
  ): MatrixRow[] {
    const rows: MatrixRow[] = [];
    for (const ind of inds) {
      const groups = scheduleGroupsOf(ind.id);
      for (const group of groups) {
        const spans = buildRowSpans(
          months,
          group.intervals,
          tempMonthKeysOf(ind.id, months, unitId),
        );
        const split = groups.length > 1;
        rows.push({
          id: split ? `${ind.id}__${group.key}` : ind.id,
          indicatorId: ind.id,
          label: split
            ? `${ind.code}・${ind.name}（${group.periodLabels.join("、")}）`
            : `${ind.code}・${ind.name}`,
          spans,
          details: withDetails
            ? matrixScoringDetails(ind, spans, unitId, mode)
            : [],
        });
      }
    }
    return rows;
  }

  const causeCountRows = useMemo(() => {    const counts = new Map<string, number>();
    for (const record of recordsInMonths(scopedRecords, allMonths)) {
      for (const answer of record.answers) {
        for (const word of new Set(answer.commonErrors ?? [])) {
          const cause = word.trim();
          if (cause) counts.set(cause, (counts.get(cause) ?? 0) + 1);
        }
      }
    }
    return [...counts.entries()]
      .map(([cause, count]) => ({ cause, count }))
      .sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause, "zh-Hant"));
  }, [scopedRecords, allMonths]);

  /**
   * v1.28 階段 7（A3）：矩陣索引——進資料時預建一次
   * Map<指標, Map<曆年月, 紀錄[]>>，cellValue／曲線／明細／下探改查表，
   * 不再每格對全部 scopedRecords 做 filter。
   */
  // v1.73.0：「顯示近 N 次」補讀的歷史月份紀錄（已封存或超出查詢年份者）；
  // 套用同一權限範圍後併入 recordIndex，換查詢條件（records 變動）即清空。
  const [historyExtra, setHistoryExtra] = useState<AnalysisRecord[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyNote, setHistoryNote] = useState("");
  const historyFetched = useRef<Set<string>>(new Set());
  useEffect(() => {
    historyFetched.current = new Set();
    setHistoryExtra([]);
    setHistoryNote("");
  }, [records]);
  const scopedHistory = useMemo(() => {
    if (historyExtra.length === 0) return historyExtra;
    if (scope.kind === "admin") return historyExtra;
    if (scope.kind === "staff")
      return historyExtra.filter((r) => visibleUnitCodes.has(r.unitId));
    return historyExtra.filter(
      (r) =>
        reviewerTaskUnitCodes.has(r.unitId) || visibleUnitCodes.has(r.unitId),
    );
  }, [historyExtra, tasks, scope, visibleUnitCodes, reviewerTaskUnitCodes]);
  const recordIndex = useMemo(
    () => buildRecordIndex(scopedHistory.length > 0 ? [...scopedRecords, ...scopedHistory] : scopedRecords),
    [scopedRecords, scopedHistory],
  );
  const recordIndexRef = useRef(recordIndex);
  recordIndexRef.current = recordIndex;
  const archiveCtxRef = useRef(archiveCtx);
  archiveCtxRef.current = archiveCtx;
  /**
   * 「顯示近 N 次」：找出選定期間之前、該指標有資料的前 N 個月（原始紀錄已載入，或封存摘要
   * 有該月），缺原始紀錄的月份只對該月補讀；不足 N 個月再逐年往前補讀（最多 3 年）。
   */
  const ensureHistory = useCallback(async (indicatorId: string, beforeKey: number, n: number): Promise<void> => {
    setHistoryBusy(true);
    setHistoryNote("");
    try {
      const db = getFirebaseDb();
      const added: AnalysisRecord[] = [];
      const toAnalysis = (d: { id: string; data: () => unknown }) => {
        const v = d.data() as Record<string, unknown>;
        const rec = recordDocToAnalysis(d.id, v);
        rec.taskId = typeof v.taskId === "string" ? v.taskId : undefined;
        return rec;
      };
      const knownKeys = () => {
        const keys = new Set<number>(recordIndexRef.current.get(indicatorId)?.keys() ?? []);
        for (const k of historyFetched.current) {
          const [ind, ym] = k.split("|");
          if (ind === indicatorId && ym.includes("-")) {
            const [y, m] = ym.split("-").map(Number);
            keys.add(y * 100 + m);
          }
        }
        for (const sm of archiveCtxRef.current?.summaries.values() ?? []) {
          if (sm.indicatorId !== indicatorId) continue;
          for (const c of sm.cells) if (c.total > 0) keys.add(c.year * 100 + c.month);
        }
        return keys;
      };
      for (let round = 0; round < 4; round++) {
        const target = [...knownKeys()].filter((k) => k < beforeKey).sort((a, b) => b - a).slice(0, n);
        const rawKeys = new Set<number>(recordIndexRef.current.get(indicatorId)?.keys() ?? []);
        const need = target.filter((k) => {
          if (rawKeys.has(k)) return false;
          return !historyFetched.current.has(`${indicatorId}|${Math.floor(k / 100)}-${k % 100}`);
        });
        if (need.length > 0) {
          const byYear = new Map<number, number[]>();
          for (const k of need) {
            const y = Math.floor(k / 100);
            byYear.set(y, [...(byYear.get(y) ?? []), k % 100]);
          }
          const got = await Promise.all(
            [...byYear].map(([year, months]) =>
              fetchIndicatorMonths(dbIndexedQueryApi, collection(db, "reviewRecords"), { indicatorId, year, months }),
            ),
          );
          got.forEach((snap, i) => {
            const year = [...byYear.keys()][i];
            for (const m of byYear.get(year) ?? []) historyFetched.current.add(`${indicatorId}|${year}-${m}`);
            snap.docs.forEach((d) => added.push(toAnalysis(d)));
          });
          if (added.length > 0) {
            const batch = [...added];
            added.length = 0;
            setHistoryExtra((prev) => [...prev, ...batch]);
          }
          continue;
        }
        if (target.length >= n) break;
        // 已知月份不足 N 個：再往前補讀一年（該指標整年）
        const earliest = Math.min(beforeKey, ...[...knownKeys()]);
        const y = Math.floor(earliest / 100) - 1;
        const yk = `${indicatorId}|${y}`;
        if (round >= 3 || historyFetched.current.has(yk)) break;
        historyFetched.current.add(yk);
        const snap = await fetchYearDocs(dbIndexedQueryApi, collection(db, "reviewRecords"), { indicatorId, year: y });
        const batch: AnalysisRecord[] = [];
        snap.docs.forEach((d) => {
          const rec = toAnalysis(d);
          const mk = `${indicatorId}|${rec.year}-${rec.month}`;
          if (historyFetched.current.has(mk) || recordIndexRef.current.get(indicatorId)?.has(rec.year * 100 + rec.month)) return;
          batch.push(rec);
        });
        for (const r of batch) historyFetched.current.add(`${indicatorId}|${r.year}-${r.month}`);
        if (batch.length === 0) break;
        setHistoryExtra((prev) => [...prev, ...batch]);
      }
      const finalTarget = [...knownKeys()].filter((k) => k < beforeKey).length;
      if (finalTarget < n) setHistoryNote(`該指標在此之前只找到 ${finalTarget} 次審查資料。`);
    } catch {
      setHistoryNote("歷史月份讀取失敗（可能是系統用量額度已滿），稍後再試。");
    } finally {
      setHistoryBusy(false);
    }
  }, []);

  /**
   * 下探 L2（再下探）才讀原始紀錄：對尚無原始紀錄的指標月份補讀一次並快取，
   * 同指標同月份再點別的單位不再讀取。L1（各單位結果）一律優先用封存摘要，不走這裡。
   */
  const ensureMonths = useCallback(async (indicatorId: string, months: { year: number; month: number }[]): Promise<void> => {
    const have = recordIndexRef.current.get(indicatorId);
    const need = months.filter(
      ({ year, month }) =>
        !(have?.get(year * 100 + month)?.length) &&
        !historyFetched.current.has(`${indicatorId}|${year}-${month}`),
    );
    if (need.length === 0) return;
    setHistoryBusy(true);
    setHistoryNote("");
    try {
      const db = getFirebaseDb();
      const byYear = new Map<number, number[]>();
      for (const { year, month } of need) byYear.set(year, [...(byYear.get(year) ?? []), month]);
      const years = [...byYear.keys()];
      const got = await Promise.all(
        years.map((year) =>
          fetchIndicatorMonths(dbIndexedQueryApi, collection(db, "reviewRecords"), {
            indicatorId,
            year,
            months: byYear.get(year) ?? [],
          }),
        ),
      );
      const batch: AnalysisRecord[] = [];
      got.forEach((snap, i) => {
        for (const m of byYear.get(years[i]) ?? []) historyFetched.current.add(`${indicatorId}|${years[i]}-${m}`);
        snap.docs.forEach((d) => {
          const v = d.data() as Record<string, unknown>;
          const rec = recordDocToAnalysis(d.id, v);
          rec.taskId = typeof v.taskId === "string" ? v.taskId : undefined;
          batch.push(rec);
        });
      });
      if (batch.length > 0) setHistoryExtra((prev) => [...prev, ...batch]);
    } catch {
      setHistoryNote("原始紀錄讀取失敗（可能是系統用量額度已滿），稍後再試。");
    } finally {
      setHistoryBusy(false);
    }
  }, []);

  /** v1.66.0：有封存摘要的指標＝已封存月份的摘要格＋其餘月份原始紀錄現算的格 */
  const hybridByInd = useMemo(() => {
    const out = new Map<string, ArchiveCell[]>();
    for (const [id, plan] of summaryPlans) {
      const opt = indicators.find((i) => i.id === id);
      if (!opt) continue;
      const rawCells = buildReviewSummary({
        indicatorId: id,
        scheduleCategory: "",
        schedulePeriod: "",
        start: { year: 0, month: 0 },
        end: { year: 0, month: 0 },
        records: recordsForIndex(recordIndex, id, allMonths),
        questions: opt.questions,
        threshold: opt.threshold,
      }).cells;
      out.set(id, [...plan.archivedCells, ...rawCells]);
    }
    return out;
  }, [summaryPlans, indicators, recordIndex, allMonths]);
  /** 指定指標（摘要模式）在期間欄／單位內的格；非摘要指標回 null */
  function cellsOfInd(
    indicatorId: string,
    months: { year: number; month: number }[],
    unitId?: string,
  ): ArchiveCell[] | null {
    const hc = hybridByInd.get(indicatorId);
    if (!hc) return null;
    const cs = cellsInMonths(hc, months);
    return unitId === undefined ? cs : cs.filter((c) => c.unitId === unitId);
  }
  const pseudoRecs = (indicatorId: string, cs: ArchiveCell[]) =>
    cs.map((c) => ({ indicatorId, year: c.year, month: c.month, unitId: c.unitId }));

  const scopedUnitCodes = useMemo(() => {
    if (scope.kind === "admin") return new Set(units.map((u) => u.code));
    if (scope.kind === "staff") return visibleUnitCodes;
    return new Set([...reviewerTaskUnitCodes, ...visibleUnitCodes]);
  }, [units, tasks, scope, visibleUnitCodes, reviewerTaskUnitCodes]);

  const scopedUnits = useMemo(
    () => units.filter((u) => scopedUnitCodes.has(u.code)),
    [units, scopedUnitCodes],
  );

  /** v1.51.0：不限單位選項值（紀錄／任務的 unitId 為 ""，顯示為 NA） */
  const NA_UNIT = "NA";
  const selUnitCode = selUnit === NA_UNIT ? "" : selUnit;
  // 單位分析：該單位的 CAPA 案件（單位條件一次查詢），供「C」標記使用
  const [unitCapaCases, setUnitCapaCases] = useState<CapaCase[]>([]);
  useEffect(() => {
    if (tab !== "unit" || !applied || !selUnitCode) {
      setUnitCapaCases([]);
      return;
    }
    let alive = true;
    loadCapaCasesByUnit(selUnitCode)
      .then((rows) => { if (alive) setUnitCapaCases(rows); })
      .catch(() => { if (alive) setUnitCapaCases([]); });
    return () => { alive = false; };
  }, [tab, applied, selUnitCode]);
  const errorUnitCode = errorUnit === NA_UNIT ? "" : errorUnit;
  // v1.88.14：指標頁籤曲線圖的 CAPA 案件（依指標一次查詢），供「C」標記使用；
  // 沿用單位圖的接線寫法（每欄只取第一件未撤案且落在該欄月份內的案件）。
  const [indCapaCases, setIndCapaCases] = useState<CapaCase[]>([]);
  useEffect(() => {
    if (tab !== "indicator" || !applied || !selIndicator) {
      setIndCapaCases([]);
      return;
    }
    let alive = true;
    loadCapaCasesByIndicator(selIndicator)
      .then((rows) => { if (alive) setIndCapaCases(rows); })
      .catch(() => { if (alive) setIndCapaCases([]); });
    return () => { alive = false; };
  }, [tab, applied, selIndicator]);
  const hasNaUnit = useMemo(
    () =>
      scopedRecords.some((r) => r.unitId === "") ||
      tasks.some((t) => t.unitId === ""),
    [scopedRecords, tasks],
  );

  const scopedGroups = useMemo(() => {
    if (scope.kind === "admin") return groups;
    const gids = new Set(scopedUnits.map((u) => u.groupId).filter(Boolean));
    const list = groups.filter((g) => gids.has(g.id));
    return list.length > 0 ? list : groups;
  }, [groups, scopedUnits, scope]);

  /**
   * v1.88.4：使用者所屬單位尚未歸屬品管組時，組別頁籤顯示明確提示而非「無指標」。
   * 條件：staff 範圍、本人單位在 units 上存在但 groupId 為空、且可見單位中
   * 沒有任何已歸組者（否則組別頁籤仍有可看的組別，不顯示此提示）。
   */
  const ownUnitUngrouped = useMemo(() => {
    if (!user?.unitCode || scope.kind !== "staff") return false;
    const own = units.find((u) => u.code === user.unitCode);
    if (!own || own.groupId) return false;
    return scopedUnits.every((u) => !u.groupId);
  }, [user?.unitCode, scope.kind, units, scopedUnits]);

  // 選項預設（資料載入後補）
  useEffect(() => {
    if (scopedGroups.length > 0 && !scopedGroups.some((g) => g.id === selGroup))
      setSelGroup(scopedGroups[0].id);
  }, [scopedGroups, selGroup]);
  useEffect(() => {
    if (scopedGroups.length > 0 && !scopedGroups.some((g) => g.id === selGroup2))
      setSelGroup2(scopedGroups[0].id);
  }, [scopedGroups, selGroup2]);
  useEffect(() => {
    if (
      scopedUnits.length > 0 &&
      selUnit !== NA_UNIT &&
      !scopedUnits.some((u) => u.code === selUnit)
    )
      setSelUnit(scopedUnits[0].code);
    else if (selUnit === NA_UNIT && !hasNaUnit)
      setSelUnit(scopedUnits[0]?.code ?? "");
  }, [scopedUnits, selUnit, hasNaUnit]);

  const indOf = useMemo(
    () => new Map(indicators.map((i) => [i.id, i])),
    [indicators],
  );
  const unitNameOf = useMemo(
    () => new Map(units.map((u) => [u.code, u.name])),
    [units],
  );
  const groupNameOf = useMemo(
    () => new Map(groups.map((g) => [g.id, g.name])),
    [groups],
  );

  const groupIndicators = useMemo(
    () => indicators.filter((i) => i.groupId === selGroup),
    [indicators, selGroup],
  );
  const indTabIndicators = useMemo(
    () => indicators.filter((i) => i.groupId === selGroup2),
    [indicators, selGroup2],
  );
  useEffect(() => {
    if (
      indTabIndicators.length > 0 &&
      !indTabIndicators.some((i) => i.id === selIndicator)
    )
      setSelIndicator(indTabIndicators[0].id);
  }, [indTabIndicators, selIndicator]);

  // 單位分析：該單位在所選期間審查過的指標（依編號排序，再經組別／指標過濾）
  const unitIndicatorsBase = useMemo(() => {
    const periodRecs = recordsInMonths(
      scopedRecords.filter((r) => r.unitId === selUnitCode),
      allMonths,
    );
    const idSet = new Set<string>(periodRecs.map((r) => r.indicatorId));
    for (const [id, plan] of summaryPlans)
      if (plan.archivedCells.some((c) => c.unitId === selUnitCode)) idSet.add(id);
    const ids = [...idSet];
    return ids
      .map((id) => indOf.get(id))
      .filter((i): i is IndicatorOpt => i != null)
      .sort((a, b) => a.code.localeCompare(b.code, "zh-Hant"));
  }, [scopedRecords, selUnitCode, allMonths, indOf, summaryPlans]);
  const unitIndicators = useMemo(
    () =>
      unitIndicatorsBase.filter(
        (i) =>
          (selGroupU === "all" || i.groupId === selGroupU) &&
          (selIndU === "all" || i.id === selIndU),
      ),
    [unitIndicatorsBase, selGroupU, selIndU],
  );
  // 單位分析指標下拉選項（依組別過濾＋全部）
  const unitIndOptions = useMemo(
    () =>
      unitIndicatorsBase.filter(
        (i) => selGroupU === "all" || i.groupId === selGroupU,
      ),
    [unitIndicatorsBase, selGroupU],
  );
  // 單位分析組別預設第一個組別；組別變動時指標重設為全部
  useEffect(() => {
    if (scopedGroups.length > 0 && !scopedGroups.some((g) => g.id === selGroupU) && selGroupU !== "all")
      setSelGroupU(scopedGroups[0].id);
  }, [scopedGroups, selGroupU]);
  useEffect(() => {
    if (selIndU !== "all" && !unitIndOptions.some((i) => i.id === selIndU))
      setSelIndU("all");
  }, [unitIndOptions, selIndU]);

  /**
   * v1.40.2「未審月份不顯示」：勾選時隱藏無資料的期間。
   * v1.88.17：改為「隱藏整段無資料區間」——隱藏單位是每列的合併格（span），
   * 不是單月欄：某月只有在「所有列包含它的 span 都無紀錄」時才隱藏，
   * 有紀錄的 span 內的無資料月份仍顯示（不切斷合併格、不破壞 colspan 對齊）。
   * 判斷以目前查詢範圍內的審查紀錄為準（組別分析＝該組指標、單位分析＝該單位
   * 該組／指標；皆限已查詢的年份區間），含封存摘要。只影響矩陣的期間欄位顯示，
   * 不改計算公式、不改下探邏輯、不動 allMonths。
   * 指標分析無矩陣，沿用舊的按月判定（只影響下探 CAPA 偵測用的欄位）。
   */
  const inArchivedMonths = useCallback(
    (
      ids: string[],
      months: { year: number; month: number }[],
      unitId?: string,
    ): boolean =>
      ids.some((id) =>
        (summaryPlans.get(id)?.archivedCells ?? []).some(
          (c) =>
            (unitId === undefined || c.unitId === unitId) &&
            months.some((m) => m.year === c.year && m.month === c.month),
        ),
      ),
    [summaryPlans],
  );
  /** 全範圍（未隱藏）的矩陣列：僅供 hideEmptyMonths 時判斷哪些月份屬於有資料的 span。 */
  const allMonthRows = useMemo<MatrixRow[]>(() => {
    if (!hideEmptyMonths || (tab !== "group" && tab !== "unit")) return [];
    const months = appliedColumns.flatMap((c) => c.months);
    if (tab === "unit") {
      return buildMatrixRows(unitIndicators, months, selUnitCode, unitUnit, false);
    }
    return buildMatrixRows(groupIndicators, months, undefined, groupUnit, false);
    // buildMatrixRows 為當次 render 的閉包（讀最新值）；deps 列其全部反應式輸入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hideEmptyMonths,
    tab,
    appliedColumns,
    groupIndicators,
    unitIndicators,
    selUnitCode,
    groupUnit,
    unitUnit,
    archiveCtx,
    recordIndex,
    tempTaskIds,
    tempTaskKeys,
    hybridByInd,
  ]);
  const visibleColumns = useMemo(() => {
    if (!hideEmptyMonths) return appliedColumns;
    if (tab === "indicator") {
      const hasRecords = (col: AnalysisPeriodColumn): boolean =>
        selIndicator !== "" &&
        (columnRecordCount(recordIndex, [selIndicator], col.months) > 0 ||
          inArchivedMonths([selIndicator], col.months));
      return appliedColumns.filter(hasRecords);
    }
    if (tab !== "group" && tab !== "unit") return appliedColumns;
    const unitId = tab === "unit" ? selUnitCode : undefined;
    const visibleKeys = new Set<string>();
    for (const row of allMonthRows) {
      for (const span of row.spans) {
        const hasData =
          columnRecordCount(recordIndex, [row.indicatorId], span.months, unitId) > 0 ||
          inArchivedMonths([row.indicatorId], span.months, unitId);
        if (!hasData) continue;
        for (const m of span.months) visibleKeys.add(`${m.year}-${m.month}`);
      }
    }
    return appliedColumns.filter((c) => visibleKeys.has(c.key));
  }, [
    hideEmptyMonths,
    appliedColumns,
    recordIndex,
    tab,
    selIndicator,
    selUnitCode,
    summaryPlans,
    allMonthRows,
    inArchivedMonths,
  ]);

  /** 目前頁籤的矩陣列（組別／單位分析；指標分析無矩陣回 []）。 */
  const matrixRows = useMemo<MatrixRow[]>(() => {
    const months = visibleColumns.flatMap((c) => c.months);
    if (tab === "group") {
      return buildMatrixRows(groupIndicators, months, undefined, groupUnit, true);
    }
    if (tab === "unit") {
      return buildMatrixRows(unitIndicators, months, selUnitCode, unitUnit, true);
    }
    return [];
    // 同 allMonthRows：deps 列 buildMatrixRows 的全部反應式輸入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tab,
    visibleColumns,
    groupIndicators,
    unitIndicators,
    selUnitCode,
    groupUnit,
    unitUnit,
    archiveCtx,
    recordIndex,
    tempTaskIds,
    tempTaskKeys,
    hybridByInd,
  ]);
  /** 列 id → 列（含指標 id 與 spans；分列時 id 帶排程 key，勿直接當指標 id 用）。 */
  const rowMetaById = useMemo(
    () => new Map(matrixRows.map((r) => [r.id, r])),
    [matrixRows],
  );
  const rowIndOf = (rowId: string): string =>
    rowMetaById.get(rowId)?.indicatorId ?? rowId;
  const rowSpansOf = (rowId: string): RowSpan[] =>
    rowMetaById.get(rowId)?.spans ?? [];

  // 期間說明文字（modal 副標共用；顯示已生效的查詢條件）
  const periodDesc = useMemo(() => {
    const from = applied?.startMonth ?? startMonth;
    const to = applied?.endMonth ?? endMonth;
    const granularity = applied?.interval ?? interval;
    const display = (value: string) => value.replace("-", "/");
    const label =
      granularity === "month"
        ? "月"
        : granularity === "academic"
          ? "學年"
          : "年";
    return `${display(from)} ~ ${display(to)}・單位：${label}`;
  }, [applied, startMonth, endMonth, interval]);

  /** 本次分析用到、但已過期（閾值變更）的封存摘要 */
  const staleSummaryLabels = useMemo(
    () => [...new Set([...summaryPlans.values()].flatMap((p) => p.staleLabels))],
    [summaryPlans],
  );

  /** v1.65.1：分析範圍內、已結束超過一個月仍未封存的區間（尚待確認封存） */
  const unconfirmed = useMemo(() => {
    if (!archiveCtx) return [];
    const monthKeys = new Set(allMonths.map((m) => `${m.year}-${m.month}`));
    if (monthKeys.size === 0) return [];
    return unarchivedOverdue(
      archiveCtx.schedules.filter((s) => indOf.has(s.indicatorId) && (!selIndicator || tab !== "indicator" || s.indicatorId === selIndicator)),
      archiveCtx.archiveIds,
      new Date(),
      archiveCtx.deadlineDay,
    ).filter((e) => e.interval.allMonths.some((m) => monthKeys.has(`${m.year}-${m.month}`)));
  }, [archiveCtx, allMonths, indOf, selIndicator, tab]);

  /** 單格達閾值率（人次＝合併；單位＝達閾值單位數／總審查單位數） */
  function cellValue(
    indicatorId: string,
    col: AnalysisPeriodColumn,
    unitId: string | undefined,
    mode: UnitMode,
  ): CellValue {
    const ind = indOf.get(indicatorId);
    const th = ind?.threshold ?? 0;
    const hcs = cellsOfInd(indicatorId, col.months, unitId);
    if (hcs) {
      if (mode === "unit") {
        const ur = unitPassRateFromCells(hcs, th);
        return { ...ur, title: ur.rate == null ? "未審核" : `達閾值 ${ur.pass}／${ur.total} 單位` };
      }
      const pr = passRateFromCells(hcs);
      return { ...pr, title: pr.total === 0 ? "未審核" : `達閾值 ${pr.pass}／${pr.total} 人次` };
    }
    // A3：查表取該指標該期間欄（可再限單位）的紀錄，不再全量 filter。
    const recs = recordsForIndex(recordIndex, indicatorId, col.months, unitId);
    if (mode === "unit") {
      const ur = unitPassRate(recs, th);
      return {
        ...ur,
        title:
          ur.rate == null
            ? "未審核"
            : `達閾值 ${ur.pass}／${ur.total} 單位`,
      };
    }
    const pr = passRateOf(recs, th);
    return {
      ...pr,
      title: pr.total === 0 ? "未審核" : `達閾值 ${pr.pass}／${pr.total} 人次`,
    };
  }

  function matrixScoringDetails(
    indicator: IndicatorOpt,
    columns: AnalysisPeriodColumn[],
    unitId: string | undefined,
    mode: UnitMode,
  ): { key: string; label: string; cells: Record<string, PassRate> }[] {
    // v1.44.0：指標未啟用分組計分時不顯示任何分組／逐題明細列。
    if (!indicator.groupScoring) return [];
    const details = new Map<string, {
      label: string;
      cells: Record<string, PassRate>;
    }>();
    for (const column of columns) {
      const hcs = cellsOfInd(indicator.id, column.months, unitId);
      const periodRecords = hcs
        ? []
        : recordsForIndex(recordIndex, indicator.id, column.months, unitId);
      const rows = hcs
        ? mode === "unit"
          ? unitScoringRowsFromCells(hcs, indicator.questions, [column], indicator.threshold)
          : personScoringRowsFromCells(hcs, indicator.questions)
        : mode === "unit"
        ? unitScoringBreakdownRows(periodRecords, indicator.questions, [column], indicator.threshold)
        : personScoringBreakdownRows(periodRecords, indicator.questions, indicator.threshold);
      for (const row of rows.slice(1)) {
        const current = details.get(row.key) ?? { label: row.label, cells: {} };
        current.cells[column.key] = {
          pass: row.yes,
          total: row.valid,
          rate: row.rate,
        };
        details.set(row.key, current);
      }
    }
    return [...details].map(([key, value]) => ({ key, ...value }));
  }

  /**
   * 曲線圖數列（v1.88.17 Q6=A：一點一合併格，x 軸標籤為區間，如 9–11月；
   * 只取有資料的格；附 hover 提示文字；v1.59.0 附加審標註）。
   * spans 為該列的合併格（矩陣列的 spans；未傳時以單月格計）。
   */
  function chartSeries(
    indicatorId: string,
    unitId: string | undefined,
    mode: UnitMode,
    spans?: RowSpan[],
  ): { values: number[]; labels: string[]; tips: string[]; cols: AnalysisPeriodColumn[]; notes: (string | null)[]; thresholds: (number | null)[] } {
    const values: number[] = [];
    const labels: string[] = [];
    const tips: string[] = [];
    const cols: AnalysisPeriodColumn[] = [];
    const notes: (string | null)[] = [];
    const thresholds: (number | null)[] = [];
    const curTh = indOf.get(indicatorId)?.threshold ?? 0;
    for (const col of spans ?? appliedColumns) {
      const c = cellValue(indicatorId, col, unitId, mode);
      if (c.rate != null) {
        const hcs = cellsOfInd(indicatorId, col.months, unitId);
        const colRecs = hcs ? [] : recordsForIndex(recordIndex, indicatorId, col.months, unitId);
        const note = columnTempNote(
          hcs ? pseudoRecs(indicatorId, hcs) : colRecs,
          tempTaskKeys,
          col.months.length,
        );
        // v1.64.0：人次模式逐筆用排程快照閾值，曲線逐欄畫當時閾值；
        // 單位模式單位層判定本來就用現行指標閾值，維持單一水平線。
        thresholds.push(
          mode === "person"
            ? hcs
              ? columnThresholdFromCells(hcs, curTh)
              : columnThresholdOf(colRecs, curTh)
            : curTh > 0 ? curTh : null,
        );
        values.push(c.rate);
        labels.push(col.label);
        tips.push(`${col.label}${note ?? ""}：${formatPassRate(c, true)}`);
        cols.push(col);
        notes.push(note);
      }
    }
    return { values, labels, tips, cols, notes, thresholds };
  }

  /**
   * v1.53.0：單一期間欄的分組達閾值率——與 matrixScoringDetails 同一口徑。
   * 人次模式：sectionPassRateOf（每人先算分組 rate 再判達標）；單位模式：
   * unitScoringBreakdownRows 單欄（B 法）。歷史分組以當欄紀錄補齊題目 id。
   */
  function sectionCellValue(
    indicator: IndicatorOpt,
    column: AnalysisPeriodColumn,
    periodRecords: AnalysisRecord[],
    mode: UnitMode,
    sectionKey: string,
  ): PassRate {
    const section = resolveDrillSection(indicator.questions, sectionKey, periodRecords);
    if (!section) return { pass: 0, total: 0, rate: null };
    if (mode === "unit") {
      const row = unitScoringBreakdownRows(periodRecords, indicator.questions, [column], indicator.threshold)
        .find((r) => r.key === sectionKey);
      return row
        ? { pass: row.yes, total: row.valid, rate: row.rate }
        : { pass: 0, total: 0, rate: null };
    }
    return sectionPassRateOf(periodRecords, section.ids, section.kind, indicator.threshold);
  }

  /** v1.53.0：分組曲線圖數列（每組一張單線圖；一點一合併格，見 chartSeries；只取有資料的格；v1.59.0 附加審標註） */
  function sectionChartSeries(
    indicatorId: string,
    unitId: string | undefined,
    mode: UnitMode,
    sectionKey: string,
    spans?: RowSpan[],
  ): { values: number[]; labels: string[]; tips: string[]; cols: AnalysisPeriodColumn[]; notes: (string | null)[]; thresholds: (number | null)[] } {
    const ind = indOf.get(indicatorId);
    const values: number[] = [];
    const labels: string[] = [];
    const tips: string[] = [];
    const cols: AnalysisPeriodColumn[] = [];
    const notes: (string | null)[] = [];
    const thresholds: (number | null)[] = [];
    if (!ind) return { values, labels, tips, cols, notes, thresholds };
    for (const col of spans ?? appliedColumns) {
      const hcs = cellsOfInd(indicatorId, col.months, unitId);
      const recs = hcs ? [] : recordsForIndex(recordIndex, indicatorId, col.months, unitId);
      let pr: PassRate;
      if (hcs) {
        const rows =
          mode === "unit"
            ? unitScoringRowsFromCells(hcs, ind.questions, [col], ind.threshold)
            : personScoringRowsFromCells(hcs, ind.questions);
        const row = rows.find((r) => r.key === sectionKey);
        pr = row ? { pass: row.yes, total: row.valid, rate: row.rate } : { pass: 0, total: 0, rate: null };
      } else pr = sectionCellValue(ind, col, recs, mode, sectionKey);
      if (pr.rate != null) {
        const note = columnTempNote(hcs ? pseudoRecs(indicatorId, hcs) : recs, tempTaskKeys, col.months.length);
        thresholds.push(
          mode === "person"
            ? hcs
              ? columnThresholdFromCells(hcs, ind.threshold)
              : columnThresholdOf(recs, ind.threshold)
            : ind.threshold > 0 ? ind.threshold : null,
        );
        values.push(pr.rate);
        labels.push(col.label);
        tips.push(`${col.label}${note ?? ""}：${formatPassRate(pr, true)}`);
        cols.push(col);
        notes.push(note);
      }
    }
    return { values, labels, tips, cols, notes, thresholds };
  }

  /** v1.53.0：選項明細只留該分組的題目（以題目 id 過濾；歷史分組無現行題目→空列） */
  function sectionOptionRows(
    rows: OptionDetailRow[],
    questions: AuditQuestion[],
    sectionKey: string,
    records: AnalysisRecord[],
  ): OptionDetailRow[] {
    const section = resolveDrillSection(questions, sectionKey, records);
    if (!section) return rows;
    const ids = new Set(section.ids);
    return rows.filter((row) => ids.has(row.questionId));
  }

  function openChart(
    indicatorId: string,
    unitId: string | undefined,
    mode: UnitMode,
    scopeLabel: string,
    section?: SectionRef,
    spans?: RowSpan[],
  ) {
    if (requireRaw(indicatorId)) return;
    const ind = indOf.get(indicatorId);
    if (!ind) return;
    const chartSpans =
      spans ?? spansForIndicator(indicatorId, visibleColumns.flatMap((c) => c.months), unitId);
    const { values, labels, tips, cols, notes, thresholds } = section
      ? sectionChartSeries(indicatorId, unitId, mode, section.key, chartSpans)
      : chartSeries(indicatorId, unitId, mode, chartSpans);
    setChartModal({
      title: section
        ? `${ind.code}・${ind.name}・${section.label} 達閾值率曲線`
        : `${ind.code}・${ind.name} 達閾值率曲線`,
      subtitle: `${periodDesc}・${scopeLabel}・${
        mode === "unit" ? "單位（達閾值單位數／總單位數）" : "人次（合併）"
      }${section ? `・分組：${section.label}` : ""}`,
      values,
      labels,
      tips,
      notes,
      thresholds,
      threshold: ind.threshold > 0 ? ind.threshold : null,
      indicatorId,
      mode,
      cols,
      unitId,
      sectionKey: section?.key,
      sectionLabel: section?.label,
    });
  }

  /**
   * 下探 L1：開啟單位矩陣（只有點選的那一個期間欄）。
   * v1.50.0：護理長不再一律不可下探——本人單位範圍（scopedRecords 已限本人
   * 單位）可下探；指定到其他單位時才擋下（見 lib/drillScope）。
   */
  function openDrill(
    indicatorId: string,
    col: AnalysisPeriodColumn,
    mode: UnitMode,
    scopeUnitId?: string,
    extra?: {
      sectionKey?: string;
      questionId?: string;
      optionLabel?: string;
      l2All?: boolean;
    },
  ) {
    if (!canOpenDrill({ isNurseLeader, scopeUnitId, visibleUnitCodes })) return;
    if (!extra?.l2All) {
      const cell = cellValue(indicatorId, col, scopeUnitId, mode);
      if (cell.rate == null) return;
    }
    setDrill({
      indicatorId,
      column: col,
      mode,
      scopeUnitId,
      l2UnitId: null,
      l2All: extra?.l2All ?? false,
      sectionKey: extra?.sectionKey,
      questionId: extra?.questionId,
      optionLabel: extra?.optionLabel,
      // v1.88.17 Q5=C：多月合併格先展開區間內各月明細（選月彈窗），再選單月進入 L1／L2。
      // 全期間欄（key "__all__"）與直接開 L2（l2All）不經選月。
      pickMonths:
        !extra?.l2All && col.key !== "__all__" && col.months.length > 1,
    });
  }

  /** v1.50.0：摘要卡／分組列下探用的全期間欄（全部已查期間欄合併）。 */
  const allPeriodColumn = useMemo(
    () => ({ key: "__all__", label: periodDesc, months: allMonths }),
    [periodDesc, allMonths],
  );

  function openDoc(
    indicatorId: string,
    unitId: string | undefined,
    scopeLabel: string,
    mode: UnitMode,
    section?: SectionRef,
  ) {
    if (requireRaw(indicatorId)) return;
    const ind = indOf.get(indicatorId);
    if (!ind) return;
    // A3：查表取該指標全部期間的紀錄（可再限單位）。
    const recs = recordsForIndex(recordIndex, indicatorId, allMonths, unitId);
    const rows = section
      ? sectionOptionRows(optionDetailRows(recs, ind.questions), ind.questions, section.key, recs)
      : optionDetailRows(recs, ind.questions);
    setDocModal({
      title: section
        ? `${ind.code}・${ind.name}・${section.label} 各選項得分狀況`
        : `${ind.code}・${ind.name} 各選項得分狀況`,
      subtitle: `${periodDesc}・${scopeLabel}・共 ${recs.length} 人次${section ? `・分組：${section.label}` : ""}`,
      rows,
      indicatorId,
      unitId,
      mode,
      sectionKey: section?.key,
      sectionLabel: section?.label,
    });
  }

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
          columns={visibleColumns}
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

interface ManagedResult {
  id: string;
  year: number;
  month: number;
  unitId: string;
  indicatorId: string;
  rate: number | null;
  reviewerEmpNo: string;
  reviewerName: string;
  /** 受審人員職編（v1.50.0：被審人員顯示職編/遮罩姓名） */
  reviewedPersonEmpNo: string;
  reviewedPersonName: string;
  submittedAt: unknown;
  /** 逐題作答快照（v1.41.1：明細展開顯示常見錯誤與補充說明） */
  answers: {
    questionId: string;
    itemText: string;
    optionLabel: string;
    commonErrors: string[];
    note: string;
  }[];
}

function ReviewResultManager({
  units,
  groups,
  indicators,
  user,
  onAction,
  onDone,
}: {
  units: UnitOpt[];
  groups: GroupOpt[];
  indicators: IndicatorOpt[];
  user: { staffId: string; name: string } | null;
  onAction: (message: string) => void;
  onDone: (years: number[]) => void;
}) {
  const now = new Date();
  const [unitId, setUnitId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [indicatorId, setIndicatorId] = useState("");
  const [start, setStart] = useState(`${now.getFullYear()}-01`);
  const [end, setEnd] = useState(
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`,
  );
  const [rows, setRows] = useState<ManagedResult[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [queried, setQueried] = useState(false);
  const [error, setError] = useState("");
  /** 展開明細的紀錄 id（v1.41.1：逐題常見錯誤與補充說明） */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    setRows([]);
    setSelected([]);
    setQueried(false);
    setError("");
    setExpandedId(null);
  }, [unitId, groupId, indicatorId, start, end]);

  const unitName = (id: string) =>
    units.find((unit) => unit.code === id)?.name ?? (id === "" ? "NA" : id);
  const indicatorName = (id: string) =>
    indicators.find((indicator) => indicator.id === id)?.name ?? id;

  const {
    sortedRows: sortedResults,
    sort: resultSort,
    toggleSort: toggleResultSort,
  } = useTableSort<
    ManagedResult,
    "date" | "unit" | "indicator" | "reviewer" | "reviewed" | "rate" | "submitted"
  >(rows, {
    date: (r) => r.year * 100 + r.month,
    unit: (r) => unitName(r.unitId),
    indicator: (r) => indicatorName(r.indicatorId),
    reviewer: (r) => r.reviewerEmpNo,
    reviewed: (r) => r.reviewedPersonEmpNo,
    rate: (r) => r.rate,
    submitted: (r) => submittedMillis(r.submittedAt),
  });

  const queryResults = async () => {
    if (busy || !start || !end || start > end) return;
    setBusy(true);
    setError("");
    setSelected([]);
    setExpandedId(null);    try {
      const db = getFirebaseDb();
      const firstYear = Number(start.slice(0, 4));
      const lastYear = Number(end.slice(0, 4));
      const years = Array.from(
        { length: lastYear - firstYear + 1 },
        (_, index) => firstYear + index,
      );
      const snaps = await Promise.all(
        years.map((year) =>
          getDocsFromServer(
            query(
              collection(db, "reviewRecords"),
              where("year", "==", year),
            ),
          ),
        ),
      );
      const result: ManagedResult[] = [];
      snaps.forEach((snapshot) => {
        snapshot.docs.forEach((document) => {
          const value = document.data() as Record<string, unknown>;
          const year = Number(value.year ?? 0);
          const month = Number(value.month ?? 0);
          const yearMonth = `${year}-${pad2(month)}`;
          const recordUnitId = String(value.unitId ?? "");
          const recordIndicatorId = String(value.indicatorId ?? "");
          const recordGroupId =
            indicators.find((indicator) => indicator.id === recordIndicatorId)
              ?.groupId ?? "";
          if (
            yearMonth < start ||
            yearMonth > end ||
            (unitId && recordUnitId !== unitId) ||
            (indicatorId && recordIndicatorId !== indicatorId) ||
            (groupId && recordGroupId !== groupId)
          )
            return;
          result.push({
            id: document.id,
            year,
            month,
            unitId: recordUnitId,
            indicatorId: recordIndicatorId,
            rate: typeof value.rate === "number" ? value.rate : null,
            reviewerEmpNo: String(value.reviewerEmpNo ?? value.reviewerId ?? ""),
            reviewerName: String(value.reviewerName ?? value.reviewerId ?? ""),
            reviewedPersonEmpNo: String(value.reviewedPersonEmpNo ?? ""),
            reviewedPersonName: String(value.reviewedPersonName ?? ""),
            submittedAt: value.submittedAt,
            answers: Array.isArray(value.answers)
              ? value.answers.map((raw) => {
                  const answer = (raw ?? {}) as Record<string, unknown>;
                  return {
                    questionId: String(answer.questionId ?? ""),
                    itemText: String(answer.itemText ?? ""),
                    optionLabel: String(answer.optionLabel ?? ""),
                    commonErrors: Array.isArray(answer.commonErrors)
                      ? answer.commonErrors.filter(
                          (word): word is string => typeof word === "string",
                        )
                      : [],
                    note: typeof answer.note === "string" ? answer.note : "",
                  };
                })
              : [],
          });
        });
      });
      result.sort(
        (a, b) =>
          b.year - a.year ||
          b.month - a.month ||
          a.unitId.localeCompare(b.unitId, "zh-Hant"),
      );
      setRows(result);
      setQueried(true);
    } catch (queryError) {
      setRows([]);
      setQueried(true);
      setError(
        `查詢失敗：${toErrorMessage(queryError)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const deleteSelected = async () => {
    if (busy || !user || selected.length === 0) return;
    const ids = [...selected];
    if (
      !window.confirm(
        `即將永久刪除 ${ids.length} 筆審查結果，且無法復原。確定刪除？`,
      )
    )
      return;
    setBusy(true);
    setError("");
    const removed: string[] = [];
    const affectedYears: number[] = [];
    try {
      const db = getFirebaseDb();
      for (let index = 0; index < ids.length; index += 400) {
        const chunk = ids.slice(index, index + 400);
        const batch = writeBatch(db);
        chunk.forEach((id) =>
          batch.delete(doc(db, "reviewRecords", id)),
        );
        const criteria = {
          unitId: unitId || null,
          groupId: groupId || null,
          indicatorId: indicatorId || null,
          startMonth: start,
          endMonth: end,
        };
        batch.set(doc(collection(db, "auditLogs")), {
          actor: user.staffId,
          actorName: user.name,
          action: "批次刪除審查結果",
          targetType: "reviewRecords",
          targetId: `${start}～${end}・${chunk.length} 筆`,
          detail: `篩選條件：單位 ${criteria.unitId ?? "全部"}；組別 ${criteria.groupId ?? "全部"}；指標 ${criteria.indicatorId ? stripInternalIdPrefix(criteria.indicatorId) : "全部"}；文件 ID：${chunk.join(", ")}`,
          criteria,
          documentIds: chunk,
          count: chunk.length,
          createdAt: serverTimestamp(),
        });
        await batch.commit();
        removed.push(...chunk);
        affectedYears.push(
          ...rows
            .filter((row) => chunk.includes(row.id))
            .map((row) => row.year),
        );
      }
      const years = [...new Set(affectedYears)];
      setRows((current) => current.filter((row) => !removed.includes(row.id)));
      setSelected([]);
      onDone(years);
      onAction(`已永久刪除 ${removed.length} 筆審查結果。`);
    } catch (deleteError) {
      const years = [
        ...new Set(
          rows
            .filter((row) => removed.includes(row.id))
            .map((row) => row.year),
        ),
      ];
      setRows((current) => current.filter((row) => !removed.includes(row.id)));
      setSelected((current) => current.filter((id) => !removed.includes(id)));
      if (removed.length > 0) onDone(years);
      const message = `刪除部分失敗：已成功刪除 ${removed.length} 筆，尚有 ${ids.length - removed.length} 筆未完成。${toErrorMessage(deleteError)}`;
      setError(message);
      onAction(message);
    } finally {
      setBusy(false);
    }
  };
  const allSelected = rows.length > 0 && rows.every((row) => selected.includes(row.id));

  return (
    <section className="review-results-manager">
      <FilterPanel
        actions={
          <button
            className="button button-primary"
            type="button"
            disabled={busy || start > end}
            onClick={queryResults}
          >
            <Search size={16} />
            搜尋
          </button>
        }
      >
        <SelectField
          label="組別"
          value={groupId}
          onChange={(value) => {
            setGroupId(value);
            setIndicatorId("");
          }}
          options={[
            { value: "", label: "全部組別" },
            ...Array.from(
              new Set(indicators.map((indicator) => indicator.groupId).filter(Boolean)),
            ).map((id) => ({
              value: id,
              label: groups.find((group) => group.id === id)?.name ?? id,
            })),
          ]}
        />
        <SelectField
          label="單位"
          value={unitId}
          onChange={setUnitId}
          options={[
            { value: "", label: "全部單位" },
            ...units.map((unit) => ({
              value: unit.code,
              label: `${unit.code}・${unit.name}`,
            })),
          ]}
        />
        <SelectField
          label="指標名稱"
          value={indicatorId}
          onChange={setIndicatorId}
          options={[
            { value: "", label: "全部指標" },
            ...indicators
              .filter((indicator) => !groupId || indicator.groupId === groupId)
              .map((indicator) => ({
                value: indicator.id,
                label: `${indicator.code}・${indicator.name}`,
              })),
          ]}
        />
        <ResultMonthPicker
          label="起始西元年月"
          value={start}
          onChange={setStart}
          ariaLabel="起始西元年月"
        />
        <ResultMonthPicker
          label="結束西元年月"
          value={end}
          onChange={setEnd}
          ariaLabel="結束西元年月"
        />
      </FilterPanel>
      {error && (
        <p className="results-range-error" role="alert">
          {error}
        </p>
      )}
      {queried && (
        <ListPanel
          title="審查結果"
          count={rows.length}
          actions={
            <>
            {selected.length > 0 && (
              <span className="list-panel-count">已選 {selected.length} 筆</span>
            )}
            <button
              type="button"
              className="button button-outline"
              disabled={busy || rows.length === 0}
              onClick={() =>
                setSelected(allSelected ? [] : rows.map((row) => row.id))
              }
            >
              {allSelected ? "取消全選" : "全選"}
            </button>
            <button
              type="button"
              className="button button-danger"
              disabled={busy || selected.length === 0}
              onClick={deleteSelected}
            >
              {busy ? "處理中…" : `永久刪除所選（${selected.length}）`}
            </button>
            </>
          }
        >
          <div className="analysis-table-wrap review-results-table-wrap">
            <table className="review-results-table">
              <thead>
                <tr>
                  <th>選取</th>
                  <SortableTh label="結果日期" sortKey="date" sort={resultSort} onSort={toggleResultSort} />
                  <SortableTh label="單位" sortKey="unit" sort={resultSort} onSort={toggleResultSort} />
                  <SortableTh label="指標" sortKey="indicator" sort={resultSort} onSort={toggleResultSort} />
                  <SortableTh label="審查人員" sortKey="reviewer" sort={resultSort} onSort={toggleResultSort} />
                  <SortableTh label="被審人員" sortKey="reviewed" sort={resultSort} onSort={toggleResultSort} />
                  <SortableTh label="正確率" sortKey="rate" sort={resultSort} onSort={toggleResultSort} />
                  <SortableTh label="提交時間" sortKey="submitted" sort={resultSort} onSort={toggleResultSort} />
                  <th>明細</th>
                </tr>
              </thead>
              <tbody>
                {sortedResults.map((row) => {
                  const noted = row.answers.filter(
                    (a) => a.note.trim() !== "" || a.commonErrors.length > 0,
                  );
                  // v1.43.0：補充說明彙整為一則（單則為備註原文、多則每則附題號）
                  const mergedNote = mergeNoteParts(
                    row.answers.map((a, i) => ({
                      questionNo: i + 1,
                      note: a.note,
                    })),
                  );
                  const expanded = expandedId === row.id;
                  return (
                    <Fragment key={row.id}>
                      <tr>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`選取 ${fmtYm(row.year, row.month)} ${indicatorName(row.indicatorId)} ${row.reviewedPersonName || "審查結果"}`}
                            checked={selected.includes(row.id)}
                            disabled={busy}
                            onChange={(event) =>
                              setSelected((current) =>
                                event.target.checked
                                  ? [...current, row.id]
                                  : current.filter((id) => id !== row.id),
                              )
                            }
                          />
                        </td>
                        <td>
                          {fmtYm(row.year, row.month)}
                        </td>
                        <td>{unitName(row.unitId)}</td>
                        <td>{indicatorName(row.indicatorId)}</td>
                        <td>{staffLabel(row.reviewerEmpNo, row.reviewerName)}</td>
                        <td>{staffLabel(row.reviewedPersonEmpNo, row.reviewedPersonName)}</td>
                        <td>{row.rate == null ? "—" : `${row.rate}%`}</td>
                        <td>{formatSubmittedAt(row.submittedAt)}</td>
                        <td>
                          {noted.length > 0 ? (
                            <button
                              type="button"
                              className="button button-ghost button-sm"
                              onClick={() =>
                                setExpandedId(expanded ? null : row.id)
                              }
                              aria-expanded={expanded}
                            >
                              {expanded ? "收合" : `明細（${noted.length}）`}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="review-record-expanded">
                          <td colSpan={9}>
                            <table className="data-table supp-note-table">
                              <thead>
                                <tr>
                                  <th>題目</th>
                                  <th>結果</th>
                                  <th>常見錯誤</th>
                                </tr>
                              </thead>
                              <tbody>
                                {noted.map((a, i) => (
                                  <tr key={`${a.questionId}-${i}`}>
                                    <td>{a.itemText || `第 ${i + 1} 題`}</td>
                                    <td>{a.optionLabel || "—"}</td>
                                    <td>
                                      {a.commonErrors.length > 0
                                        ? a.commonErrors.join("、")
                                        : "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {mergedNote ? (
                              <div className="supp-notes-block">
                                <p className="supp-notes-title">補充說明</p>
                                <p className="supp-note-text">{mergedNote}</p>
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="review-results-cards" aria-label="審查紀錄摘要清單">
            {rows.length === 0 && (
              <p className="review-results-empty">沒有符合條件的審查紀錄。</p>
            )}
            {sortedResults.map((row) => {
              const noted = row.answers.filter(
                (answer) => answer.note.trim() !== "" || answer.commonErrors.length > 0,
              );
              const mergedNote = mergeNoteParts(
                row.answers.map((answer, index) => ({
                  questionNo: index + 1,
                  note: answer.note,
                })),
              );
              const expanded = expandedId === row.id;
              return (
                <article className="review-result-card" key={row.id}>
                  <header>
                    <label className="review-result-card-select">
                      <input
                        type="checkbox"
                        aria-label={`選取 ${fmtYm(row.year, row.month)} ${indicatorName(row.indicatorId)} ${row.reviewedPersonName || "審查結果"}`}
                        checked={selected.includes(row.id)}
                        disabled={busy}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, row.id]
                              : current.filter((id) => id !== row.id),
                          )
                        }
                      />
                      <span>{fmtYm(row.year, row.month)}</span>
                    </label>
                    <strong>{row.rate == null ? "—" : `${row.rate}%`}</strong>
                  </header>
                  <h3>{indicatorName(row.indicatorId)}</h3>
                  <dl>
                    <div><dt>單位</dt><dd>{unitName(row.unitId)}</dd></div>
                    <div><dt>審查人員</dt><dd>{staffLabel(row.reviewerEmpNo, row.reviewerName)}</dd></div>
                    <div><dt>受審人員</dt><dd>{staffLabel(row.reviewedPersonEmpNo, row.reviewedPersonName)}</dd></div>
                    <div><dt>提交時間</dt><dd>{formatSubmittedAt(row.submittedAt)}</dd></div>
                  </dl>
                  {noted.length > 0 && (
                    <>
                      <button
                        type="button"
                        className="button button-ghost button-sm review-result-card-detail-toggle"
                        onClick={() => setExpandedId(expanded ? null : row.id)}
                        aria-expanded={expanded}
                      >
                        {expanded ? "收合明細" : `查看明細與備註（${noted.length}）`}
                      </button>
                      {expanded && (
                        <div className="review-result-card-detail">
                          {noted.map((answer, index) => (
                            <div key={`${answer.questionId}-${index}`}>
                              <b>{answer.itemText || `第 ${index + 1} 題`}</b>
                              <span>
                                {answer.optionLabel || "—"}
                                {answer.commonErrors.length > 0
                                  ? ` · ${answer.commonErrors.join("、")}`
                                  : ""}
                              </span>
                            </div>
                          ))}
                          {mergedNote && <p><b>補充說明：</b>{mergedNote}</p>}
                        </div>
                      )}
                    </>
                  )}
                </article>
              );
            })}
          </div>
        </ListPanel>
      )}
      {!queried && (
        <EmptyState
          title="尚未搜尋"
          description="設定篩選條件後按「搜尋」讀取審查結果。"
        />
      )}
    </section>
  );
}

function submittedMillis(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const t = value as { toDate?: () => Date; seconds?: number };
  if (typeof t.toDate === "function") return t.toDate().getTime();
  return typeof t.seconds === "number" ? t.seconds * 1000 : null;
}

function formatSubmittedAt(value: unknown): string {
  // v1.88.15：走 ym.ts 共用函式（不補零）；非 Timestamp 回 "—"。
  return fmtTsDate(value);
}

/* ================= 達閾值率矩陣（組別／單位分析共用） ================= */

function RateMatrix({
  rows,
  columns,
  cellOf,
  hasExtraReview,
  thresholdOf,
  capaMarkOf,
  onCell,
  onDetailCell,
  onChart,
  onDoc,
  onDetailChart,
  onDetailDoc,
}: {
  rows: {
    id: string;
    label: string;
    /**
     * v1.88.17：該列的合併格（表頭仍為單月欄；每列資料格按自己的排程區間
     * colspan 合併）。未傳時退回一月一格。
     */
    spans?: RowSpan[];
    details?: { key: string; label: string; cells: Record<string, PassRate> }[];
  }[];
  columns: AnalysisPeriodColumn[];
  cellOf: (rowId: string, col: AnalysisPeriodColumn) => CellValue;
  hasExtraReview?: (rowId: string, col: AnalysisPeriodColumn) => boolean;
  /** 單位分析：低於閾值顯示紅字 */
  thresholdOf?: (rowId: string) => number;
  /** 單位分析：該欄期間內有啟動 CAPA 時於結果旁顯示圓圈 C */
  capaMarkOf?: (rowId: string, col: AnalysisPeriodColumn) => CapaCase | undefined;
  onCell?: (rowId: string, col: AnalysisPeriodColumn) => void;
  /** v1.50.0：分組／逐題明細格可點下探（帶分組 key，只顯示該分組的個人結果） */
  onDetailCell?: (rowId: string, detailKey: string, col: AnalysisPeriodColumn) => void;
  onChart: (rowId: string) => void;
  onDoc: (rowId: string) => void;
  /** v1.53.0：分組子列曲線圖／文件圖示（點開看該組；同主列做法） */
  onDetailChart?: (rowId: string, detailKey: string, detailLabel: string) => void;
  onDetailDoc?: (rowId: string, detailKey: string, detailLabel: string) => void;
}) {
  return (
    <div className="analysis-table-wrap">
      <table className="data-table analysis-matrix">
        <thead>
          <tr>
            <th className="ind-col">指標</th>
            {columns.map((c) => (
              <th key={c.key} className="rate-col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.flatMap((row) => [
            <tr key={row.id}>
              <td className="ind-col">
                <div className="analysis-indicator-sticky">
                  <span className="analysis-indicator-name">{row.label}</span>
                  <span className="analysis-indicator-actions">
                    <button
                      type="button"
                      className="icon-button"
                      title="曲線圖"
                      aria-label={`${row.label} 曲線圖`}
                      onClick={() => onChart(row.id)}
                    >
                      <TrendingUp size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      title="各選項得分狀況"
                      aria-label={`${row.label} 各選項得分狀況`}
                      onClick={() => onDoc(row.id)}
                    >
                      <FileText size={16} />
                    </button>
                  </span>
                </div>
              </td>
              {(() => {
                // v1.88.17：每列用自己的 spans 渲染（合併格 colSpan）；未傳 spans 時一月一格。
                const spans = row.spans ?? columns.map((c) => singleMonthSpan(c.months[0]));
                return spans.map((span) => {
                  const cell = cellOf(row.id, span);
                  const clickable = cell.rate != null && onCell != null;
                  return (
                    <td
                      key={span.key}
                      colSpan={span.months.length}
                      className={`rate-cell${clickable ? " clickable" : ""}${isBelow(cell.rate, thresholdOf?.(row.id))}`}
                      title={clickable ? `${cell.title}（點選下探）` : cell.title}
                      onClick={
                        clickable ? () => onCell(row.id, span) : undefined
                      }
                      role={clickable ? "button" : undefined}
                      tabIndex={clickable ? 0 : undefined}
                      onKeyDown={
                        clickable
                          ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                onCell(row.id, span);
                              }
                            }
                          : undefined
                      }
                    >
                      <RateCellBody cell={cell} extra={!!hasExtraReview?.(row.id, span)} capa={capaMarkOf?.(row.id, span)} />
                    </td>
                  );
                });
              })()}
            </tr>,
            ...(row.details ?? []).map((detail) => (
              <tr key={`${row.id}-detail-${detail.key}`} className="analysis-matrix-detail-row">
                <td className="ind-col">
                  <div className="analysis-matrix-subrow">
                    <span>{detail.label}</span>
                    <span className="analysis-indicator-actions">
                      <button
                        type="button"
                        className="icon-button"
                        title="曲線圖"
                        aria-label={`${detail.label} 曲線圖`}
                        onClick={() => onDetailChart?.(row.id, detail.key, detail.label)}
                      >
                        <TrendingUp size={16} />
                      </button>
                      {/* v1.53.0：歷史分組無現行題目，選項明細為空列，故不顯示文件圖示 */}
                      {!detail.key.startsWith("historical-") && (
                        <button
                          type="button"
                          className="icon-button"
                          title="各選項得分狀況"
                          aria-label={`${detail.label} 各選項得分狀況`}
                          onClick={() => onDetailDoc?.(row.id, detail.key, detail.label)}
                        >
                          <FileText size={16} />
                        </button>
                      )}
                    </span>
                  </div>
                </td>
                {(() => {
                  // v1.88.17：明細列與主列用同一組 spans 合併（否則欄位錯位）。
                  const spans = row.spans ?? columns.map((c) => singleMonthSpan(c.months[0]));
                  return spans.map((span) => {
                    const detailCell = detail.cells[span.key] ?? { pass: 0, total: 0, rate: null };
                    const detailClickable = detailCell.rate != null && onDetailCell != null;
                    return (
                      <td
                        key={span.key}
                        colSpan={span.months.length}
                        className={`rate-cell${detailClickable ? " clickable" : ""}${isBelow(detailCell.rate, thresholdOf?.(row.id))}`}
                        title={detailClickable ? `${formatPassRate(detailCell)}（點選下探到個人審查結果）` : formatPassRate(detailCell)}
                        onClick={
                          detailClickable ? () => onDetailCell(row.id, detail.key, span) : undefined
                        }
                        role={detailClickable ? "button" : undefined}
                        tabIndex={detailClickable ? 0 : undefined}
                        onKeyDown={
                          detailClickable
                            ? (e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  onDetailCell(row.id, detail.key, span);
                                }
                              }
                            : undefined
                        }
                      >
                        <RateCellBody cell={detailCell} extra={!!hasExtraReview?.(row.id, span)} />
                      </td>
                    );
                  });
                })()}
              </tr>
            )),
          ])}
        </tbody>
      </table>
    </div>
  );
}

/* ================= 單位分析矩陣下方展開面板 ================= */

function UnitBelowPanel({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="analysis-below-panel">
      <div className="analysis-below-head">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <button
          type="button"
          className="button button-ghost"
          onClick={onClose}
          aria-label="關閉"
        >
          <X size={16} />
        </button>
      </div>
      {children}
    </div>
  );
}

/* ================= 下探：合併格先展開區間內各月（v1.88.17 Q5=C） ================= */

/** 點多月合併格時的中間層：列出區間內各月達閾值率，點有資料的月份進入 L1。 */
function SpanMonthPicker({
  title,
  subtitle,
  months,
  cellOf,
  onPick,
  onClose,
}: {
  title: string;
  subtitle: string;
  months: { year: number; month: number }[];
  cellOf: (month: { year: number; month: number }) => CellValue;
  onPick: (month: { year: number; month: number }) => void;
  onClose: () => void;
}) {
  return (
    <div className="reviewer-modal-backdrop" onClick={onClose}>
      <div
        className="reviewer-modal panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="reviewer-modal-head">
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button
            className="button button-ghost"
            onClick={onClose}
            aria-label="關閉"
          >
            <X size={16} />
          </button>
        </div>
        <div className="analysis-table-wrap">
          <table className="data-table analysis-matrix">
            <thead>
              <tr>
                <th className="ind-col">審查月份</th>
                <th className="rate-col">達閾值率</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => {
                const cell = cellOf(m);
                const clickable = cell.rate != null;
                return (
                  <tr key={`${m.year}-${m.month}`}>
                    <td className="ind-col">{fmtYm(m.year, m.month)}</td>
                    <td
                      className={`rate-cell${clickable ? " clickable" : ""}`}
                      title={clickable ? `${cell.title}（點選看該月各單位）` : cell.title}
                      onClick={clickable ? () => onPick(m) : undefined}
                      role={clickable ? "button" : undefined}
                      tabIndex={clickable ? 0 : undefined}
                      onKeyDown={
                        clickable
                          ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                onPick(m);
                              }
                            }
                          : undefined
                      }
                    >
                      <RateCellBody cell={cell} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ================= 下探：L1 單位矩陣 → L2 人員各選項結果 ================= */

/** 原因詞庫下探彈窗（v1.50.0）：勾選指定原因詞庫項目的個人審查結果。 */
function CauseDrillModal({
  cause,
  onClose,
  records,
  indOf,
  unitNameOf,
}: {
  cause: string;
  onClose: () => void;
  records: AnalysisRecord[];
  indOf: Map<string, IndicatorOpt>;
  unitNameOf: Map<string, string>;
}) {
  const entries = useMemo(() => causeRecordEntries(records, cause), [records, cause]);
  return (
    <div className="reviewer-modal-backdrop" onClick={onClose}>
      <div
        className="reviewer-modal wide panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`原因：${cause}`}
      >
        <div className="reviewer-modal-head">
          <div>
            <h2>原因：{cause}</h2>
            <p>勾選該原因的個人審查結果（共 {entries.length} 筆作答）</p>
          </div>
          <button
            className="button button-ghost"
            onClick={onClose}
            aria-label="關閉"
          >
            <X size={16} />
          </button>
        </div>
        {entries.length === 0 ? (
          <EmptyState title="無資料" description="所選期間尚無勾選該原因的審查紀錄。" />
        ) : (
          <div className="analysis-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>指標</th>
                  <th>單位</th>
                  <th>年月</th>
                  <th>被審人員</th>
                  <th>題目</th>
                  <th>作答</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, i) => {
                  const ind = indOf.get(entry.record.indicatorId);
                  return (
                    <tr key={`${entry.record.personEmpNo}-${entry.record.year}-${entry.record.month}-${entry.questionId}-${i}`}>
                      <td>{ind ? `${stripInternalIdPrefix(ind.code)}・${ind.name}` : stripInternalIdPrefix(entry.record.indicatorId)}</td>
                      <td>{entry.record.unitId === "" ? "NA" : `${entry.record.unitId}・${unitNameOf.get(entry.record.unitId) ?? ""}`}</td>
                      <td>{fmtYm(entry.record.year, entry.record.month)}</td>
                      <td>{staffLabel(entry.record.personEmpNo, entry.record.personName)}</td>
                      <td>{entry.itemText}</td>
                      <td>{entry.optionLabel}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function DrillModal({
  drill,
  onClose,
  onBackToL1,
  onSelectUnit,
  onNeedHistory,
  onNeedMonths,
  summaryCellsFor,
  historyBusy,
  historyNote,
  recordIndex,
  indOf,
  unitNameOf,
  columns,
}: {
  drill: DrillState;
  onClose: () => void;
  onBackToL1: () => void;
  onSelectUnit: (unitId: string, month?: { year: number; month: number }) => void;
  onNeedHistory: (indicatorId: string, beforeKey: number, n: number) => Promise<void>;
  onNeedMonths: (indicatorId: string, months: { year: number; month: number }[]) => Promise<void>;
  summaryCellsFor: (indicatorId: string, months: { year: number; month: number }[], unitId?: string) => ArchiveCell[] | null;
  historyBusy: boolean;
  historyNote: string;
  recordIndex: RecordIndex;
  indOf: Map<string, IndicatorOpt>;
  unitNameOf: Map<string, string>;
  /** 目前查詢畫面的期間欄（由舊到新）：連續未達標偵測只用已載入的欄，不另外讀取 */
  columns: AnalysisPeriodColumn[];
}) {
  const ind = indOf.get(drill.indicatorId);
  const th = ind?.threshold ?? 0;
  const col = drill.column;
  // v1.73.0：L2 的期間月份——點歷史月份格子時只看該月，否則為選定的期間欄
  const l2Months = drill.l2Months ?? col.months;
  const l2Needs = drill.l2UnitId != null || drill.l2All === true;
  // 只有「再下探」（L2）或 L1 無摘要可用時，才補讀原始紀錄
  useEffect(() => {
    if (l2Needs) void onNeedMonths(drill.indicatorId, l2Months);
  }, [l2Needs, drill.indicatorId, l2Months, onNeedMonths]);
  const [showRecentResults, setShowRecentResults] = useState(false);
  const [recentResultCount, setRecentResultCount] = useState(3);
  // CAPA：該指標的案件（一次）與觸發規則設定（一次），僅 L1 單位列表使用
  const [capaCases, setCapaCases] = useState<CapaCase[] | null>(null);
  const [capaSettings, setCapaSettings] = useState<CapaSettings | null>(null);
  useEffect(() => {
    if (drill.l2UnitId != null || drill.l2All === true) return;
    let alive = true;
    loadCapaCasesByIndicator(drill.indicatorId)
      .then((rows) => { if (alive) setCapaCases(rows); })
      .catch(() => { if (alive) setCapaCases([]); });
    loadCapaSettings()
      .then((v) => { if (alive) setCapaSettings(v); })
      .catch(() => { if (alive) setCapaSettings(null); });
    return () => { alive = false; };
  }, [drill.indicatorId, drill.l2UnitId, drill.l2All]);
  const currentStartKey = useMemo(
    () => Math.min(...col.months.map(({ year, month }) => year * 100 + month)),
    [col.months],
  );
  // 勾選「顯示近 N 次」時，自動補讀尚未載入的歷史月份（見 ensureHistory）
  useEffect(() => {
    if (!showRecentResults) return;
    void onNeedHistory(drill.indicatorId, currentStartKey, recentResultCount);
  }, [showRecentResults, drill.indicatorId, currentStartKey, recentResultCount, onNeedHistory]);
  // 歷史月份：選定期間之前、有資料的前 N 個月，由舊到新排列（選定月在最右）
  const historyMonths = useMemo(() => {
    const byMonth = recordIndex.get(drill.indicatorId);
    if (!byMonth) return [] as { year: number; month: number; key: number; label: string }[];
    const currentStart = currentStartKey;
    return [...byMonth.keys()]
      .filter((key) => key < currentStart && (byMonth.get(key)?.length ?? 0) > 0)
      .sort((a, b) => b - a)
      .slice(0, recentResultCount)
      .reverse()
      .map((key) => {
        const year = Math.floor(key / 100);
        const month = key % 100;
        return { year, month, key, label: fmtYm(year, month) };
      });
  }, [recordIndex, drill.indicatorId, currentStartKey, recentResultCount]);
  // v1.50.0：分組／逐題／選項篩選——只顯示該分組／該題的個人結果
  const section = useMemo(() => {
    if (!drill.sectionKey || !ind) return null;
    const scopeRecs = recordsForIndex(
      recordIndex,
      drill.indicatorId,
      [...col.months, ...(drill.l2Months ?? [])],
      drill.scopeUnitId,
    );
    return resolveDrillSection(ind.questions, drill.sectionKey, scopeRecs);
  }, [recordIndex, drill.indicatorId, drill.sectionKey, drill.scopeUnitId, drill.l2Months, col, ind]);
  const filterIds = useMemo(() => {
    if (section) return section.ids;
    if (drill.questionId) return [drill.questionId];
    return null;
  }, [section, drill.questionId]);
  const filterKind = section?.kind ?? (drill.questionId ? "question" : null);
  const filterLabel = useMemo(() => {
    if (!ind) return "";
    if (drill.optionLabel && drill.questionId) {
      const q = ind.questions.find((x) => x.id === drill.questionId);
      return `${q ? q.itemText : "題目"}・答「${drill.optionLabel}」的人員`;
    }
    if (section) {
      if (section.kind === "group") {
        const gq = ind.questions.find((q) => section.ids.includes(q.id));
        return gq?.groupId ? gq.groupName || "未命名分組" : "未分組項目";
      }
      const q = ind.questions.find((x) => x.id === section.ids[0]);
      return q?.itemText ?? "歷史題目";
    }
    if (drill.questionId) {
      const q = ind.questions.find((x) => x.id === drill.questionId);
      return q?.itemText ?? "題目";
    }
    return "";
  }, [ind, section, drill.optionLabel, drill.questionId]);
  // L2 顯示的題目：篩選時只列該分組／該題；歷史題目以作答中的題目文字補齊
  const l2Questions = useMemo(() => {
    if (!ind) return [] as AuditQuestion[];
    if (!filterIds) return ind.questions;
    const known = new Map(ind.questions.map((q) => [q.id, q]));
    const scopeRecs = recordsForIndex(
      recordIndex,
      drill.indicatorId,
      l2Months,
      drill.scopeUnitId,
    );
    const list: AuditQuestion[] = [];
    for (const id of filterIds) {
      const q = known.get(id);
      if (q) {
        list.push(q);
        continue;
      }
      const ans = scopeRecs
        .flatMap((r) => r.answers)
        .find((a) => a.questionId === id);
      list.push({
        id,
        itemText: ans?.itemText ?? "歷史題目",
        optionSet: "yes-no-na",
        guidance: "",
        commonErrors: [],
        groupId: null,
        groupName: "",
        order: list.length,
      });
    }
    return list;
  }, [ind, filterIds, recordIndex, drill.indicatorId, drill.scopeUnitId, l2Months]);
  // L1：指標有封存摘要且未做分組／逐題篩選時，直接用摘要格（單位×月份）——不讀原始紀錄。
  // 有篩選（分組／逐題）或指標無摘要時，才用原始紀錄。
  const l1Summary = useMemo(
    () => (filterIds ? null : summaryCellsFor(drill.indicatorId, col.months, drill.scopeUnitId)),
    [filterIds, summaryCellsFor, drill.indicatorId, col.months, drill.scopeUnitId],
  );
  // 分組／逐題篩選下探 L1 摘要不足，才補讀原始紀錄（指標無摘要時原始紀錄本就已載入，no-op）
  useEffect(() => {
    if (filterIds) void onNeedMonths(drill.indicatorId, col.months);
  }, [filterIds, drill.indicatorId, col.months, onNeedMonths]);
  const l1Units = useMemo(() => {
    if (l1Summary) {
      const ids = new Set(l1Summary.filter((c) => c.total > 0).map((c) => c.unitId));
      return [...ids].sort((a, b) => a.localeCompare(b, "zh-Hant"));
    }
    const recs = recordsForIndex(recordIndex, drill.indicatorId, col.months, drill.scopeUnitId);
    return unitsForDrill(recs, col.months);
  }, [l1Summary, recordIndex, drill.indicatorId, drill.scopeUnitId, col]);
  const l1Cells = useMemo(() => {
    const map = new Map<string, CellValue>();
    for (const unitId of l1Units) {
      const pr = l1Summary
        ? passRateFromCells(l1Summary.filter((c) => c.unitId === unitId))
        : (() => {
            const recs = recordsForIndex(recordIndex, drill.indicatorId, col.months, unitId);
            return filterIds && filterKind
              ? drill.mode === "unit"
                ? sectionUnitPassRateOf(recs, filterIds, th)
                : sectionPassRateOf(recs, filterIds, filterKind, th)
              : passRateOf(recs, th);
          })();
      map.set(unitId, {
        ...pr,
        title: pr.total === 0 ? "未審核" : `達閾值 ${pr.pass}／${pr.total} 人次`,
      });
    }
    return map;
  }, [recordIndex, drill.indicatorId, drill.mode, l1Units, l1Summary, col, th, filterIds, filterKind]);
  // v1.88.13：L1「審查月份」欄——每單位在該期間欄內有紀錄的排程月份。
  // 封存摘要路徑由 SummaryCell 的 year／month 推出（只顯示排程月份，
  // 真實審查日只在 L2 顯示）；原始紀錄路徑由 unitMonthsForDrill 推出。
  const l1UnitMonths = useMemo(() => {
    const map = new Map<string, { year: number; month: number }[]>();
    for (const unitId of l1Units) {
      if (l1Summary) {
        const keys = new Set<string>();
        for (const c of l1Summary) {
          if (c.unitId !== unitId || c.total <= 0) continue;
          keys.add(`${c.year}-${c.month}`);
        }
        map.set(
          unitId,
          [...keys]
            .map((k) => {
              const [year, month] = k.split("-").map(Number);
              return { year, month };
            })
            .sort((a, b) => a.year - b.year || a.month - b.month),
        );
      } else {
        const recs = recordsForIndex(
          recordIndex,
          drill.indicatorId,
          col.months,
          unitId,
        );
        map.set(unitId, unitMonthsForDrill(recs, col.months, unitId));
      }
    }
    return map;
  }, [l1Summary, l1Units, recordIndex, drill.indicatorId, col]);
  // 連續未達標偵測：只用目前查詢畫面已載入的期間欄；沒有審查資料的欄不列入；
  // 期數取 CAPA 設定（指標覆寫優先，否則全院預設）。選定期間本身須有資料且為最新一期。
  const capaTriggers = useMemo(() => {
    const map = new Map<string, { need: number; series: { label: string; rate: number; ym: string }[] }>();
    if (!capaSettings?.triggerEnabled || th <= 0 || filterIds) return map;
    const need = Math.max(1, capaSettings.indicatorOverrides[drill.indicatorId] ?? capaSettings.defaultTriggerPeriods);
    // v1.88.17：columns 已是一月一欄；取選定格最後一個月的索引作截止（含整個合併格）。
    const lastMonth = col.months[col.months.length - 1];
    const lastKey = lastMonth ? `${lastMonth.year}-${lastMonth.month}` : col.key;
    const idx = columns.findIndex((c) => c.key === lastKey);
    const cols = idx >= 0 ? columns.slice(0, idx + 1) : [col];
    const rateOf = (months: { year: number; month: number }[], unitId: string): PassRate => {
      const cells = summaryCellsFor(drill.indicatorId, months, unitId);
      if (cells) return passRateFromCells(cells.filter((c) => c.unitId === unitId));
      return passRateOf(recordsForIndex(recordIndex, drill.indicatorId, months, unitId), th);
    };
    for (const unitId of l1Units) {
      const series: { label: string; rate: number; ym: string }[] = [];
      for (const c of cols) {
        const pr = rateOf(c.months, unitId);
        if (pr.rate == null || pr.total === 0) continue;
        const withData = [...c.months]
          .sort((a, b) => b.year * 100 + b.month - (a.year * 100 + a.month))
          .find((m) => rateOf([m], unitId).total > 0) ?? c.months[c.months.length - 1];
        series.push({ label: c.label, rate: pr.rate, ym: `${withData.year}-${pad2(withData.month)}` });
      }
      const last = series.slice(-need);
      const lastYm = series.length > 0 ? series[series.length - 1].ym : "";
      const selectedHasData =
        series.length > 0 &&
        col.months.some((m) => `${m.year}-${pad2(m.month)}` === lastYm);
      if (selectedHasData && last.length >= need && last.every((x) => x.rate < th)) {
        map.set(unitId, { need, series: last });
      }
    }
    return map;
  }, [capaSettings, th, filterIds, drill.indicatorId, columns, col, l1Units, summaryCellsFor, recordIndex]);
  const startCapa = (unitId: string) => {
    const trig = capaTriggers.get(unitId);
    if (!trig) return;
    const fmt = (r: number) => (Number.isInteger(r) ? String(r) : r.toFixed(1));
    const lastItem = trig.series[trig.series.length - 1];
    window.dispatchEvent(new CustomEvent("capa:open", { detail: {
      indicatorId: drill.indicatorId,
      indicatorCode: ind?.code ?? "",
      indicatorName: ind?.name ?? "",
      threshold: th,
      period: lastItem.ym,
      periodKeys: trig.series.map((x) => x.ym),
      unitCode: unitId,
      unitName: unitNameOf.get(unitId) ?? "",
      rate: lastItem.rate,
      summary: `${trig.series.map((x) => `${x.label} ${fmt(x.rate)}%`).join("、")}，連續${trig.need}次審查皆未達閾值`,
      snapshots: trig.series.map((x) => ({ period: x.ym.replace("-", "/").replace(/\/(\d)$/, "/0$1"), rate: x.rate })),
    } }));
  };
  // L2 列：該單位該期間被審人員在各選項的審查結果（l2All 時為全部單位）
  const l2Active = drill.l2UnitId != null || drill.l2All === true;
  const l2Rows = useMemo(() => {
    if (!l2Active) return [];
    const recs = recordsForIndex(
      recordIndex,
      drill.indicatorId,
      l2Months,
      drill.l2UnitId ?? drill.scopeUnitId,
    );
    const rows = personOptionRows(recs, th);
    // 選項篩選：只顯示答此選項的人員
    if (drill.optionLabel && drill.questionId) {
      return rows.filter(
        (row) => row.answers.get(drill.questionId as string) === drill.optionLabel,
      );
    }
    return rows;
  }, [recordIndex, drill.indicatorId, drill.l2UnitId, drill.scopeUnitId, l2Months, th, l2Active, drill.optionLabel, drill.questionId]);
  // L2 轉置（v1.27.1）：直向＝題目、橫向＝人員（職編/遮罩姓名，v1.40.2），中間＝審查結果
  const l2Matrix = useMemo(
    () =>
      ind
        ? transposePersonOptionRows(l2Rows, l2Questions)
        : { headers: [] as string[], bedNos: [] as string[], months: [] as string[], reviewDates: [] as string[], rows: [], rates: [] },
    [l2Rows, ind, l2Questions],
  );

  // L2 補充說明（v1.43.0）：每欄＝一筆紀錄，每筆彙整為一則（單則為備註
  // 原文、多則每則附題號），顯示於矩陣下方。
  const l2NoteGroups = useMemo(() => {
    if ((!drill.l2UnitId && !drill.l2All) || !ind) return [];
    return l2Rows
      .map((row, i) => {
        const text = mergeNoteParts(
          l2Questions.map((q, qi) => ({
            questionNo: qi + 1,
            note: row.notes.get(q.id) ?? "",
          })),
        );
        if (!text) return null;
        return {
          key: `${row.personEmpNo}-${row.year}-${row.month}-${i}`,
          label: l2Matrix.headers[i] ?? row.personEmpNo,
          monthLabel: fmtYm(row.year, row.month),
          reviewDate: fmtYmd(row.reviewDate ?? ""),
          bedNo: row.bedNo,
          text,
        };
      })
      .filter((g): g is NonNullable<typeof g> => g != null);
  }, [l2Rows, ind, drill.l2UnitId, drill.l2All, l2Matrix, l2Questions]);

  if (!ind) return null;
  const title = `${ind.code}・${ind.name}`;
  const l2UnitLabel = drill.l2UnitId
    ? `${drill.l2UnitId}・${unitNameOf.get(drill.l2UnitId) ?? ""}`
    : drill.scopeUnitId
      ? `${drill.scopeUnitId}・${unitNameOf.get(drill.scopeUnitId) ?? ""}`
      : "全部單位";
  return (
    <div
      className="reviewer-modal-backdrop"
      onClick={onClose}
    >
      <div
        className="reviewer-modal wide panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="reviewer-modal-head">
          <div>
            <h2>{title}</h2>
            <p>
              {l2Active
                ? `${drill.l2Months?.length === 1 ? fmtYm(drill.l2Months[0].year, drill.l2Months[0].month) : col.label}・${l2UnitLabel}・被審人員各選項結果${filterLabel ? `・${filterLabel}` : ""}`
                : `${col.label}・各單位審查結果（點選格子看被審人員）${filterLabel ? `・${filterLabel}` : ""}`}
            </p>
          </div>
          <button
            className="button button-ghost"
            onClick={onClose}
            aria-label="關閉"
          >
            <X size={16} />
          </button>
        </div>
        {!l2Active ? (
          <>
          <div className="drill-history-controls">
            <label className="check-row">
              <input type="checkbox" checked={showRecentResults} onChange={(event) => setShowRecentResults(event.target.checked)} />
              顯示近
              <select aria-label="顯示近幾次審查結果" value={recentResultCount} onChange={(event) => setRecentResultCount(Number(event.target.value))}>
                {Array.from({ length: 12 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}</option>)}
              </select>
              次的審查結果
            </label>
            {showRecentResults && (
              <span className="muted-text">
                {historyBusy ? "補讀歷史月份中…" : historyNote || "由舊到新排列，選定月份在最右；點格子可看該月被審人員。"}
              </span>
            )}
          </div>
          <div className="analysis-table-wrap">
            <table className="data-table analysis-matrix">
              <thead>
                <tr>
                  <th className="ind-col">單位</th>
                  <th>審查月份</th>
                  {showRecentResults && historyMonths.map((month) => <th key={month.key} className="rate-col">{month.label}</th>)}
                  <th className="rate-col" style={showRecentResults ? { background: "#eef4ff" } : undefined}>{col.label}</th>
                  <th className="rate-col">操作</th>
                </tr>
              </thead>
              <tbody>
                {l1Units.length === 0 ? (
                  <tr>
                    <td colSpan={4 + (showRecentResults ? historyMonths.length : 0)}>{historyBusy ? "讀取中…" : historyNote || "無資料"}</td>
                  </tr>
                ) : (
                  l1Units.map((unitId) => {
                    const cell = l1Cells.get(unitId);
                    const clickable = cell != null && cell.rate != null;
                    const unitMonths = l1UnitMonths.get(unitId) ?? [];
                    return (
                      <tr key={unitId}>
                        <td className="ind-col">
                          {unitId === "" ? "NA" : `${unitId}・${unitNameOf.get(unitId) ?? ""}`}
                        </td>
                        <td>
                          {unitMonths.length === 0
                            ? "—"
                            : unitMonths.map((m) => (
                              <button
                                key={`${m.year}-${m.month}`}
                                type="button"
                                className="text-button"
                                style={{ marginRight: 6 }}
                                title="點選只看該月被審人員"
                                onClick={() => onSelectUnit(unitId, { year: m.year, month: m.month })}
                              >
                                {fmtYm(m.year, m.month)}
                              </button>
                            ))}
                        </td>
                        {showRecentResults && historyMonths.map((month) => {
                          const recs = recordsForIndex(recordIndex, drill.indicatorId, [{ year: month.year, month: month.month }], unitId);
                          // 與選定月相同的內容：套用同一分組／題目篩選與閾值
                          const hp = filterIds && filterKind
                            ? drill.mode === "unit"
                              ? sectionUnitPassRateOf(recs, filterIds, th)
                              : sectionPassRateOf(recs, filterIds, filterKind, th)
                            : passRateOf(recs, th);
                          const hCell: CellValue = { ...hp, title: hp.total === 0 ? "無資料" : `達閾值 ${hp.pass}／${hp.total} 人次` };
                          const hClickable = hp.rate != null;
                          const pick = () => onSelectUnit(unitId, { year: month.year, month: month.month });
                          return (
                            <td
                              key={month.key}
                              className={`rate-cell${hClickable ? " clickable" : ""}${hp.rate != null && th > 0 && hp.rate < th ? " below" : ""}`}
                              title={hClickable ? `${hCell.title}（點選看被審人員）` : hCell.title}
                              onClick={hClickable ? pick : undefined}
                              role={hClickable ? "button" : undefined}
                              tabIndex={hClickable ? 0 : undefined}
                              onKeyDown={hClickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } } : undefined}
                            >
                              {hp.total === 0 ? "—" : <RateCellBody cell={hCell} />}
                            </td>
                          );
                        })}
                        <td
                          className={`rate-cell${clickable ? " clickable" : ""}${cell?.rate != null && th > 0 && cell.rate < th ? " below" : ""}`}
                          title={
                            clickable
                              ? `${cell.title}（點選看被審人員）`
                              : (cell?.title ?? "未審核")
                          }
                          onClick={
                            clickable ? () => onSelectUnit(unitId) : undefined
                          }
                          role={clickable ? "button" : undefined}
                          tabIndex={clickable ? 0 : undefined}
                          onKeyDown={
                            clickable
                              ? (e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    onSelectUnit(unitId);
                                  }
                                }
                              : undefined
                          }
                        >
                          {cell ? (
                            <RateCellBody
                              cell={cell}
                              capa={(capaCases ?? []).find((c) => c.unitCode === unitId && c.stage !== "已撤案" && capaInColumn(c, col.months))}
                            />
                          ) : "—"}
                        </td>
                        <td className="rate-cell">
                          {(() => {
                            if (!capaTriggers.has(unitId) || capaCases == null) return null;
                            const open = capaCases.some((c) => c.unitCode === unitId && c.stage !== "正式結案" && c.stage !== "已撤案");
                            return open ? (
                              <span className="muted-text">CAPA 進行中</span>
                            ) : (
                              <button type="button" className="text-button capa-start-link" onClick={() => startCapa(unitId)}>
                                啟動CAPA
                              </button>
                            );
                          })()}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          </>
        ) : (
          <>
            <div className="drill-back">
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={onBackToL1}
              >
                <ChevronLeft size={15} /> 返回單位列表
              </button>
            </div>
            {l2Rows.length === 0 ? (
              <EmptyState title={historyBusy ? "讀取原始紀錄中…" : "無資料"} description={historyBusy ? "正在讀取該單位被審人員的原始紀錄。" : historyNote || "該單位該期間尚無審查紀錄。"} />
            ) : (
              <>
                <div className="analysis-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>題目</th>
                      {l2Matrix.headers.map((h, i) => (
                        <th
                          key={`${l2Rows[i].personEmpNo}-${l2Rows[i].year}-${l2Rows[i].month}-${i}`}
                        >
                          <div>{h}</div>
                          <div>{l2Matrix.bedNos[i] ?? ""}</div>
                          <div>{l2Matrix.months[i] ?? ""}</div>
                          <div>審查日 {l2Matrix.reviewDates[i] ?? "—"}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {l2Matrix.rows.map((qr, qi) => (
                      <tr key={qr.questionId}>
                        <td>
                          {qi + 1}. {qr.itemText}
                        </td>
                        {qr.values.map((v, i) => (
                          <td
                            key={i}
                            className={v.trim() === "否" ? "drill-option-no" : undefined}
                          >
                            {v}
                          </td>
                        ))}
                      </tr>
                    ))}
                    <tr>
                      <td>正確率</td>
                      {l2Matrix.rates.map((r, i) => (
                        <td
                          key={i}
                          className={`drill-person-rate${r.rate != null && th > 0 && r.rate < th ? " below" : r.passing ? " pass" : ""}`}
                          title={r.passing ? "達閾值" : "未達閾值"}
                        >
                          {fmtRate(r.rate)}
                          {r.passing ? " ✓" : ""}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
              {l2NoteGroups.length > 0 && (
                <section className="supp-notes">
                  <SectionTitle
                    title="補充說明"
                    note="審查員備註未通過原因；每筆紀錄彙整為一則，只列有填寫備註的紀錄。"
                  />
                  {l2NoteGroups.map((g) => (
                    <div key={g.key} className="supp-notes-group">
                      <p className="supp-notes-person">
                        {g.label}・{g.monthLabel}・審查日 {g.reviewDate}
                        {g.bedNo ? `・床號 ${g.bedNo}` : ""}
                      </p>
                      <p className="supp-note-text">{g.text}</p>
                    </div>
                  ))}
                </section>
              )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ================= 各選項得分狀況表（文件圖示／指標選項明細共用） ================= */

function OptionDetailTable({
  rows,
  onQuestionClick,
  threshold,
}: {
  rows: OptionDetailRow[];
  /** v1.50.0：題目列可點下探到該題的個人審查結果 */
  onQuestionClick?: (questionId: string) => void;
  /**
   * v1.88.14：得分率未達閾值時該格顯示紅色，判紅用指標閾值。
   * 口徑提醒：得分率是題目層級聚合（是／（是＋否）），指標閾值原本是
   * 單筆紀錄 rate 的達標線，此處是借用同一數字；閾值 ≤0／缺值不標。
   */
  threshold?: number;
}) {
  if (rows.length === 0) {
    return <EmptyState title="無題目" description="該指標尚無審核表題目。" />;
  }
  const hasData = rows.some((r) => r.total > 0);
  const hasVersions = rows.some((row) => Boolean(row.indicatorVersion));
  const cell = (n: number, rate: number | null) =>
    `${n}（${rate == null ? "—" : `${rate.toFixed(1)}%`}）`;
  return (
    <>
      {!hasData && (
        <p className="settings-note" role="status">
          所選期間尚無審查紀錄。
        </p>
      )}
      <div className="analysis-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {hasVersions && <th>版本</th>}
              <th>題目</th>
              <th>是</th>
              <th>否</th>
              <th>不適用</th>
              <th>得分率</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const clickable = r.total > 0 && onQuestionClick != null;
              return (
                <tr
                  key={`${r.indicatorVersion ?? ""}-${r.questionId}-${i}`}
                  className={clickable ? "clickable" : undefined}
                  title={clickable ? "點選下探到該題的個人審查結果" : undefined}
                  onClick={clickable ? () => onQuestionClick(r.questionId) : undefined}
                >
                  {hasVersions && <td>{r.indicatorVersion}</td>}
                  <td>
                    {i + 1}. {r.itemText}
                  </td>
                  <td>{cell(r.yes, r.yesRate)}</td>
                  <td>{cell(r.no, r.noRate)}</td>
                  <td>{cell(r.na, r.naRate)}</td>
                  <td className={`rate-cell${isBelow(r.scoreRate, threshold)}`}>{fmtRate(r.scoreRate)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function QuestionErrorTable({
  rows,
  onQuestionClick,
}: {
  rows: QuestionErrorRow[];
  /** v1.50.0：錯題列可點下探到該題答「否」的個人審查結果 */
  onQuestionClick?: (questionId: string) => void;
}) {
  if (rows.length === 0) {
    return <EmptyState title="尚無錯題資料" description="所選期間與單位沒有可分析的題目作答。" />;
  }
  const errorTotal = rows.reduce((sum, row) => sum + row.no, 0);
  return (
    <>
      <p className="settings-note">
        所選期間共計 {errorTotal} 次「否」作答；排行依錯題次數由多至少。不同版本分列，舊資料未保存版本時標示「版本未記錄」。點選列下探到該題答「否」的個人審查結果。
      </p>
      <div className="analysis-table-wrap">
        <table className="data-table">
          <thead><tr><th>排名</th><th>版本</th><th>題目</th><th>錯題數（否）</th><th>有效作答數</th><th>錯誤率</th><th>不適用數</th></tr></thead>
          <tbody>{rows.map((row, index) => {
            const clickable = row.no > 0 && onQuestionClick != null;
            return (
              <tr
                key={`${row.indicatorVersion}-${row.questionId}-${row.itemText}`}
                className={clickable ? "clickable" : undefined}
                title={clickable ? "點選下探到該題答「否」的個人審查結果" : undefined}
                onClick={clickable ? () => onQuestionClick(row.questionId) : undefined}
              >
                <td>{index + 1}</td><td>{row.indicatorVersion}</td><td>{row.itemText}</td>
                <td>{row.no}</td><td>{row.validCount}</td>
                <td>{row.errorRate == null ? "—" : `${row.errorRate.toFixed(1)}%`}</td>
                <td>{row.notApplicable}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    </>
  );
}

/* ================= 品管審查結果匯入（v1.21.0 邏輯原樣搬入頁籤） ================= */

/**
 * 匯入預覽列（v1.47.0）：選檔後先預覽、不直接寫入；硬錯誤列不能匯入，
 * 軟錯誤列由匯入者逐列勾選「仍要匯入」才寫入。
 */
interface ImportPreviewRow {
  lineNo: number;
  unitCode: string;
  monthRaw: string;
  reviewerId: string;
  personEmpNo: string;
  /** 審核項目（v1.48.0）：該列的值，無此欄為 "" */
  auditItem: string;
  errors: string[];
  softErrors: string[];
  /** 該列將覆寫既有同一身分紀錄（指標＋單位＋年＋月＋受審人職編＋審核項目） */
  willOverwrite: boolean;
  /** 軟錯誤列是否仍要匯入（預設不勾） */
  forceImport: boolean;
  values: NonNullable<ResultImportRowResult["values"]> | null;
}

/**
 * 各指標審查結果匯入：選組別→選指標（只列啟用）→選檔匯入。
 * 範本依所選指標審查表題目即時產生（前 6 欄固定＋每題一欄）。
 * 預檢：指標代號與題數不符即整檔中止；逐列未填忽略、非法值該列跳過。
 * 每列寫一筆 reviewRecord（source="import"，不自動建 reviewTasks），
 * 計入審核進度（unitId／year／month 參與進度計算）。
 * v1.47.0：選檔後先顯示預覽／錯誤清單，按「確認匯入」才寫入；去重鍵
 * 改為身分鍵（指標＋單位＋年＋月＋受審人職編），重複即覆寫。
 * v1.48.0：指標有設審核項目時，範本與檔案多一欄「審核項目」（床號之後、
 * 第 7 欄），必填且須為清單內的值；去重身分鍵納入審核項目。
 */
function ResultImportPanel({
  indicators,
  indicatorsLoaded,
  user,
  onAction,
  onDone,
}: {
  indicators: IndicatorOpt[];
  /** 指標參考資料是否已載入完成（v1.43.1：未完成前不顯示下拉為空的診斷提示）。 */
  indicatorsLoaded: boolean;
  user: { staffId: string; name: string } | null;
  onAction: (m: string) => void;
  onDone: (years: number[]) => void;
}) {
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [unitCodes, setUnitCodes] = useState<Set<string>>(new Set());
  const [staffMap, setStaffMap] = useState<Map<string, string>>(new Map());
  const [staffLoaded, setStaffLoaded] = useState(false);
  const [selGroup, setSelGroup] = useState("");
  const [selIndicatorId, setSelIndicatorId] = useState("");
  const [summary, setSummary] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  /** 匯入預覽（v1.47.0）：選檔後先預覽，按「確認匯入」才寫入 */
  const [preview, setPreview] = useState<ImportPreviewRow[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const [gSnap, uSnap, sSnap] = await Promise.all([
          loadRefCollection("groups"),
          loadRefCollection("units"),
          loadRefCollection("users"),
        ]);
        setGroups(
          gSnap.docs
            .map((d) => ({
              id: d.id,
              name:
                typeof d.data().name === "string" ? d.data().name : d.id,
            }))
            .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")),
        );
        setUnitCodes(new Set(uSnap.docs.map((d) => d.id)));
        const sm = new Map<string, string>();
        sSnap.docs.forEach((d) => {
          const name = d.data().name;
          sm.set(d.id, typeof name === "string" ? name : d.id);
        });
        setStaffMap(sm);
        setStaffLoaded(true);
      } catch {
        setStaffLoaded(false);
      }
    })();
  }, []);

  // v1.43.1：指標下拉只列啟用指標、依所選組別過濾（純函式在 lib/import，
  // 單測覆蓋）。為空時顯示診斷提示而非靜默空白——原因只可能是資料面。
  const enabledByGroup = useMemo(
    () => filterImportIndicators(indicators, selGroup),
    [indicators, selGroup],
  );
  const indicatorHint = indicatorsLoaded
    ? importIndicatorEmptyHint(indicators, selGroup)
    : null;
  const selInd = indicators.find((i) => i.id === selIndicatorId) ?? null;

  function handleGroupChange(groupId: string) {
    setSelGroup(groupId);
    setSelIndicatorId("");
    setSummary(null);
    setErrors([]);
    setPreview(null);
  }

  function handleIndicatorChange(id: string) {
    setSelIndicatorId(id);
    setSummary(null);
    setErrors([]);
    setPreview(null);
  }

  function downloadCurrentTemplate() {
    if (!selInd) return;
    // v1.28 階段 5：downloadTemplate 為 async；xlsx 元件載入失敗時退回 CSV，提示使用者
    void downloadTemplate(
      resultTemplateRows(
        selInd.code,
        selInd.questions.map((q) => q.itemText),
        selInd.auditItems,
      ),
      "審查結果",
      `${selInd.code}_審查結果範本`,
    ).then((fmt) => {
      if (fmt === "csv") onAction("Excel 元件載入失敗，已改下載 CSV 範本");
    });
  }

  /** v1.47.0 預覽階段：選檔後先驗證、顯示預覽／錯誤清單，不直接寫入。 */
  async function handleImport(file: File) {
    if (!selInd || !user) return;
    setSummary(null);
    setErrors([]);
    setPreview(null);
    setBusy(true);
    try {
      const sheet = await readSheetFile(file);
      const { headerErrors, hasAuditItemColumn, data } = parseResultSheet(
        sheet,
        {
          questionTitles: selInd.questions.map((q) => q.itemText),
          auditItems: selInd.auditItems,
        },
      );
      if (headerErrors.length > 0) {
        setErrors(headerErrors);
        onAction("審查結果匯入失敗：標題列不符，請下載範本對照");
        return;
      }
      if (data.length === 0) {
        setErrors(["檔案內無資料列"]);
        return;
      }
      const { fileErrors, rows } = validateResultSheet(data, {
        code: selInd.code,
        questionCount: selInd.questions.length,
        unitHas: (c) => unitCodes.has(c),
        staffHas: (id) => staffMap.has(id),
        staffLoaded,
        auditItems: selInd.auditItems,
        hasAuditItemColumn,
      });
      if (fileErrors.length > 0) {
        setErrors(fileErrors);
        onAction("審查結果匯入中止：預檢不符（指標代號或題數）");
        return;
      }
      // 覆寫預查：身分鍵（指標＋單位＋年＋月＋受審人職編＋審核項目，
      // v1.48.0 納入審核項目；空值時與 v1.47.0 相同）已存在即覆寫；
      // 同一檔案內重複身分者，後者亦覆寫前者。
      const db = getFirebaseDb();
      const seenIds = new Set<string>();
      const previewRows: ImportPreviewRow[] = await Promise.all(
        rows.map(async (r) => {
          let willOverwrite = false;
          if (r.values) {
            const docId = importIdentityDocId({
              indicatorId: selInd.id,
              unitCode: r.values.unitCode,
              year: r.values.year,
              month: r.values.month,
              personEmpNo: r.values.personEmpNo,
              auditItem: r.values.auditItem,
            });
            if (seenIds.has(docId)) {
              willOverwrite = true;
            } else {
              seenIds.add(docId);
              try {
                const snap = await getDoc(doc(db, "reviewRecords", docId));
                willOverwrite = snap.exists();
              } catch {
                willOverwrite = false;
              }
            }
          }
          return {
            lineNo: r.lineNo,
            unitCode: r.unitCode,
            monthRaw: r.monthRaw,
            reviewerId: r.reviewerId,
            personEmpNo: r.personEmpNo,
            auditItem: r.auditItem,
            errors: r.errors,
            softErrors: r.softErrors,
            willOverwrite,
            forceImport: false,
            values: r.values,
          };
        }),
      );
      setPreview(previewRows);
      const writable = previewRows.filter(
        (r) => r.values && r.errors.length === 0,
      ).length;
      const badCount = previewRows.filter(
        (r) => r.errors.length > 0,
      ).length;
      const overwriteCount = previewRows.filter(
        (r) => r.values && r.errors.length === 0 && r.willOverwrite,
      ).length;
      setSummary(
        `預覽：共 ${previewRows.length} 列，可匯入 ${writable} 列、錯誤 ${badCount} 列` +
          (overwriteCount > 0
            ? `、其中 ${overwriteCount} 列將覆蓋既有資料`
            : "") +
          "。請確認後按「確認匯入」寫入；軟錯誤列須逐列勾選「仍要匯入」才會寫入。",
      );
    } catch (error) {
      setErrors([
        `讀取檔案失敗：${toErrorMessage(error, "讀寫失敗")}`,
      ]);
    } finally {
      setBusy(false);
    }
  }

  /** v1.47.0 確認匯入：只寫入無硬錯誤的列；軟錯誤列須逐列勾選才寫入。 */
  async function confirmImport() {
    if (!selInd || !user || !preview) return;
    const toWrite = preview.filter(
      (r) =>
        r.values &&
        r.errors.length === 0 &&
        (r.softErrors.length === 0 || r.forceImport),
    );
    if (toWrite.length === 0) return;
    const skipped = preview.length - toWrite.length;
    const hardErrorRows = preview.filter((r) => r.errors.length > 0);
    setBusy(true);
    try {
      const db = getFirebaseDb();
      // v1.47.0 去重：身分鍵（指標＋單位＋年＋月＋受審人職編）決定文件 ID，
      // 同一身分再匯即覆寫，不重複建檔；每 500 筆分段提交（batch 上限）。
      // v1.48.0：身分鍵納入審核項目（空值時與 v1.47.0 相同）。
      const today = new Date().toISOString().slice(0, 10);
      let batch = writeBatch(db);
      let pending = 0;
      const flush = async () => {
        if (pending > 0) {
          await batch.commit();
          batch = writeBatch(db);
          pending = 0;
        }
      };
      let overwritten = 0;
      for (const r of toWrite) {
        const v = r.values!;
        if (r.willOverwrite) overwritten += 1;
        const answers = selInd.questions.map((q, i) => {
          const label = v.answers[i] ?? "";
          const excluded = label === "不適用" || label === "";
          const note = (v.notes[i] ?? "").trim();
          return {
            questionId: q.id,
            itemText: q.itemText,
            optionLabel: label,
            score: label === "是" ? 1 : 0,
            excluded,
            ...(note ? { note } : {}),
          };
        });
        const { totalScore, maxScore, rate } = computeOptionSetScore(
          answers.map((a) => ({ score: a.score, excluded: a.excluded })),
        );
        const ref = doc(
          collection(db, "reviewRecords"),
          importIdentityDocId({
            indicatorId: selInd.id,
            unitCode: v.unitCode,
            year: v.year,
            month: v.month,
            personEmpNo: v.personEmpNo,
            auditItem: v.auditItem,
          }),
        );
        batch.set(ref, {
          taskId: "",
          indicatorId: selInd.id,
          unitId: v.unitCode,
          reviewerId: v.reviewerId,
          year: v.year,
          month: v.month,
          caseSeq: null,
          reviewDate: today,
          reviewerEmpNo: v.reviewerId,
          reviewerName: v.reviewerId
            ? (staffMap.get(v.reviewerId) ?? v.reviewerId)
            : "",
          reviewedPersonEmpNo: v.personEmpNo,
          reviewedPersonName: v.personEmpNo
            ? (staffMap.get(v.personEmpNo) ?? v.personEmpNo)
            : "",
          bedNo: v.bedNo,
          // v1.48.0：審核項目有值才寫、無值不寫欄位（維持 auditItem? 選填語義）
          ...(v.auditItem ? { auditItem: v.auditItem } : {}),
          answers,
          totalScore,
          maxScore,
          rate,
          submittedAt: serverTimestamp(),
          submittedBy: user.staffId,
          source: "import",
        });
        pending++;
        if (pending >= 500) await flush();
      }
      await flush();
      // 覆寫不留痕（v1.47.0 拍板）；稽核只記總數與覆寫筆數。
      logAudit(db, {
        actor: user.staffId,
        actorName: user.name,
        action: "匯入品管審查結果",
        targetType: "indicator",
        targetId: selInd.id,
        detail: `${selInd.code}：匯入 ${toWrite.length} 筆（其中資料重複已覆蓋 ${overwritten} 筆）、跳過 ${skipped} 列`,
      });
      const msg =
        `審查結果匯入：成功 ${toWrite.length} 筆` +
        (overwritten > 0 ? `（其中資料重複已覆蓋 ${overwritten} 筆）` : "") +
        `、跳過 ${skipped} 列`;
      setPreview(null);
      setErrors(
        hardErrorRows.map(
          (r) => `第 ${r.lineNo} 列：${r.errors.join("；")}`,
        ),
      );
      setSummary(msg);
      onAction(msg);
      onDone([...new Set(toWrite.map((r) => r.values!.year))]);
    } catch (error) {
      setErrors([
        `匯入失敗：${toErrorMessage(error, "讀寫失敗")}`,
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <SectionTitle
        title="匯入品管審查結果"
        note="先選組別與指標（只列啟用），再選 Excel／CSV 檔匯入。預檢不符（指標代號或題數）即整檔中止；選檔後先顯示預覽／錯誤清單，按「確認匯入」才寫入。匯入的紀錄計入審核進度，不自動建立審查任務。指標有設審核項目時，範本多一欄「審核項目」（必填，須為指標清單內的值）。同一指標、單位、月份、受審人員、審核項目重複匯入以後者覆蓋前者，不會重複建檔。"
      />
      <div className="form-stack results-import-filters">
        <FormSelect label="組別" value={selGroup}
              onChange={(e) => handleGroupChange(e.target.value)}>
              <option value="">全部組別</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </FormSelect>
        <div className="form-field">
          <label className="field-label">指標（只列啟用）</label>
          <div className="select-wrap">
            <select
              value={selIndicatorId}
              onChange={(e) => handleIndicatorChange(e.target.value)}
            >
              <option value="">請選擇指標</option>
              {enabledByGroup.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.code}・{i.name}（{i.questions.length} 題）
                </option>
              ))}
            </select>
            <ChevronDown size={15} />
          </div>
          {indicatorHint ? (
            <p className="field-hint">{indicatorHint}</p>
          ) : null}
        </div>
      </div>
      <div className="batch-toolbar">
        <button
          className="button button-outline button-sm"
          disabled={!selInd}
          onClick={downloadCurrentTemplate}
        >
          <Download size={14} /> 下載範本（依該指標題目產生）
        </button>
        <button
          className="button button-outline button-sm"
          disabled={!selInd || busy}
          onClick={() => fileRef.current?.click()}
        >
          <Upload size={14} /> 選擇檔案匯入
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          style={{ display: "none" }}
          aria-label="匯入審查結果檔案"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void handleImport(f);
          }}
        />
      </div>
      {preview && (
        <div style={{ marginTop: 12 }}>
          <div className="batch-toolbar" style={{ marginBottom: 8 }}>
            <button
              className="button button-primary button-sm"
              disabled={
                busy ||
                preview.filter(
                  (r) =>
                    r.values &&
                    r.errors.length === 0 &&
                    (r.softErrors.length === 0 || r.forceImport),
                ).length === 0
              }
              onClick={() => void confirmImport()}
            >
              確認匯入（
              {preview.filter(
                (r) =>
                  r.values &&
                  r.errors.length === 0 &&
                  (r.softErrors.length === 0 || r.forceImport),
              ).length}{" "}
              筆）
            </button>
            <button
              className="button button-outline button-sm"
              disabled={busy}
              onClick={() => {
                setPreview(null);
                setSummary(null);
              }}
            >
              取消
            </button>
            {preview.some(
              (r) => r.softErrors.length > 0 && r.errors.length === 0,
            ) && (
              <label
                style={{ display: "flex", alignItems: "center", gap: 4 }}
              >
                <input
                  type="checkbox"
                  checked={preview
                    .filter(
                      (r) =>
                        r.softErrors.length > 0 && r.errors.length === 0,
                    )
                    .every((r) => r.forceImport)}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setPreview((prev) =>
                      prev
                        ? prev.map((r) =>
                            r.softErrors.length > 0 && r.errors.length === 0
                              ? { ...r, forceImport: checked }
                              : r,
                          )
                        : prev,
                    );
                  }}
                />
                軟錯誤列全部仍要匯入
              </label>
            )}
          </div>
          <div style={{ maxHeight: 320, overflow: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>列</th>
                  <th>受審單位</th>
                  <th>審查月份</th>
                  <th>審查員</th>
                  <th>受審人員</th>
                  <th>審核項目</th>
                  <th>狀態</th>
                  <th>原因</th>
                  <th>仍要匯入</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((r) => {
                  const status =
                    r.errors.length > 0
                      ? "錯誤，不匯入"
                      : r.willOverwrite
                        ? "可匯入（將覆蓋既有資料）"
                        : "可匯入";
                  const reasons = [...r.errors, ...r.softErrors].join("；");
                  const canForce =
                    r.errors.length === 0 && r.softErrors.length > 0;
                  return (
                    <tr key={r.lineNo}>
                      <td>{r.lineNo}</td>
                      <td>{r.unitCode || "—"}</td>
                      <td>{r.monthRaw || "—"}</td>
                      <td>{staffLabel(r.reviewerId, staffMap.get(r.reviewerId) ?? "")}</td>
                      <td>{staffLabel(r.personEmpNo, staffMap.get(r.personEmpNo) ?? "")}</td>
                      <td>{r.auditItem || "—"}</td>
                      <td>{status}</td>
                      <td>{reasons || "—"}</td>
                      <td>
                        {canForce ? (
                          <input
                            type="checkbox"
                            aria-label={`第 ${r.lineNo} 列仍要匯入`}
                            checked={r.forceImport}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setPreview((prev) =>
                                prev
                                  ? prev.map((x) =>
                                      x.lineNo === r.lineNo
                                        ? { ...x, forceImport: checked }
                                        : x,
                                    )
                                  : prev,
                              );
                            }}
                          />
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {summary && (
        <p className="settings-note" role="status">
          {summary}
        </p>
      )}
      {errors.length > 0 && (
        <div style={{ maxHeight: 160, overflow: "auto", marginBottom: 8 }}>
          {errors.map((msg, i) => (
            <div key={i} className="field-error">
              {msg}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
