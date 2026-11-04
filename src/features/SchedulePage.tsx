import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  ChevronDown,
  MoreHorizontal,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { DEMO_SCHEDULES } from "../data/demo";
import { PageHeading } from "../components/ui";
import {
  readIndicatorYearSchedule,
  readFirebaseScheduleUnits,
  saveIndicatorYearSchedule,
  type FirebaseUnitOption,
  type FirebaseProfile,
  type IndicatorYearSchedule,
} from "../lib/firebase";
import type { Indicator } from "../types";

const LOCAL_KEY = "qaweb-indicator-year-schedule";
const MONTH_NAMES = [
  "1月",
  "2月",
  "3月",
  "4月",
  "5月",
  "6月",
  "7月",
  "8月",
  "9月",
  "10月",
  "11月",
  "12月",
];
const DEFAULT_MONTHS = [1, 4, 7, 10];
const DEMO_UNITS: FirebaseUnitOption[] = [
  ...new Set(DEMO_SCHEDULES.map((item) => item.unit)),
].map((unit) => ({ id: unit, name: unit, groupId: "demo" }));

function scheduleKey(indicatorId: string, year: number) {
  return `${LOCAL_KEY}:${indicatorId}:${year}`;
}

function duplicateCoveredMonths(months: number[], duration: number): number[] {
  const counts = Array(13).fill(0) as number[];
  for (const start of months) {
    for (let offset = 0; offset < duration; offset += 1) {
      const month = ((start + offset - 1) % 12) + 1;
      counts[month] += 1;
    }
  }
  return MONTH_NAMES.flatMap((_, index) =>
    counts[index + 1] > 1 ? [index + 1] : [],
  );
}

function uncoveredMonths(months: number[], duration: number): number[] {
  const covered = new Set<number>();
  for (const start of months) {
    for (let offset = 0; offset < duration; offset += 1)
      covered.add(((start + offset - 1) % 12) + 1);
  }
  return MONTH_NAMES.flatMap((_, index) =>
    covered.has(index + 1) ? [] : [index + 1],
  );
}

