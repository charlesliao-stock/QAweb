/**
 * SVG 折線趨勢圖（純展示，無外部依賴）。
 * v1.13.0：x 座標依點數動態分布、y 軸為 0–100 線性、支援可選 x 軸標籤。
 * v1.27.0：hover 顯示期間＋正確率＋（正確數／審查數）；紅色虛線閾值線；
 * 點可點選（下探）；修正拉伸（preserveAspectRatio="meet"，保持 3:1 長寬比）。
 */
import { useState } from "react";

export function TrendChart({
  values = [],
  labels = [],
  tooltips = [],
  threshold = null,
  legend = "整體達標率",
  currentLabel = "本月",
  onPointClick,
}: {
  values?: number[];
  /** x 軸標籤（例如月份），數量對齊 values */
  labels?: string[];
  /** hover 提示文字（與 values 對齊；未提供時用「標籤：數值%」） */
  tooltips?: string[];
  /** 閾值（紅色虛線水平線；null 表示不畫） */
  threshold?: number | null;
  legend?: string;
  currentLabel?: string;
  /** 點選某點（下探用）；未提供時點不可點 */
  onPointClick?: (index: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
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
  /** Y 軸刻度（0／25／50／75／100，對齊 yOf 映射） */
  const yTicks = [100, 75, 50, 25, 0].map((v) => ({ v, y: yOf(v) }));
  const tipText = (i: number) =>
    tooltips[i] ??
    (labels[i] ? `${labels[i]}：${values[i]}%` : `${values[i]}%`);
  const thY = threshold != null ? yOf(threshold) : null;
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
      <div className="chart-svg-wrap">
        <svg
          className="trend-chart"
          viewBox="0 0 600 200"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="趨勢圖"
        >
          <defs>
            <linearGradient id="areaFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#0f766e" stopOpacity=".14" />
              <stop offset="100%" stopColor="#0f766e" stopOpacity="0" />
            </linearGradient>
          </defs>
          {yTicks.map(({ v, y }) => (
            <g key={v}>
              <line x1="35" x2="565" y1={y} y2={y} className="chart-gridline" />
              <text
                x="30"
                y={y + 4}
                textAnchor="end"
                className="chart-label"
              >
                {v}
              </text>
            </g>
          ))}
          {thY != null && (
            <g>
              <line
                x1="35"
                x2="565"
                y1={thY}
                y2={thY}
                className="chart-threshold"
              />
              <text
                x="563"
                y={thY - 5}
                textAnchor="end"
                className="chart-threshold-label"
              >
                閾值 {threshold}%
              </text>
            </g>
          )}
          <path
            d={`M${x0},170 L${line.replaceAll(" ", " L")} L${x1},170 L${x0},170 Z`}
            fill="url(#areaFill)"
          />
          <polyline points={line} className="chart-line" />
          {pts.map((p, index) => (
            <g key={index}>
              {/* 加大命中區（hover／點選好點） */}
              <circle
                cx={p.x}
                cy={p.y}
                r="12"
                fill="transparent"
                style={{ cursor: onPointClick ? "pointer" : "default" }}
                onMouseEnter={() => setHover(index)}
                onMouseLeave={() => setHover(null)}
                onClick={() => {
                  setHover(index);
                  onPointClick?.(index);
                }}
              >
                <title>{tipText(index)}</title>
              </circle>
              <circle
                cx={p.x}
                cy={p.y}
                r="4"
                className={
                  `chart-dot${index === n - 1 ? " latest" : ""}` +
                  (onPointClick ? " clickable" : "")
                }
                style={{ pointerEvents: "none" }}
              />
            </g>
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
        {hover != null && (
          <div
            className="chart-tip"
            style={{
              left: `${(pts[hover].x / 600) * 100}%`,
              top: `${(pts[hover].y / 200) * 100}%`,
            }}
          >
            {tipText(hover)}
          </div>
        )}
      </div>
    </div>
  );
}
