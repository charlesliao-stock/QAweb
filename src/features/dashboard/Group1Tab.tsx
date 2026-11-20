/**
 * 儀表板第 1 群（v1.88.35）：委員會各角色、部級各職稱、系統管理員。
 * 只顯示全院三率＋系統公告（公告在 DashboardPage 頂部）。
 * 督導範圍限轄區（titleUnitCodes），其餘為全院。
 */
import { useMemo } from "react";
import type { DashboardData } from "./useDashboardData";
import { RateCard } from "./RateCard";
import {
  auditCompletionRate,
  capaCompletionRate,
  scopeUnitCodes,
  unitThresholdRate,
  type DashboardScope,
} from "../../lib/dashboardGroups";
import { fmtYm } from "../../lib/ym";

export function Group1Tab({
  data,
  scope,
}: {
  data: DashboardData;
  scope: DashboardScope;
}) {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;
  const units = useMemo(() => scopeUnitCodes(scope), [scope]);
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
  const scopeLabel =
    scope.kind === "all"
      ? "全院"
      : scope.kind === "units"
        ? "負責轄區"
        : "所屬單位";

  if (scope.kind === "units" && scope.unitCodes.length === 0) {
    return (
      <p className="settings-note">
        尚未設定負責單位，請聯絡系統管理員。
      </p>
    );
  }

  return (
    <>
      <RateCard
        title={`全院查核完成率（${fmtYm(curYear, curMonth)}）`}
        note={`${scopeLabel} · 本月任務`}
        result={completion}
      />
      <RateCard
        title={`全院單位達閾值率（${fmtYm(curYear, curMonth)}）`}
        note={`${scopeLabel} · 每單位每指標月平均 vs 該指標閾值`}
        result={threshold}
      />
      <RateCard
        title="全院 CAPA 完成率"
        note={`${scopeLabel} · 正式結案／全部案件累計（不含已撤案）`}
        result={capa}
      />
    </>
  );
}
