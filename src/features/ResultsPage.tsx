/**
 * 結果分析頁（v1.25.0：取代舊畫面）。
 * 四個頁籤：組別分析、單位分析、指標分析、結果匯入。
 * 期間模型：年別／年份（起算年）／年數（往後數）／區間（月／季／年）／子選項
 * （月→只有全部；季→第一～四季／全部；年→半年／一年／全部），矩陣欄＝期間欄。
 * 達閾值＝紀錄 rate ≥ 指標閾值（紀錄無自帶達標旗標，一律以當前閾值計算；
 * 匯入紀錄同樣計入）；人次率＝合併計算，單位彙總率＝各單位率平均。
 * 權限：can("resultQuery")；資料範圍：管理員全部、審查員只看負責單位、
 * 一般人員只看自己單位（沿用舊頁規則）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronLeft,
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
  currentQuarterSub,
  expandAnalysisColumns,
  type AnalysisCycle,
  type AnalysisInterval,
  type AnalysisPeriodColumn,
  type AnalysisSub,
  type QuarterSub,
  type YearSub,
} from "../lib/analysisPeriod";
import {
  formatPassRate,
  optionDetailRows,
  passRateOf,
  personOptionRows,
  recordsInMonths,
  transposePersonOptionRows,
  unitPassRate,
  unitPeriodPassRate,
  unitsForDrill,
  type AnalysisRecord,
  type OptionDetailRow,
  type PassRate,
} from "../lib/analysisRates";
import { YEAR_FILTER_OPTIONS, yearOptionLabel } from "../lib/scheduling";
import {
  getCachedYears,
  invalidateCachedYears,
  mergeYearDocs,
  setCachedYear,
  type ResultsCacheScope,
} from "../lib/resultsCache";
import {
  clearRefCache,
  getCachedRef,
  getCachedRefCollection,
  SYSTEM_CONFIG_KEY,
} from "../lib/refCache";

interface IndicatorOpt {
  id: string;
  code: string;
  name: string;
  groupId: string;
  status: string;
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
}

type TabId = "group" | "unit" | "indicator" | "import";
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

const QUARTER_LABELS: Record<QuarterSub, string> = {
  1: "第一季",
  2: "第二季",
  3: "第三季",
  4: "第四季",
};

function fmtRate(rate: number | null): string {
  return rate == null ? "—" : `${rate.toFixed(1)}%`;
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
  const [tasks, setTasks] = useState<
    { id: string; unitId: string; reviewerId: string }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  // v1.28 階段 4：按「重新整理」時 meta effect 重跑、拉最新參考資料
  const [refNonce, setRefNonce] = useState(0);
  /**
   * 已生效的查詢條件（null＝尚未查詢，顯示空白頁）。
   * 篩選器一變只改 live 值，不觸發查詢；按「查詢」才把當下條件生效。
   */
  const [applied, setApplied] = useState<{
    years: number[];
    cycle: AnalysisCycle;
    startYear: number;
    yearCount: number;
    interval: AnalysisInterval;
    sub: AnalysisSub;
  } | null>(null);
  /** 資料時間（本次顯示年份中最新的抓取時間；快取命中沿用原抓取時間） */
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [tab, setTab] = useState<TabId>("group");
  /** 統計週期（系統參數 systemParams.statsCycle；載入後套為年別預設） */
  const [statsCycle, setStatsCycle] = useState<AnalysisCycle | null>(null);
  const statsAppliedRef = useRef(false);

  // 期間篩選（四個頁籤共用）
  const [cycle, setCycle] = useState<AnalysisCycle>("year");
  const [startYear, setStartYear] = useState(now.getFullYear());
  const [yearCount, setYearCount] = useState(1);
  const [interval, setInterval] = useState<AnalysisInterval>("quarter");
  const [sub, setSub] = useState<AnalysisSub>(
    currentQuarterSub("year"),
  );
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
  // Modal
  const [chartModal, setChartModal] = useState<ChartModalData | null>(null);
  const [docModal, setDocModal] = useState<DocModalData | null>(null);
  // 下探（L1 單位矩陣／L2 人員各選項結果）
  const [drill, setDrill] = useState<DrillState | null>(null);
  // 單位分析矩陣下方展開面板（曲線圖／選項明細）
  const [unitPanel, setUnitPanel] = useState<UnitPanel | null>(null);

  // 資料範圍（沿用舊頁規則）
  const scope = useMemo(() => {
    const roles = user?.roles ?? [];
    if (roles.includes("系統管理員")) return { kind: "admin" as const };
    if (user && isReviewerRole(roles))
      return { kind: "reviewer" as const, staffId: user.staffId };
    if (user) return { kind: "staff" as const, unitCode: user.unitCode };
    return { kind: "admin" as const };
  }, [user]);

  /** 按年份快取的權限範圍鍵（與 scope 同義，格式見 resultsCache） */
  const cacheScope: ResultsCacheScope = useMemo(() => {
    if (scope.kind === "reviewer")
      return { kind: "reviewer", staffId: scope.staffId };
    if (scope.kind === "staff")
      return { kind: "staff", unitCode: scope.unitCode };
    return { kind: "admin" };
  }, [scope]);

  // 指標／組別／單位／統計週期（掛載時載入一次）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = getFirebaseDb();
        const [isnap, gsnap, usnap, cfg] = await Promise.all([
          getCachedRefCollection("indicators", () =>
            getDocs(collection(db, "indicators")),
          ),
          getCachedRefCollection("groups", () =>
            getDocs(collection(db, "groups")),
          ),
          getCachedRefCollection("units", () =>
            getDocs(collection(db, "units")),
          ),
          getCachedRef(SYSTEM_CONFIG_KEY, () =>
            getDoc(doc(getFirebaseDb(), "systemParams", "config")),
          ).catch(() => null),
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
              };
            })
            .sort((a, b) => a.code.localeCompare(b.code, "zh-Hant")),
        );
        const v = cfg?.data()?.statsCycle;
        setStatsCycle(v === "academic" ? "academic" : "year");
      } catch {
        if (!cancelled) {
          setIndicators([]);
          setGroups([]);
          setUnits([]);
          setStatsCycle("year");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refNonce]);

  // 統計週期載入後套為年別預設（只套一次，不蓋掉使用者已改的值）
  useEffect(() => {
    if (statsCycle == null || statsAppliedRef.current) return;
    statsAppliedRef.current = true;
    setCycle(statsCycle);
    if (interval === "quarter") setSub(currentQuarterSub(statsCycle));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsCycle]);

  // 期間欄（年份為起算年，年數往後數；live 值，只供「查詢」按鈕取年份）
  const columns = useMemo(
    () =>
      expandAnalysisColumns({
        cycle,
        startYear,
        yearCount,
        interval,
        sub,
      }),
    [cycle, startYear, yearCount, interval, sub],
  );
  const queryYears = useMemo(() => calendarYearsOf(columns), [columns]);
  /** 已生效的期間欄：未查詢前沿用 live 值（畫面為空白頁，不渲染矩陣） */
  const appliedColumns = useMemo(
    () =>
      applied
        ? expandAnalysisColumns({
            cycle: applied.cycle,
            startYear: applied.startYear,
            yearCount: applied.yearCount,
            interval: applied.interval,
            sub: applied.sub,
          })
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
    if (!applied) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const db = getFirebaseDb();
        const years = applied.years;
        const recCached = getCachedYears<AnalysisRecord>(
          "reviewRecords",
          years,
          cacheScope,
        );
        const recFresh = new Map<number, AnalysisRecord[]>();
        if (recCached.missing.length > 0) {
          const snaps = await Promise.all(
            recCached.missing.map((y) =>
              getDocs(
                query(
                  collection(db, "reviewRecords"),
                  where("year", "==", y),
                ),
              ),
            ),
          );
          snaps.forEach((snap, i) => {
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
                    };
                  })
                : [];
              docs.push({
                indicatorId: String(v.indicatorId ?? ""),
                unitId: String(v.unitId ?? ""),
                year: Number(v.year ?? 0),
                month: Number(v.month ?? 0),
                rate: typeof v.rate === "number" ? v.rate : null,
                answers,
                personEmpNo: String(v.reviewedPersonEmpNo ?? ""),
                personName: String(v.reviewedPersonName ?? ""),
              });
            });
            setCachedYear("reviewRecords", y, cacheScope, docs);
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
  }, [appliedYearsKey, reloadNonce, scope.kind, scope.kind === "reviewer" ? scope.staffId : ""]);

  /** 按「查詢」：把當下期間條件生效（同年份重按不重拉，吃快取） */
  function handleQuery() {
    setApplied({
      years: queryYears,
      cycle,
      startYear,
      yearCount,
      interval,
      sub,
    });
  }

  /** 重新整理：失效已查年份的快取（紀錄＋任務）＋參考快取，再重拉一次 */
  function handleRefresh() {
    if (!applied) return;
    invalidateCachedYears("reviewRecords", applied.years, cacheScope);
    invalidateCachedYears("reviewTasks", applied.years, cacheScope);
    // v1.28 階段 4：參考快取也失效，meta effect（refNonce）重跑才拉最新
    clearRefCache();
    setRefNonce((n) => n + 1);
    setReloadNonce((n) => n + 1);
  }

  // 範圍內紀錄（依權限範圍過濾）
  const scopedRecords = useMemo(() => {
    if (scope.kind === "admin") return records;
    if (scope.kind === "staff")
      return records.filter((r) => r.unitId === scope.unitCode);
    const unitIds = new Set(
      tasks
        .filter((t) => t.reviewerId === scope.staffId)
        .map((t) => t.unitId),
    );
    return records.filter((r) => unitIds.has(r.unitId));
  }, [records, tasks, scope]);

  const scopedUnitCodes = useMemo(() => {
    if (scope.kind === "admin") return new Set(units.map((u) => u.code));
    if (scope.kind === "staff") return new Set([scope.unitCode]);
    return new Set(
      tasks
        .filter((t) => t.reviewerId === scope.staffId)
        .map((t) => t.unitId),
    );
  }, [units, tasks, scope]);

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

  // 期間說明文字（modal 副標共用；顯示已生效的查詢條件）
  const periodDesc = useMemo(() => {
    const pc = applied?.cycle ?? cycle;
    const ps = applied?.startYear ?? startYear;
    const py = applied?.yearCount ?? yearCount;
    const pi = applied?.interval ?? interval;
    const pb = applied?.sub ?? sub;
    const cycleLabel = pc === "academic" ? "學年度" : "年度";
    const subLabel =
      pb === "all"
        ? pi === "month"
          ? "月・全部"
          : pi === "quarter"
            ? "季・全部"
            : "年・全部"
        : pi === "quarter"
          ? QUARTER_LABELS[pb as QuarterSub]
          : pb === "half"
            ? "半年"
            : "一年";
    return `${cycleLabel} ${ps} 起 ${py} 年・${subLabel}`;
  }, [applied, cycle, startYear, yearCount, interval, sub]);

  function handleCycleChange(v: string) {
    const c = v as AnalysisCycle;
    setCycle(c);
    if (interval === "quarter") setSub(currentQuarterSub(c));
  }
  function handleIntervalChange(v: string) {
    const iv = v as AnalysisInterval;
    setInterval(iv);
    // 區間切換時期間重設為預設值：月→全部；季→當前所在的季；年→一年
    setSub(
      iv === "month"
        ? "all"
        : iv === "quarter"
          ? currentQuarterSub(cycle)
          : "full",
    );
  }

  /** 單格達閾值率（人次＝合併；單位＝達閾值單位數／總審查單位數） */
  function cellValue(
    indicatorId: string,
    col: AnalysisPeriodColumn,
    unitId: string | undefined,
    mode: UnitMode,
  ): CellValue {
    const ind = indOf.get(indicatorId);
    const th = ind?.threshold ?? 0;
    let recs = scopedRecords.filter((r) => r.indicatorId === indicatorId);
    if (unitId) recs = recs.filter((r) => r.unitId === unitId);
    recs = recordsInMonths(recs, col.months);
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
    const cell = cellValue(indicatorId, col, scopeUnitId, mode);
    if (cell.rate == null) return;
    setDrill({
      indicatorId,
      column: col,
      mode,
      scopeUnitId,
      l2UnitId: null,
    });
  }

  function openDoc(
    indicatorId: string,
    unitId: string | undefined,
    scopeLabel: string,
  ) {
    const ind = indOf.get(indicatorId);
    if (!ind) return;
    let recs = scopedRecords.filter((r) => r.indicatorId === indicatorId);
    if (unitId) recs = recs.filter((r) => r.unitId === unitId);
    recs = recordsInMonths(recs, allMonths);
    setDocModal({
      title: `${ind.code}・${ind.name} 各選項得分狀況`,
      subtitle: `${periodDesc}・${scopeLabel}・共 ${recs.length} 人次`,
      rows: optionDetailRows(recs, ind.questions),
    });
  }

  if (!can("resultQuery")) {
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
    return recordsInMonths(
      scopedRecords.filter((r) => r.indicatorId === selIndicator),
      allMonths,
    );
  }, [scopedRecords, selIndicator, allMonths]);
  const indSel = indOf.get(selIndicator);
  const indSummary = useMemo(() => {
    if (!indSel) return null;
    const th = indSel.threshold;
    const unitIds = new Set(indRecs.map((r) => r.unitId));
    // 單位正確率：unit-period 計（一個單位在兩個期間欄受審＝兩筆審查）
    const unitPr = unitPeriodPassRate(indRecs, appliedColumns, th);
    const merged = passRateOf(indRecs, th);
    const perColumn =
      indUnit === "unit"
        ? appliedColumns.map((c) => ({
            column: c,
            pr: unitPassRate(recordsInMonths(indRecs, c.months), th),
          }))
        : appliedColumns.map((c) => ({
            column: c,
            pr: passRateOf(recordsInMonths(indRecs, c.months), th),
          }));
    const pts = perColumn.filter(
      (p): p is { column: AnalysisPeriodColumn; pr: PassRate } & { pr: { rate: number } } =>
        p.pr.rate != null,
    );
    return {
      unitCount: unitIds.size,
      total: indRecs.length,
      unitPr,
      personPr: merged,
      chartValues: pts.map((p) => p.pr.rate as number),
      chartLabels: pts.map((p) => p.column.label),
      chartTips: pts.map(
        (p) => `${p.column.label}：${formatPassRate(p.pr, true)}`,
      ),
      chartCols: pts.map((p) => p.column),
      optionRows: optionDetailRows(indRecs, indSel.questions),
    };
  }, [indRecs, indSel, indUnit, appliedColumns]);

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

      {tab !== "import" && (
        <div className="results-filters">
          <SelectField
            label="年別"
            value={cycle}
            onChange={handleCycleChange}
            options={[
              { value: "year", label: "年度" },
              { value: "academic", label: "學年度" },
            ]}
          />
          <SelectField
            label="年份"
            value={startYear}
            onChange={(v) => setStartYear(Number(v))}
            options={YEAR_FILTER_OPTIONS.map((y) => ({
              value: y,
              label: yearOptionLabel(y),
            }))}
          />
          <SelectField
            label="年數"
            value={yearCount}
            onChange={(v) => setYearCount(Number(v))}
            options={[1, 2, 3].map((n) => ({ value: n, label: `${n}年` }))}
          />
          <SelectField
            label="區間"
            value={interval}
            onChange={handleIntervalChange}
            options={[
              { value: "month", label: "月" },
              { value: "quarter", label: "季" },
              { value: "year", label: "年" },
            ]}
          />
          {interval === "month" ? (
            <SelectField
              label="期間"
              value={sub}
              onChange={() => setSub("all")}
              options={[{ value: "all", label: "全部" }]}
            />
          ) : interval === "quarter" ? (
            <SelectField
              label="季"
              value={sub}
              onChange={(v) =>
                setSub(v === "all" ? "all" : (Number(v) as QuarterSub))
              }
              options={[
                ...([1, 2, 3, 4] as QuarterSub[]).map((q) => ({
                  value: q,
                  label: QUARTER_LABELS[q],
                })),
                { value: "all", label: "全部" },
              ]}
            />
          ) : (
            <SelectField
              label="期間"
              value={sub}
              onChange={(v) => setSub(v as YearSub | "all")}
              options={[
                { value: "half", label: "半年" },
                { value: "full", label: "一年" },
                { value: "all", label: "全部" },
              ]}
            />
          )}
          <div className="results-query-actions">
            <button
              type="button"
              className="button button-primary"
              onClick={handleQuery}
              disabled={loading}
            >
              {applied ? "重新查詢" : "查詢"}
            </button>
            {applied && (
              <button
                type="button"
                className="button button-outline"
                onClick={handleRefresh}
                disabled={loading}
                title="清除已查年份的快取並重新讀取"
              >
                重新整理
              </button>
            )}
          </div>
        </div>
      )}
      {tab !== "import" && applied && fetchedAt != null && !loading && (
        <p className="results-data-time">
          資料時間：
          {new Date(fetchedAt).toLocaleString("zh-Hant-TW", {
            hour12: false,
          })}
          （他人異動不會自動更新，請按「重新整理」）
        </p>
      )}

      {tab === "group" && (
        <>
          <div className="results-filters">
            <SelectField
              label="組別"
              value={selGroup}
              onChange={setSelGroup}
              options={scopedGroups.map((g) => ({
                value: g.id,
                label: g.name,
              }))}
            />
            <SelectField
              label="單元"
              value={groupUnit}
              onChange={(v) => setGroupUnit(v as UnitMode)}
              options={[
                { value: "person", label: "人次" },
                { value: "unit", label: "單位" },
              ]}
            />
          </div>
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
                columns={appliedColumns}
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
          <div className="results-filters">
            <SelectField
              label="組別"
              value={selGroupU}
              onChange={(v) => {
                setSelGroupU(v);
                setSelIndU("all");
              }}
              options={[
                { value: "all", label: "全部組別" },
                ...scopedGroups.map((g) => ({
                  value: g.id,
                  label: g.name,
                })),
              ]}
            />
            <SelectField
              label="單位"
              value={selUnit}
              onChange={setSelUnit}
              options={scopedUnits.map((u) => ({
                value: u.code,
                label: `${u.code}・${u.name}`,
              }))}
            />
            <SelectField
              label="指標"
              value={selIndU}
              onChange={setSelIndU}
              options={[
                { value: "all", label: "全部指標" },
                ...unitIndOptions.map((i) => ({
                  value: i.id,
                  label: `${i.code}・${i.name}`,
                })),
              ]}
            />
          </div>
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
                columns={appliedColumns}
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
                  const recs = recordsInMonths(
                    scopedRecords.filter(
                      (r) =>
                        r.indicatorId === ind.id && r.unitId === selUnit,
                    ),
                    allMonths,
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
          <div className="results-filters">
            <SelectField
              label="組別"
              value={selGroup2}
              onChange={setSelGroup2}
              options={scopedGroups.map((g) => ({
                value: g.id,
                label: g.name,
              }))}
            />
            <SelectField
              label="指標"
              value={selIndicator}
              onChange={setSelIndicator}
              options={indTabIndicators.map((i) => ({
                value: i.id,
                label: `${i.code}・${i.name}`,
              }))}
            />
            <SelectField
              label="單元"
              value={indUnit}
              onChange={(v) => setIndUnit(v as UnitMode)}
              options={[
                { value: "person", label: "人次" },
                { value: "unit", label: "單位" },
              ]}
            />
          </div>
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
                  label="受審單位數"
                  value={String(indSummary.unitCount)}
                  note="所選期間內有紀錄的單位"
                />
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
              </div>
              <section className="panel">
                <SectionTitle
                  title="通過率"
                  note={`${indSel.code}・${indSel.name}・${periodDesc}・單元：${indUnit === "unit" ? "單位（達閾值單位數／總單位數）" : "人次（合併）"}`}
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
                    onPointClick={(i) =>
                      openDrill(
                        selIndicator,
                        indSummary.chartCols[i],
                        indUnit,
                      )
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
          scopedRecords={scopedRecords}
          indOf={indOf}
          unitNameOf={unitNameOf}
        />
      )}
    </div>
  );
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
            <th className="icon-col">曲線圖</th>
            <th className="icon-col">明細</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="ind-col">{row.label}</td>
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
              <td className="icon-col">
                <button
                  type="button"
                  className="icon-button"
                  title="曲線圖"
                  aria-label={`${row.label} 曲線圖`}
                  onClick={() => onChart(row.id)}
                >
                  <TrendingUp size={16} />
                </button>
              </td>
              <td className="icon-col">
                <button
                  type="button"
                  className="icon-button"
                  title="各選項得分狀況"
                  aria-label={`${row.label} 各選項得分狀況`}
                  onClick={() => onDoc(row.id)}
                >
                  <FileText size={16} />
                </button>
              </td>
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
  scopedRecords,
  indOf,
  unitNameOf,
}: {
  drill: DrillState;
  onClose: () => void;
  onBackToL1: () => void;
  onSelectUnit: (unitId: string) => void;
  scopedRecords: AnalysisRecord[];
  indOf: Map<string, IndicatorOpt>;
  unitNameOf: Map<string, string>;
}) {
  const ind = indOf.get(drill.indicatorId);
  const th = ind?.threshold ?? 0;
  const col = drill.column;
  // L1 列：分母單元的單位（該指標該期間欄內有審查紀錄的單位）
  const l1Units = useMemo(() => {
    let recs = scopedRecords.filter((r) => r.indicatorId === drill.indicatorId);
    if (drill.scopeUnitId) recs = recs.filter((r) => r.unitId === drill.scopeUnitId);
    return unitsForDrill(recs, col.months);
  }, [scopedRecords, drill.indicatorId, drill.scopeUnitId, col]);
  const l1Cells = useMemo(() => {
    const map = new Map<string, CellValue>();
    for (const unitId of l1Units) {
      const recs = recordsInMonths(
        scopedRecords.filter(
          (r) => r.indicatorId === drill.indicatorId && r.unitId === unitId,
        ),
        col.months,
      );
      const pr = passRateOf(recs, th);
      map.set(unitId, {
        ...pr,
        title: pr.total === 0 ? "無資料" : `達閾值 ${pr.pass}／${pr.total} 人次`,
      });
    }
    return map;
  }, [scopedRecords, drill.indicatorId, l1Units, col, th]);
  // L2 列：該單位該期間被審人員在各選項的審查結果
  const l2Rows = useMemo(() => {
    if (!drill.l2UnitId) return [];
    const recs = recordsInMonths(
      scopedRecords.filter(
        (r) =>
          r.indicatorId === drill.indicatorId &&
          r.unitId === drill.l2UnitId,
      ),
      col.months,
    );
    return personOptionRows(recs, th);
  }, [scopedRecords, drill.indicatorId, drill.l2UnitId, col, th]);
  // L2 轉置（v1.27.1）：直向＝題目、橫向＝人員姓名，中間＝審查結果
  const l2Matrix = useMemo(
    () =>
      ind
        ? transposePersonOptionRows(l2Rows, ind.questions)
        : { headers: [] as string[], rows: [], rates: [] },
    [l2Rows, ind],
  );

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
              <div className="analysis-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>題目</th>
                      {l2Matrix.headers.map((h, i) => (
                        <th
                          key={`${l2Rows[i].personEmpNo}-${l2Rows[i].year}-${l2Rows[i].month}-${i}`}
                        >
                          {h}
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
                          <td key={i}>{v}</td>
                        ))}
                      </tr>
                    ))}
                    <tr>
                      <td>正確率</td>
                      {l2Matrix.rates.map((r, i) => (
                        <td
                          key={i}
                          className={`drill-person-rate${r.passing ? " pass" : ""}`}
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
              <th>題目</th>
              <th>是</th>
              <th>否</th>
              <th>不適用</th>
              <th>得分率</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.questionId}>
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
            getDocs(collection(db, "groups")),
          ),
          getCachedRefCollection("units", () =>
            getDocs(collection(db, "units")),
          ),
          getCachedRefCollection("users", () =>
            getDocs(collection(db, "users")),
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
    downloadTemplate(
      resultTemplateRows(
        selInd.code,
        selInd.questions.map((q) => q.itemText),
      ),
      "審查結果",
      `${selInd.code}_審查結果範本`,
    );
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
