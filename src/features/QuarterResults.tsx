import { useEffect, useMemo, useState } from "react";
import { SectionTitle } from "../components/ui";
import {
  readIndicatorYearSchedule,
  readReviewRecords,
  type FirebaseProfile,
  type IndicatorYearSchedule,
  type ReviewRecord,
} from "../lib/firebase";
import type { Indicator, Role } from "../types";

type ViewMode = "people" | "units";
type ResultRow = {
  id: string;
  name: string;
  values: (number | null)[];
  audited: number[];
};
type PeriodRecord = ReviewRecord & { __period: number };
const DEFAULT_SCHEDULE: IndicatorYearSchedule = {
  indicatorId: "",
  year: new Date().getFullYear(),
  months: [1, 4, 7, 10],
  monthsPerAudit: 3,
};
const DEMO_PEOPLE = ["示範人員 A", "示範人員 B", "示範人員 C", "示範人員 D"];
const DEMO_UNITS = [
  "示範內科病房",
  "示範外科病房",
  "示範加護病房",
  "示範急診單位",
];
const DEMO_SHIFT: Record<string, number[]> = {
  i1: [-4, -1, 2, 4],
  i2: [-2, 1, 0, 3],
  i3: [-5, -2, 1, 3],
  i4: [-3, 0, 2, 4],
  i5: [-6, -3, 0, 3],
  i6: [-2, 0, 2, 1],
};

