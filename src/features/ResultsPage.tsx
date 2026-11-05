/**
 * 結果分析頁（v1.13.0：佔位文字改為真實串接）。
 * 三區塊：指標趨勢（月平均正確率折線）、達標統計（各指標 RAG）、結果明細（各單位＋查看）。
 * 資料歸屬依排程月份（reviewTasks.year/month）與單位代號；權限用 can("resultQuery") gating；
 * 資料範圍：管理員全部、審查員只看自己負責單位、一般人員只看自己單位。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Download, Upload, X } from "lucide-react";
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
import { getFirebaseDb, toFirebaseProfile } from "../lib/firebase";
import { useAuth } from "../lib/auth";
import { usePermissions } from "../lib/usePermissions";
import { isDemoMode } from "../lib/demoMode";
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
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { TrendChart } from "../components/TrendChart";
import { ReviewExecutePage } from "./ReviewExecutePage";
import { QuarterResults } from "./QuarterResults";
import type { Indicator as LegacyIndicator, Role } from "../types";
import {
  filterByScope,
  indicatorMonthStats,
  monthlyTrend,
  unitMonthRows,
  type AnalysisTask,
  type DataScope,
  type RagState,
  type RateRecord,
  type StatsCycle,
} from "../lib/resultAnalysis";
import { academicYearOf } from "../lib/cycle";

interface IndicatorOpt {
  id: string;
  /** 顯示用編號（由複合文件 ID 解析；v1.21） */
  code: string;
  name: string;
  groupId: string;
  status: string;
  threshold: number;
  /** 審查表題目（匯入範本與計分用） */
  questions: AuditQuestion[];
}

function RagDot({ state, label }: { state: RagState; label: string }) {
  return (
    <span className={`rag-badge rag-${state}`}>
      <i />
      {label}
    </span>
  );
}

function unitRagLabel(avgRate: number | null, threshold: number): string {
  if (avgRate == null) return "無資料";
  if (!(threshold > 0)) return "無閾值";
  return avgRate >= threshold ? "達標" : "未達標";
}

