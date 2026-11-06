/**
 * 護理長儀表板頁籤（v1.15.0）：範圍＝所屬單位（user.unitId）。
 * 48h 即時缺失紅字、次月受審預告、本單位 vs 全院兩大平均、超額加審提醒。
 * 絕不顯示其他單位數值。
 */
import { useMemo } from "react";
import { SectionTitle } from "../../components/ui";
import {
  recentAlerts,
  staffAvgRate,
  unitPassRate,
} from "../../lib/dashboardStats";
import {
  DEFAULT_DASHBOARD_SECTIONS,
  type DashboardSections,
} from "../../lib/dashboardSections";
import { requiredCases } from "../../lib/reviewProgress";
import type { DashboardData } from "./useDashboardData";

export function HeadNurseTab({
  data,
  unitCode,
  sections = DEFAULT_DASHBOARD_SECTIONS,
}: {
  data: DashboardData;
  unitCode: string;
  /** v1.28 階段 2：顯示設定旗標（預設只留 48h 警示／次月預告／超額加審） */
  sections?: DashboardSections;
}) {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;
  const nextMonth = curMonth === 12 ? 1 : curMonth + 1;
  const nextYear = curMonth === 12 ? curYear + 1 : curYear;

  const alerts = useMemo(
    () => recentAlerts(data.records, unitCode, 48),
    [data, unitCode],
  );

  const nextAudits = useMemo(
    () =>
      data.tasks.filter(
        (t) => t.unitId === unitCode && t.year === nextYear && t.month === nextMonth,
      ),
    [data, unitCode, nextYear, nextMonth],
  );

  // 本單位本月 vs 全院兩大平均（本月）
  const monthRecords = useMemo(
    () =>
      data.records.filter((r) => r.year === curYear && r.month === curMonth),
    [data, curYear, curMonth],
  );
  const myAvg = useMemo(
    () =>
      monthRecords.length
        ? (() => {
            const rs = monthRecords
              .filter((r) => r.unitId === unitCode)
              .map((r) => r.rate);
            const vals = rs.filter(
              (x): x is number => typeof x === "number",
            );
            return vals.length
              ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
              : null;
          })()
        : null,
    [monthRecords, unitCode],
  );
  const allAvg = useMemo(() => staffAvgRate(monthRecords), [monthRecords]);
  const thresholds = useMemo(
    () => new Map(data.indicators.map((i) => [i.id, i.threshold])),
    [data],
  );
  const pass = useMemo(
    () => unitPassRate(monthRecords, thresholds),
    [monthRecords, thresholds],
  );

  // 超額加審：完成數 ＞ 應審件數
  const overAudits = useMemo(
    () =>
      data.tasks.filter(
        (t) =>
          t.unitId === unitCode &&
          t.year === curYear &&
          t.month === curMonth &&
          t.doneCount > requiredCases(t.caseCount),
      ),
    [data, unitCode, curYear, curMonth],
  );

  return (
    <>
      {sections.alert48h && (
        <section className="panel" style={{ borderColor: "#e0a3a3" }}>
          <SectionTitle title="即時缺失通報（48 小時內）" note="紅字警示：審查員勾選不符合的細項" />
        {alerts.length === 0 ? (
          <p className="settings-note">近 48 小時無不符合紀錄。</p>
        ) : (
          alerts.map((a) => (
            <div key={a.recordId} style={{ marginBottom: 12 }}>
              <p style={{ margin: "0 0 4px" }}>
                <b style={{ color: "#b3372f" }}>
                  {data.indicatorMap.get(a.indicatorId) ?? a.indicatorId}
                </b>
                <span className="muted-text">（{a.reviewDate || "日期未填"}）</span>
              </p>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {a.items.map((it, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>
                    <span style={{ color: "#b3372f", fontWeight: 600 }}>
                      {it.itemText}
                    </span>
                    <span className="muted-text">（{it.optionLabel}）</span>
                    {it.note && <div className="settings-note">備註：{it.note}</div>}
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
        </section>
      )}

      {sections.nextMonthPreview && (
        <section className="panel">
          <SectionTitle
            title={`次月受審預告（${nextYear}/${String(nextMonth).padStart(2, "0")}）`}
          />
        {nextAudits.length === 0 ? (
          <p className="settings-note">次月本單位尚無排定審查。</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>指標名稱</th>
                  <th>應審件數</th>
                  <th>截止日期</th>
                </tr>
              </thead>
              <tbody>
                {nextAudits.map((t) => (
                  <tr key={t.id}>
                    <td>
                      {data.indicatorMap.get(t.indicatorId) ?? t.indicatorId}
                    </td>
                    <td>{t.caseCount ?? "未設定"}</td>
                    <td>{t.deadline}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </section>
      )}

      {/* v1.28 階段 2：單位 vs 全院平均改去「結果分析」看，程式保留、旗標關閉 */}
      {sections.unitAvg ? (
        <section className="panel">
          <SectionTitle
            title={`本單位 vs 全院基準（${curYear}/${String(curMonth).padStart(2, "0")}）`}
            note="僅顯示全院平均，不顯示其他單位數值"
          />
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th></th>
                <th>本單位平均正確率</th>
                <th>全院人員平均符合率</th>
                <th>全院單位達標率</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>本月</td>
                <td>{myAvg != null ? `${myAvg}%` : "—"}</td>
                <td>{allAvg != null ? `${allAvg}%` : "—"}</td>
                <td>
                  {pass.rate != null
                    ? `${pass.rate}%（${pass.pass}/${pass.total} 單位）`
                    : "—"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        </section>
      ) : (
        <p className="settings-note">單位 vs 全院平均已移至「結果分析」查看。</p>
      )}

      {sections.overAudit && overAudits.length > 0 && (
        <section className="panel">
          <SectionTitle title="超額加審提醒" note="完成數超過應審件數" />
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {overAudits.map((t) => (
              <li key={t.id}>
                {data.indicatorMap.get(t.indicatorId) ?? t.indicatorId}：
                已完成 {t.doneCount} 件（應審 {requiredCases(t.caseCount)} 件）
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
