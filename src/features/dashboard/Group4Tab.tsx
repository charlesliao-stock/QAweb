/**
 * 儀表板第 4 群（v1.88.35）：護理師（另含指標負責人／一般人員）。
 * 單位本月重點指標、被審查數、達閾值率（期間＝年度或學年度，依系統設定）、
 * 次月待審指標數。
 */
import { useMemo } from "react";
import { SectionTitle } from "../../components/ui";
import type { DashboardData } from "./useDashboardData";
import {
  myPeriodStats,
  nextMonthDistinctIndicators,
} from "../../lib/dashboardGroups";
import type { StatsCycle } from "../../lib/resultAnalysis";
import { fmtYm } from "../../lib/ym";
import { stripInternalIdPrefix } from "../../lib/indicators";

export function Group4Tab({
  data,
  staffId,
  unitCode,
  cycle,
}: {
  data: DashboardData;
  staffId: string;
  unitCode: string;
  cycle: StatsCycle;
}) {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;
  const nextYear = curMonth === 12 ? curYear + 1 : curYear;
  const nextMonth = curMonth === 12 ? 1 : curMonth + 1;
  const thresholds = useMemo(
    () => new Map(data.indicators.map((i) => [i.id, i.threshold])),
    [data],
  );

  const focusIndicators = useMemo(() => {
    const ids = new Set<string>();
    for (const t of data.tasks) {
      if (t.unitId === unitCode && t.year === curYear && t.month === curMonth) {
        ids.add(t.indicatorId);
      }
    }
    return [...ids]
      .map((id) => data.indicatorMap.get(id) ?? stripInternalIdPrefix(id))
      .sort((a, b) => a.localeCompare(b, "zh-Hant"));
  }, [data, unitCode, curYear, curMonth]);

  const mine = useMemo(
    () => myPeriodStats(data.myRecords, staffId, thresholds, cycle, now),
    [data, staffId, thresholds, cycle],
  );
  const nextCount = useMemo(
    () =>
      unitCode
        ? nextMonthDistinctIndicators(data.tasks, nextYear, nextMonth, [unitCode])
        : 0,
    [data, unitCode, nextYear, nextMonth],
  );
  const periodLabel =
    cycle === "academic"
      ? `本學年度（${curMonth >= 8 ? curYear : curYear - 1} 年 8 月～本月）`
      : `本年度（${curYear} 年 1 月～本月）`;

  return (
    <>
      <section className="panel">
        <SectionTitle
          title={`單位本月重點指標（${fmtYm(curYear, curMonth)}）`}
          note={unitCode || "未設定單位"}
        />
        {!unitCode ? (
          <p className="settings-note">尚未設定所屬單位，請聯絡系統管理員。</p>
        ) : focusIndicators.length === 0 ? (
          <p className="settings-note">本月單位無排定審查指標。</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {focusIndicators.map((n) => (
              <li key={n} style={{ marginBottom: 6 }}>
                {n}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <SectionTitle title="被審查數" note={periodLabel} />
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <strong style={{ fontSize: 32 }}>{mine.count}</strong>
          <span className="muted-text">次</span>
        </div>
      </section>

      <section className="panel">
        <SectionTitle title="達閾值率" note={`${periodLabel} · 本人紀錄達各指標閾值筆數／總筆數`} />
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <strong style={{ fontSize: 32 }}>
            {mine.rate != null ? `${mine.rate}%` : "—"}
          </strong>
          <span className="muted-text">
            （{mine.pass}/{mine.count}）
          </span>
        </div>
      </section>

      <section className="panel">
        <SectionTitle
          title={`次月待審指標數（${fmtYm(nextYear, nextMonth)}）`}
          note="本單位 · 不重複指標支數"
        />
        {!unitCode ? (
          <p className="settings-note">尚未設定所屬單位，請聯絡系統管理員。</p>
        ) : (
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <strong style={{ fontSize: 32 }}>{nextCount}</strong>
            <span className="muted-text">支指標</span>
          </div>
        )}
      </section>
    </>
  );
}
