/**
 * 護理師儀表板頁籤（v1.15.0）：個人受審得分走勢、個人常犯扣分 Top3、
 * 單位本月重點指標；審查員姓名一律隱藏（不顯示）。
 */
import { useMemo } from "react";
import { SectionTitle } from "../../components/ui";
import {
  personalTrend,
  weakTop3,
} from "../../lib/dashboardStats";
import {
  DEFAULT_DASHBOARD_SECTIONS,
  type DashboardSections,
} from "../../lib/dashboardSections";
import type { DashboardData } from "./useDashboardData";

export function NurseTab({
  data,
  staffId,
  unitCode,
  sections = DEFAULT_DASHBOARD_SECTIONS,
}: {
  data: DashboardData;
  staffId: string;
  unitCode: string;
  /** v1.28 階段 2：顯示設定旗標（預設只留本月重點指標） */
  sections?: DashboardSections;
}) {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;

  const trend = useMemo(
    () => personalTrend(data.records, staffId, 6),
    [data, staffId],
  );
  const weak = useMemo(
    () => weakTop3(data.records, staffId),
    [data, staffId],
  );
  // 單位本月重點指標：本月該單位有排程任務的指標
  const focusIndicators = useMemo(() => {
    const ids = new Set<string>();
    for (const t of data.tasks) {
      if (t.unitId === unitCode && t.year === curYear && t.month === curMonth) {
        ids.add(t.indicatorId);
      }
    }
    return [...ids]
      .map((id) => data.indicatorMap.get(id) ?? id)
      .sort((a, b) => a.localeCompare(b, "zh-Hant"));
  }, [data, unitCode, curYear, curMonth]);

  const maxRate = Math.max(0, ...trend.map((r) => r.rate ?? 0));

  return (
    <>
      {/* v1.28 階段 2：個人走勢／常犯扣分改去「結果分析」看，程式保留、旗標關閉 */}
      {sections.personalTrend ? (
        <section className="panel">
          <SectionTitle title="我的受審得分走勢" note="近 6 次" />
        {trend.length === 0 ? (
          <p className="settings-note">尚無受審紀錄。</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>審查日期</th>
                  <th>指標名稱</th>
                  <th>正確率</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {trend.map((r) => (
                  <tr key={r.id}>
                    <td>{r.reviewDate || "—"}</td>
                    <td>{data.indicatorMap.get(r.indicatorId) ?? r.indicatorId}</td>
                    <td>{r.rate != null ? `${r.rate}%` : "—"}</td>
                    <td style={{ minWidth: 120 }}>
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
                            width: `${maxRate > 0 ? ((r.rate ?? 0) / 100) * 100 : 0}%`,
                            height: "100%",
                            background:
                              (r.rate ?? 0) >= 90 ? "#3f9e6e" : "#d9a441",
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
        <p className="settings-note">個人走勢已移至「結果分析」查看。</p>
      )}

      {sections.weakTop3 ? (
        <section className="panel">
          <SectionTitle title="個人常犯扣分 Top3" note="依題目聚合未符合（0 分）的次數" />
        {weak.length === 0 ? (
          <p className="settings-note">尚無扣分紀錄，繼續保持。</p>
        ) : (
          <ol style={{ margin: "0 0 8px", paddingLeft: 22 }}>
            {weak.map((w) => (
              <li key={w.itemText} style={{ marginBottom: 8 }}>
                <b>{w.itemText}</b>
                <div className="settings-note">
                  未符合 {w.miss} 次（共 {w.total} 次受審）
                </div>
              </li>
            ))}
          </ol>
        )}
        </section>
      ) : (
        <p className="settings-note">個人常犯扣分 Top3 已移至「結果分析」查看。</p>
      )}

      {sections.focusIndicators && (
        <section className="panel">
        <SectionTitle
          title={`單位本月重點指標（${curYear}/${String(curMonth).padStart(2, "0")}）`}
          note={unitCode || "未設定單位"}
        />
        {focusIndicators.length === 0 ? (
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
      )}
    </>
  );
}
