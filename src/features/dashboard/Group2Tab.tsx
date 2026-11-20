/**
 * 儀表板第 2 群（v1.88.35）：品管組召集人、執行幹事、組長；
 * 單位護理長／副護理長（另含單位召集人／單位執行幹事）。
 * 範圍統一為「自己單位」。
 */
import { useMemo } from "react";
import { SectionTitle } from "../../components/ui";
import type { DashboardData } from "./useDashboardData";
import { RateCard } from "./RateCard";
import {
  auditCompletionRate,
  capaCompletionRate,
  nextMonthDistinctIndicators,
  unitThresholdRate,
} from "../../lib/dashboardGroups";
import { fmtYm } from "../../lib/ym";

export function Group2Tab({
  data,
  unitCode,
}: {
  data: DashboardData;
  unitCode: string;
}) {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;
  const nextYear = curMonth === 12 ? curYear + 1 : curYear;
  const nextMonth = curMonth === 12 ? 1 : curMonth + 1;
  const units = useMemo(() => (unitCode ? [unitCode] : []), [unitCode]);
  const thresholds = useMemo(
    () => new Map(data.indicators.map((i) => [i.id, i.threshold])),
    [data],
  );
  const completion = useMemo(
    () => auditCompletionRate(data.tasks, curYear, curMonth, units),
    [data, curYear, curMonth, units],
  );
  const threshold = useMemo(
    () => unitThresholdRate(data.records, thresholds, curYear, curMonth, units),
    [data, thresholds, curYear, curMonth, units],
  );
  const capa = useMemo(
    () => capaCompletionRate(data.capaCases, units),
    [data, units],
  );
  const nextCount = useMemo(
    () =>
      nextMonthDistinctIndicators(data.tasks, nextYear, nextMonth, units),
    [data, nextYear, nextMonth, units],
  );

  if (!unitCode) {
    return (
      <p className="settings-note">
        尚未設定所屬單位，請聯絡系統管理員。
      </p>
    );
  }

  return (
    <>
      <RateCard
        title={`單位查核完成率（${fmtYm(curYear, curMonth)}）`}
        note="本單位 · 本月任務"
        result={completion}
      />
      <RateCard
        title={`達閾值率（${fmtYm(curYear, curMonth)}）`}
        note="本單位 · 每指標月平均 vs 該指標閾值"
        result={threshold}
      />
      <RateCard
        title="單位 CAPA 完成率"
        note="本單位 · 正式結案／全部案件累計（不含已撤案）"
        result={capa}
      />
      <section className="panel">
        <SectionTitle
          title={`次月待審指標數（${fmtYm(nextYear, nextMonth)}）`}
          note="本單位 · 不重複指標支數"
        />
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <strong style={{ fontSize: 32 }}>{nextCount}</strong>
          <span className="muted-text">支指標</span>
        </div>
      </section>
    </>
  );
}
