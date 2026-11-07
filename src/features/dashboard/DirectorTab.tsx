/**
 * 主任儀表板頁籤（v1.15.0）：全院戰情總覽、科部雷達圖（SVG）、
 * 紅旗 Top3 指標／高風險單位。
 */
import { useMemo } from "react";
import { SectionTitle } from "../../components/ui";
import { radarMatrix, taskProgressCount } from "../../lib/dashboardStats";
import {
  DEFAULT_DASHBOARD_SECTIONS,
  type DashboardSections,
} from "../../lib/dashboardSections";
import { avgRateOf } from "../../lib/resultAnalysis";
import { requiredCases } from "../../lib/reviewProgress";
import type { DashboardData } from "./useDashboardData";

/** 簡易 SVG 雷達圖：axes 軸、series 系列（值 0–100） */
function RadarChart({
  axes,
  series,
}: {
  axes: string[];
  series: { name: string; values: (number | null)[] }[];
}) {
  const size = 300;
  const cx = size / 2;
  const cy = size / 2;
  const R = 110;
  const n = axes.length;
  if (n < 3) {
    return <p className="settings-note">組別不足，無法繪製雷達圖（至少需要 3 軸）。</p>;
  }
  const pt = (i: number, v: number): [number, number] => {
    const ang = (Math.PI * 2 * i) / n - Math.PI / 2;
    const r = (Math.max(0, Math.min(100, v)) / 100) * R;
    return [cx + r * Math.cos(ang), cy + r * Math.sin(ang)];
  };
  const gridPolys = [1, 0.75, 0.5, 0.25].map((f) =>
    Array.from({ length: n }, (_, i) => pt(i, f * 100).join(",")).join(" "),
  );
  const colors = ["#2e7d6f", "#b3372f", "#d9a441", "#4a6fa5", "#7b5ea7", "#c26d3d"];
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      style={{ maxWidth: 340, width: "100%", height: "auto" }}
      role="img"
      aria-label="科部雷達圖"
    >
      {gridPolys.map((p, i) => (
        <polygon
          key={i}
          points={p}
          fill="none"
          stroke="#cfd8dc"
          strokeWidth={1}
        />
      ))}
      {axes.map((ax, i) => {
        const [x, y] = pt(i, 100);
        const [lx, ly] = pt(i, 128);
        return (
          <g key={ax}>
            <line x1={cx} y1={cy} x2={x} y2={y} stroke="#cfd8dc" />
            <text
              x={lx}
              y={ly}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={11}
              fill="#546e7a"
            >
              {ax.length > 8 ? `${ax.slice(0, 8)}…` : ax}
            </text>
          </g>
        );
      })}
      {series.map((s, si) => {
        const vals = s.values.map((v) => v ?? 0);
        const pts = vals.map((v, i) => pt(i, v).join(",")).join(" ");
        const c = colors[si % colors.length];
        return (
          <polygon
            key={s.name}
            points={pts}
            fill={c}
            fillOpacity={0.18}
            stroke={c}
            strokeWidth={2}
          />
        );
      })}
      <g fontSize={12} fill="#37474f">
        {series.map((s, si) => (
          <g key={s.name} transform={`translate(8, ${size - 16 - si * 18})`}>
            <rect width={12} height={12} fill={colors[si % colors.length]} />
            <text x={18} y={11}>
              {s.name}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}

export function DirectorTab({
  data,
  sections = DEFAULT_DASHBOARD_SECTIONS,
}: {
  data: DashboardData;
  /** v1.28 階段 2：顯示設定旗標（預設只留全院戰情總覽，雷達／紅旗／高風險關閉） */
  sections?: DashboardSections;
}) {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;

  const monthTasks = useMemo(
    () =>
      data.tasks.filter((t) => t.year === curYear && t.month === curMonth),
    [data, curYear, curMonth],
  );
  const monthRecords = useMemo(
    () =>
      data.records.filter((r) => r.year === curYear && r.month === curMonth),
    [data, curYear, curMonth],
  );

  // 全院戰情：週期配額按 quota group 去重，temp/舊 task 則各自計算。
  const countedMonthTasks = useMemo(() => {
    const seenQuotaGroups = new Set<string>();
    return monthTasks.filter((task) => {
      if (!task.quotaGroupId) return true;
      if (seenQuotaGroups.has(task.quotaGroupId)) return false;
      seenQuotaGroups.add(task.quotaGroupId);
      return true;
    });
  }, [monthTasks]);
  const totalTasks = countedMonthTasks.length;
  const doneTasks = countedMonthTasks.filter((task) => {
    const count = taskProgressCount(task);
    return count != null && count >= requiredCases(task.caseCount);
  }).length;
  const totalRate =
    totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 1000) / 10 : null;
  // 月報的人次只算本月紀錄；週期 quota progress 不重複列入各月件數。
  const totalCases = monthRecords.length;
  // 綜合達標率：各單位月平均達標的比例
  const byUnit = new Map<string, (number | null)[]>();
  for (const r of monthRecords) {
    const arr = byUnit.get(r.unitId);
    if (arr) arr.push(r.rate);
    else byUnit.set(r.unitId, [r.rate]);
  }
  let passUnits = 0;
  for (const rates of byUnit.values()) {
    const avg = avgRateOf(rates);
    if (avg != null && avg >= 90) passUnits += 1;
  }
  const unitPassRate =
    byUnit.size > 0 ? Math.round((passUnits / byUnit.size) * 1000) / 10 : null;

  // 雷達矩陣：系列＝單位群組、軸＝指標分類組別
  const radar = useMemo(() => {
    const unitGroupOf = new Map<string, string>();
    for (const u of data.units) {
      if (u.groupId) unitGroupOf.set(u.id, data.groupMap.get(u.groupId) ?? u.groupId);
    }
    const indGroupOf = new Map<string, string>();
    for (const i of data.indicators) {
      if (i.groupId) indGroupOf.set(i.id, data.groupMap.get(i.groupId) ?? i.groupId);
    }
    return radarMatrix(monthRecords, unitGroupOf, indGroupOf);
  }, [data, monthRecords]);

  // 紅旗 Top3 指標（達標率最低）：以各指標達標單位比例計
  const redFlags = useMemo(() => {
    const byInd = new Map<string, Map<string, (number | null)[]>>();
    for (const r of monthRecords) {
      let m = byInd.get(r.indicatorId);
      if (!m) {
        m = new Map();
        byInd.set(r.indicatorId, m);
      }
      const arr = m.get(r.unitId);
      if (arr) arr.push(r.rate);
      else m.set(r.unitId, [r.rate]);
    }
    const rows: { id: string; name: string; passRate: number | null }[] = [];
    for (const [indId, umap] of byInd) {
      const ind = data.indicatorById.get(indId);
      const th = ind?.threshold ?? 0;
      let pass = 0;
      let total = 0;
      for (const rates of umap.values()) {
        const avg = avgRateOf(rates);
        if (avg == null) continue;
        total += 1;
        if (!(th > 0) || avg >= th) pass += 1;
      }
      rows.push({
        id: indId,
        name: ind?.name ?? indId,
        passRate: total > 0 ? Math.round((pass / total) * 1000) / 10 : null,
      });
    }
    return rows
      .filter((r) => r.passRate != null)
      .sort((a, b) => (a.passRate ?? 0) - (b.passRate ?? 0))
      .slice(0, 3);
  }, [data, monthRecords]);

  // 高風險單位：平均正確率最低 Top3
  const riskyUnits = useMemo(() => {
    const rows: { unitId: string; avg: number }[] = [];
    for (const [unitId, rates] of byUnit) {
      const avg = avgRateOf(rates);
      if (avg != null) rows.push({ unitId, avg });
    }
    return rows.sort((a, b) => a.avg - b.avg).slice(0, 3);
  }, [byUnit]);

  return (
    <>
      {sections.overview && (
        <section className="panel">
          <SectionTitle
            title={`全院品質戰情總覽（${curYear}/${String(curMonth).padStart(2, "0")}）`}
          />
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>全院查核完成率</th>
                <th>綜合達標率（單位≧90%）</th>
                <th>當月受審總人次</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <b>{totalRate != null ? `${totalRate}%` : "—"}</b>
                  <span className="muted-text">
                    （{doneTasks}/{totalTasks} 任務）
                  </span>
                </td>
                <td>
                  <b>{unitPassRate != null ? `${unitPassRate}%` : "—"}</b>
                  <span className="muted-text">
                    （{passUnits}/{byUnit.size} 單位）
                  </span>
                </td>
                <td>
                  <b>{totalCases}</b>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        </section>
      )}

      {/* v1.28 階段 2：雷達圖／紅旗／高風險單位改去「結果分析」看，程式保留、旗標關閉 */}
      {sections.radar ? (
        <section className="panel">
          <SectionTitle title="各科部品質雷達圖" note="系列＝單位群組、軸＝指標分類組別、值＝平均正確率" />
          {data.loading ? (
            <p className="settings-note">讀取中…</p>
          ) : (
            <RadarChart axes={radar.axes} series={radar.series} />
          )}
        </section>
      ) : (
        <p className="settings-note">科部雷達圖已移至「結果分析」查看。</p>
      )}

      {sections.redFlags ? (
        <section className="panel">
          <SectionTitle title="紅旗指標 Top3" note="達標率最低的指標" />
          {redFlags.length === 0 ? (
            <p className="settings-note">尚無資料。</p>
          ) : (
            <ol style={{ margin: 0, paddingLeft: 22 }}>
              {redFlags.map((r) => (
                <li key={r.id} style={{ marginBottom: 6 }}>
                  <b style={{ color: "#b3372f" }}>{r.name}</b>
                  <span className="muted-text">（達標率 {r.passRate}%）</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : (
        <p className="settings-note">紅旗指標 Top3 已移至「結果分析」查看。</p>
      )}

      {sections.riskyUnits ? (
        <section className="panel">
          <SectionTitle title="高風險單位 Top3" note="平均正確率最低的單位" />
          {riskyUnits.length === 0 ? (
            <p className="settings-note">尚無資料。</p>
          ) : (
            <ol style={{ margin: 0, paddingLeft: 22 }}>
              {riskyUnits.map((r) => (
                <li key={r.unitId} style={{ marginBottom: 6 }}>
                  <b style={{ color: "#b3372f" }}>{r.unitId}</b>
                  <span className="muted-text">（平均 {r.avg}%）</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : (
        <p className="settings-note">高風險單位 Top3 已移至「結果分析」查看。</p>
      )}
    </>
  );
}
