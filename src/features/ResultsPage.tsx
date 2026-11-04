/**
 * 結果分析頁（v1.13.0：佔位文字改為真實串接）。
 * 三區塊：指標趨勢（月平均正確率折線）、達標統計（各指標 RAG）、結果明細（各單位＋查看）。
 * 資料歸屬依排程月份（reviewTasks.year/month）與單位代號；權限用 can("resultQuery") gating；
 * 資料範圍：管理員全部、審查員只看自己負責單位、一般人員只看自己單位。
 */
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { collection, getDocs, query, where } from "../lib/db";
import { getFirebaseDb } from "../lib/firebase";
import { useAuth } from "../lib/auth";
import { usePermissions } from "../lib/usePermissions";
import { primaryThreshold } from "../lib/indicators";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { TrendChart } from "../components/TrendChart";
import { ReviewExecutePage } from "./ReviewExecutePage";
import {
  filterByScope,
  indicatorMonthStats,
  monthlyTrend,
  unitMonthRows,
  type AnalysisTask,
  type DataScope,
  type RagState,
  type RateRecord,
} from "../lib/resultAnalysis";

interface IndicatorOpt {
  id: string;
  name: string;
  threshold: number;
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

  const scope: DataScope = useMemo(() => {
    const roles = user?.roles ?? [];
    if (roles.includes("系統管理員")) return { kind: "admin" };
    if (user && roles.includes("審查員"))
      return { kind: "reviewer", staffId: user.staffId };
    if (user) return { kind: "staff", unitCode: user.unitCode };
    return { kind: "admin" };
  }, [user]);

  // 指標清單（名稱＋主閾值）
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
          list.push({ id: d.id, name, threshold: primaryThreshold(data) });
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
  }, [selYear]);

  const scoped = useMemo(
    () => filterByScope(tasks, records, scope),
    [tasks, records, scope],
  );
  const thresholds = useMemo(
    () => new Map(indicators.map((i) => [i.id, i.threshold])),
    [indicators],
  );
  const selInd = indicators.find((i) => i.id === selIndicator);
  const trend = useMemo(
    () => monthlyTrend(scoped.records, selIndicator),
    [scoped, selIndicator],
  );
  const stats = useMemo(
    () =>
      indicatorMonthStats(scoped.tasks, scoped.records, selYear, selMonth, thresholds),
    [scoped, selYear, selMonth, thresholds],
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
  const trendLabels = trend.map((t) => `${t.month}月`);

  return (
    <div className="results-page">
      <PageHeading
        page="results"
        action={
          <button
            className="button button-outline"
            onClick={() => onAction("報表匯出功能開發中")}
          >
            <Download size={16} />
            匯出報表
          </button>
        }
      />

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
              note={
                selInd
                  ? `${selInd.name}・${selYear}年各月份平均正確率`
                  : undefined
              }
            />
            {trend.length === 0 ? (
              <div className="chart-empty">尚無趨勢資料</div>
            ) : (
              <TrendChart
                values={trendValues}
                labels={trendLabels}
                legend="平均正確率"
                currentLabel={`${trend[trend.length - 1].month}月`}
              />
            )}
          </section>

          <section className="panel">
            <SectionTitle
              title="達標統計"
              note={`${selYear}年${selMonth}月・達標率＝達標單位數 ÷ 已完成單位數`}
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
    </div>
  );
}
