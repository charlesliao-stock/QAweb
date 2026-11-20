/**
 * 立體彩色圖示（v1.88.38 底導專用；v1.88.39 起側邊欄共用同一元件）。
 *
 * - 供 App.tsx 的 mobile-bottom-nav（含「更多」彈出選單）與側邊欄主導覽共用；
 *   同一功能在兩處顏色一致（dashboard 首頁 teal、overview 總覽藍…）。
 * - 每個圖示都是 inline SVG：三段式垂直漸層（亮→主色→深色）＋頂部高光＋
 *   feDropShadow 底部投影，做出浮起的立體感；不引入新字體／新套件、不用 emoji。
 * - 選中／未選中以 CSS class（.nav-3d-icon / .is-active）區分：選中放大＋陰影加深＋
 *   底座光暈；未選中彩度稍降（saturate 0.72–0.75）但仍是彩色，不變回單色灰。
 * - 漸層用亮色起點（非深色起點），在深色模式底色上仍有足夠對比。
 */
import { useId } from "react";

export type BottomNavIconKind =
  | "dashboard"
  | "overview"
  | "audit"
  | "results"
  | "more"
  | "schedule"
  | "capa"
  | "handoff"
  | "groups"
  | "admin"
  | "permissions";

/** [亮色, 主色, 深色]：每項一組辨識色，沿用站內配色方向（首頁 teal 為主色系）。 */
const PALETTES: Record<BottomNavIconKind, [string, string, string]> = {
  dashboard: ["#5eead4", "#14b8a6", "#0f766e"], // 首頁 teal
  overview: ["#93c5fd", "#3b82f6", "#1e40af"], // 總覽 藍
  audit: ["#86efac", "#22c55e", "#15803d"], // 審查 綠
  results: ["#fcd34d", "#f59e0b", "#b45309"], // 分析 琥珀
  more: ["#d8b4fe", "#a855f7", "#7e22ce"], // 更多 紫
  schedule: ["#a5b4fc", "#6366f1", "#4338ca"], // 排程 靛藍
  capa: ["#fda4af", "#f43f5e", "#9f1239"], // CAPA 玫瑰紅
  handoff: ["#67e8f9", "#06b6d4", "#0e7490"], // 任務交接 青
  groups: ["#f9a8d4", "#ec4899", "#9d174d"], // 品管組與人員 粉
  admin: ["#cbd5e1", "#64748b", "#334155"], // 系統管理 石板灰藍
  permissions: ["#fdba74", "#f97316", "#9a3412"], // 權限管理 橘
};

function Highlight({ x, y, w, h, r = 1.2 }: { x: number; y: number; w: number; h: number; r?: number }) {
  return <rect x={x} y={y} width={w} height={h} rx={r} fill="#ffffff" opacity={0.38} />;
}

