import { MONTHLY_TREND, MONTHLY_TREND_LABELS } from "../data/demo";

const W = 600;
const H = 200;
const LEFT = 42;
const RIGHT = 567;
const TOP = 30;
const BOTTOM = 158;

export function TrendChart({
  values = MONTHLY_TREND,
  labels = MONTHLY_TREND_LABELS,
}: {
  values?: number[];
  labels?: string[];
}) {
  if (values.length === 0) return null;
  const lo = Math.floor((Math.min(...values) - 2) / 10) * 10;
  const hi = Math.max(lo + 10, Math.ceil(Math.max(...values) / 10) * 10);
  const step = values.length > 1 ? (RIGHT - LEFT) / (values.length - 1) : 0;
  const xAt = (i: number) => LEFT + i * step;
  const yAt = (v: number) => BOTTOM - ((v - lo) / (hi - lo)) * (BOTTOM - TOP);
  const points = values.map((v, i) => `${xAt(i)},${yAt(v)}`).join(" ");
  const last = values[values.length - 1];
  const gridYs = [0, 1, 2, 3].map((n) => TOP + (n * (BOTTOM - TOP)) / 3);
  return (
    <div className="trend-chart-wrap">
      <div className="chart-legend">
        <span>
          <i className="legend-line" />
          整體達標率
        </span>
        <span className="chart-current">
          本月 <b>{last}%</b>
        </span>
      </div>
      <svg
        className="trend-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`近 ${values.length} 個月達標率趨勢圖，最新為 ${last}%`}
      >
        <defs>
          <linearGradient id="areaFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#0f766e" stopOpacity=".14" />
            <stop offset="100%" stopColor="#0f766e" stopOpacity="0" />
          </linearGradient>
        </defs>
        {gridYs.map((y) => (
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
          d={`M${xAt(0)},${BOTTOM + 12} L${points.split(" ").join(" L")} L${xAt(values.length - 1)},${BOTTOM + 12} Z`}
          fill="url(#areaFill)"
        />
        <polyline points={points} className="chart-line" />
        {values.map((value, index) => (
          <circle
            key={index}
            cx={xAt(index)}
            cy={yAt(value)}
            r="4"
            className={
              index === values.length - 1 ? "chart-dot latest" : "chart-dot"
            }
          >
            <title>{`${labels[index] ?? ""} ${value}%`}</title>
          </circle>
        ))}
      </svg>
      <div className="chart-x-labels">
        {labels.map((month) => (
          <span key={month}>{month}</span>
        ))}
      </div>
    </div>
  );
}
