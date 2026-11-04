import { useEffect, useMemo, useState } from "react";
import { SectionTitle } from "../components/ui";
import type { Indicator, Role } from "../types";

const QUARTERS = ["第1季", "第2季", "第3季", "第4季"] as const;
type ViewMode = "people" | "units";
type ResultRow = { name: string; values: number[]; audited: number[] };

const PEOPLE = ["示範人員 A", "示範人員 B", "示範人員 C", "示範人員 D"];
const UNITS = ["示範內科病房", "示範外科病房", "示範加護病房", "示範急診單位"];
const QUARTER_SHIFTS: Record<string, number[]> = {
  i1: [-4, -1, 2, 4],
  i2: [-2, 1, 0, 3],
  i3: [-5, -2, 1, 3],
  i4: [-3, 0, 2, 4],
  i5: [-6, -3, 0, 3],
  i6: [-2, 0, 2, 1],
};
const SUBJECT_OFFSETS = [-5, 2, 5, -1];

function createRows(
  indicator: Indicator,
  mode: ViewMode,
  role: Role,
): ResultRow[] {
  const names =
    role === "一般人員"
      ? ["本人（展示帳號）"]
      : role === "護理長"
        ? mode === "people"
          ? PEOPLE.map((name) => `示範內科病房 ${name}`)
          : [UNITS[0]]
        : mode === "people"
          ? PEOPLE
          : UNITS;
  const shifts = QUARTER_SHIFTS[indicator.id] ?? [-3, -1, 1, 3];
  const base = indicator.attainment;
  return names.map((name, subjectIndex) => ({
    name,
    values: shifts.map((shift) => {
      const subjectOffset =
        mode === "people"
          ? SUBJECT_OFFSETS[subjectIndex]
          : SUBJECT_OFFSETS[(subjectIndex + 1) % SUBJECT_OFFSETS.length];
      return Math.max(0, Math.min(100, base + shift + subjectOffset));
    }),
    audited: shifts.map((_, quarterIndex) =>
      mode === "people" ? 1 : 5 + ((subjectIndex + quarterIndex) % 5),
    ),
  }));
}