export function SchedulePage({
  indicators,
  firebaseMode,
  profile,
  onAction,
}: {
  indicators: Indicator[];
  firebaseMode: boolean;
  profile: FirebaseProfile | null;
  onAction: (message: string) => void;
}) {
  const [period, setPeriod] = useState("2026 年 11 月");
  const year = new Date().getFullYear();
  const [indicatorId, setIndicatorId] = useState(indicators[0]?.id ?? "");
  const [months, setMonths] = useState<number[]>(DEFAULT_MONTHS);
  const [monthsPerAudit, setMonthsPerAudit] = useState(3);
  const [availableUnits, setAvailableUnits] = useState<FirebaseUnitOption[]>(
    [],
  );
  const [selectedUnitIds, setSelectedUnitIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [configError, setConfigError] = useState("");
  const [configSource, setConfigSource] = useState("預設設定");
  const indicator =
    indicators.find((item) => item.id === indicatorId) ?? indicators[0];
  const roles = new Set(profile?.roles ?? []);
  const canEdit =
    !firebaseMode ||
    [
      "主任",
      "副主任",
      "督導",
      "各組召集人",
      "執行幹事",
      "品管執行幹事",
      "指標負責人",
      "系統管理員",
    ].some((role) => roles.has(role));
  const duplicateMonths = useMemo(
    () => duplicateCoveredMonths(months, monthsPerAudit),
    [months, monthsPerAudit],
  );
  const gaps = useMemo(
    () => uncoveredMonths(months, monthsPerAudit),
    [months, monthsPerAudit],
  );

  useEffect(() => {
    if (!indicators.length) {
      setIndicatorId("");
      return;
    }
    if (!indicators.some((item) => item.id === indicatorId))
      setIndicatorId(indicators[0].id);
  }, [indicators, indicatorId]);

  useEffect(() => {
    if (!indicator) return;
    let active = true;
    setLoading(true);
    setConfigError("");
    const load = async () => {
      if (firebaseMode && !profile) throw new Error("請先登入 Firebase 帳號。");
      const units = firebaseMode
        ? await readFirebaseScheduleUnits(profile!)
        : DEMO_UNITS;
      if (!active) return;
      setAvailableUnits(units);

      if (firebaseMode) {
        const saved = await readIndicatorYearSchedule(indicator.id, year);
        if (!active) return;
        const value = saved ?? {
          indicatorId: indicator.id,
          year,
          months: DEFAULT_MONTHS,
          monthsPerAudit: 3,
        };
        setMonths(value.months.length ? value.months : DEFAULT_MONTHS);
        setMonthsPerAudit(value.monthsPerAudit || 3);
        const savedUnitIds = saved?.unitIds;
        const initialUnitIds =
          savedUnitIds === undefined
            ? units.map((unit) => unit.id)
            : savedUnitIds;
        setSelectedUnitIds(
          initialUnitIds.filter((id) => units.some((unit) => unit.id === id)),
        );
        setConfigSource(
          saved
            ? savedUnitIds === undefined
              ? "Firestore 舊設定（已預選可管理單位）"
              : "Firestore 指標年度排程"
            : "尚未設定（已預選可管理單位）",
        );
        return;
      }

      const stored = localStorage.getItem(scheduleKey(indicator.id, year));
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as {
            months?: number[];
            monthsPerAudit?: number;
            unitIds?: string[];
          };
          setMonths(parsed.months?.length ? parsed.months : DEFAULT_MONTHS);
          setMonthsPerAudit(parsed.monthsPerAudit ?? 3);
          const savedUnitIds = parsed.unitIds ?? units.map((unit) => unit.id);
          setSelectedUnitIds(
            savedUnitIds.filter((id) => units.some((unit) => unit.id === id)),
          );
          setConfigSource("此瀏覽器的展示設定");
        } catch {
          setMonths(DEFAULT_MONTHS);
          setMonthsPerAudit(3);
          setSelectedUnitIds(units.map((unit) => unit.id));
        }
      } else {
        setMonths(DEFAULT_MONTHS);
        setMonthsPerAudit(3);
        setSelectedUnitIds(units.map((unit) => unit.id));
        setConfigSource("預設設定");
      }
    };
    void load()
      .catch((cause: unknown) => {
        if (active)
          setConfigError(
            cause instanceof Error ? cause.message : "讀取排程設定失敗。",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [firebaseMode, indicator, year, profile]);

  const toggleMonth = (month: number) => {
    setMonths((current) =>
      current.includes(month)
        ? current.filter((item) => item !== month)
        : [...current, month].sort((a, b) => a - b),
    );
  };

  const toggleUnit = (unitId: string) => {
    setSelectedUnitIds((current) =>
      current.includes(unitId)
        ? current.filter((item) => item !== unitId)
        : [...current, unitId],
    );
  };

  const saveSchedule = async () => {
    if (!indicator || !months.length || !selectedUnitIds.length) {
      setConfigError("請至少選擇一個排程單位及一個審查起始月份。");
      return;
    }
    if (duplicateMonths.length) {
      setConfigError(
        `審查區間重疊：${duplicateMonths.map((month) => `${month}月`).join("、")}。請調整起始月份或審核月數。`,
      );
      return;
    }
    setSaving(true);
    setConfigError("");
    const config: IndicatorYearSchedule = {
      indicatorId: indicator.id,
      year,
      months: [...months].sort((a, b) => a - b),
      monthsPerAudit,
      unitIds: [...selectedUnitIds],
    };
    try {
      if (firebaseMode) {
        if (!profile) throw new Error("請先登入 Firebase 帳號。");
        await saveIndicatorYearSchedule(config, profile.staffId);
        setConfigSource("Firestore 指標年度排程");
      } else {
        localStorage.setItem(
          scheduleKey(indicator.id, year),
          JSON.stringify(config),
        );
        setConfigSource("此瀏覽器的展示設定");
      }
      onAction("排程單位、審查月份與審核月數已儲存。");
    } catch (cause) {
      setConfigError(
        cause instanceof Error
          ? cause.message
          : "儲存排程設定失敗，請確認 Firestore Rules。",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeading
        page="schedule"
        action={
          firebaseMode ? undefined : (
            <button
              className="button button-primary"
              onClick={() =>
                onAction(
                  "任務排程建立流程尚未開放；可先設定年度審查月份與區間長度。",
                )
              }
            >
              <Plus size={16} />
              建立排程
            </button>
          )
        }
      />
      <section className="panel schedule-period-config">
        <div className="schedule-period-head">
          <div>
            <h2>年度排程單位與月份設定</h2>
            <p>
              先選擇本年度要排程的單位，再設定各期起始月份與涵蓋月數；審查員指派另行管理。
            </p>
          </div>
          <span className="status-pill info">
            {year} 年 · {configSource}
          </span>
        </div>
        <div className="schedule-period-controls">
          <label className="quarter-control">
            <span>分析指標</span>
            <select
              value={indicator?.id ?? ""}
              onChange={(event) => setIndicatorId(event.target.value)}
              disabled={!indicators.length}
            >
              {indicators.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.code}｜{item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="quarter-control">
            <span>審核月數</span>
            <select
              value={monthsPerAudit}
              onChange={(event) =>
                setMonthsPerAudit(Number(event.target.value))
              }
              disabled={!canEdit || loading}
            >
              {Array.from({ length: 12 }, (_, index) => index + 1).map(
                (count) => (
                  <option value={count} key={count}>
                    {count} 個月
                  </option>
                ),
              )}
            </select>
          </label>
          <button
            className="button button-primary"
            onClick={() => void saveSchedule()}
            disabled={saving || loading || !canEdit || !selectedUnitIds.length}
          >
            {saving ? "儲存中…" : "儲存設定"}
          </button>
        </div>
        <div className="schedule-month-picker">
          <span className="field-label">審查起始月份</span>
          <div className="schedule-month-grid">
            {MONTH_NAMES.map((name, index) => {
              const month = index + 1;
              const checked = months.includes(month);
              return (
                <label
                  className={`schedule-month-option${checked ? " selected" : ""}`}
                  key={month}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!canEdit || loading}
                    onChange={() => toggleMonth(month)}
                  />
                  <span>{name}</span>
                </label>
              );
            })}
          </div>
        </div>
        <div className="schedule-unit-picker">
          <div className="schedule-unit-head">
            <div>
              <span className="field-label">排程單位（可多選）</span>
              <p>
                設定這支指標本年度要排程的單位；審查員與單位的對應分開設定，本區不會修改該指派。
              </p>
            </div>
            <div className="schedule-unit-actions">
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  setSelectedUnitIds(availableUnits.map((unit) => unit.id))
                }
                disabled={!canEdit || loading || !availableUnits.length}
              >
                全選
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => setSelectedUnitIds([])}
                disabled={!canEdit || loading || !selectedUnitIds.length}
              >
                清除
              </button>
            </div>
          </div>
          {availableUnits.length ? (
            <>
              <div className="schedule-unit-summary">
                已選 {selectedUnitIds.length} / {availableUnits.length} 個單位
              </div>
              <div className="schedule-unit-grid">
                {availableUnits.map((unit) => {
                  const checked = selectedUnitIds.includes(unit.id);
                  return (
                    <label
                      className={`schedule-unit-option${checked ? " selected" : ""}`}
                      key={unit.id}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!canEdit || loading}
                        onChange={() => toggleUnit(unit.id)}
                      />
                      <span>{unit.name}</span>
                    </label>
                  );
                })}
              </div>
            </>
          ) : (
            <p className="schedule-config-note">
              {loading
                ? "正在載入可排程單位…"
                : "目前權限範圍內沒有可選單位；請確認 units 資料與 Firestore Rules。"}
            </p>
          )}
        </div>
        {configError && (
          <p className="login-error" role="alert">
            {configError}
          </p>
        )}
        {duplicateMonths.length > 0 ? (
          <p className="schedule-config-note error">
            區間重疊：{duplicateMonths.map((month) => `${month}月`).join("、")}
          </p>
        ) : gaps.length > 0 ? (
          <p className="schedule-config-note">
            未涵蓋月份：{gaps.map((month) => `${month}月`).join("、")}
            ；這些月份的審查紀錄不會被歸入任何期別。
          </p>
        ) : (
          <p className="schedule-config-note success">
            每月恰落在一個審查區間。例如 1、4、7、10 月起始且審核月數 3，分為
            1–3、4–6、7–9、10–12 月。
          </p>
        )}
        {firebaseMode && !canEdit && (
          <p className="schedule-config-note">
            目前帳號可以查看排程，但角色沒有設定排程的操作權限。
          </p>
        )}
      </section>
      {firebaseMode ? (
        <section className="panel schedule-live-note">
          <ShieldCheck size={17} />
          <span>
            單位與月份設定已寫入
            Firestore；審查員對應單位需在獨立指派區設定，本區不會修改該指派。
            任務建立及進度清單尚未串接 `reviewTasks`，因此不顯示虛構排程列。
          </span>
        </section>
      ) : (
        <>
          <div className="schedule-banner">
            <div className="schedule-banner-icon">
              <CalendarDays size={20} />
            </div>
            <div>
              <b>{period}排程完成率</b>
              <span>共 84 項審查任務，尚有 24 項待完成</span>
            </div>
            <strong>
              71%<small>60 / 84 項</small>
            </strong>
            <div className="banner-progress">
              <i style={{ width: "71%" }} />
            </div>
          </div>
          <div className="toolbar schedule-toolbar">
            <div className="tabs">
              <button className="tab active">
                全部任務 <span>84</span>
              </button>
              <button className="tab">
                待審查 <span>24</span>
              </button>
              <button className="tab">
                逾期補審 <span>4</span>
              </button>
            </div>
            <div className="toolbar-actions">
              <button
                className="select-like"
                onClick={() =>
                  setPeriod(
                    period === "2026 年 11 月"
                      ? "2026 年 12 月"
                      : "2026 年 11 月",
                  )
                }
              >
                <CalendarDays size={15} />
                {period}
                <ChevronDown size={14} />
              </button>
              <button
                className="button button-outline"
                onClick={() => onAction("排程資料為虛構展示內容")}
              >
                <SlidersHorizontal size={15} />
                篩選
              </button>
            </div>
          </div>
          <section className="panel data-panel">
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>指標／受審單位</th>
                    <th>審查員</th>
                    <th>排程月份</th>
                    <th>任務進度</th>
                    <th>截止日</th>
                    <th>狀態</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {DEMO_SCHEDULES.map((task) => (
                    <tr key={task.id}>
                      <td>
                        <div className="indicator-title">
                          <b>{task.indicator}</b>
                          <span>{task.unit}</span>
                        </div>
                      </td>
                      <td>
                        <div className="person-cell">
                          <span className="person-avatar">
                            {task.reviewer.slice(-1)}
                          </span>
                          {task.reviewer}
                        </div>
                      </td>
                      <td>{task.month}</td>
                      <td>
                        <div className="schedule-progress">
                          <span>
                            {task.done} / {task.total}
                          </span>
                          <div className="mini-progress">
                            <i
                              style={{
                                width: `${Math.round((task.done / task.total) * 100)}%`,
                              }}
                            />
                          </div>
                        </div>
                      </td>
                      <td>{task.due}</td>
                      <td>
                        <span
                          className={`status-pill ${task.status === "逾期補審" ? "danger" : task.status === "待開始" ? "muted" : "info"}`}
                        >
                          {task.status}
                        </span>
                      </td>
                      <td>
                        <button
                          className="icon-button"
                          onClick={() =>
                            onAction(`排程「${task.indicator}」僅供展示`)
                          }
                          aria-label="排程更多選項"
                        >
                          <MoreHorizontal size={17} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-footer">
              <span>目前顯示 4 筆虛構排程</span>
              <button
                className="text-button"
                onClick={() => onAction("已複製上月展示排程（未儲存）")}
              >
                複製上個月 <ArrowRight size={14} />
              </button>
            </div>
          </section>
          <div className="dashboard-footnote">
            <ShieldCheck size={14} />
            利益迴避規則：審查員不得審查自己所屬單位；加審超過當月次數時提示但不阻擋，正式排程須記錄改派與加派。
          </div>
        </>
      )}
    </>
  );
}
