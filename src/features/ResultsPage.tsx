/**
 * 結果分析頁（v1.25.0：取代舊畫面）。
 * 四個分析／匯入頁籤；系統管理員另可使用審查結果管理。
 * 期間模型：年別／年份（起算年）／年數（往後數）／區間（月／季／年）／子選項
 * （月→只有全部；季→第一～四季／全部；年→半年／一年／全部），矩陣欄＝期間欄。
 * 達閾值＝紀錄 rate ≥ 指標閾值（紀錄無自帶達標旗標，一律以當前閾值計算；
 * 匯入紀錄同樣計入）；人次率＝合併計算，單位彙總率＝各單位率平均。
 * 權限：can("resultQuery")；資料範圍：管理員全部、審查員只看負責單位、
 * 一般人員只看自己單位（沿用舊頁規則）。
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  TrendingUp,
  Upload,
  X,
} from "lucide-react";
import {
  collection,
  doc,
  getDocs,
  getDocsFromServer,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from "../lib/db";
import { getFirebaseDb } from "../lib/firebase";
import { useAuth } from "../lib/auth";
import { usePermissions } from "../lib/usePermissions";
import {
  effectiveThreshold,
  indicatorCodeOf,
  normalizeQuestions,
  type AuditQuestion,
} from "../lib/indicators";
import { isReviewerRole } from "../lib/roleIdentity";
import { useOrgMeta } from "../lib/useOrgMeta";
import { hasRoleCategory, titleFlagsOf } from "../lib/orgMeta";
import { maskName } from "../lib/mask";
import { computeOptionSetScore } from "../lib/reviewRecords";
import { logAudit } from "../lib/audit";
import {
  parseResultSheet,
  resultTemplateRows,
  validateResultSheet,
} from "../lib/import";
import { downloadTemplate, readSheetFile } from "../lib/sheetFile";
import { EmptyState, PageHeading, SectionTitle, SummaryCell } from "../components/ui";
import { TrendChart } from "../components/TrendChart";
import {
  calendarYearsOf,
  expandMonthRangeColumns,
  type AnalysisGranularity,
  type AnalysisPeriodColumn,
} from "../lib/analysisPeriod";
import {
  formatPassRate,
  collectRecordNotes,
  optionDetailRows,
  questionErrorRows,
  questionErrorRowsFromSummaries,
  passRateOf,
  round1,
  personOptionRows,
  recordsInMonths,
  transposePersonOptionRows,
  unitPassRate,
  unitPeriodPassRate,
  unitsForDrill,
  type AnalysisRecord,
  type OptionDetailRow,
  type PassRate,
  type QuestionErrorRow,
} from "../lib/analysisRates";
import {
  getCachedYears,
  invalidateCachedYears,
  mergeYearDocs,
  setCachedYear,
  type ResultsCacheScope,
} from "../lib/resultsCache";
import { getCachedRefCollection } from "../lib/refCache";
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
import { unitHistoryCodes } from "../lib/unitHistory";

interface IndicatorOpt {
  id: string;
  code: string;
  name: string;
  groupId: string;
  status: string;
  version: string;
  threshold: number;
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

interface ResultSummaryDoc {
  id: string;
  indicatorId: string;
  scheduleStartYear: number;
  scheduleStartMonth: number;
  scheduleStartKey: number;
  indicatorVersion: string;
  scope: "unit" | "all";
  unitId: string | null;
  threshold: number;
  passedCount: number;
  totalCount: number;
  questionOptions: {
    questionId: string;
    itemText: string;
    yes: number;
    no: number;
    notApplicable: number;
  }[];
  precomputedAt: unknown;
}

function summaryPassRate(rows: ResultSummaryDoc[]): PassRate {
  const total = rows.reduce((sum, row) => sum + row.totalCount, 0);
  const pass = rows.reduce((sum, row) => sum + row.passedCount, 0);
  return { pass, total, rate: total > 0 ? round1((pass / total) * 100) : null };
}

function summaryOptionRows(rows: ResultSummaryDoc[]): OptionDetailRow[] {
  const counts = new Map<string, {
    indicatorVersion: string; questionId: string; itemText: string;
    yes: number; no: number; na: number;
  }>();
  for (const summary of rows) {
    for (const option of summary.questionOptions) {
      const key = `${summary.indicatorVersion}\u0000${option.questionId}\u0000${option.itemText}`;
      const row = counts.get(key) ?? {
        indicatorVersion: summary.indicatorVersion, questionId: option.questionId,
        itemText: option.itemText, yes: 0, no: 0, na: 0,
      };
      row.yes += option.yes;
      row.no += option.no;
      row.na += option.notApplicable;
      counts.set(key, row);
    }
  }
  return [...counts.values()]
    .sort((a, b) => a.indicatorVersion.localeCompare(b.indicatorVersion, "zh-Hant") || a.questionId.localeCompare(b.questionId, "zh-Hant"))
    .map((row, index) => {
      const total = row.yes + row.no + row.na;
      const pct = (n: number) => total > 0 ? round1((n / total) * 100) : null;
      return {
        ...row, order: index + 1, total, yesRate: pct(row.yes), noRate: pct(row.no),
        naRate: pct(row.na), scoreRate: row.yes + row.no > 0
          ? round1((row.yes / (row.yes + row.no)) * 100) : null,
      };
    });
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
  /** 閾值（紅色虛線）；null 表示不畫 */
  threshold: number | null;
}

interface DocModalData {
  title: string;
  subtitle: string;
  rows: OptionDetailRow[];
}

/** 下探狀態：L1 單位矩陣（l2UnitId 為 null）；L2 人員各選項結果（l2UnitId 有值） */
interface DrillState {
  indicatorId: string;
  column: AnalysisPeriodColumn;
  mode: UnitMode;
  /** 單位分析限定該單位；組別／指標分析為 undefined（全部單位） */
  scopeUnitId?: string;
  l2UnitId: string | null;
}

