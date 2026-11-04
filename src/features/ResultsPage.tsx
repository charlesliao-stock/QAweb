import { ArrowRight, ChevronDown, Download } from "lucide-react";
import { PageHeading, RagBadge, SectionTitle, ragFor } from "../components/ui";
import { TrendChart } from "../components/TrendChart";
import { QuarterResults } from "./QuarterResults";
import type { FirebaseProfile } from "../lib/firebase";
import type { Indicator, Role } from "../types";
export function ResultsPage({
  indicators,
  role,
  firebaseMode,
  profile,
  onAction,
}: {
  indicators: Indicator[];
  role: Role;
  firebaseMode: boolean;
  profile: FirebaseProfile | null;
  onAction: (message: string) => void;
}) {
  if (firebaseMode) {
    return (
      <>
        <PageHeading
          page="results"
          action={
            <button
              className="button button-outline"
              onClick={() =>
                onAction(
                  "正式匯出尚未開放；目前結果只讀取 Firestore 測試紀錄。",
                )
              }
            >
              <Download size={16} />
              匯出報表
            </button>
          }
        />
        <div className="results-filter">
          <span className="filter-caption">
            資料來源：Firestore reviewRecords · 僅顯示已送出紀錄
          </span>
        </div>
        <QuarterResults
          indicators={indicators}
          role={role}
          firebaseMode={true}
          profile={profile}
        />
      </>
    );
  }
  const achieved = indicators.filter(
    (item) => item.attainment >= item.threshold,
  ).length;
  const notAchieved = indicators.length - achieved;
  const averageAttainment = indicators.length
    ? indicators.reduce((sum, item) => sum + item.attainment, 0) /
      indicators.length
    : 0;
  const achievementRate = indicators.length
    ? (achieved / indicators.length) * 100
    : 0;
  return (
    <>
      <PageHeading
        page="results"
        action={
          <button
            className="button button-outline"
            onClick={() => onAction("展示版不會匯出真實或正式報表")}
          >
            <Download size={16} />
            匯出報表
          </button>
        }
      />
      <div className="results-filter">
        <button
          type="button"
          className="filter-chip active"
          onClick={() => onAction("展示篩選：2026 年度")}
        >
          2026 年度 <ChevronDown size={14} />
        </button>
        <button
          type="button"
          className="filter-chip"
          onClick={() => onAction("展示篩選：全部組別")}
        >
          全部組別 <ChevronDown size={14} />
        </button>
        <button
          type="button"
          className="filter-chip"
          onClick={() => onAction("展示篩選：全部指標")}
        >
          全部指標 <ChevronDown size={14} />
        </button>
        <span className="filter-caption">資料歸屬依排程月份與單位代號</span>
      </div>
      <div className="results-kpis">
        <div className="result-kpi">
          <span>展示指標平均符合率</span>
          <strong>{averageAttainment.toFixed(1)}%</strong>
          <small>目前展示指標的算術平均，非正式全院統計</small>
        </div>
        <div className="result-kpi">
          <span>達標指標比例</span>
          <strong>{achievementRate.toFixed(1)}%</strong>
          <small>
            {achieved} / {indicators.length} 項達標
          </small>
        </div>
        <div className="result-kpi">
          <span>達標指標</span>
          <strong>
            {achieved}
            <small> / {indicators.length}</small>
          </strong>
          <small>依各指標閾值判定</small>
        </div>
        <div className="result-kpi">
          <span>未達標指標</span>
          <strong className="red-text">
            {notAchieved}
            <small> 項</small>
          </strong>
          <small>符合率低於各自閾值</small>
        </div>
      </div>
      <div className="results-grid">
        <section className="panel trend-panel">
          <SectionTitle
            title="指標達標率趨勢"
            note="固定虛構趨勢資料 · 2026 年 4–11 月"
            action={
              <button
                className="select-like"
                onClick={() => onAction("圖表顯示虛構趨勢資料")}
              >
                <span>月趨勢</span>
                <ChevronDown size={14} />
              </button>
            }
          />
          <TrendChart />
        </section>
        <section className="panel chart-panel">
          <SectionTitle title="指標達標概況" note="依展示資料排序" />
          <div className="bar-list">
            {indicators.slice(0, 5).map((item) => (
              <div className="bar-row" key={item.id}>
                <div className="bar-label">
                  <span>{item.name}</span>
                  <b>{item.attainment}%</b>
                </div>
                <div className="bar-track">
                  <i
                    className={`bar-fill ${ragFor(item.attainment, item.threshold)}`}
                    style={{
                      width: `${Math.max(0, Math.min(100, item.attainment))}%`,
                    }}
                  />
                  <span
                    className="threshold-marker"
                    style={{
                      left: `${Math.max(0, Math.min(100, item.threshold))}%`,
                    }}
                  />
                </div>
                <small>閾值 {item.threshold}%</small>
              </div>
            ))}
          </div>
        </section>
      </div>
      <QuarterResults
        indicators={indicators}
        role={role}
        firebaseMode={false}
        profile={null}
      />
      <section className="panel data-panel results-table-panel">
        <SectionTitle
          title="指標結果明細"
          note="月度彙整 · 展示資料"
          action={
            <button
              className="text-button"
              onClick={() => onAction("明細限本地虛構資料")}
            >
              查看趨勢 <ArrowRight size={14} />
            </button>
          }
        />
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>指標</th>
                <th>組別</th>
                <th>閾值</th>
                <th>符合率</th>
                <th>已審人數</th>
                <th>規劃人數</th>
                <th>狀態</th>
              </tr>
            </thead>
            <tbody>
              {indicators.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div className="indicator-title">
                      <b>{item.name}</b>
                      <span>{item.code}</span>
                    </div>
                  </td>
                  <td>{item.group}</td>
                  <td>{item.threshold}%</td>
                  <td className="threshold-cell">{item.attainment}%</td>
                  <td>{item.audited}</td>
                  <td>{item.planned}</td>
                  <td>
                    <RagBadge
                      value={item.attainment}
                      threshold={item.threshold}
                      compact
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
