/**
 * SVG 折線趨勢圖（純展示，無外部依賴）。
 * v1.13.0：x 座標依點數動態分布、y 軸為 0–100 線性、支援可選 x 軸標籤。
 * v1.27.0：hover 顯示期間＋正確率＋（正確數／審查數）；紅色虛線閾值線；
 * 點可點選（下探）；修正拉伸（preserveAspectRatio="meet"，保持 3:1 長寬比）。
 * v1.50.0：只有一個資料點時只畫一個點、放圖中央（x=300），不畫折線與面積；
 * hover 提示框改跟滑鼠（onMouseMove 取滑鼠在容器內的座標定位）；圖例列右側
 * 的查詢結果（.chart-current）移除。
 * v1.59.0：未達閾值的點標紅（填色／描邊改紅色，連線不改色；閾值取
 * threshold prop，與紅色虛線閾值線同一來源；無資料的點不會出現在 values 中）。
 */
import { useRef, useState } from "react";
import { isPassing } from "../lib/analysisRates";

export function TrendChart({
  values = [],
  labels = [],
  tooltips = [],
  notes = [],
  threshold = null,
  legend = "整體達標率",
  onPointClick,
}: {
  values?: number[];
  /** x 軸標籤（例如月份），數量對齊 values */
  labels?: string[];
  /** hover 提示文字（與 values 對齊；未提供時用「標籤：數值%」） */
  tooltips?: string[];
  /** x 軸標籤附註（v1.59.0：與 labels 對齊，如「（加審）」／「（有加審）」；
   *  以藍色 80% 字體接在標籤右方；null／缺值不顯示） */
  notes?: (string | null)[];
  /** 閾值（紅色虛線水平線；null 表示不畫） */
  threshold?: number | null;
  legend?: string;
  /** 點選某點（下探用）；未提供時點不可點 */
  onPointClick?: (index: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [tipPos, setTipPos] = useState<{ x: number; y: number } | null>(null);
  const [highlightBelow, setHighlightBelow] = useState(true);
  const [showThreshold, setShowThreshold] = useState(true);
  const [showCapaPlaceholder, setShowCapaPlaceholder] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  if (values.length === 0) {
    return (
      <div className="trend-chart-wrap">
        <div className="chart-empty">尚無趨勢資料</div>
      </div>
    );
  }
  const n = values.length;
  const single = n === 1;
  const x0 = 42;
  const x1 = 567;
  const step = n > 1 ? (x1 - x0) / (n - 1) : 0;
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  /** 單點時放圖中央（x=300），不畫折線與面積。 */
  const xOf = (i: number) => (single ? 300 : x0 + i * step);
  const yOf = (v: number) => 170 - clamp(v) * 1.35;
  const pts = values.map((v, i) => ({ x: xOf(i), y: yOf(v) }));
  const line = pts.map((p) => `${p.x},${p.y}`).join(" ");
  /** Y 軸刻度（0／25／50／75／100，對齊 yOf 映射） */
  const yTicks = [100, 75, 50, 25, 0].map((v) => ({ v, y: yOf(v) }));
  const tipText = (i: number) =>
    tooltips[i] ??
    (labels[i] ? `${labels[i]}：${values[i]}%` : `${values[i]}%`);
  const thY = showThreshold && threshold != null ? yOf(threshold) : null;
  /** 提示框跟滑鼠：取滑鼠在容器內的座標，水平夾在容器內避免溢出。 */
  const handleMouseMove = (event: React.MouseEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    setTipPos({
      x: Math.max(70, Math.min(x, Math.max(70, rect.width - 70))),
      y,
    });
  };
  return (
    <div className="trend-chart-wrap">
      <div className="chart-options" aria-label="曲線圖顯示選項">
        <label className="check-row">
          <input type="checkbox" checked={highlightBelow} onChange={(event) => setHighlightBelow(event.target.checked)} />
          低於閾值呈現紅色
        </label>
        <label className="check-row">
          <input type="checkbox" checked={showThreshold} onChange={(event) => setShowThreshold(event.target.checked)} />
          顯示閾值線
        </label>
        <label className="check-row">
          <input type="checkbox" checked={showCapaPlaceholder} onChange={(event) => setShowCapaPlaceholder(event.target.checked)} />
          顯示未達閾值月份的改善措施
        </label>
      </div>
      {showCapaPlaceholder && <p className="settings-note" role="status">改善措施顯示功能已保留，待 CAPA 功能完成後串接。</p>}
      <div className="chart-legend">
        <span>
          <i className="legend-line" />
          {legend}
        </span>
      </div>
      <div className="chart-svg-wrap" ref={wrapRef}>
        <svg
          className="trend-chart"
          viewBox="0 0 600 218"
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
          {!single && (
            <path
              d={`M${x0},170 L${line.replaceAll(" ", " L")} L${x1},170 L${x0},170 Z`}
              fill="url(#areaFill)"
            />
          )}
          {!single && <polyline points={line} className="chart-line" />}
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
                onMouseMove={handleMouseMove}
                onMouseLeave={() => {
                  setHover(null);
                  setTipPos(null);
                }}
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
                  (onPointClick ? " clickable" : "") +
                  // v1.59.0：未達閾值（rate < 閾值，沿用 isPassing 口徑；閾值 null／≤0 不標）
                  (highlightBelow && threshold != null && !isPassing(values[index], threshold)
                    ? " below"
                    : "")
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
          {labels.map((_, index) => notes[index] && index < n ? (
            <text key={`note-${index}`} x={xOf(index)} y={207} textAnchor="middle" className="chart-label-note">
              {notes[index] === "（加審）" ? "(加審)" : notes[index]}
            </text>
          ) : null)}
        </svg>
        {hover != null && tipPos != null && (
          <div
            className="chart-tip"
            style={{
              left: `${tipPos.x}px`,
              top: `${tipPos.y}px`,
            }}
          >
            {tipText(hover)}
          </div>
        )}
      </div>
    </div>
  );
}