export function QuarterResults({
  indicators,
  role,
}: {
  indicators: Indicator[];
  role: Role;
}) {
  const [indicatorId, setIndicatorId] = useState(indicators[0]?.id ?? "");
  const [mode, setMode] = useState<ViewMode>(
    role === "護理長" ? "units" : "people",
  );
  const [selectedQuarter, setSelectedQuarter] = useState(0);
  useEffect(() => {
    setMode(role === "護理長" ? "units" : "people");
  }, [role]);
  const indicator =
    indicators.find((item) => item.id === indicatorId) ?? indicators[0];
  const effectiveMode: ViewMode = role === "一般人員" ? "people" : mode;
  const rows = useMemo(
    () => (indicator ? createRows(indicator, effectiveMode, role) : []),
    [indicator, effectiveMode, role],
  );
  const averages = QUARTERS.map((_, quarterIndex) =>
    rows.length
      ? rows.reduce((sum, row) => sum + row.values[quarterIndex], 0) /
        rows.length
      : 0,
  );

  if (role === "審查員") {
    return (
      <section className="panel quarter-panel">
        <SectionTitle
          title="季度審查結果趨勢"
          note="目前角色不顯示全院人員／單位比較"
        />
        <p className="quarter-empty">
          審查員應依任務查看本人經手的審查紀錄；本展示版尚未建立審查員個人任務資料，因此不顯示比較結果。
        </p>
      </section>
    );
  }

  if (!indicator) {
    return (
      <section className="panel quarter-panel">
        <SectionTitle title="季度審查結果趨勢" note="目前沒有可分析的指標" />
        <p className="quarter-empty">請先建立或載入展示指標資料。</p>
      </section>
    );
  }

  return (
    <section className="panel quarter-panel">
      <SectionTitle
        title="季度審查結果趨勢"
        note="依審查完成季度彙整 · 展示資料"
      />
      <div className="quarter-toolbar">
        <label className="quarter-control">
          <span>指標</span>
          <select
            value={indicator.id}
            onChange={(event) => setIndicatorId(event.target.value)}
          >
            {indicators.map((item) => (
              <option key={item.id} value={item.id}>
                {item.code}｜{item.name}
              </option>
            ))}
          </select>
        </label>
        <div
          className="quarter-mode"
          role="group"
          aria-label="選擇結果分析對象"
        >
          <button
            type="button"
            className={effectiveMode === "people" ? "active" : ""}
            onClick={() => setMode("people")}
          >
            人員結果
          </button>
          {role !== "一般人員" && (
            <button
              type="button"
              className={effectiveMode === "units" ? "active" : ""}
              onClick={() => setMode("units")}
            >
              單位結果
            </button>
          )}
        </div>
        <label className="quarter-control quarter-select">
          <span>明細季度</span>
          <select
            value={selectedQuarter}
            onChange={(event) => setSelectedQuarter(Number(event.target.value))}
          >
            {QUARTERS.map((quarter, index) => (
              <option key={quarter} value={index}>
                {quarter}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="quarter-summary">
        <div>
          <span>分析指標</span>
          <strong>{indicator.name}</strong>
        </div>
        <div>
          <span>指標閾值</span>
          <strong>{indicator.threshold}%</strong>
        </div>
        <div>
          <span>{QUARTERS[selectedQuarter]}平均</span>
          <strong>{averages[selectedQuarter].toFixed(1)}%</strong>
        </div>
        <div>
          <span>比較對象</span>
          <strong>
            {rows.length} {effectiveMode === "people" ? "位人員" : "個單位"}
          </strong>
        </div>
      </div>
      <QuarterLineChart rows={rows} threshold={indicator.threshold} />
      <div className="quarter-detail-heading">
        <div>
          <h3>{QUARTERS[selectedQuarter]}審查明細</h3>
          <span>符合率以百分比呈現；人員資料為匿名展示名稱</span>
        </div>
      </div>
      <div className="table-scroll">
        <table className="data-table quarter-table">
          <thead>
            <tr>
              <th>{effectiveMode === "people" ? "受審人員" : "受審單位"}</th>
              <th>符合率</th>
              <th>閾值</th>
              <th>結果</th>
              <th>審查數</th>
              <th>年度趨勢（Q1 → Q4）</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const score = row.values[selectedQuarter];
              return (
                <tr key={row.name}>
                  <td>
                    <b>{row.name}</b>
                  </td>
                  <td className="threshold-cell">{score}%</td>
                  <td>{indicator.threshold}%</td>
                  <td>
                    <span
                      className={`quarter-result ${score >= indicator.threshold ? "met" : "below"}`}
                    >
                      {score >= indicator.threshold ? "達標" : "未達標"}
                    </span>
                  </td>
                  <td>{row.audited[selectedQuarter]} 人次</td>
                  <td className="quarter-spark-values">
                    {row.values.map((value, index) => (
                      <span
                        className={index === selectedQuarter ? "selected" : ""}
                        key={index}
                      >
                        {value}%
                      </span>
                    ))}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6}>沒有可顯示的展示結果。</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="quarter-disclaimer">
        展示資料為虛構數值。正式結果應依審查完成紀錄、受審樣本及指標核定公式彙整；人員與單位資料範圍須依登入者權限控管。
      </p>
    </section>
  );
}

function QuarterLineChart({
  rows,
  threshold,
}: {
  rows: ResultRow[];
  threshold: number;
}) {
  const width = 760;
  const height = 220;
  const left = 48;
  const right = 730;
  const top = 24;
  const bottom = 174;
  const x = (index: number) => left + (index * (right - left)) / 3;
  const y = (value: number) => bottom - (value / 100) * (bottom - top);
  const palette = ["#0f766e", "#2563eb", "#b45309", "#7c3aed"];
  return (
    <div className="quarter-chart-wrap">
      <div className="quarter-chart-legend">
        {rows.map((row, index) => (
          <span key={row.name}>
            <i style={{ backgroundColor: palette[index % palette.length] }} />
            {row.name}
          </span>
        ))}
        <span className="threshold-legend">
          <i />
          閾值 {threshold}%
        </span>
      </div>
      <div className="quarter-chart-scroll">
        <svg
          className="quarter-chart"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="各人員或單位四季審查符合率折線圖"
        >
          {[0, 25, 50, 75, 100].map((value) => (
            <g key={value}>
              <line
                x1={left}
                x2={right}
                y1={y(value)}
                y2={y(value)}
                className="quarter-gridline"
              />
              <text
                x={left - 10}
                y={y(value) + 4}
                textAnchor="end"
                className="quarter-axis-label"
              >
                {value}%
              </text>
            </g>
          ))}
          <line
            x1={left}
            x2={right}
            y1={y(threshold)}
            y2={y(threshold)}
            className="quarter-threshold-line"
          />
          {QUARTERS.map((quarter, index) => (
            <text
              key={quarter}
              x={x(index)}
              y={bottom + 28}
              textAnchor="middle"
              className="quarter-axis-label"
            >
              {quarter}
            </text>
          ))}
          {rows.map((row, rowIndex) => (
            <g key={row.name}>
              <polyline
                points={row.values
                  .map((value, index) => `${x(index)},${y(value)}`)
                  .join(" ")}
                fill="none"
                stroke={palette[rowIndex % palette.length]}
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {row.values.map((value, index) => (
                <circle
                  key={index}
                  cx={x(index)}
                  cy={y(value)}
                  r="5"
                  fill={palette[rowIndex % palette.length]}
                  stroke="white"
                  strokeWidth="2"
                >
                  <title>{`${row.name} ${QUARTERS[index]} ${value}%`}</title>
                </circle>
              ))}
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}
