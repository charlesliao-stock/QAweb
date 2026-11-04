/**
 * 督導儀表板頁籤（v1.15.0）：轄區＝負責群組下的單位。
 * 各單位進度＋品質燈號、連續下滑／未達標警訊。
 */
import { useMemo } from "react";
import { SectionTitle } from "../../components/ui";
import {
  declineAlerts,
  unitMonthAvgs,
} from "../../lib/dashboardStats";
import { avgRateOf, ragStatus } from "../../lib/resultAnalysis";
import { requiredCases } from "../../lib/reviewProgress";
import type { DashboardData } from "./useDashboardData";

function ymOf(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function SupervisorTab({
  data,
  districtGroupIds,
}: {
  data: DashboardData;
  districtGroupIds: string[];
}) {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;

  const districtUnits = useMemo(
    () => data.units.filter((u) => districtGroupIds.includes(u.groupId)),
    [data, districtGroupIds],
  );
  const districtUnitIds = useMemo(
    () => new Set(districtUnits.map((u) => u.id)),
    [districtUnits],
  );

  const ym = ymOf(curYear, curMonth);
  // 各單位本月進度＋品質燈號
  const unitRows = useMemo(() => {
    return districtUnits.map((u) => {
      const tasks = data.tasks.filter(
        (t) => t.unitId === u.id && t.year === curYear && t.month === curMonth,
      );
      const done = tasks.reduce((n, t) => n + t.doneCount, 0);
      const req = tasks.reduce((n, t) => n + requiredCases(t.caseCount), 0);
      const rates = data.records
        .filter(
          (r) => r.unitId === u.id && r.year === curYear && r.month === curMonth,
        )
        .map((r) => r.rate);
      const avg = avgRateOf(rates);
      // 燈號：用該單位本月指標的最低閾值判定（簡化）
      const ths = tasks
        .map((t) => data.indicatorById.get(t.indicatorId)?.threshold ?? 0)
        .filter((x) => x > 0);
      const th = ths.length ? Math.min(...ths) : 0;
      return {
        unit: u,
        done,
        req,
        avg,
        rag: ragStatus(avg, th),
        complete: req > 0 && done >= req,
      };
    });
  }, [data, districtUnits, curYear, curMonth]);

  // 連續下滑／未達標警訊（近三個月）
  const alerts = useMemo(() => {
    const yms: [string, string, string] = [0, 1, 2].map((k) => {
      let y = curYear;
      let m = curMonth - k;
      while (m <= 0) {
        m += 12;
        y -= 1;
      }
      return ymOf(y, m);
    }).reverse() as [string, string, string];
    const rows = unitMonthAvgs(data.records, yms).filter((r) =>
      districtUnitIds.has(r.unitId),
    );
    return declineAlerts(rows, yms, 90);
  }, [data, districtUnitIds, curYear, curMonth]);

  if (districtGroupIds.length === 0) {
    return (
      <section className="panel">
        <SectionTitle title="督導轄區" />
        <p className="settings-note">
          尚未設定負責群組，請聯絡系統管理員至「群組與人員」→ 人員編輯 → 督導轄區群組勾選。
        </p>
      </section>
    );
  }

  return (
    <>
      {alerts.length > 0 && (
        <section className="panel" style={{ borderColor: "#e0a3a3" }}>
          <SectionTitle title="品質警訊" note="連續下滑或未達標單位" />
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {alerts.map((a) => (
              <li key={`${a.unitId}-${a.kind}`} style={{ marginBottom: 6 }}>
                <b style={{ color: "#b3372f" }}>{a.unitId}</b>：{a.detail}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <SectionTitle
          title={`轄區單位進度（${ym.replace("-", "/")}）`}
          note={`共 ${districtUnits.length} 個單位`}
        />
        {unitRows.length === 0 ? (
          <p className="settings-note">轄區內尚無單位。</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>單位</th>
                  <th>完成/應審件數</th>
                  <th>平均正確率</th>
                  <th>品質燈號</th>
                  <th>狀態</th>
                </tr>
              </thead>
              <tbody>
                {unitRows.map((r) => (
                  <tr key={r.unit.id}>
                    <td>{r.unit.code}</td>
                    <td>
                      {r.req > 0
                        ? `${r.done}/${r.req}`
                        : "本月無任務"}
                    </td>
                    <td>{r.avg != null ? `${r.avg}%` : "—"}</td>
                    <td>
                      <span
                        className={`status-pill${
                          r.rag === "green"
                            ? " success"
                            : r.rag === "red"
                              ? " danger"
                              : ""
                        }`}
                      >
                        {r.rag === "green"
                          ? "達標"
                          : r.rag === "red"
                            ? "未達標"
                            : "無資料"}
                      </span>
                    </td>
                    <td>
                      {r.req === 0 ? (
                        <span className="muted-text">—</span>
                      ) : (
                        <span
                          className={`status-pill${r.complete ? " success" : " warning"}`}
                        >
                          {r.complete ? "已完成" : "進行中"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="task-cards">
        {unitRows.map((r) => (
          <div key={r.unit.id} className="task-card">
            <div className="task-card-top">
              <b>{r.unit.code}</b>
              <span
                className={`status-pill${
                  r.rag === "green"
                    ? " success"
                    : r.rag === "red"
                      ? " danger"
                      : ""
                }`}
              >
                {r.rag === "green" ? "達標" : r.rag === "red" ? "未達標" : "無資料"}
              </span>
            </div>
            <div className="task-card-meta">
              <span>
                完成/應審：{r.req > 0 ? `${r.done}/${r.req}` : "本月無任務"}
              </span>
              <span>
                平均正確率：{r.avg != null ? `${r.avg}%` : "—"}
              </span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
