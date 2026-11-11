/**
 * 結果分析頁（v1.25.0：取代舊畫面；v1.44.0：分組計分改 1A／2B 口徑，不再讀預存摘要）。
 * 四個分析／匯入頁籤；系統管理員另可使用審查結果管理。
 * 期間模型：年別／年份（起算年）／年數（往後數）／區間（月／季／年）／子選項
 * （月→只有全部；季→第一～四季／全部；年→半年／一年／全部），矩陣欄＝期間欄。
 * 達閾值＝紀錄 rate ≥ 指標閾值（逐筆優先用排程快照 thresholdAtSchedule，
 * 匯入紀錄無快照才用現行指標閾值）；人次率＝合併計算，單位彙總率＝各單位率平均。
 * 分組／逐題明細只在指標「啟用分組計分」開啟時顯示；人次模式分子分母與主格
 * 同口徑（分組達標人次／總人次），單位模式維持彙總作答率判定；一律讀原始
 * reviewRecords 即時算，不讀 reviewSummaries。
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
  getDoc,
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
  collectConsolidatedRecordNotes,
  optionDetailRows,
  questionErrorRows,
  passRateOf,
  personScoringBreakdownRows,
  personOptionRows,
  recordsInMonths,
  transposePersonOptionRows,
  unitPassRate,
  unitPeriodPassRate,
  unitScoringBreakdownRows,
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
  /** 指標設定頁「啟用分組計分」開關；關閉時結果分析不顯示任何分組／逐題明細列 */
  groupScoring: boolean;
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
  /** 指標／組別／單位參考資料是否已載入完成（v1.43.1：匯入面板據此決定是否顯示指標下拉為空的診斷提示，載入中不顯示、避免閃爍）。 */
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [groups, setGroups] = useState<GroupOpt[]>([]);
  const [units, setUnits] = useState<UnitOpt[]>([]);
  const [records, setRecords] = useState<AnalysisRecord[]>([]);
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
  const [unitUnit, setUnitUnit] = useState<UnitMode>("person");
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
            groupScoring: data.groupScoring === true,
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
      try {
        const db = getFirebaseDb();
        const years = applied.years;
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
      const periodRecords = recordsForIndex(
        recordIndex,
        indicator.id,
        column.months,
        unitId,
      );
      const rows = mode === "unit"
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
    const optionRows = optionDetailRows(indRecs, indSel.questions);
    return {
      unitCount: unitIds.size, total: indRecs.length, unitPr, personPr: merged,
      // v1.44.0：結果分析不再讀預存摘要；明細只含本人單位範圍，不提供全院彙總。
      ownPersonPr: merged, ownTotal: indRecs.length,
      chartValues: pts.map((point) => point.pr.rate as number),
      chartLabels: pts.map((point) => point.column.label),
      chartTips: pts.map((point) => `${point.column.label}：${formatPassRate(point.pr, true)}`),
      chartCols: pts.map((point) => point.column),
      optionRows,
      // 分組計分只在指標開啟 groupScoring 時顯示（v1.44.0）。
      scoringRows: !indSel.groupScoring
        ? []
        : indUnit === "unit"
          ? unitScoringBreakdownRows(indRecs, indSel.questions, appliedColumns, th)
          : personScoringBreakdownRows(indRecs, indSel.questions, th),
    };
  }, [indRecs, indSel, indUnit, appliedColumns]);

  const errorAnalysisRows = questionErrorRows(
    errorUnit === "all"
      ? indRecs
      : indRecs.filter((record) => record.unitId === errorUnit),
  );

  /**
   * 指標分析補充說明（v1.43.0）：取即時明細（indRecs）中有備註的紀錄，
   * 每筆彙整為一則（單則為備註原文、多則每則附題號）。只收有備註者。
   */
  const indNotes = useMemo(() => {
    if (!indSel) return [];
    const source =
      errorUnit === "all"
        ? indRecs
        : indRecs.filter((record) => record.unitId === errorUnit);
    return collectConsolidatedRecordNotes(source, indSel.questions);
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
                  details: matrixScoringDetails(i, visibleColumns, undefined, groupUnit),
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
                note={`${periodDesc}・單元：${unitUnit === "unit" ? "單位（達閾值單位數／總單位數）" : "人次（合併）"}`}
              />
              <RateMatrix
                rows={unitIndicators.map((i) => ({
                  id: i.id,
                  label: `${i.code}・${i.name}`,
                  details: matrixScoringDetails(i, visibleColumns, selUnit, unitUnit),
                }))}
                columns={visibleColumns}
                cellOf={(id, col) =>
                  cellValue(id, col, selUnit, unitUnit)
                }
                onCell={(id, col) =>
                  openDrill(id, col, unitUnit, selUnit)
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
                      unitUnit,
                    );
                    return (
                      <UnitBelowPanel
                        title={`${ind.code}・${ind.name} 達閾值率曲線`}
                        subtitle={`${periodDesc}・單位：${selUnit}・${unitUnit === "unit" ? "單位（達閾值單位數／總單位數）" : "人次（合併）"}`}
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
              {indRecs.length > 0 && (
                <p className="settings-note" role="status">
                  {isNurseLeader ? "目前僅顯示本單位資料，無法提供全院彙總。" : "明細中的閾值快照優先於指標現行閾值。"}錯題排行依完全相同題目文字跨版本彙總，僅作排行、不代表版本等價或趨勢合併。
                </p>
              )}
              {indSummary.scoringRows.length > 0 && (
                <section className="panel score-breakdown-panel" aria-label="指標計分明細">
                  <div className="score-breakdown">
                    {indSummary.scoringRows.map((row) => (
                      <div
                        key={row.key}
                        className={`score-breakdown-row${row.isTotal ? " score-breakdown-total" : " score-breakdown-detail"}`}
                      >
                        <span>{row.isTotal ? indSel.name : row.label}</span>
                        <strong>
                          {formatPassRate({ pass: row.yes, total: row.valid, rate: row.rate })}
                        </strong>
                      </div>
                    ))}
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
                    threshold={indSel.threshold > 0 ? indSel.threshold : null}
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
  rows: {
    id: string;
    label: string;
    details?: { key: string; label: string; cells: Record<string, PassRate> }[];
  }[];
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
            </tr>,
            ...(row.details ?? []).map((detail) => (
              <tr key={`${row.id}-detail-${detail.key}`} className="analysis-matrix-detail-row">
                <td className="ind-col">
                  <div className="analysis-matrix-subrow">{detail.label}</div>
                </td>
                {columns.map((column) => (
                  <td key={column.key} className="rate-cell">
                    {formatPassRate(detail.cells[column.key] ?? { pass: 0, total: 0, rate: null })}
                  </td>
                ))}
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

  // L2 補充說明（v1.43.0）：每欄＝一筆紀錄，每筆彙整為一則（單則為備註
  // 原文、多則每則附題號），顯示於矩陣下方。
  const l2NoteGroups = useMemo(() => {
    if (!drill.l2UnitId || !ind) return [];
    return l2Rows
      .map((row, i) => {
        const text = mergeNoteParts(
          ind.questions.map((q, qi) => ({
            questionNo: qi + 1,
            note: row.notes.get(q.id) ?? "",
          })),
        );
        if (!text) return null;
        return {
          key: `${row.personEmpNo}-${row.year}-${row.month}-${i}`,
          label: l2Matrix.headers[i] ?? row.personEmpNo,
          monthLabel: `${row.year}/${String(row.month).padStart(2, "0")}`,
          bedNo: row.bedNo,
          text,
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
                    note="審查員備註未通過原因；每筆紀錄彙整為一則，只列有填寫備註的紀錄。"
                  />
                  {l2NoteGroups.map((g) => (
                    <div key={g.key} className="supp-notes-group">
                      <p className="supp-notes-person">
                        {g.label}・{g.monthLabel}
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
 * 匯入預覽列（v1.47.0）：選檔後先預覽、不直接寫入；硬錯誤列不能匯入，
 * 軟錯誤列由匯入者逐列勾選「仍要匯入」才寫入。
 */
interface ImportPreviewRow {
  lineNo: number;
  unitCode: string;
  monthRaw: string;
  reviewerId: string;
  personEmpNo: string;
  errors: string[];
  softErrors: string[];
  /** 該列將覆寫既有同一身分紀錄（指標＋單位＋年＋月＋受審人職編） */
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
      const { headerErrors, data } = parseResultSheet(sheet, {
        questionTitles: selInd.questions.map((q) => q.itemText),
      });
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
      // 覆寫預查：身分鍵（指標＋單位＋年＋月＋受審人職編）已存在即覆寫；
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
        `讀取檔案失敗：${error instanceof Error ? error.message : "讀寫失敗"}`,
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
        `匯入失敗：${error instanceof Error ? error.message : "讀寫失敗"}`,
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <SectionTitle
        title="匯入品管審查結果"
        note="先選組別與指標（只列啟用），再選 Excel／CSV 檔匯入。預檢不符（指標代號或題數）即整檔中止；選檔後先顯示預覽／錯誤清單，按「確認匯入」才寫入。匯入的紀錄計入審核進度，不自動建立審查任務。同一指標、單位、月份、受審人員重複匯入以後者覆蓋前者，不會重複建檔。"
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
                      <td>{r.reviewerId || "—"}</td>
                      <td>{r.personEmpNo || "—"}</td>
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