/** 矩陣下方展開面板（僅單位分析）：曲線圖／選項明細 */
interface UnitPanel {
  kind: "chart" | "doc";
  indicatorId: string;
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
          {year}年{String(month).padStart(2, "0")}月
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
                    onChange(`${displayYear}-${String(item).padStart(2, "0")}`);
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

/** 矩陣格格式：75%(3/4)；無資料 — */
function fmtCell(cell: CellValue): string {
  return formatPassRate(cell);
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
  const { can } = usePermissions();
  const now = new Date();
  const [indicators, setIndicators] = useState<IndicatorOpt[]>([]);
  const [groups, setGroups] = useState<GroupOpt[]>([]);
  const [units, setUnits] = useState<UnitOpt[]>([]);
  const [records, setRecords] = useState<AnalysisRecord[]>([]);
  const [summaryRecords, setSummaryRecords] = useState<ResultSummaryDoc[]>([]);
  const [tasks, setTasks] = useState<
    { id: string; unitId: string; reviewerId: string }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  /**
   * 已生效的查詢條件（null＝尚未查詢，顯示空白頁）。
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
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
  );
  const [interval, setInterval] = useState<AnalysisGranularity>("month");
  /** v1.40.2「未審月份不顯示」：勾選時隱藏該期間欄內零審查的欄位；預設不勾選，全部顯示。純顯示切換，不觸發重新查詢。 */
  const [hideEmptyMonths, setHideEmptyMonths] = useState(false);
  // 組別分析
  const [selGroup, setSelGroup] = useState("");
  const [groupUnit, setGroupUnit] = useState<UnitMode>("person");
  // 單位分析
  const [selUnit, setSelUnit] = useState("");
  const [selGroupU, setSelGroupU] = useState("");
  const [selIndU, setSelIndU] = useState("all");
  // 指標分析
  const [selGroup2, setSelGroup2] = useState("");
  const [selIndicator, setSelIndicator] = useState("");
  const [indUnit, setIndUnit] = useState<UnitMode>("person");
  const [errorUnit, setErrorUnit] = useState("all");
  // Modal
  const [chartModal, setChartModal] = useState<ChartModalData | null>(null);
  const [docModal, setDocModal] = useState<DocModalData | null>(null);
  // 下探（L1 單位矩陣／L2 人員各選項結果）
  const [drill, setDrill] = useState<DrillState | null>(null);
  // 單位分析矩陣下方展開面板（曲線圖／選項明細）
  const [unitPanel, setUnitPanel] = useState<UnitPanel | null>(null);

  // 資料範圍（沿用舊頁規則；v1.40.5 改以職稱旗標／角色類別判斷，不再比對名稱）
  const orgMeta = useOrgMeta();
  const isNurseLeader = !!user && (
    titleFlagsOf(user.title ?? "", user.titleId, orgMeta.titleMeta, orgMeta.titleMetaById).isUnitHead ||
    hasRoleCategory(user.roles ?? [], "unitHead", orgMeta.roleMeta)
  );
  const scope = useMemo(() => {
    const roles = user?.roles ?? [];
    if (roles.includes("系統管理員")) return { kind: "admin" as const };
    if (user && isNurseLeader)
      return { kind: "staff" as const, unitCode: user.unitCode };
    if (user && isReviewerRole(roles, orgMeta.roleMeta))
      return { kind: "reviewer" as const, staffId: user.staffId };
    if (user) return { kind: "staff" as const, unitCode: user.unitCode };
    return { kind: "admin" as const };
  }, [user, isNurseLeader, orgMeta.roleMeta]);

  const visibleUnitCodes = useMemo(() => {
    if (scope.kind !== "staff") return new Set<string>();
    return isNurseLeader
      ? unitHistoryCodes(units, scope.unitCode)
      : new Set([scope.unitCode]);
  }, [scope, isNurseLeader, units]);

  /** 按年份快取的權限範圍鍵（與 scope 同義，格式見 resultsCache） */
  const cacheScope: ResultsCacheScope = useMemo(() => {
    if (scope.kind === "reviewer")
      return { kind: "reviewer", staffId: scope.staffId };
    if (scope.kind === "staff")
      return { kind: "staff", unitCode: scope.unitCode };
    return { kind: "admin" };
  }, [scope]);

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
        const [isnap, gsnap, usnap] = await Promise.all([
          getCachedRefCollection("indicators", () =>
            getDocsCacheFirst(collection(db, "indicators")),
          ),
          getCachedRefCollection("groups", () =>
            getDocsCacheFirst(collection(db, "groups")),
          ),
          getCachedRefCollection("units", () =>
            getDocsCacheFirst(collection(db, "units")),
          ),
        ]);
        if (cancelled) return;
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
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rangeValid = Boolean(startMonth && endMonth && startMonth <= endMonth);
  // 期間欄只取所選年月範圍內的月份，再依月／季／半年／年分組。
  const columns = useMemo(
    () => expandMonthRangeColumns(startMonth, endMonth, interval),
    [startMonth, endMonth, interval],
  );
  const queryYears = useMemo(() => calendarYearsOf(columns), [columns]);
  /** 已生效的期間欄：未查詢前沿用 live 值（畫面為空白頁，不渲染矩陣） */
  const appliedColumns = useMemo(
    () =>
      applied
        ? expandMonthRangeColumns(
            applied.startMonth,
            applied.endMonth,
            applied.interval,
          )
        : columns,
    [applied, columns],
  );
  const appliedYearsKey = applied ? applied.years.join(",") : "";
  const allMonths = useMemo(
    () => appliedColumns.flatMap((c) => c.months),
    [appliedColumns],
  );

  // 審查紀錄（查詢閘門＋按年份快取）：
  // 未按「查詢」不觸發（applied 為 null）；已查過的年份直接吃記憶體快取，
  // 缺的年份才按年發查詢，併回後畫面永遠從合併後的快取渲染。
  // 快取鍵含權限範圍（見 resultsCache），不同範圍不共用。
  useEffect(() => {
    if (!applied || tab === "manage" || tab === "import") return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setSummaryRecords([]);
      try {
        const db = getFirebaseDb();
        const years = applied.years;
        if (tab === "indicator" && selIndicator) {
          const toMonthKey = (value: string) => Number(value.replace("-", ""));
          const startKey = toMonthKey(applied.startMonth);
          const endKey = toMonthKey(applied.endMonth);
          try {
            const summarySnap = await getDocs(
              query(
                collection(db, "reviewSummaries"),
                where("indicatorId", "==", selIndicator),
                where("scheduleStartKey", ">=", startKey),
                where("scheduleStartKey", "<=", endKey),
              ),
            );
            let summaries = summarySnap.docs.map((summaryDoc) => {
              const value = summaryDoc.data() as Record<string, unknown>;
              return {
                id: summaryDoc.id,
                indicatorId: String(value.indicatorId ?? ""),
                scheduleStartYear: Number(value.scheduleStartYear ?? 0),
                scheduleStartMonth: Number(value.scheduleStartMonth ?? 0),
                scheduleStartKey: Number(value.scheduleStartKey ?? 0),
                indicatorVersion: String(value.indicatorVersion ?? ""),
                scope: value.scope === "all" ? "all" as const : "unit" as const,
                unitId: typeof value.unitId === "string" ? value.unitId : null,
                threshold: Number(value.threshold ?? 0),
                passedCount: Number(value.passedCount ?? 0),
                totalCount: Number(value.totalCount ?? 0),
                questionOptions: Array.isArray(value.questionOptions)
                  ? value.questionOptions.map((raw) => {
                      const option = (raw ?? {}) as Record<string, unknown>;
                      return {
                        questionId: String(option.questionId ?? ""),
                        itemText: String(option.itemText ?? ""),
                        yes: Number(option.yes ?? 0),
                        no: Number(option.no ?? 0),
                        notApplicable: Number(option.notApplicable ?? 0),
                      };
                    })
                  : [],
                precomputedAt: value.precomputedAt,
              };
            });
            if (scope.kind === "admin") {
              // 管理者同時需要全院摘要及單位摘要（單位模式／篩選使用）。
            } else if (scope.kind === "staff") {
              summaries = summaries.filter((summary) =>
                isNurseLeader
                  ? summary.scope === "all" || (summary.scope === "unit" && summary.unitId != null && visibleUnitCodes.has(summary.unitId))
                  : summary.scope === "unit" && summary.unitId === scope.unitCode,
              );
            } else {
              const taskSnaps = await Promise.all(
                years.map((year) =>
                  getDocs(query(collection(db, "reviewTasks"), where("year", "==", year))),
                ),
              );
              const reviewerTasks: { id: string; unitId: string; reviewerId: string }[] = [];
              taskSnaps.forEach((snap) => snap.docs.forEach((taskDoc) => {
                const task = taskDoc.data() as Record<string, unknown>;
                if (task.reviewerId === scope.staffId) {
                  reviewerTasks.push({
                    id: taskDoc.id,
                    unitId: String(task.unitId ?? ""),
                    reviewerId: scope.staffId,
                  });
                }
              }));
              const allowedUnits = new Set(reviewerTasks.map((task) => task.unitId));
              summaries = summaries.filter(
                (summary) => summary.scope === "unit" && summary.unitId && allowedUnits.has(summary.unitId),
              );
              setTasks(reviewerTasks);
            }
            if (summaries.length > 0) {
              if (cancelled) return;
              setSummaryRecords(summaries);
              setRecords([]);
              if (scope.kind !== "reviewer") setTasks([]);
              setIndexFallback(false);
              setFetchedAt(Date.now());
              return;
            }
          } catch (summaryError) {
            // 摘要索引／文件尚未部署或期間未預存時，明確回退既有逐筆查詢。
            console.warn("結果分析摘要查詢未命中，改讀審查明細。", summaryError);
          }
        }
        setSummaryRecords([]);
        // v1.28 階段 7（B7）：單一指標限縮時改走 indicatorId＋year 複合索引
        // 查詢；索引未就緒時 fetchYearDocs 自動退回舊查詢＋前端過濾。
        const indFilter = singleIndicatorId ?? undefined;
        const recCached = getCachedYears<AnalysisRecord>(
          "reviewRecords",
          years,
          cacheScope,
          indFilter,
        );
        const recFresh = new Map<number, AnalysisRecord[]>();
        let fellBack = false;
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
        const rl = mergeYearDocs(recCached.hits, recFresh);
        let tl: { id: string; unitId: string; reviewerId: string }[] = [];
        let taskFetchedAt: number | null = null;
        if (scope.kind === "reviewer") {
          const taskCached = getCachedYears<{
            id: string;
            unitId: string;
            reviewerId: string;
          }>("reviewTasks", years, cacheScope);
          const taskFresh = new Map<
            number,
            { id: string; unitId: string; reviewerId: string }[]
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
              }[] = [];
              snap.docs.forEach((d) => {
                const v = d.data() as Record<string, unknown>;
                docs.push({
                  id: d.id,
                  unitId: String(v.unitId ?? ""),
                  reviewerId: String(v.reviewerId ?? ""),
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
        setSummaryRecords([]);
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
          setSummaryRecords([]);
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
  }, [appliedYearsKey, reloadNonce, scope.kind, scope.kind === "reviewer" ? scope.staffId : "", scope.kind === "staff" ? scope.unitCode : "", tab, singleIndicatorId, isNurseLeader, visibleUnitCodes]);

  /** 每次查詢皆失效所選年份，避免再次查詢命中過期快取。 */
  function handleQuery() {
    if (!rangeValid || tab === "manage") return;
    invalidateCachedYears("reviewRecords", queryYears, cacheScope);
    invalidateCachedYears("reviewTasks", queryYears, cacheScope);
    setApplied({ years: queryYears, startMonth, endMonth, interval });
    setReloadNonce((n) => n + 1);
  }
  // 範圍內紀錄（依權限範圍過濾）
  const scopedRecords = useMemo(() => {
    if (scope.kind === "admin") return records;
    if (scope.kind === "staff")
      return records.filter((r) => visibleUnitCodes.has(r.unitId));
    const unitIds = new Set(
      tasks
        .filter((t) => t.reviewerId === scope.staffId)
        .map((t) => t.unitId),
    );
    return records.filter((r) => unitIds.has(r.unitId));
  }, [records, tasks, scope, visibleUnitCodes]);

  const causeCountRows = useMemo(() => {
    const counts = new Map<string, number>();
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
  const recordIndex = useMemo(
    () => buildRecordIndex(scopedRecords),
    [scopedRecords],
  );

  const scopedUnitCodes = useMemo(() => {
    if (scope.kind === "admin") return new Set(units.map((u) => u.code));
    if (scope.kind === "staff") return visibleUnitCodes;
    return new Set(
      tasks
        .filter((t) => t.reviewerId === scope.staffId)
        .map((t) => t.unitId),
    );
  }, [units, tasks, scope, visibleUnitCodes]);

  const scopedUnits = useMemo(
    () => units.filter((u) => scopedUnitCodes.has(u.code)),
    [units, scopedUnitCodes],
  );

  const scopedGroups = useMemo(() => {
    if (scope.kind === "admin") return groups;
    const gids = new Set(scopedUnits.map((u) => u.groupId).filter(Boolean));
    const list = groups.filter((g) => gids.has(g.id));
    return list.length > 0 ? list : groups;
  }, [groups, scopedUnits, scope]);

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
    if (scopedUnits.length > 0 && !scopedUnits.some((u) => u.code === selUnit))
      setSelUnit(scopedUnits[0].code);
  }, [scopedUnits, selUnit]);

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
      scopedRecords.filter((r) => r.unitId === selUnit),
      allMonths,
    );
    const ids = [...new Set(periodRecs.map((r) => r.indicatorId))];
    return ids
      .map((id) => indOf.get(id))
      .filter((i): i is IndicatorOpt => i != null)
      .sort((a, b) => a.code.localeCompare(b.code, "zh-Hant"));
  }, [scopedRecords, selUnit, allMonths, indOf]);
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
   * v1.40.2「未審月份不顯示」：勾選時只保留該期間欄內有審查紀錄的欄位。
   * 判斷以目前查詢範圍內的審查紀錄為準（組別分析＝該組指標、單位分析＝該單位
   * 該組／指標、指標分析＝該支指標；皆限已查詢的年份區間）：該欄總審查數為 0
   * 就隱藏，≥1 就顯示。區間單位為季／半年／年時同理（該區間全部月份合計）。
   * 只影響矩陣的期間欄位顯示，不改計算公式、不改下探邏輯、不動 allMonths。
   */
  const visibleColumns = useMemo(() => {
    if (!hideEmptyMonths) return appliedColumns;
    const hasRecords = (col: AnalysisPeriodColumn): boolean => {
      if (tab === "unit") {
        return (
          columnRecordCount(
            recordIndex,
            unitIndicators.map((ind) => ind.id),
            col.months,
            selUnit,
          ) > 0
        );
      }
      if (tab === "indicator") {
        return (
          selIndicator !== "" &&
          columnRecordCount(recordIndex, [selIndicator], col.months) > 0
        );
      }
      return (
        columnRecordCount(
          recordIndex,
          groupIndicators.map((ind) => ind.id),
          col.months,
        ) > 0
      );
    };
    return appliedColumns.filter(hasRecords);
  }, [
    hideEmptyMonths,
    appliedColumns,
    recordIndex,
    tab,
    groupIndicators,
    unitIndicators,
    selIndicator,
    selUnit,
  ]);

  // 期間說明文字（modal 副標共用；顯示已生效的查詢條件）
  const periodDesc = useMemo(() => {
    const from = applied?.startMonth ?? startMonth;
    const to = applied?.endMonth ?? endMonth;
    const granularity = applied?.interval ?? interval;
    const display = (value: string) => value.replace("-", "/");
    const label =
      granularity === "month"
        ? "月"
        : granularity === "quarter"
          ? "季"
          : granularity === "halfYear"
            ? "半年"
            : "年";
    return `${display(from)} ~ ${display(to)}・單位：${label}`;
  }, [applied, startMonth, endMonth, interval]);

  /** 單格達閾值率（人次＝合併；單位＝達閾值單位數／總審查單位數） */
  function cellValue(
    indicatorId: string,
    col: AnalysisPeriodColumn,
    unitId: string | undefined,
    mode: UnitMode,
  ): CellValue {
    const ind = indOf.get(indicatorId);
    const th = ind?.threshold ?? 0;
    // A3：查表取該指標該期間欄（可再限單位）的紀錄，不再全量 filter。
    const recs = recordsForIndex(recordIndex, indicatorId, col.months, unitId);
    if (mode === "unit") {
      const ur = unitPassRate(recs, th);
      return {
        ...ur,
        title:
          ur.rate == null
            ? "無資料"
            : `達閾值 ${ur.pass}／${ur.total} 單位`,
      };
    }
    const pr = passRateOf(recs, th);
    return {
      ...pr,
      title: pr.total === 0 ? "無資料" : `達閾值 ${pr.pass}／${pr.total} 人次`,
    };
  }

  /** 曲線圖數列（只取有資料的欄；附 hover 提示文字） */
  function chartSeries(
    indicatorId: string,
    unitId: string | undefined,
    mode: UnitMode,
  ): { values: number[]; labels: string[]; tips: string[]; cols: AnalysisPeriodColumn[] } {
    const values: number[] = [];
    const labels: string[] = [];
    const tips: string[] = [];
    const cols: AnalysisPeriodColumn[] = [];
    for (const col of appliedColumns) {
      const c = cellValue(indicatorId, col, unitId, mode);
      if (c.rate != null) {
        values.push(c.rate);
        labels.push(col.label);
        tips.push(`${col.label}：${formatPassRate(c, true)}`);
        cols.push(col);
      }
    }
    return { values, labels, tips, cols };
  }

  function openChart(
    indicatorId: string,
    unitId: string | undefined,
    mode: UnitMode,
    scopeLabel: string,
  ) {
    const ind = indOf.get(indicatorId);
    if (!ind) return;
    const { values, labels, tips } = chartSeries(indicatorId, unitId, mode);
    setChartModal({
      title: `${ind.code}・${ind.name} 達閾值率曲線`,
      subtitle: `${periodDesc}・${scopeLabel}・${
        mode === "unit" ? "單位（達閾值單位數／總單位數）" : "人次（合併）"
      }`,
      values,
      labels,
      tips,
      threshold: ind.threshold > 0 ? ind.threshold : null,
    });
  }

  /** 下探 L1：開啟單位矩陣（只有點選的那一個期間欄） */
  function openDrill(
    indicatorId: string,
    col: AnalysisPeriodColumn,
    mode: UnitMode,
    scopeUnitId?: string,
  ) {
    if (isNurseLeader) return;
    if (summaryRecords.length > 0 && records.length === 0) {
      if (!applied || loading) return;
      setLoading(true);
      void (async () => {
        try {
          const db = getFirebaseDb();
          const snaps = await Promise.all(
            applied.years.map((year) =>
              fetchYearDocs(
                dbIndexedQueryApi,
                collection(db, "reviewRecords"),
                { indicatorId, year },
              ),
            ),
          );
          const details: AnalysisRecord[] = [];
          for (const snap of snaps) {
            snap.docs.forEach((recordDoc) => {
              const value = recordDoc.data() as Record<string, unknown>;
              const answers = Array.isArray(value.answers)
                ? value.answers.map((raw) => {
                    const answer = (raw ?? {}) as Record<string, unknown>;
                    return {
                      questionId: String(answer.questionId ?? ""),
                      itemText: String(answer.itemText ?? ""),
                      optionLabel: String(answer.optionLabel ?? ""),
                      score: typeof answer.score === "number" ? answer.score : 0,
                      excluded: answer.excluded === true,
                      commonErrors: Array.isArray(answer.commonErrors)
                        ? answer.commonErrors.filter((word): word is string => typeof word === "string")
                        : [],
                      note: typeof answer.note === "string" ? answer.note : "",
                    };
                  })
                : [];
              details.push({
                indicatorId: String(value.indicatorId ?? indicatorId),
                unitId: String(value.unitId ?? ""),
                year: Number(value.year ?? 0),
                month: Number(value.month ?? 0),
                rate: typeof value.rate === "number" ? value.rate : null,
                thresholdAtSchedule:
                  typeof value.thresholdAtSchedule === "number" ? value.thresholdAtSchedule : undefined,
                indicatorVersion:
                  typeof value.indicatorVersionAtSchedule === "string"
                    ? value.indicatorVersionAtSchedule
                    : undefined,
                answers,
                personEmpNo: String(value.reviewedPersonEmpNo ?? ""),
                personName: String(value.reviewedPersonName ?? ""),
                bedNo: typeof value.bedNo === "string" ? value.bedNo : "",
              });
            });
          }
          if (details.length === 0) {
            onAction("此摘要尚無可下探的原始審查明細");
            return;
          }
          setRecords(details);
          setDrill({ indicatorId, column: col, mode, scopeUnitId, l2UnitId: null });
          onAction(`已載入 ${details.length} 筆原始審查明細`);
        } catch {
          onAction("讀取審查明細失敗，請稍後重試");
        } finally {
          setLoading(false);
        }
      })();
      return;
    }
    const cell = cellValue(indicatorId, col, scopeUnitId, mode);
    if (cell.rate == null) return;
    setDrill({ indicatorId, column: col, mode, scopeUnitId, l2UnitId: null });
  }

  function openDoc(
    indicatorId: string,
    unitId: string | undefined,
    scopeLabel: string,
  ) {
    const ind = indOf.get(indicatorId);
    if (!ind) return;
    // A3：查表取該指標全部期間的紀錄（可再限單位）。
    const recs = recordsForIndex(recordIndex, indicatorId, allMonths, unitId);
    setDocModal({
      title: `${ind.code}・${ind.name} 各選項得分狀況`,
      subtitle: `${periodDesc}・${scopeLabel}・共 ${recs.length} 人次`,
      rows: optionDetailRows(recs, ind.questions),
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
  const indSummary = useMemo(() => {
    if (!indSel) return null;
    if (summaryRecords.length > 0) {
      const metrics = summaryRecords.filter((row) =>
        scope.kind === "admin" || isNurseLeader ? row.scope === "all" : row.scope === "unit",
      );
      const unitRows = summaryRecords.filter(
        (row) => row.scope === "unit" && row.totalCount > 0 &&
          (scope.kind === "admin" || !isNurseLeader || (row.unitId != null && visibleUnitCodes.has(row.unitId))),
      );
      const unitPeriodRows = unitRows;
      const unitPassed = unitPeriodRows.filter((row) =>
        row.totalCount > 0 && (row.passedCount / row.totalCount) * 100 >= row.threshold,
      ).length;
      const unitPr: PassRate = {
        pass: unitPassed,
        total: unitPeriodRows.length,
        rate: unitPeriodRows.length ? round1((unitPassed / unitPeriodRows.length) * 100) : null,
      };
      const personPr = summaryPassRate(metrics);
      // v1.36.0（D12）：護理長同時看「本單位」與「全院彙總」比較——本單位來自 unit-scope 摘要，
      // 全院來自 scope==="all" 預存彙總；兩者皆為彙總數，不含其他單位個別結果與個人細項。
      const ownPersonPr = summaryPassRate(unitRows);
      const ownTotal = unitRows.reduce((sum, row) => sum + row.totalCount, 0);
      const hospitalPersonPr =
        scope.kind === "admin" || isNurseLeader ? personPr : null;
      const perColumn = appliedColumns.map((column) => {
        const keys = new Set(column.months.map((month) => month.year * 100 + month.month));
        if (indUnit === "unit") {
          const periodUnits = unitRows.filter((row) => keys.has(row.scheduleStartKey));
          const pass = periodUnits.filter((row) =>
            row.totalCount > 0 && (row.passedCount / row.totalCount) * 100 >= row.threshold,
          ).length;
          return { column, pr: { pass, total: periodUnits.length, rate: periodUnits.length ? round1((pass / periodUnits.length) * 100) : null } as PassRate };
        }
        return { column, pr: summaryPassRate(metrics.filter((row) => keys.has(row.scheduleStartKey))) };
      });
      const pts = perColumn.filter(
        (point): point is { column: AnalysisPeriodColumn; pr: PassRate & { rate: number } } => point.pr.rate != null,
      );
      return {
        unitCount: new Set(unitRows.map((row) => row.unitId).filter((id): id is string => Boolean(id))).size,
        total: personPr.total, unitPr, personPr,
        ownPersonPr, ownTotal, hospitalPersonPr,
        chartValues: pts.map((point) => point.pr.rate),
        chartLabels: pts.map((point) => point.column.label),
        chartTips: pts.map((point) => `${point.column.label}：${formatPassRate(point.pr, true)}`),
        chartCols: pts.map((point) => point.column),
        optionRows: summaryOptionRows(metrics),
      };
    }
    const th = indSel.threshold;
    const unitIds = new Set(indRecs.map((record) => record.unitId));
    const unitPr = unitPeriodPassRate(indRecs, appliedColumns, th);
    const merged = passRateOf(indRecs, th);
    const perColumn =
      indUnit === "unit"
        ? appliedColumns.map((column) => ({ column, pr: unitPassRate(recordsInMonths(indRecs, column.months), th) }))
        : appliedColumns.map((column) => ({ column, pr: passRateOf(recordsInMonths(indRecs, column.months), th) }));
    const pts = perColumn.filter(
      (point): point is { column: AnalysisPeriodColumn; pr: PassRate } & { pr: { rate: number } } => point.pr.rate != null,
    );
    return {
      unitCount: unitIds.size, total: indRecs.length, unitPr, personPr: merged,
      // 無預存摘要時無法算全院彙總（明細只含本人單位），全院比較留空並由畫面註明。
      ownPersonPr: merged, ownTotal: indRecs.length, hospitalPersonPr: null,
      chartValues: pts.map((point) => point.pr.rate as number),
      chartLabels: pts.map((point) => point.column.label),
      chartTips: pts.map((point) => `${point.column.label}：${formatPassRate(point.pr, true)}`),
      chartCols: pts.map((point) => point.column),
      optionRows: optionDetailRows(indRecs, indSel.questions),
    };
  }, [indRecs, indSel, indUnit, appliedColumns, summaryRecords, scope.kind, isNurseLeader, visibleUnitCodes]);

  const errorSummarySource = summaryRecords.length > 0
    ? summaryRecords.filter((row) => {
        if (errorUnit !== "all") return row.scope === "unit" && row.unitId === errorUnit;
        return scope.kind === "admin" || isNurseLeader ? row.scope === "all" : row.scope === "unit";
      })
    : [];
  const thresholdLabels = [...new Map(
    summaryRecords
      .filter((row) => scope.kind === "admin" || isNurseLeader ? row.scope === "all" : row.scope === "unit")
      .map((row) => [
        `${row.scheduleStartKey}-${row.indicatorVersion}-${row.threshold}`,
        `${row.scheduleStartYear}-${String(row.scheduleStartMonth).padStart(2, "0")} ${row.indicatorVersion} 閾值 ${row.threshold}%`,
      ]),
  ).values()].sort((a, b) => a.localeCompare(b, "zh-Hant"));
  const errorAnalysisRows = summaryRecords.length > 0
    ? questionErrorRowsFromSummaries(errorSummarySource)
    : questionErrorRows(
        errorUnit === "all"
          ? indRecs
          : indRecs.filter((record) => record.unitId === errorUnit),
      );

  /**
   * 指標分析補充說明（v1.41.1）：取即時明細（indRecs）中有備註的作答；
   * 預存摘要模式無原始明細時為空，整區不顯示。只收有備註者。
   */
  const indNotes = useMemo(() => {
    if (!indSel) return [];
    const source =
      errorUnit === "all"
        ? indRecs
        : indRecs.filter((record) => record.unitId === errorUnit);
    return collectRecordNotes(source, indSel.questions);
  }, [indRecs, indSel, errorUnit]);
  return (
    <div className="results-page">
      <PageHeading page="results" />

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
        <div className="results-filters results-analysis-filters">
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
                options={scopedUnits.map((unit) => ({
                  value: unit.code,
                  label: `${unit.code}・${unit.name}`,
                }))}
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
            onChange={(value) => setInterval(value as AnalysisGranularity)}
            options={[
              { value: "month", label: "月" },
              { value: "quarter", label: "季" },
              { value: "halfYear", label: "半年" },
              { value: "year", label: "年" },
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
              查詢
            </button>
          </div>
          {!rangeValid && (
            <span className="results-range-error" role="alert">
              起始年月不可晚於結束年月。
            </span>
          )}
        </div>
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
          {new Date(fetchedAt).toLocaleString("zh-Hant-TW", {
            hour12: false,
          })}
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

      {tab !== "import" && tab !== "manage" && applied && !loading && causeCountRows.length > 0 && (
        <section className="panel results-cause-summary">
          <SectionTitle title="原因詞庫件數" note="依目前使用者可見資料及已查詢期間統計；只計入題目原因詞庫中已勾選的項目。" />
          <div className="table-scroll"><table className="data-table"><thead><tr><th>原因詞庫項目</th><th>勾選件數</th></tr></thead><tbody>{causeCountRows.map((row) => <tr key={row.cause}><td>{row.cause}</td><td>{row.count}</td></tr>)}</tbody></table></div>
        </section>
      )}

      {tab === "group" && (
        <>
          {!applied ? (
            <EmptyState
              title="尚未查詢"
              description="請先選擇期間，再按「查詢」開始分析。只想匯入結果，可直接切換至「結果匯入」頁籤，不需查詢。"
            />
          ) : loading ? (
            <EmptyState title="載入中" description="正在讀取審查紀錄…" />
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
                rows={groupIndicators.map((i) => ({
                  id: i.id,
                  label: `${i.code}・${i.name}`,
                }))}
                columns={visibleColumns}
                cellOf={(id, col) =>
                  cellValue(id, col, undefined, groupUnit)
                }
                onCell={(id, col) => openDrill(id, col, groupUnit)}
                onChart={(id) =>
                  openChart(id, undefined, groupUnit, "全部單位")
                }
                onDoc={(id) => openDoc(id, undefined, "全部單位")}
              />
            </section>
          )}
        </>
      )}

      {tab === "unit" && (
        <>
          {!applied ? (
            <EmptyState
              title="尚未查詢"
              description="請先選擇期間，再按「查詢」開始分析。只想匯入結果，可直接切換至「結果匯入」頁籤，不需查詢。"
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
                note={`${periodDesc}・單元：人次`}
              />
              <RateMatrix
                rows={unitIndicators.map((i) => ({
                  id: i.id,
                  label: `${i.code}・${i.name}`,
                }))}
                columns={visibleColumns}
                cellOf={(id, col) =>
                  cellValue(id, col, selUnit, "person")
                }
                onCell={(id, col) =>
                  openDrill(id, col, "person", selUnit)
                }
                onChart={(id) =>
                  setUnitPanel((p) =>
                    p?.kind === "chart" && p.indicatorId === id
                      ? null
                      : { kind: "chart", indicatorId: id },
                  )
                }
                onDoc={(id) =>
                  setUnitPanel((p) =>
                    p?.kind === "doc" && p.indicatorId === id
                      ? null
                      : { kind: "doc", indicatorId: id },
                  )
                }
              />
              {unitPanel &&
                (() => {
                  const ind = indOf.get(unitPanel.indicatorId);
                  if (!ind) return null;
                  if (unitPanel.kind === "chart") {
                    const s = chartSeries(
                      ind.id,
                      selUnit,
                      "person",
                    );
                    return (
                      <UnitBelowPanel
                        title={`${ind.code}・${ind.name} 達閾值率曲線`}
                        subtitle={`${periodDesc}・單位：${selUnit}・人次（合併）`}
                        onClose={() => setUnitPanel(null)}
                      >
                        {s.values.length === 0 ? (
                          <div className="chart-empty">尚無資料</div>
                        ) : (
                          <TrendChart
                            values={s.values}
                            labels={s.labels}
                            tooltips={s.tips}
                            threshold={
                              ind.threshold > 0 ? ind.threshold : null
                            }
                            legend="達閾值率"
                            currentLabel={s.labels[s.labels.length - 1]}
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
                    selUnit,
                  );
                  return (
                    <UnitBelowPanel
                      title={`${ind.code}・${ind.name} 各選項得分狀況`}
                      subtitle={`${periodDesc}・單位：${selUnit}・共 ${recs.length} 人次`}
                      onClose={() => setUnitPanel(null)}
                    >
                      <OptionDetailTable
                        rows={optionDetailRows(recs, ind.questions)}
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
              title="尚未查詢"
              description="請先選擇期間，再按「查詢」開始分析。只想匯入結果，可直接切換至「結果匯入」頁籤，不需查詢。"
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
                />
                {isNurseLeader ? (
                  <>
                    <SummaryCell
                      label="本單位受審人次"
                      value={String(indSummary.ownTotal)}
                      note="所選期間內本單位總人次數"
                    />
                    <SummaryCell
                      label="單位正確率"
                      value={formatPassRate(indSummary.unitPr, true)}
                      note="達閾值單位數／審查單位數（unit-period 計）"
                    />
                    <SummaryCell
                      label="本單位人員正確率"
                      value={formatPassRate(indSummary.ownPersonPr, true)}
                      note="本單位達閾值人次／本單位總人次"
                    />
                    <SummaryCell
                      label="全院人員正確率"
                      value={indSummary.hospitalPersonPr ? formatPassRate(indSummary.hospitalPersonPr, true) : "—"}
                      note={indSummary.hospitalPersonPr
                        ? `同一指標、同一區間全院彙總比較（全院共 ${indSummary.hospitalPersonPr.total} 人次）；不含其他單位個別結果與個人細項`
                        : "此期間尚無全院預存摘要，無法提供全院彙總"}
                    />
                  </>
                ) : (
                  <>
                    <SummaryCell
                      label="受審總人次"
                      value={String(indSummary.total)}
                      note="所選期間內總人次數"
                    />
                    <SummaryCell
                      label="單位正確率"
                      value={formatPassRate(indSummary.unitPr, true)}
                      note="達閾值單位數／審查單位數（unit-period 計）"
                    />
                    <SummaryCell
                      label="人員正確率"
                      value={formatPassRate(indSummary.personPr, true)}
                      note="達閾值人次／總人次"
                    />
                  </>
                )}
              </div>
              {summaryRecords.length > 0 && (
                <p className="settings-note" role="status">
                  {isNurseLeader ? "全院指標結果使用預存彙總，不提供其他單位或個人明細下探。" : "已使用預存摘要；逐筆下探時才讀取原始紀錄。"}排程快照閾值：{thresholdLabels.join("；")}。錯題排行依完全相同題目文字跨版本彙總，僅作排行、不代表版本等價或趨勢合併。
                </p>
              )}
              {summaryRecords.length === 0 && indRecs.length > 0 && (
                <p className="settings-note" role="status">
                  {isNurseLeader ? "此期間尚無全院預存摘要；目前僅顯示本單位資料，無法提供全院彙總。" : "此期間尚無預存摘要，暫以審查明細計算；明細中的閾值快照優先於指標現行閾值。"}
                </p>
              )}
              <section className="panel">
                <SectionTitle
                  title="通過率"
                  note={`${indSel.code}・${indSel.name}・${periodDesc}・單元：${indUnit === "unit" ? "單位（達閾值單位數／總單位數）" : "人次（合併）"}${isNurseLeader && indUnit !== "unit" && summaryRecords.length > 0 ? "・人次曲線為全院彙總比較（不含其他單位個別結果）" : ""}`}
                />
                {indSummary.chartValues.length === 0 ? (
                  <div className="chart-empty">尚無資料</div>
                ) : (
                  <TrendChart
                    values={indSummary.chartValues}
                    labels={indSummary.chartLabels}
                    tooltips={indSummary.chartTips}
                    threshold={summaryRecords.length > 0 ? null : indSel.threshold > 0 ? indSel.threshold : null}
                    legend="正確率"
                    currentLabel={
                      indSummary.chartLabels[indSummary.chartLabels.length - 1]
                    }
                    onPointClick={isNurseLeader ? undefined : (i) =>
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
                <OptionDetailTable rows={indSummary.optionRows} />
              </section>
              <section className="panel">
                <SectionTitle
                  title="指標錯誤分析・題目排行"
                  note={`${indSel.code}・${indSel.name}・${periodDesc}・${errorUnit === "all" ? "全部單位" : `單位 ${errorUnit}`}；「否」為錯誤，「不適用」不列入錯誤率分母`}
                />
                <QuestionErrorTable rows={errorAnalysisRows} />
              </section>
              {indNotes.length > 0 && (
                <section className="panel">
                  <SectionTitle
                    title="補充說明"
                    note={`${indSel.code}・${indSel.name}・${periodDesc}・審查員備註未通過原因；只列有填寫備註的題目。`}
                  />
                  <div className="analysis-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>被審人員</th>
                          <th>題目</th>
                          <th>結果</th>
                          <th>補充說明</th>
                        </tr>
                      </thead>
                      <tbody>
                        {indNotes.map((entry, i) => (
                          <tr
                            key={`${entry.personEmpNo}-${entry.year}-${entry.month}-${entry.questionId}-${i}`}
                          >
                            <td>
                              {staffLabel(entry.personEmpNo, entry.personName)}
                            </td>
                            <td>{entry.itemText}</td>
                            <td>{entry.optionLabel || "—"}</td>
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
          user={user ? { staffId: user.staffId, name: user.name } : null}
          onAction={onAction}
          onDone={(years) => {
            // 尚未查詢：不觸發重拉，否則匯入完又把整年紀錄拉回來、閘門白做。
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
                threshold={chartModal.threshold}
                legend="達閾值率"
                currentLabel={
                  chartModal.labels[chartModal.labels.length - 1]
                }
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
            <OptionDetailTable rows={docModal.rows} />
          </div>
        </div>
      )}

      {drill && (
        <DrillModal
          drill={drill}
          onClose={() => setDrill(null)}
          onBackToL1={() => setDrill({ ...drill, l2UnitId: null })}
          onSelectUnit={(unitId) => setDrill({ ...drill, l2UnitId: unitId })}
          recordIndex={recordIndex}
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

/** 顯示「職編/遮罩姓名」（半形斜線；v1.40.2）。姓名缺值或與職編相同（舊資料以職編代姓名）時只顯示職編，兩者皆無顯示 —。 */
function staffLabel(empNo: string, name: string): string {
  const masked = name && name !== empNo ? maskName(name) : "";
  if (empNo && masked) return `${empNo}/${masked}`;
  return empNo || masked || "—";
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
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
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
    units.find((unit) => unit.code === id)?.name ?? id;
  const indicatorName = (id: string) =>
    indicators.find((indicator) => indicator.id === id)?.name ?? id;

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
          const yearMonth = `${year}-${String(month).padStart(2, "0")}`;
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
        `查詢失敗：${queryError instanceof Error ? queryError.message : String(queryError)}`,
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
          detail: `篩選條件：單位 ${criteria.unitId ?? "全部"}；組別 ${criteria.groupId ?? "全部"}；指標 ${criteria.indicatorId ?? "全部"}；文件 ID：${chunk.join(", ")}`,
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
      const message = `刪除部分失敗：已成功刪除 ${removed.length} 筆，尚有 ${ids.length - removed.length} 筆未完成。${deleteError instanceof Error ? deleteError.message : String(deleteError)}`;
      setError(message);
      onAction(message);
    } finally {
      setBusy(false);
    }
  };
  const allSelected = rows.length > 0 && rows.every((row) => selected.includes(row.id));

  return (
    <section className="review-results-manager">
      <div className="results-filters">
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
        <div className="results-query-actions">
          <button
            className="button button-primary"
            type="button"
            disabled={busy || start > end}
            onClick={queryResults}
          >
            查詢
          </button>
        </div>
      </div>
      {error && (
        <p className="results-range-error" role="alert">
          {error}
        </p>
      )}
      {queried && (
        <div className="panel">
          <div className="review-results-actions">
            <strong>
              查得 {rows.length} 筆{selected.length > 0 && `・已選 ${selected.length} 筆`}
            </strong>
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
          </div>
          <div className="analysis-table-wrap">
            <table className="review-results-table">
              <thead>
                <tr>
                  <th>選取</th>
                  <th>結果日期</th>
                  <th>單位</th>
                  <th>指標</th>
                  <th>審查人員</th>
                  <th>被審人員</th>
                  <th>正確率</th>
                  <th>提交時間</th>
                  <th>明細</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const noted = row.answers.filter(
                    (a) => a.note.trim() !== "" || a.commonErrors.length > 0,
                  );
                  const expanded = expandedId === row.id;
                  return (
                    <Fragment key={row.id}>
                      <tr>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`選取 ${row.year}/${String(row.month).padStart(2, "0")} ${indicatorName(row.indicatorId)} ${row.reviewedPersonName || "審查結果"}`}
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
                          {row.year}/{String(row.month).padStart(2, "0")}
                        </td>
                        <td>{unitName(row.unitId)}</td>
                        <td>{indicatorName(row.indicatorId)}</td>
                        <td>{staffLabel(row.reviewerEmpNo, row.reviewerName)}</td>
                        <td>{row.reviewedPersonName || "—"}</td>
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
                                  <th>補充說明</th>
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
                                    <td className="supp-note-cell">
                                      {a.note.trim() || "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {!queried && (
        <EmptyState
          title="尚未查詢"
          description="設定篩選條件後按「查詢」讀取審查結果。"
        />
      )}
    </section>
  );
}

function formatSubmittedAt(value: unknown): string {
  if (!value || typeof value !== "object") return "—";
  const timestamp = value as { toDate?: () => Date; seconds?: number };
  const date =
    typeof timestamp.toDate === "function"
      ? timestamp.toDate()
      : typeof timestamp.seconds === "number"
        ? new Date(timestamp.seconds * 1000)
        : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleString("zh-Hant-TW", { hour12: false })
    : "—";
}

/* ================= 達閾值率矩陣（組別／單位分析共用） ================= */

function RateMatrix({
  rows,
  columns,
  cellOf,
  onCell,
  onChart,
  onDoc,
}: {
  rows: { id: string; label: string }[];
  columns: AnalysisPeriodColumn[];
  cellOf: (rowId: string, col: AnalysisPeriodColumn) => CellValue;
  onCell?: (rowId: string, col: AnalysisPeriodColumn) => void;
  onChart: (rowId: string) => void;
  onDoc: (rowId: string) => void;
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
          {rows.map((row) => (
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
              {columns.map((c) => {
                const cell = cellOf(row.id, c);
                const clickable = cell.rate != null && onCell != null;
                return (
                  <td
                    key={c.key}
                    className={`rate-cell${clickable ? " clickable" : ""}`}
                    title={clickable ? `${cell.title}（點選下探）` : cell.title}
                    onClick={
                      clickable ? () => onCell(row.id, c) : undefined
                    }
                    role={clickable ? "button" : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onKeyDown={
                      clickable
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onCell(row.id, c);
                            }
                          }
                        : undefined
                    }
                  >
                    {fmtCell(cell)}
                  </td>
                );
              })}
            </tr>
          ))}
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

/* ================= 下探：L1 單位矩陣 → L2 人員各選項結果 ================= */

function DrillModal({
  drill,
  onClose,
  onBackToL1,
  onSelectUnit,
  recordIndex,
  indOf,
  unitNameOf,
}: {
  drill: DrillState;
  onClose: () => void;
  onBackToL1: () => void;
  onSelectUnit: (unitId: string) => void;
  recordIndex: RecordIndex;
  indOf: Map<string, IndicatorOpt>;
  unitNameOf: Map<string, string>;
}) {
  const ind = indOf.get(drill.indicatorId);
  const th = ind?.threshold ?? 0;
  const col = drill.column;
  // L1 列：分母單元的單位（該指標該期間欄內有審查紀錄的單位）
  const l1Units = useMemo(() => {
    // A3：查表取該指標該期間欄的紀錄（可再限單位）。
    const recs = recordsForIndex(
      recordIndex,
      drill.indicatorId,
      col.months,
      drill.scopeUnitId,
    );
    return unitsForDrill(recs, col.months);
  }, [recordIndex, drill.indicatorId, drill.scopeUnitId, col]);
  const l1Cells = useMemo(() => {
    const map = new Map<string, CellValue>();
    for (const unitId of l1Units) {
      const recs = recordsForIndex(
        recordIndex,
        drill.indicatorId,
        col.months,
        unitId,
      );
      const pr = passRateOf(recs, th);
      map.set(unitId, {
        ...pr,
        title: pr.total === 0 ? "無資料" : `達閾值 ${pr.pass}／${pr.total} 人次`,
      });
    }
    return map;
  }, [recordIndex, drill.indicatorId, l1Units, col, th]);
  // L2 列：該單位該期間被審人員在各選項的審查結果
  const l2Rows = useMemo(() => {
    if (!drill.l2UnitId) return [];
    const recs = recordsForIndex(
      recordIndex,
      drill.indicatorId,
      col.months,
      drill.l2UnitId,
    );
    return personOptionRows(recs, th);
  }, [recordIndex, drill.indicatorId, drill.l2UnitId, col, th]);
  // L2 轉置（v1.27.1）：直向＝題目、橫向＝人員（職編/遮罩姓名，v1.40.2），中間＝審查結果
  const l2Matrix = useMemo(
    () =>
      ind
        ? transposePersonOptionRows(l2Rows, ind.questions)
        : { headers: [] as string[], bedNos: [] as string[], rows: [], rates: [] },
    [l2Rows, ind],
  );

  // L2 補充說明（v1.41.1）：每欄＝一筆紀錄，依欄位順序分組，只列有備註的題目。
  const l2NoteGroups = useMemo(() => {
    if (!drill.l2UnitId || !ind) return [];
    return l2Rows
      .map((row, i) => {
        const items = ind.questions
          .map((q, qi) => {
            const note = row.notes.get(q.id) ?? "";
            if (!note.trim()) return null;
            return {
              questionId: q.id,
              num: qi + 1,
              itemText: q.itemText,
              optionLabel: row.answers.get(q.id) ?? "—",
              note: note.trim(),
            };
          })
          .filter((x): x is NonNullable<typeof x> => x != null);
        if (items.length === 0) return null;
        return {
          key: `${row.personEmpNo}-${row.year}-${row.month}-${i}`,
          label: l2Matrix.headers[i] ?? row.personEmpNo,
          monthLabel: `${row.year}/${String(row.month).padStart(2, "0")}`,
          bedNo: row.bedNo,
          items,
        };
      })
      .filter((g): g is NonNullable<typeof g> => g != null);
  }, [l2Rows, ind, drill.l2UnitId, l2Matrix]);

  if (!ind) return null;
  const title = `${ind.code}・${ind.name}`;
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
              {drill.l2UnitId
                ? `${col.label}・${drill.l2UnitId}・${unitNameOf.get(drill.l2UnitId) ?? ""}・被審人員各選項結果`
                : `${col.label}・各單位審查結果（點選格子看被審人員）`}
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
        {drill.l2UnitId == null ? (
          <div className="analysis-table-wrap">
            <table className="data-table analysis-matrix">
              <thead>
                <tr>
                  <th className="ind-col">單位</th>
                  <th className="rate-col">{col.label}</th>
                </tr>
              </thead>
              <tbody>
                {l1Units.length === 0 ? (
                  <tr>
                    <td colSpan={2}>無資料</td>
                  </tr>
                ) : (
                  l1Units.map((unitId) => {
                    const cell = l1Cells.get(unitId);
                    const clickable = cell != null && cell.rate != null;
                    return (
                      <tr key={unitId}>
                        <td className="ind-col">
                          {unitId}・{unitNameOf.get(unitId) ?? ""}
                        </td>
                        <td
                          className={`rate-cell${clickable ? " clickable" : ""}`}
                          title={
                            clickable
                              ? `${cell.title}（點選看被審人員）`
                              : (cell?.title ?? "無資料")
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
                          {cell ? fmtCell(cell) : "—"}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
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
              <EmptyState title="無資料" description="該單位該期間尚無審查紀錄。" />
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
                    note="審查員備註未通過原因；只列有填寫備註的題目。"
                  />
                  {l2NoteGroups.map((g) => (
                    <div key={g.key} className="supp-notes-group">
                      <p className="supp-notes-person">
                        {g.label}・{g.monthLabel}
                        {g.bedNo ? `・床號 ${g.bedNo}` : ""}
                      </p>
                      <ul className="supp-notes-list">
                        {g.items.map((it) => (
                          <li key={it.questionId}>
                            <span className="supp-notes-q">
                              {it.num}. {it.itemText}（{it.optionLabel}）
                            </span>
                            <span className="supp-note-text">{it.note}</span>
                          </li>
                        ))}
                      </ul>
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

function OptionDetailTable({ rows }: { rows: OptionDetailRow[] }) {
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
            {rows.map((r, i) => (
              <tr key={`${r.indicatorVersion ?? ""}-${r.questionId}-${i}`}>
                {hasVersions && <td>{r.indicatorVersion}</td>}
                <td>
                  {i + 1}. {r.itemText}
                </td>
                <td>{cell(r.yes, r.yesRate)}</td>
                <td>{cell(r.no, r.noRate)}</td>
                <td>{cell(r.na, r.naRate)}</td>
                <td>{fmtRate(r.scoreRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function QuestionErrorTable({ rows }: { rows: QuestionErrorRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="尚無錯題資料" description="所選期間與單位沒有可分析的題目作答。" />;
  }
  const errorTotal = rows.reduce((sum, row) => sum + row.no, 0);
  return (
    <>
      <p className="settings-note">
        所選期間共計 {errorTotal} 次「否」作答；排行依錯題次數由多至少。不同版本分列，舊資料未保存版本時標示「版本未記錄」。
      </p>
      <div className="analysis-table-wrap">
        <table className="data-table">
          <thead><tr><th>排名</th><th>版本</th><th>題目</th><th>錯題數（否）</th><th>有效作答數</th><th>錯誤率</th><th>不適用數</th></tr></thead>
          <tbody>{rows.map((row, index) => (
            <tr key={`${row.indicatorVersion}-${row.questionId}-${row.itemText}`}>
              <td>{index + 1}</td><td>{row.indicatorVersion}</td><td>{row.itemText}</td>
              <td>{row.no}</td><td>{row.validCount}</td>
              <td>{row.errorRate == null ? "—" : `${row.errorRate.toFixed(1)}%`}</td>
              <td>{row.notApplicable}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </>
  );
}

/* ================= 品管審查結果匯入（v1.21.0 邏輯原樣搬入頁籤） ================= */

/**
 * 各指標審查結果匯入：選組別→選指標（只列啟用）→選檔匯入。
 * 範本依所選指標審查表題目即時產生（前 6 欄固定＋每題一欄）。
 * 預檢：指標代號與題數不符即整檔中止；逐列未填忽略、非法值該列跳過。
 * 每列寫一筆 reviewRecord（source="import"，不自動建 reviewTasks），
 * 計入審核進度（unitId／year／month 參與進度計算）。
 */
function ResultImportPanel({
  indicators,
  user,
  onAction,
  onDone,
}: {
  indicators: IndicatorOpt[];
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
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const db = getFirebaseDb();
        const [gSnap, uSnap, sSnap] = await Promise.all([
          getCachedRefCollection("groups", () =>
            getDocsCacheFirst(collection(db, "groups")),
          ),
          getCachedRefCollection("units", () =>
            getDocsCacheFirst(collection(db, "units")),
          ),
          getCachedRefCollection("users", () =>
            getDocsFromServer(collection(db, "users")),
          ),
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

  const enabledByGroup = useMemo(
    () =>
      indicators.filter(
        (i) => i.status === "啟用" && (!selGroup || i.groupId === selGroup),
      ),
    [indicators, selGroup],
  );
  const selInd = indicators.find((i) => i.id === selIndicatorId) ?? null;

  function handleGroupChange(groupId: string) {
    setSelGroup(groupId);
    setSelIndicatorId("");
    setSummary(null);
    setErrors([]);
  }

  function handleIndicatorChange(id: string) {
    setSelIndicatorId(id);
    setSummary(null);
    setErrors([]);
  }

  function downloadCurrentTemplate() {
    if (!selInd) return;
    // v1.28 階段 5：downloadTemplate 為 async；xlsx 元件載入失敗時退回 CSV，提示使用者
    void downloadTemplate(
      resultTemplateRows(
        selInd.code,
        selInd.questions.map((q) => q.itemText),
      ),
      "審查結果",
      `${selInd.code}_審查結果範本`,
    ).then((fmt) => {
      if (fmt === "csv") onAction("Excel 元件載入失敗，已改下載 CSV 範本");
    });
  }

  async function handleImport(file: File) {
    if (!selInd || !user) return;
    setSummary(null);
    setErrors([]);
    setBusy(true);
    try {
      const sheet = await readSheetFile(file);
      const { headerErrors, data } = parseResultSheet(sheet);
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
      });
      if (fileErrors.length > 0) {
        setErrors(fileErrors);
        onAction("審查結果匯入中止：預檢不符（指標代號或題數）");
        return;
      }
      const ok = rows.filter((r) => r.ok && r.values);
      const bad = rows.filter((r) => !r.ok);
      if (ok.length > 0) {
        const db = getFirebaseDb();
        const batch = writeBatch(db);
        const today = new Date().toISOString().slice(0, 10);
        for (const r of ok) {
          const v = r.values!;
          const answers = selInd.questions.map((q, i) => {
            const label = v.answers[i] ?? "";
            const excluded = label === "不適用" || label === "";
            return {
              questionId: q.id,
              itemText: q.itemText,
              optionLabel: label,
              score: label === "是" ? 1 : 0,
              excluded,
            };
          });
          const { totalScore, maxScore, rate } = computeOptionSetScore(
            answers.map((a) => ({ score: a.score, excluded: a.excluded })),
          );
          const ref = doc(collection(db, "reviewRecords"));
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
            answers,
            totalScore,
            maxScore,
            rate,
            submittedAt: serverTimestamp(),
            submittedBy: user.staffId,
            source: "import",
          });
        }
        await batch.commit();
        logAudit(db, {
          actor: user.staffId,
          actorName: user.name,
          action: "匯入品管審查結果",
          targetType: "indicator",
          targetId: selInd.id,
          detail: `${selInd.code}：匯入 ${ok.length} 筆、跳過 ${bad.length} 列`,
        });
      }
      setErrors(
        bad.map((r) => `第 ${r.lineNo} 列：${r.errors.join("；")}`),
      );
      const msg = `審查結果匯入：成功 ${ok.length} 筆、跳過 ${bad.length} 列`;
      setSummary(msg);
      onAction(msg);
      if (ok.length > 0)
        onDone([...new Set(ok.map((r) => r.values!.year))]);
    } catch (error) {
      setErrors([
        `讀取檔案失敗：${error instanceof Error ? error.message : "讀寫失敗"}`,
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <SectionTitle
        title="匯入品管審查結果"
        note="先選組別與指標（只列啟用），再選 Excel／CSV 檔匯入。預檢不符（指標代號或題數）即整檔中止；逐列未填忽略、非法值該列跳過。匯入的紀錄計入審核進度，不自動建立審查任務。"
      />
      <div className="form-stack">
        <div className="form-field">
          <label className="field-label">組別</label>
          <div className="select-wrap">
            <select
              value={selGroup}
              onChange={(e) => handleGroupChange(e.target.value)}
            >
              <option value="">全部組別</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <ChevronDown size={15} />
          </div>
        </div>
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
