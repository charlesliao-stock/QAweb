/**
 * 召集人儀表板頁籤（v1.15.0）：組別下拉 → 該組指標全院達標率、
 * 扣分柏拉圖 Top3（全院答案聚合）。
 */
import { useMemo, useState } from "react";
import { SectionTitle } from "../../components/ui";
import { paretoTop3 } from "../../lib/dashboardStats";
import {
  DEFAULT_DASHBOARD_SECTIONS,
  type DashboardSections,
} from "../../lib/dashboardSections";
import { avgRateOf } from "../../lib/resultAnalysis";
import type { DashboardData } from "./useDashboardData";

export function ConvenerTab({
  data,
  sections = DEFAULT_DASHBOARD_SECTIONS,
}: {
  data: DashboardData;
  /** v1.28 階段 2：顯示設定旗標（預設只留組別達標率，帕累托關閉） */
  sections?: DashboardSections;
}) {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;

  // 有指標的組別（依指標 groupId）
  const usedGroups = useMemo(() => {
    const ids = new Set(data.indicators.map((i) => i.groupId).filter(Boolean));
    return data.groups.filter((g) => ids.has(g.id));
  }, [data]);
  const [groupId, setGroupId] = useState("");
  const activeGroupId = groupId || usedGroups[0]?.id || "";

  const groupIndicators = useMemo(
    () => data.indicators.filter((i) => i.groupId === activeGroupId),
    [data, activeGroupId],
  );

  // 該組各指標本月全院達標率
  const stats = useMemo(() => {
    const monthRecs = data.records.filter(
      (r) => r.year === curYear && r.month === curMonth,
    );
    return groupIndicators.map((ind) => {
      const recs = monthRecs.filter((r) => r.indicatorId === ind.id);
      const byUnit = new Map<string, (number | null)[]>();
      for (const r of recs) {
        const arr = byUnit.get(r.unitId);
        if (arr) arr.push(r.rate);
        else byUnit.set(r.unitId, [r.rate]);
      }
      let pass = 0;
      let total = 0;
      for (const rates of byUnit.values()) {
        const avg = avgRateOf(rates);
        if (avg == null) continue;
        total += 1;
        if (!(ind.threshold > 0) || avg >= ind.threshold) pass += 1;
      }
      return {
        id: ind.id,
        name: ind.name,
        threshold: ind.threshold,
        pass,
        total,
        passRate:
          total > 0 ? Math.round((pass / total) * 1000) / 10 : null,
      };
    });
  }, [data, groupIndicators, curYear, curMonth]);

  const pareto = useMemo(() => {
    const ids = new Set(groupIndicators.map((i) => i.id));
    return paretoTop3(data.records, ids);
  }, [data, groupIndicators]);

  return (
    <>
      <section className="panel">
        <div className="form-field" style={{ maxWidth: 320 }}>
          <label className="field-label">指標分類組別</label>
          <div className="select-wrap">
            <select
              value={activeGroupId}
              onChange={(e) => setGroupId(e.target.value)}
            >
              {usedGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {sections.groupPassRate && (
        <section className="panel">
          <SectionTitle
            title={`本組指標全院達標率（${curYear}/${String(curMonth).padStart(2, "0")}）`}
          />
        {stats.length === 0 ? (
          <p className="settings-note">該組別尚無指標。</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>指標名稱</th>
                  <th>達標單位數</th>
                  <th>達標率</th>
                  <th>燈號</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td>
                      {s.pass}/{s.total}
                    </td>
                    <td>{s.passRate != null ? `${s.passRate}%` : "—"}</td>
                    <td>
                      <span
                        className={`status-pill${
                          s.total === 0
                            ? ""
                            : s.pass === s.total
                              ? " success"
                              : " danger"
                        }`}
                      >
                        {s.total === 0
                          ? "無資料"
                          : s.pass === s.total
                            ? "全數達標"
                            : "有未達標"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </section>
      )}

      {/* v1.28 階段 2：扣分柏拉圖 Top3 改去「結果分析」看，程式保留、旗標關閉 */}
      {sections.pareto ? (
        <section className="panel">
          <SectionTitle title="扣分柏拉圖 Top3" note="全院該組指標最常被扣分的題目" />
        {pareto.length === 0 ? (
          <p className="settings-note">尚無扣分紀錄。</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>題目</th>
                  <th>扣分次數</th>
                  <th>累積 %</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pareto.map((p, i) => (
                  <tr key={p.itemText}>
                    <td>{i + 1}</td>
                    <td style={{ maxWidth: 320 }}>{p.itemText}</td>
                    <td>{p.count}</td>
                    <td>{p.cumPct}%</td>
                    <td style={{ minWidth: 100 }}>
                      <div
                        style={{
                          height: 8,
                          borderRadius: 4,
                          background: "#e8eef0",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${Math.min(100, p.cumPct)}%`,
                            height: "100%",
                            background: "#b3372f",
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </section>
      ) : (
        <p className="settings-note">扣分柏拉圖 Top3 已移至「結果分析」查看。</p>
      )}
    </>
  );
}