function statRagLabel(state: RagState): string {
  return state === "green" ? "全數達標" : state === "red" ? "有未達標" : "無資料";
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
  const [tasks, setTasks] = useState<AnalysisTask[]>([]);
  const [records, setRecords] = useState<RateRecord[]>([]);
  const [years, setYears] = useState<number[]>([]);
  const [selIndicator, setSelIndicator] = useState("");
  const [selYear, setSelYear] = useState(now.getFullYear());
  const [selMonth, setSelMonth] = useState(now.getMonth() + 1);
  const [loading, setLoading] = useState(true);
  const [viewingTaskId, setViewingTaskId] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "quarterly">("overview");
  /** 匯入品管審查結果 dialog 開關（v1.21） */
  const [importOpen, setImportOpen] = useState(false);
  /** 匯入後重讀任務／紀錄的觸發器 */
  const [reloadNonce, setReloadNonce] = useState(0);
  /** 統計週期（系統參數 systemParams.statsCycle；缺值預設 'year'） */
  const [statsCycle, setStatsCycle] = useState<StatsCycle>("year");

  // 統計週期：讀系統參數（沿用既有 systemParams/config 讀法）
  useEffect(() => {
    (async () => {
      try {
        const snap = await getDoc(
          doc(getFirebaseDb(), "systemParams", "config"),
        );
        const v = snap.data()?.statsCycle;
        setStatsCycle(v === "academic" ? "academic" : "year");
      } catch {
        setStatsCycle("year");
      }
    })();
  }, []);

  const scope: DataScope = useMemo(() => {
    const roles = user?.roles ?? [];
    if (roles.includes("系統管理員")) return { kind: "admin" };
    if (user && isReviewerRole(roles))
      return { kind: "reviewer", staffId: user.staffId };
    if (user) return { kind: "staff", unitCode: user.unitCode };
    return { kind: "admin" };
  }, [user]);

  // 指標清單（名稱＋閾值；v1.17 起達標判定吃基本資料閾值）
  useEffect(() => {
    (async () => {
      try {
        const db = getFirebaseDb();
        const snap = await getDocs(collection(db, "indicators"));
        const list: IndicatorOpt[] = [];
        snap.docs.forEach((d) => {
          const data = d.data() as Record<string, unknown>;
          const name =
            typeof data.name === "string" && data.name ? data.name : d.id;
          list.push({
            id: d.id,
            code: indicatorCodeOf(d.id),
            name,
            groupId: typeof data.groupId === "string" ? data.groupId : "",
            status: typeof data.status === "string" ? data.status : "",
            threshold: effectiveThreshold(data),
            questions: normalizeQuestions(data.questions).questions,
          });
        });
        list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
        setIndicators(list);
        setSelIndicator((prev) => prev || list[0]?.id || "");
      } catch {
        setIndicators([]);
      }
    })();
  }, []);

  // 任務＋逐件紀錄（依年度；單一 where 避免複合索引，範圍在前端過濾）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const db = getFirebaseDb();
        const [tsnap, rsnap] = await Promise.all([
          getDocs(
            query(collection(db, "reviewTasks"), where("year", "==", selYear)),
          ),
          getDocs(
            query(
              collection(db, "reviewRecords"),
              where("year", "==", selYear),
            ),
          ),
        ]);
        if (cancelled) return;
        const tl: AnalysisTask[] = [];
        tsnap.docs.forEach((d) => {
          const v = d.data() as Record<string, unknown>;
          tl.push({
            id: d.id,
            indicatorId: String(v.indicatorId ?? ""),
            unitId: String(v.unitId ?? ""),
            reviewerId: String(v.reviewerId ?? ""),
            year: Number(v.year ?? 0),
            month: Number(v.month ?? 0),
            caseCount:
              typeof v.caseCount === "number" && v.caseCount >= 1
                ? v.caseCount
                : null,
          });
        });
        const rl: RateRecord[] = [];
        rsnap.docs.forEach((d) => {
          const v = d.data() as Record<string, unknown>;
          rl.push({
            taskId:
              typeof v.taskId === "string" && v.taskId ? v.taskId : d.id,
            indicatorId: String(v.indicatorId ?? ""),
            unitId: String(v.unitId ?? ""),
            year: Number(v.year ?? selYear),
            month: Number(v.month ?? 0),
            rate: typeof v.rate === "number" ? v.rate : null,
          });
        });
        const ys = [...new Set(tl.map((t) => t.year))].sort((a, b) => b - a);
        if (!ys.includes(now.getFullYear())) ys.unshift(now.getFullYear());
        setYears(ys);
        setTasks(tl);
        setRecords(rl);
      } catch {
        if (!cancelled) {
          setTasks([]);
          setRecords([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selYear, reloadNonce]);

  const scoped = useMemo(
    () => filterByScope(tasks, records, scope),
    [tasks, records, scope],
  );
  const thresholds = useMemo(
    () => new Map(indicators.map((i) => [i.id, i.threshold])),
    [indicators],
  );
  const selInd = indicators.find((i) => i.id === selIndicator);
  /** 趨勢的週期鍵：年度＝西元年；學年度＝包含所選曆年月的學年度 */
  const trendPeriod = useMemo(
    () =>
      statsCycle === "academic"
        ? String(academicYearOf(new Date(selYear, selMonth - 1, 1)))
        : String(selYear),
    [statsCycle, selYear, selMonth],
  );
  const trendScopeLabel =
    statsCycle === "academic"
      ? `${trendPeriod}學年度各月份平均正確率`
      : `${selYear}年各月份平均正確率`;
  const trend = useMemo(
    () => monthlyTrend(scoped.records, selIndicator, statsCycle, trendPeriod),
    [scoped, selIndicator, statsCycle, trendPeriod],
  );
  const stats = useMemo(
    () =>
      indicatorMonthStats(
        scoped.tasks,
        scoped.records,
        selYear,
        selMonth,
        thresholds,
        statsCycle,
      ),
    [scoped, selYear, selMonth, thresholds, statsCycle],
  );
  const rows = useMemo(
    () =>
      unitMonthRows(
        scoped.tasks,
        scoped.records,
        selIndicator,
        selYear,
        selMonth,
        selInd?.threshold ?? 0,
      ),
    [scoped, selIndicator, selYear, selMonth, selInd],
  );
  const indNameOf = useMemo(
    () => new Map(indicators.map((i) => [i.id, i.name])),
    [indicators],
  );

  // 季度分析 tab：把新版指標對應到舊版 Indicator 形狀
  const primaryRole: Role = useMemo(() => {
    const first = user?.roles?.[0];
    const known: Role[] = [
      "一般人員",
      "審查員",
      "護理長",
      "主任",
      "副主任",
      "督導",
      "各組召集人",
      "執行幹事",
      "品管執行幹事",
      "系統管理員",
      "指標負責人",
      "品管組召集人",
      "品管組執行幹事",
      "品管組審查員",
      "單位召集人",
      "單位執行幹事",
      "單位審查員",
    ];
    return first && (known as string[]).includes(first)
      ? (first as Role)
      : "一般人員";
  }, [user]);
  const quarterlyIndicators: LegacyIndicator[] = useMemo(
    () =>
      indicators.map((i) => ({
        id: i.id,
        code: i.code,
        name: i.name,
        group: "未分類",
        threshold: i.threshold,
        attainment: 0,
        audited: 0,
        planned: 0,
        version: "",
        status: "啟用" as const,
        owner: "",
        resultLabel: "符合率",
      })),
    [indicators],
  );

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

  // 明細「查看」→ 該單位該月查詢頁（沿用審查執行的查詢模式）
  if (viewingTaskId) {
    return (
      <ReviewExecutePage
        target={{ mode: "records", taskId: viewingTaskId }}
        onBack={() => setViewingTaskId(null)}
        onAction={onAction}
      />
    );
  }

  const trendValues = trend.map((t) => t.rate);
  const trendLabels = trend.map((t) => t.label);

  return (
    <div className="results-page">
      <PageHeading
        page="results"
        action={
          <>
            <button
              className="button button-outline"
              onClick={() => setImportOpen(true)}
            >
              <Upload size={16} />
              匯入品管審查結果
            </button>
            <button
              className="button button-outline"
              onClick={() => onAction("報表匯出功能開發中")}
            >
              <Download size={16} />
              匯出報表
            </button>
          </>
        }
      />

      <div className="results-tabs" role="tablist" aria-label="結果分析檢視">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "overview"}
          className={tab === "overview" ? "active" : ""}
          onClick={() => setTab("overview")}
        >
          分析總覽
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "quarterly"}
          className={tab === "quarterly" ? "active" : ""}
          onClick={() => setTab("quarterly")}
        >
          季度分析
        </button>
      </div>

      {tab === "quarterly" ? (
        <QuarterResults
          indicators={quarterlyIndicators}
          role={primaryRole}
          firebaseMode={!isDemoMode()}
          profile={toFirebaseProfile(user)}
        />
      ) : (
        <>
          <div className="results-filters">
        <label className="field-label">
          指標
          <div className="select-wrap">
            <select
              value={selIndicator}
              onChange={(e) => setSelIndicator(e.target.value)}
            >
              {indicators.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
            <ChevronDown size={15} />
          </div>
        </label>
        <label className="field-label">
          年度
          <div className="select-wrap">
            <select
              value={selYear}
              onChange={(e) => setSelYear(Number(e.target.value))}
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <ChevronDown size={15} />
          </div>
        </label>
        <label className="field-label">
          月份
          <div className="select-wrap">
            <select
              value={selMonth}
              onChange={(e) => setSelMonth(Number(e.target.value))}
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {m}月
                </option>
              ))}
            </select>
            <ChevronDown size={15} />
          </div>
        </label>
      </div>

      {loading ? (
        <EmptyState title="載入中" description="正在讀取審查紀錄…" />
      ) : (
        <>
          <section className="panel">
            <SectionTitle
              title="指標趨勢"
              note={selInd ? `${selInd.name}・${trendScopeLabel}` : undefined}
            />
            {trend.length === 0 ? (
              <div className="chart-empty">尚無趨勢資料</div>
            ) : (
              <TrendChart
                values={trendValues}
                labels={trendLabels}
                legend="平均正確率"
                currentLabel={trend[trend.length - 1].label}
              />
            )}
          </section>

          <section className="panel">
            <SectionTitle
              title="達標統計"
              note={`${statsCycle === "academic" ? `${trendPeriod}學年度・${selMonth}月` : `${selYear}年${selMonth}月`}・達標率＝達標單位數 ÷ 已完成單位數`}
            />
            {stats.length === 0 ? (
              <EmptyState
                title="無排程資料"
                description="該月份尚無審查任務。"
              />
            ) : (
              <>
                <div className="task-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>指標名稱</th>
                        <th>應審單位數</th>
                        <th>已完成單位數</th>
                        <th>達標單位數</th>
                        <th>達標率</th>
                        <th>燈號</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.map((s) => (
                        <tr key={s.indicatorId}>
                          <td>{indNameOf.get(s.indicatorId) ?? s.indicatorId}</td>
                          <td>{s.totalUnits}</td>
                          <td>{s.doneUnits}</td>
                          <td>{s.passUnits}</td>
                          <td>
                            {s.passRate == null ? "—" : `${s.passRate}%`}
                          </td>
                          <td>
                            <RagDot state={s.rag} label={statRagLabel(s.rag)} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="task-cards">
                  {stats.map((s) => (
                    <div className="task-card" key={s.indicatorId}>
                      <div className="task-card-top">
                        <b>{indNameOf.get(s.indicatorId) ?? s.indicatorId}</b>
                        <RagDot state={s.rag} label={statRagLabel(s.rag)} />
                      </div>
                      <div className="task-card-meta">
                        應審 {s.totalUnits}・已完成 {s.doneUnits}・達標{" "}
                        {s.passUnits}・達標率{" "}
                        {s.passRate == null ? "—" : `${s.passRate}%`}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="panel">
            <SectionTitle
              title="結果明細"
              note={
                selInd
                  ? `${selInd.name}・${selYear}年${selMonth}月各單位`
                  : undefined
              }
            />
            {rows.length === 0 ? (
              <EmptyState
                title="無資料"
                description="該指標該月份尚無審查任務或紀錄。"
              />
            ) : (
              <>
                <div className="task-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>審查單位</th>
                        <th>完成/應審件數</th>
                        <th>平均正確率</th>
                        <th>達標燈號</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.unitId}>
                          <td>{r.unitId}</td>
                          <td>
                            {r.doneCount}/{r.required}
                          </td>
                          <td>
                            {r.avgRate == null ? "—" : `${r.avgRate}%`}
                          </td>
                          <td>
                            <RagDot
                              state={r.rag}
                              label={unitRagLabel(
                                r.avgRate,
                                selInd?.threshold ?? 0,
                              )}
                            />
                          </td>
                          <td>
                            <button
                              className="button button-outline button-sm"
                              onClick={() => setViewingTaskId(r.taskId)}
                              disabled={!r.taskId}
                            >
                              查看
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="task-cards">
                  {rows.map((r) => (
                    <div className="task-card" key={r.unitId}>
                      <div className="task-card-top">
                        <b>{r.unitId}</b>
                        <RagDot
                          state={r.rag}
                          label={unitRagLabel(r.avgRate, selInd?.threshold ?? 0)}
                        />
                      </div>
                      <div className="task-card-meta">
                        完成/應審 {r.doneCount}/{r.required}・平均正確率{" "}
                        {r.avgRate == null ? "—" : `${r.avgRate}%`}
                      </div>
                      <button
                        className="button button-outline button-sm button-block"
                        onClick={() => setViewingTaskId(r.taskId)}
                        disabled={!r.taskId}
                      >
                        查看
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        </>
      )}
        </>
      )}
      {importOpen && (
        <ResultImportDialog
          indicators={indicators}
          user={user ? { staffId: user.staffId, name: user.name } : null}
          onAction={onAction}
          onClose={() => setImportOpen(false)}
          onDone={() => setReloadNonce((n) => n + 1)}
        />
      )}
    </div>
  );
}

/* ================= 品管審查結果匯入（v1.21.0） ================= */

/**
 * 各指標審查結果匯入：選組別→選指標（只列啟用）→選檔匯入。
 * 範本依所選指標審查表題目即時產生（前 6 欄固定＋每題一欄）。
 * 預檢：指標代號與題數不符即整檔中止；逐列未填忽略、非法值該列跳過。
 * 每列寫一筆 reviewRecord（source="import"，不自動建 reviewTasks），
 * 計入審核進度（unitId／year／month 參與進度計算）。
 */
function ResultImportDialog({
  indicators,
  user,
  onAction,
  onClose,
  onDone,
}: {
  indicators: IndicatorOpt[];
  user: { staffId: string; name: string } | null;
  onAction: (m: string) => void;
  onClose: () => void;
  onDone: () => void;
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
          getDocs(collection(db, "groups")),
          getDocs(collection(db, "units")),
          getDocs(collection(db, "users")),
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
      if (ok.length > 0) onDone();
    } catch (error) {
      setErrors([
        `讀取檔案失敗：${error instanceof Error ? error.message : "讀寫失敗"}`,
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="reviewer-modal-backdrop" onClick={onClose}>
      <div
        className="reviewer-modal panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="匯入品管審查結果"
      >
        <div className="reviewer-modal-head">
          <div>
            <h2>匯入品管審查結果</h2>
            <p>
              先選組別與指標（只列啟用），再選 Excel／CSV 檔匯入。預檢不符（指標代號或題數）即整檔中止；逐列未填忽略、非法值該列跳過。匯入的紀錄計入審核進度，不自動建立審查任務。
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
        <div className="form-actions">
          <button className="button button-outline" onClick={onClose}>
            關閉
          </button>
        </div>
      </div>
    </div>
  );
}
