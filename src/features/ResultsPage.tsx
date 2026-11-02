import { ArrowRight, ArrowUpRight, ChevronDown, Download } from "lucide-react";
import { PageHeading, RagBadge, SectionTitle, ragFor } from "../components/ui";
import { TrendChart } from "../components/TrendChart";
import type { Indicator } from "../types";

export function ResultsPage({
  indicators,
  onAction,
}: {
  indicators: Indicator[];
  onAction: (message: string) => void;
}) {
  const achieved = indicators.filter(
    (item) => item.attainment >= item.threshold,
  ).length;
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
        <div className="filter-chip active">
          2026 年度 <ChevronDown size={14} />
        </div>
        <div className="filter-chip">
          全部組別 <ChevronDown size={14} />
        </div>
        <div className="filter-chip">
          全部指標 <ChevronDown size={14} />
        </div>
        <span className="filter-caption">資料歸屬依排程月份與單位代號</span>
      </div>
      <div className="results-kpis">
        <div className="result-kpi">
          <span>全院平均符合率</span>
          <strong>91.8%</strong>
          <small>
            <ArrowUpRight size={13} />
            較去年同期 +3.4%
          </small>
        </div>
        <div className="result-kpi">
          <span>單位平均達標率</span>
          <strong>82.1%</strong>
          <small>
            <ArrowUpRight size={13} />
            較去年同期 +1.8%
          </small>
        </div>
        <div className="result-kpi">
          <span>達標指標</span>
          <strong>
            {achieved}
            <small> / {indicators.length}</small>
          </strong>
          <small>本頁展示指標</small>
        </div>
        <div className="result-kpi">
          <span>未達標單位</span>
          <strong className="red-text">
            2<small> 個</small>
          </strong>
          <small>建議啟動改善追蹤</small>
        </div>
      </div>
      <div className="results-grid">
        <section className="panel trend-panel">
          <SectionTitle
            title="指標達標率趨勢"
            note="整體平均 · 2026 年 4–11 月"
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
                    style={{ width: `${item.attainment}%` }}
                  />
                  <span
                    className="threshold-marker"
                    style={{ left: `${item.threshold}%` }}
                  />
                </div>
                <small>閾值 {item.threshold}%</small>
              </div>
            ))}
          </div>
        </section>
      </div>
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
                <th>達標人數</th>
                <th>受審人數</th>
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
                  <td>{Math.round((item.audited * item.attainment) / 100)}</td>
                  <td>{item.audited}</td>
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