export function BottomNavIcon({
  kind,
  size = 22,
  active = false,
}: {
  kind: BottomNavIconKind;
  size?: number;
  active?: boolean;
}) {
  const uid = useId().replace(/:/g, "");
  const [light, main, dark] = PALETTES[kind];
  const g = `bn3d-g-${uid}`;
  const glow = `bn3d-glow-${uid}`;
  const sh = `bn3d-sh-${uid}`;
  const shadowOpacity = active ? 0.45 : 0.32;
  const shadowDy = active ? 2.2 : 1.4;

  return (
    <svg
      className={`nav-3d-icon${active ? " is-active" : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={g} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={light} />
          <stop offset="55%" stopColor={main} />
          <stop offset="100%" stopColor={dark} />
        </linearGradient>
        <radialGradient id={glow} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor={main} stopOpacity="0.55" />
          <stop offset="100%" stopColor={main} stopOpacity="0" />
        </radialGradient>
        <filter id={sh} x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy={shadowDy} stdDeviation="1.3" floodColor="#0f172a" floodOpacity={shadowOpacity} />
        </filter>
      </defs>

      {/* 選中：底座光暈 */}
      {active && <circle cx="12" cy="13" r="11" fill={`url(#${glow})`} />}

      <g filter={`url(#${sh})`}>
        {kind === "dashboard" && (
          <>
            <rect x="3" y="3" width="8" height="8" rx="2" fill={`url(#${g})`} />
            <rect x="13" y="3" width="8" height="8" rx="2" fill={`url(#${g})`} />
            <rect x="3" y="13" width="8" height="8" rx="2" fill={`url(#${g})`} />
            <rect x="13" y="13" width="8" height="8" rx="2" fill={`url(#${g})`} />
            <Highlight x={4.2} y={4.2} w={5.6} h={2.2} />
            <Highlight x={14.2} y={4.2} w={5.6} h={2.2} />
          </>
        )}
        {kind === "overview" && (
          <>
            {[5.5, 12, 18.5].map((cy, i) => (
              <g key={cy}>
                <circle cx="5" cy={cy} r="2.7" fill={`url(#${g})`} />
                <path
                  d={`M3.9 ${cy}l0.9 0.9 1.7-1.9`}
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <rect x="9.5" y={cy - 1.4} width={11 - i * 2} height="2.8" rx="1.4" fill={`url(#${g})`} />
              </g>
            ))}
          </>
        )}
        {kind === "audit" && (
          <>
            <rect x="5.5" y="3.5" width="13" height="17.5" rx="2.5" fill={`url(#${g})`} />
            <rect x="9" y="2" width="6" height="4.5" rx="1.5" fill={main} stroke={light} strokeWidth="0.8" />
            <Highlight x={7.2} y={5.2} w={9.6} h={1.8} />
            <path
              d="M8.3 13.2l2.5 2.5 4.9-5.4"
              fill="none"
              stroke="#ffffff"
              strokeWidth="2.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}
        {kind === "results" && (
          <>
            <rect x="4" y="11" width="4.4" height="9" rx="1.5" fill={`url(#${g})`} />
            <rect x="9.8" y="6.5" width="4.4" height="13.5" rx="1.5" fill={`url(#${g})`} />
            <rect x="15.6" y="13.5" width="4.4" height="6.5" rx="1.5" fill={`url(#${g})`} />
            <Highlight x={4.9} y={11.9} w={2.6} h={2} />
            <Highlight x={10.7} y={7.4} w={2.6} h={2} />
            <Highlight x={16.5} y={14.4} w={2.6} h={2} />
            <rect x="3.5" y="20.4" width="17" height="1.7" rx="0.85" fill={dark} />
          </>
        )}
        {kind === "more" && (
          <>
            <rect x="4" y="4.2" width="16" height="3.4" rx="1.7" fill={`url(#${g})`} />
            <rect x="4" y="10.3" width="16" height="3.4" rx="1.7" fill={`url(#${g})`} />
            <rect x="4" y="16.4" width="16" height="3.4" rx="1.7" fill={`url(#${g})`} />
            <Highlight x={5.4} y={5} w={6} h={1.5} />
            <Highlight x={5.4} y={11.1} w={6} h={1.5} />
          </>
        )}
        {kind === "schedule" && (
          <>
            <rect x="3.5" y="5" width="17" height="16" rx="2.5" fill={`url(#${g})`} />
            <rect x="3.5" y="5" width="17" height="5.5" rx="2.5" fill={dark} />
            <rect x="7.5" y="2.5" width="2.6" height="4.5" rx="1.3" fill={dark} />
            <rect x="13.9" y="2.5" width="2.6" height="4.5" rx="1.3" fill={dark} />
            {[7.2, 12, 16.8].map((cx) => (
              <rect key={cx} x={cx - 1.5} y={13} width="3" height="3" rx="0.9" fill="#ffffff" opacity="0.85" />
            ))}
            {[7.2, 12, 16.8].map((cx) => (
              <rect key={cx} x={cx - 1.5} y={17.4} width="3" height="3" rx="0.9" fill="#ffffff" opacity="0.4" />
            ))}
          </>
        )}
        {kind === "capa" && (
          <>
            <path
              d="M3 12h3.6l2.4-5.8 4.2 11.6 2.4-5.8H21"
              fill="none"
              stroke={`url(#${g})`}
              strokeWidth="2.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {/* 頂部高光：同形細白線微上移，做出立體受光邊 */}
            <path
              d="M3 12h3.6l2.4-5.8 4.2 11.6 2.4-5.8H21"
              fill="none"
              stroke="#ffffff"
              strokeWidth="0.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.35"
              transform="translate(0 -0.9)"
            />
          </>
        )}
        {kind === "handoff" && (
          <>
            <path
              d="M4 7.5h11.5l-3-3"
              fill="none"
              stroke={`url(#${g})`}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M20 16.5H8.5l3 3"
              fill="none"
              stroke={`url(#${g})`}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M4 7.5h11.5l-3-3"
              fill="none"
              stroke="#ffffff"
              strokeWidth="0.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.35"
              transform="translate(0 -0.9)"
            />
            <path
              d="M20 16.5H8.5l3 3"
              fill="none"
              stroke="#ffffff"
              strokeWidth="0.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.35"
              transform="translate(0 -0.9)"
            />
          </>
        )}
        {kind === "groups" && (
          <>
            <path
              d="M6 8.8v6.4M6 12.5c4.5 0 7.5-0.8 9.6-2.3"
              fill="none"
              stroke={`url(#${g})`}
              strokeWidth="2.2"
              strokeLinecap="round"
            />
            {[
              [6, 6],
              [6, 18],
              [18, 8.5],
            ].map(([cx, cy]) => (
              <g key={`${cx}-${cy}`}>
                <circle cx={cx} cy={cy} r="3" fill={`url(#${g})`} />
                <circle cx={cx} cy={cy} r="1.1" fill="#ffffff" opacity="0.9" />
              </g>
            ))}
          </>
        )}
        {kind === "admin" && (
          <>
            {[6, 12, 18].map((cy) => (
              <line key={cy} x1="4" y1={cy} x2="20" y2={cy} stroke={`url(#${g})`} strokeWidth="2.2" strokeLinecap="round" />
            ))}
            {[
              [9, 6],
              [15, 12],
              [8, 18],
            ].map(([cx, cy]) => (
              <g key={`${cx}-${cy}`}>
                <circle cx={cx} cy={cy} r="3.1" fill={`url(#${g})`} />
                <circle cx={cx} cy={cy} r="1.1" fill="#ffffff" opacity="0.9" />
              </g>
            ))}
          </>
        )}
        {kind === "permissions" && (
          <>
            <path
              d="M12 2.8l7 2.6v5.4c0 4.8-3 8.4-7 10.4-4-2-7-5.6-7-10.4V5.4z"
              fill={`url(#${g})`}
            />
            <Highlight x={8.5} y={4.6} w={7} h={1.8} />
            <path
              d="M8.4 11.9l2.4 2.4 4.8-5.4"
              fill="none"
              stroke="#ffffff"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}
      </g>
    </svg>
  );
}