function getPeriodIndex(
  month: number,
  schedule: IndicatorYearSchedule,
): number | null {
  const starts = [...new Set(schedule.months)]
    .filter((value) => value >= 1 && value <= 12)
    .sort((a, b) => a - b);
  if (!starts.length) return null;
  const duration = Math.max(1, Math.min(12, schedule.monthsPerAudit || 3));
  const matches: number[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    for (let offset = 0; offset < duration; offset += 1) {
      if (((starts[index] + offset - 1) % 12) + 1 === month)
        matches.push(index);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function periodLabel(index: number, count: number): string {
  return count === 4 ? `第${index + 1}季` : `第${index + 1}期`;
}

function buildRows(
  records: PeriodRecord[],
  mode: ViewMode,
  periods: number,
): ResultRow[] {
  const grouped = new Map<
    string,
    { name: string; sums: number[]; counts: number[] }
  >();
  for (const record of records) {
    if (record.__period < 0) continue;
    const key =
      mode === "people"
        ? record.reviewerId || record.reviewerName
        : record.unitId;
    if (!key) continue;
    const name =
      mode === "people"
        ? record.reviewerName || record.reviewerId
        : record.unitId;
    const entry = grouped.get(key) ?? {
      name,
      sums: Array(periods).fill(0),
      counts: Array(periods).fill(0),
    };
    const quarter = record.__period;
    if (quarter >= 0 && quarter < periods) {
      entry.sums[quarter] += record.rate;
      entry.counts[quarter] += 1;
    }
    if (mode === "people" && record.reviewerName)
      entry.name = record.reviewerName;
    grouped.set(key, entry);
  }
  return [...grouped.entries()]
    .map(([id, item]) => ({
      id,
      name: item.name,
      values: item.sums.map((sum, index) =>
        item.counts[index] ? sum / item.counts[index] : null,
      ),
      audited: item.counts,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
}

function averageForPeriod(
  records: PeriodRecord[],
  period: number,
): number | null {
  const values = records
    .filter((record) => record.__period === period)
    .map((record) => record.rate);
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function createDemoRows(indicator: Indicator, mode: ViewMode): ResultRow[] {
  const names = mode === "people" ? DEMO_PEOPLE : DEMO_UNITS;
  const shifts = DEMO_SHIFT[indicator.id] ?? [-3, -1, 1, 3];
  const offsets = [-5, 2, 5, -1];
  return names.map((name, subjectIndex) => ({
    id: name,
    name,
    values: shifts.map((shift) =>
      Math.max(
        0,
        Math.min(100, indicator.attainment + shift + offsets[subjectIndex]),
      ),
    ),
    audited: shifts.map((_, index) =>
      mode === "people" ? 1 : 5 + ((subjectIndex + index) % 5),
    ),
  }));
}

export function QuarterResults({
  indicators,
  role,
  firebaseMode,
  profile,
}: {
  indicators: Indicator[];
  role: Role;
  firebaseMode: boolean;
  profile: FirebaseProfile | null;
}) {
  const [indicatorId, setIndicatorId] = useState(indicators[0]?.id ?? "");
  const [mode, setMode] = useState<ViewMode>(
    role === "護理長" ? "units" : "people",
  );
  const [selectedPeriod, setSelectedPeriod] = useState(0);
  const [year, setYear] = useState(new Date().getFullYear());
  const [schedule, setSchedule] =
    useState<IndicatorYearSchedule>(DEFAULT_SCHEDULE);
  const [rawRecords, setRawRecords] = useState<PeriodRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const indicator =
    indicators.find((item) => item.id === indicatorId) ?? indicators[0];
  const scheduleKey = indicator?.id ?? "";

  useEffect(() => {
    if (!indicators.length) {
      setIndicatorId("");
      return;
    }
    if (!indicators.some((item) => item.id === indicatorId))
      setIndicatorId(indicators[0].id);
  }, [indicators, indicatorId]);

  useEffect(() => setMode(role === "護理長" ? "units" : "people"), [role]);

  useEffect(() => {
    if (!firebaseMode || !profile || !scheduleKey) return;
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([
      readReviewRecords(scheduleKey, year, profile),
      readIndicatorYearSchedule(scheduleKey, year),
    ])
      .then(([records, storedSchedule]) => {
        if (!active) return;
        const nextSchedule = storedSchedule ?? {
          ...DEFAULT_SCHEDULE,
          indicatorId: scheduleKey,
          year,
        };
        setSchedule(nextSchedule);
        setRawRecords(
          records.map((record) => ({
            ...record,
            __period: getPeriodIndex(record.month, nextSchedule) ?? -1,
          })),
        );
        setSelectedPeriod((current) =>
          Math.min(current, Math.max(nextSchedule.months.length - 1, 0)),
        );
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error ? cause.message : "讀取審查紀錄失敗。",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [firebaseMode, profile, scheduleKey, year]);

  const periods = firebaseMode
    ? schedule.months.length
      ? schedule.months
      : DEFAULT_SCHEDULE.months
    : [1, 4, 7, 10];
  const periodNames = periods.map((_, index) =>
    periodLabel(index, periods.length),
  );
  const filteredRecords = rawRecords;
  const canCompareUnits = firebaseMode
    ? Boolean(
        profile?.roles.some((item) =>
          [
            "主任",
            "副主任",
            "督導",
            "各組召集人",
            "執行幹事",
            "品管執行幹事",
            "護理長",
          ].includes(item),
        ),
      )
    : role !== "一般人員" && role !== "審查員";
  const effectiveMode: ViewMode = canCompareUnits ? mode : "people";
  const rows = useMemo(() => {
    if (firebaseMode)
      return buildRows(filteredRecords, effectiveMode, periods.length);
    return indicator ? createDemoRows(indicator, effectiveMode) : [];
  }, [firebaseMode, filteredRecords, effectiveMode, periods.length, indicator]);
  const periodAverage = firebaseMode
    ? averageForPeriod(filteredRecords, selectedPeriod)
    : rows.length
      ? rows.reduce((sum, row) => sum + (row.values[selectedPeriod] ?? 0), 0) /
        rows.length
      : null;
  const activeYearChoices = [year - 2, year - 1, year, year + 1].sort(
    (a, b) => a - b,
  );

  if (!indicator) {
    return (
      <section className="panel quarter-panel">
        <SectionTitle title="季度審查結果趨勢" note="目前沒有可分析的指標" />
        <p className="quarter-empty">
          請先登入有權限的 Firebase 帳號，並確認 Firestore 已有指標資料。
        </p>
      </section>
    );
  }

  return (
    <section className="panel quarter-panel">
      <SectionTitle
        title="季度審查結果趨勢"
        note={
          firebaseMode
            ? "資料來源：Firestore reviewRecords（唯讀）"
            : "虛構展示資料"
        }
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
        <label className="quarter-control">
          <span>年度</span>
          <select
            value={year}
            onChange={(event) => setYear(Number(event.target.value))}
          >
            {activeYearChoices.map((item) => (
              <option key={item} value={item}>
                {item} 年
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
          {canCompareUnits && (
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
          <span>明細期別</span>
          <select
            value={selectedPeriod}
            onChange={(event) => setSelectedPeriod(Number(event.target.value))}
          >
            {periodNames.map((period, index) => (
              <option key={period} value={index}>
                {period}（{periods[index]} 月起、{schedule.monthsPerAudit || 3}{" "}
                個月）
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
          <span>{periodNames[selectedPeriod] ?? "期別"}平均</span>
          <strong>
            {periodAverage === null ? "—" : `${periodAverage.toFixed(1)}%`}
          </strong>
        </div>
        <div>
          <span>比較對象</span>
          <strong>
            {rows.length} {effectiveMode === "people" ? "位審查人員" : "個單位"}
          </strong>
        </div>
      </div>
      {loading && (
        <p className="quarter-empty" role="status">
          正在讀取 Firebase 審查結果…
        </p>
      )}
      {error && (
        <p className="login-error" role="alert">
          {error} 請確認帳號權限、Firestore Rules
          與必要索引；本頁不會改用匿名或本地假資料。
        </p>
      )}
      {!loading && !error && (
        <QuarterLineChart
          rows={rows}
          periodNames={periodNames}
          threshold={indicator.threshold}
        />
      )}
      <div className="quarter-detail-heading">
        <div>
          <h3>{periodNames[selectedPeriod] ?? "期別"}審查明細</h3>
          <span>按審查完成紀錄彙整；人員視角顯示審查紀錄中的審查員</span>
        </div>
      </div>
      <div className="table-scroll">
        <table className="data-table quarter-table">
          <thead>
            <tr>
              <th>{effectiveMode === "people" ? "審查人員" : "受審單位"}</th>
              <th>平均符合率</th>
              <th>閾值</th>
              <th>結果</th>
              <th>審查件數</th>
              <th>期別趨勢</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const score = row.values[selectedPeriod];
              return (
                <tr key={row.id}>
                  <td>
                    <b>{row.name}</b>
                  </td>
                  <td className="threshold-cell">
                    {score === null || score === undefined
                      ? "—"
                      : `${score.toFixed(1)}%`}
                  </td>
                  <td>{indicator.threshold}%</td>
                  <td>
                    {score === null || score === undefined ? (
                      "—"
                    ) : (
                      <span
                        className={`quarter-result ${score >= indicator.threshold ? "met" : "below"}`}
                      >
                        {score >= indicator.threshold ? "達標" : "未達標"}
                      </span>
                    )}
                  </td>
                  <td>{row.audited[selectedPeriod] ?? 0} 件</td>
                  <td className="quarter-spark-values">
                    {row.values.map((value, index) => (
                      <span
                        className={index === selectedPeriod ? "selected" : ""}
                        key={index}
                      >
                        {value === null ? "—" : `${value.toFixed(1)}%`}
                      </span>
                    ))}
                  </td>
                </tr>
              );
            })}
            {!loading && !error && rows.length === 0 && (
              <tr>
                <td colSpan={6}>
                  {firebaseMode
                    ? "此指標／年度／權限範圍內尚無已送出的審查紀錄。"
                    : "沒有可顯示的展示結果。"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="quarter-disclaimer">
        期間依排程設定的起始月份與審核月數歸類；例如 1、4、7、10 月起始且每期 3
        個月，分別為 1–3、4–6、7–9、10–12
        月。結果只讀取已送出且符合目前帳號查詢範圍的紀錄。
      </p>
    </section>
  );
}

function QuarterLineChart({
  rows,
  periodNames,
  threshold,
}: {
  rows: ResultRow[];
  periodNames: string[];
  threshold: number;
}) {
  const width = 760;
  const height = 220;
  const left = 48;
  const right = 730;
  const top = 24;
  const bottom = 174;
  const x = (index: number) =>
    left + (index * (right - left)) / Math.max(periodNames.length - 1, 1);
  const y = (value: number) => bottom - (value / 100) * (bottom - top);
  const palette = [
    "#0f766e",
    "#2563eb",
    "#b45309",
    "#7c3aed",
    "#be185d",
    "#475569",
  ];
  return (
    <div className="quarter-chart-wrap">
      <div className="quarter-chart-legend">
        {rows.map((row, index) => (
          <span key={row.id}>
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
          aria-label="各審查人員或單位各期平均符合率趨勢圖"
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
          {periodNames.map((period, index) => (
            <text
              key={period}
              x={x(index)}
              y={bottom + 28}
              textAnchor="middle"
              className="quarter-axis-label"
            >
              {period}
            </text>
          ))}
          {rows.map((row, rowIndex) => {
            const points = row.values.flatMap((value, index) =>
              value === null ? [] : [{ index, value }],
            );
            return (
              <g key={row.id}>
                <polyline
                  points={points
                    .map(({ value, index }) => `${x(index)},${y(value)}`)
                    .join(" ")}
                  fill="none"
                  stroke={palette[rowIndex % palette.length]}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {points.map(({ value, index }) => (
                  <circle
                    key={index}
                    cx={x(index)}
                    cy={y(value)}
                    r="5"
                    fill={palette[rowIndex % palette.length]}
                    stroke="white"
                    strokeWidth="2"
                  >
                    <title>{`${row.name} ${periodNames[index]} ${value.toFixed(1)}%`}</title>
                  </circle>
                ))}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
