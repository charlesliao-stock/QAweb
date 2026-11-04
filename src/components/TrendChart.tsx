/**
 * SVG 折線趨勢圖（純展示，無外部依賴）。
 * v1.13.0：x 座標依點數動態分布、y 軸為 0–100 線性、支援可選 x 軸標籤。
 */
export function TrendChart({
  values = [],
  labels = [],
  legend = "整體達標率",
  currentLabel = "本月",
}: {
  values?: number[];
  /** x 軸標籤（例如月份），數量對齊 values */
  labels?: string[];
  legend?: string;
  currentLabel?: string;
}) {
  if (values.length === 0) {
    return (
      <div className="trend-chart-wrap">
        <div className="chart-empty">尚無趨勢資料</div>
      </div>
    );
  }
  const n = values.length;
  const x0 = 42;
  const x1 = 567;
  const step = n > 1 ? (x1 - x0) / (n - 1) : 0;
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const xOf = (i: number) => x0 + i * step;
  const yOf = (v: number) => 170 - clamp(v) * 1.35;
  const pts = values.map((v, i) => ({ x: xOf(i), y: yOf(v) }));
  const line = pts.map((p) => `${p.x},${p.y}`).join(" ");
  const latest = values[n - 1] ?? 0;
  return (
    <div className="trend-chart-wrap">
      <div className="chart-legend">
        <span>
          <i className="legend-line" />
          {legend}
        </span>
        <span className="chart-current">
          {currentLabel} <b>{latest}%</b>
        </span>
      </div>
      <svg
        className="trend-chart"
        viewBox="0 0 600 200"
        preserveAspectRatio="none"
        role="img"
        aria-label="趨勢圖"
      >
        <defs>
          <linearGradient id="areaFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#0f766e" stopOpacity=".14" />
            <stop offset="100%" stopColor="#0f766e" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[35, 75, 115, 155].map((y) => (
          <line
            key={y}
            x1="35"
            x2="565"
            y1={y}
            y2={y}
            className="chart-gridline"
          />
        ))}
        <path
          d={`M${x0},170 L${line.replaceAll(" ", " L")} L${x1},170 L${x0},170 Z`}
          fill="url(#areaFill)"
        />
        <polyline points={line} className="chart-line" />
        {pts.map((p, index) => (
          <circle
            key={index}
            cx={p.x}
            cy={p.y}
            r="4"
            className={
              index === n - 1 ? "chart-dot latest" : "chart-dot"
            }
          >
            <title>{values[index]}%</title>
          </circle>
        ))}
        {labels.map(
          (lb, index) =>
            index < n && (
              <text
                key={index}
                x={xOf(index)}
                y={190}
                textAnchor="middle"
                className="chart-label"
              >
                {lb}
              </text>
            ),
        )}
      </svg>
    </div>
  );
}
