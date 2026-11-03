export function TrendChart({ values = [] }: { values?: number[] }) {
  if (values.length === 0) {
    return (
      <div className="trend-chart-wrap">
        <div className="chart-empty">尚無趨勢資料</div>
      </div>
    );
  }
  const points = values
    .map((value, index) => `${42 + index * 75},${158 - (value - 70) * 4.2}`)
    .join(" ");
  const latest = values[values.length - 1] ?? 0;
  return (
    <div className="trend-chart-wrap">
      <div className="chart-legend">
        <span>
          <i className="legend-line" />
          整體達標率
        </span>
        <span className="chart-current">
          本月 <b>{latest}%</b>
        </span>
      </div>
      <svg
        className="trend-chart"
        viewBox="0 0 600 200"
        preserveAspectRatio="none"
        role="img"
        aria-label="達標率趨勢圖"
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
          d={`M42,158 L${points.replaceAll(" ", " L")} L567,170 L42,170 Z`}
          fill="url(#areaFill)"
        />
        <polyline points={points} className="chart-line" />
        {values.map((value, index) => (
          <circle
            key={index}
            cx={42 + index * 75}
            cy={158 - (value - 70) * 4.2}
            r="4"
            className={
              index === values.length - 1 ? "chart-dot latest" : "chart-dot"
            }
          >
            <title>{value}%</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}
