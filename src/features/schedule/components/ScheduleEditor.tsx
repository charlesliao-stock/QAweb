import type { UnitLite } from "../model/types";
import { useState, useMemo, useCallback, useEffect } from "react";
import { periodForFilter, type ReviewFrequency, DEFAULT_FREQUENCY, DEFAULT_INTERVAL_MONTHS, type IndicatorSchedule, getSchedule, previousPeriodSchedule, clampIntervalForEditor, autoSelectMonths, saveSchedule, parseCaseCount, deleteScheduleWithTasks, YEAR_FILTER_OPTIONS, yearOptionLabel, FREQUENCY_OPTIONS, frequencyLabel, INTERVAL_OPTIONS, intervalRangeLabels } from "../../../lib/scheduling";
import { useCaseCountInput, UnitTreePicker, MonthPicker } from "./pickers";
import { cycleMonths, periodLabel, categoryLabel } from "../../../lib/cycle";
import { getFirebaseDb } from "../../../lib/firebase";
import { toErrorMessage } from "../../../lib/errors";
import { SectionTitle, FormSelect } from "../../../components/ui";
import { Copy, Trash2 } from "lucide-react";

/* ================= 排程設定編輯器（年度／學年度；v1.18 頻次＋區間） ================= */

export function ScheduleEditor({
  indicatorId,
  indicatorName,
  category,
  initialYear,
  units,
  groupMap,
  restrictedUnitCodes,
  restrictedUnitName,
  canEdit,
  actor,
  onAction,
  onSaved,
}: {
  indicatorId: string;
  indicatorName: string;
  category: "year" | "academic";
  initialYear: number;
  units: UnitLite[];
  groupMap: Map<string, string>;
  /**
   * v1.88.5：單位排程者（單位召集人／執行幹事）的可排單位集合
   * （僅自己單位；null＝不設限）。設定時沿用同一集合。
   */
  restrictedUnitCodes: ReadonlySet<string> | null;
  /** 受限時顯示用（自己單位名稱；未設單位時為單位代碼本身） */
  restrictedUnitName: string;
  canEdit: boolean;
  actor: { id: string; name: string };
  onAction: (m: string) => void;
  onSaved: () => void;
}) {
  const restricted = restrictedUnitCodes != null;
  const [year, setYear] = useState(initialYear);
  const period = periodForFilter(category, year);
  const [months, setMonths] = useState<number[]>([]);
  const [frequency, setFrequency] =
    useState<ReviewFrequency>(DEFAULT_FREQUENCY);
  const [interval, setInterval] =
    useState<1 | 2 | 3>(DEFAULT_INTERVAL_MONTHS);
  const caseCount = useCaseCountInput();
  const [unitIds, setUnitIds] = useState<string[]>([]);
  // v1.88.5：受限時，載入的既有單位中不屬於自己的部分另外保存，
  // 儲存時併回（只改自己單位，不刪其他單位的既有設定）。
  const [otherUnitIds, setOtherUnitIds] = useState<string[]>([]);
  // v1.51.0：不限單位（不固定單位、沒有單位限制；勾選時單位清單忽略）
  const [unlimited, setUnlimited] = useState(false);
  const [notes, setNotes] = useState("");
  const [exists, setExists] = useState(false);
  const [prev, setPrev] = useState<IndicatorSchedule | null>(null);
  const [loadingPeriod, setLoadingPeriod] = useState(true);
  const [saving, setSaving] = useState(false);
  /** v1.88.19：已確認刪除、待按「儲存設定」才真正刪除（未儲存就離開＝不刪除） */
  const [pendingDelete, setPendingDelete] = useState(false);

  const monthOrder = useMemo(
    () => cycleMonths(category, period),
    [category, period],
  );
  const unitNameOf = useCallback(
    (code: string) => units.find((u) => u.code === code)?.name ?? code,
    [units],
  );

  useEffect(() => {
    let cancelled = false;
    setPendingDelete(false); // v1.88.19：切換期間時清除待刪除標記
    (async () => {
      setLoadingPeriod(true);
      try {
        const db = getFirebaseDb();
        const [s, pv] = await Promise.all([
          getSchedule(db, indicatorId, category, period),
          previousPeriodSchedule(db, indicatorId, category, period),
        ]);
        if (cancelled) return;
        setExists(!!s);
        if (s) {
          // 編輯舊排程：保留原月份，不強制重算（v1.18）；改頻次才重算
          setMonths(s.months);
          setFrequency(s.frequency ?? DEFAULT_FREQUENCY);
          setInterval(clampIntervalForEditor(s.intervalMonths));
        } else {
          // 新排程：依預設頻次自動預選月份（12 個月平分）
          setMonths(autoSelectMonths(DEFAULT_FREQUENCY, monthOrder));
          setFrequency(DEFAULT_FREQUENCY);
          setInterval(DEFAULT_INTERVAL_MONTHS);
        }
        caseCount.setValue(
          s?.caseCount != null ? String(s.caseCount) : "3",
        );
        // v1.88.5：受限時只載入自己單位的選擇；其他單位保留在 otherUnitIds，
        // 儲存時併回，不因編輯而刪除。
        const loadedUnitIds = s?.unitIds ?? [];
        setUnitIds(
          restricted
            ? loadedUnitIds.filter((c) => restrictedUnitCodes!.has(c))
            : loadedUnitIds,
        );
        setOtherUnitIds(
          restricted
            ? loadedUnitIds.filter((c) => !restrictedUnitCodes!.has(c))
            : [],
        );
        setUnlimited(s?.unlimitedUnits === true);
        setNotes(s?.notes ?? "");
        setPrev(pv);
      } catch (error) {
        if (!cancelled) onAction(`讀取排程失敗：${toErrorMessage(error)}`);
      } finally {
        if (!cancelled) setLoadingPeriod(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicatorId, category, period]);

  /** 切換頻次下拉 → 重新依規則預選月份（覆蓋手動勾選） */
  function handleFrequencyChange(f: ReviewFrequency) {
    setFrequency(f);
    setMonths(autoSelectMonths(f, monthOrder));
  }

  function handleCopyPrev() {
    if (!prev) return;
    setMonths([...prev.months]);
    if (prev.frequency) setFrequency(prev.frequency);
    setInterval(clampIntervalForEditor(prev.intervalMonths));
    caseCount.setValue(
      prev.caseCount != null ? String(prev.caseCount) : "3",
    );
    // v1.88.5：受限時只帶入自己單位；不限單位旗標與其他單位保留現況，
    // 不由前一期帶入。
    setUnitIds(
      restricted
        ? [...prev.unitIds].filter((c) => restrictedUnitCodes!.has(c))
        : [...prev.unitIds],
    );
    if (!restricted) setUnlimited(prev.unlimitedUnits === true);
    setNotes(prev.notes);
    onAction(`已帶入前一期（${prev.periodLabel}）設定，請確認後儲存`);
  }

  async function handleSave() {
    // v1.88.19：已標記刪除時，「儲存設定」就是執行刪除（不寫回設定）
    if (pendingDelete) {
      await performDelete();
      return;
    }
    if (months.length === 0) {
      onAction("請至少選擇一個審查月份");
      return;
    }
    if (unitIds.length === 0 && !unlimited) {
      onAction("請勾選不限單位或至少選擇一個受審單位");
      return;
    }
    // v1.18：審查件數改為必填
    if (caseCount.value.trim() === "") {
      onAction("請填寫審查件數");
      return;
    }
    setSaving(true);
    try {
      const db = getFirebaseDb();
      const cc = Number(caseCount.value);
      await saveSchedule(
        db,
        {
          indicatorId,
          category,
          period,
          periodLabel: periodLabel(category, period),
          months: [...months].sort((a, b) => a - b),
          frequency,
          // v1.23：區間由下拉獨立選擇（1／2／3 個月），不再由頻次衍生
          intervalMonths: interval,
          refYear: null,
          caseCount: parseCaseCount(cc),
          // v1.88.5：受限時併回其他單位的既有設定（只改自己單位）；
          // 不限單位時 unitIds 為空（與既有行為一致）。
          unitIds: unlimited ? [] : [...new Set([...unitIds, ...otherUnitIds])],
          unlimitedUnits: unlimited,
          notes: notes.trim(),
          selfReview: false,
          updatedBy: actor.id,
          updatedByName: actor.name,
          updatedAt: null,
        },
        actor,
      );
      onAction(
        `已儲存 ${indicatorName}・${periodLabel(category, period)}排程設定`,
      );
      onSaved();
    } catch (error) {
      onAction(`儲存失敗：${toErrorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    // v1.88.5：單位排程者僅能刪除只含自己單位的期間設定；含其他單位
    // （或不限單位）者僅能由管理員刪除（防護，正常流程下該按鈕不顯示）。
    if (restricted && (otherUnitIds.length > 0 || unlimited)) {
      onAction("此排程包含其他單位，僅能由管理員刪除");
      return;
    }
    // v1.88.19：先確認，確認後只標記待刪除，按「儲存設定」才真正刪除；
    // 未儲存就離開此頁，設定保持不變。
    const ok = window.confirm(
      `確定刪除 ${periodLabel(category, period)} 的排程設定？將一併刪除該排程的未完成任務；已完成任務與已提交的審查紀錄不受影響。按「儲存設定」後才真正刪除。`,
    );
    if (!ok) return;
    setPendingDelete(true);
    onAction(
      `已標記刪除 ${periodLabel(category, period)} 的排程設定，按「儲存設定」後才真正刪除；未儲存就離開則不刪除。`,
    );
  }

  async function performDelete() {
    setSaving(true);
    try {
      const db = getFirebaseDb();
      const { deletedTasks, keptDoneTasks } = await deleteScheduleWithTasks(
        db,
        indicatorId,
        category,
        period,
        actor,
      );
      onAction(
        `已刪除 ${periodLabel(category, period)} 排程設定（刪除 ${deletedTasks} 筆未完成任務，已完成 ${keptDoneTasks} 筆保留）`,
      );
      onSaved();
    } catch (error) {
      onAction(`刪除失敗：${toErrorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <section className="panel">
        <SectionTitle
          title="排程設定"
          note={`${categoryLabel(category)}・${periodLabel(category, period)}`}
        />
        {loadingPeriod ? (
          <p className="settings-note">讀取中…</p>
        ) : (
          <>
            <div className="form-row">
              <FormSelect label="年份" maxWidth={200} value={year}
                    onChange={(e) => setYear(Number(e.target.value))}>
                    {YEAR_FILTER_OPTIONS.map((y) => (
                      <option key={y} value={y}>
                        {yearOptionLabel(y)}
                      </option>
                    ))}
                  </FormSelect>
              <FormSelect label="年別" maxWidth={160} value={category} disabled>
                    <option value="year">年度</option>
                    <option value="academic">學年度</option>
                  </FormSelect>
              <div className="form-field" style={{ maxWidth: 280 }}>
                <label className="field-label">複製前一期</label>
                <button
                  className="button button-outline"
                  disabled={!canEdit || !prev}
                  title={
                    prev
                      ? `帶入 ${prev.periodLabel} 的頻次／月份／件數／單位／備註`
                      : "前一期無排程資料"
                  }
                  onClick={handleCopyPrev}
                >
                  <Copy size={15} />{" "}
                  {prev ? `帶入 ${prev.periodLabel}` : "前一期無資料"}
                </button>
              </div>
            </div>

            <div className="form-field">
              <label className="field-label">
                受審單位（可複選）
                {!unlimited && unitIds.length > 0 && `：已選 ${unitIds.length} 個`}
              </label>
              <label className="check-row" style={{ marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={unlimited}
                  // v1.88.5：單位排程者不提供不限單位（不限單位等於幫所有
                  // 單位排）；既有不限單位排程的旗標維持現況、不可切換。
                  disabled={!canEdit || restricted}
                  onChange={(e) => setUnlimited(e.target.checked)}
                />
                <b>不限單位</b>
                <span className="muted-text">
                  （不固定單位、沒有單位限制；單位顯示為 NA，審查時不用選單位）
                  {restricted && "；單位召集人／執行幹事僅能為自己單位排程，不提供此選項"}
                </span>
              </label>
              {restricted && (
                <p className="settings-note">
                  僅能為自己單位（{restrictedUnitName || "尚未設定所屬單位"}）排程
                  {otherUnitIds.length > 0 &&
                    "；其他單位的既有設定會保留，不會因儲存而刪除"}
                  。月份、頻次、件數為該指標該期間共用設定。
                </p>
              )}
              {restricted && restrictedUnitCodes!.size === 0 && (
                <p className="settings-note">
                  尚未設定所屬單位，請先至「群組與人員」→「人員」設定單位。
                </p>
              )}
              <UnitTreePicker
                units={
                  restricted
                    ? units.filter((u) => restrictedUnitCodes!.has(u.code))
                    : units
                }
                groupMap={groupMap}
                selected={unitIds}
                onChange={setUnitIds}
                disabled={!canEdit || unlimited}
                unitNameOf={unitNameOf}
              />
            </div>

            <div className="form-row">
              <FormSelect label="審查頻次" maxWidth={200} value={frequency}
                    disabled={!canEdit}
                    onChange={(e) =>
                      handleFrequencyChange(Number(e.target.value) as ReviewFrequency)
                    }>
                    {FREQUENCY_OPTIONS.map((f) => (
                      <option key={f} value={f}>
                        {frequencyLabel(f)}
                      </option>
                    ))}
                  </FormSelect>
              <FormSelect label="審查區間" maxWidth={200} value={interval}
                    disabled={!canEdit}
                    onChange={(e) =>
                      setInterval(Number(e.target.value) as 1 | 2 | 3)
                    }>
                    {INTERVAL_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n}個月
                      </option>
                    ))}
                  </FormSelect>
              <div className="form-field" style={{ maxWidth: 200 }}>
                <label className="field-label">
                  {unlimited ? "每審查區間件數 *" : "每單位每審查區間件數 *"}
                  <span className="muted-text">
                    {unlimited
                      ? "（區間內各月份合計；區間內所有審查員共用）"
                      : "（區間內各月份合計；同單位多位審查員共用）"}
                  </span>
                </label>
                <span className="case-count-field">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={caseCount.value}
                    placeholder="3"
                    disabled={!canEdit}
                    onChange={(e) => caseCount.onInput(e.target.value)}
                    aria-label="審查件數"
                  />
                  件
                </span>
              </div>
            </div>
            <p className="settings-note">
              審查頻次將 12 個月平分（例：4次/年 → 1、4、7、10月；學年度
              3次/年 → 8、12、4月）；審查區間為每次審查連續涵蓋的月數。
              {months.length > 0 &&
                ` 本次審查區間：${intervalRangeLabels(
                  [...months].sort(
                    (a, b) => monthOrder.indexOf(a) - monthOrder.indexOf(b),
                  ),
                  interval,
                ).join("、")}`}
            </p>

            <div className="form-field">
              <label className="field-label">
                審查月份（可複選）
                {months.length > 0 && `：已選 ${months.length} 個月`}
              </label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                <button
                  className="button button-outline button-sm"
                  disabled={!canEdit}
                  onClick={() => setMonths(autoSelectMonths(frequency, monthOrder))}
                >
                  依頻次預選
                </button>
                <button
                  className="button button-outline button-sm"
                  disabled={!canEdit}
                  onClick={() => setMonths([...monthOrder])}
                >
                  全選
                </button>
                <button
                  className="button button-outline button-sm"
                  disabled={!canEdit}
                  onClick={() => setMonths([])}
                >
                  清除
                </button>
              </div>
              <MonthPicker
                order={monthOrder}
                selected={months}
                onChange={setMonths}
                disabled={!canEdit}
              />
              <p className="settings-note">
                切換審查頻次會依規則重新預選月份（覆蓋手動勾選），之後可再手動調整。
                {category === "academic" &&
                  "學年度月份依 8 月制順序排列（8–12 月為前一年曆年、1–7 月為後一年曆年）。"}
              </p>
            </div>

            <div className="form-field">
              <label className="field-label">備註</label>
              <textarea
                className="text-input"
                rows={2}
                value={notes}
                disabled={!canEdit}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="例如：避開農曆年節月份"
              />
            </div>

            <div className="form-actions">
              {canEdit && (
                <button
                  className="button button-primary"
                  disabled={saving}
                  onClick={handleSave}
                >
                  {saving
                    ? pendingDelete
                      ? "刪除中…"
                      : "儲存中…"
                    : pendingDelete
                      ? "儲存設定（將刪除此期間設定）"
                      : "儲存設定"}
                </button>
              )}
              {canEdit && exists && pendingDelete && (
                <>
                  <span className="settings-note" style={{ color: "#b3372f" }}>
                    已標記刪除此期間設定，按「儲存設定」後才真正刪除；未儲存就離開則不刪除。
                  </span>
                  <button
                    className="button button-outline"
                    disabled={saving}
                    onClick={() => setPendingDelete(false)}
                  >
                    取消刪除
                  </button>
                </>
              )}
              {canEdit && exists && !pendingDelete && !(restricted && (otherUnitIds.length > 0 || unlimited)) && (
                <button className="button button-ghost" onClick={handleDelete}>
                  <Trash2 size={15} /> 刪除此期間設定
                </button>
              )}
              {canEdit && exists && restricted && (otherUnitIds.length > 0 || unlimited) && (
                <span className="settings-note">
                  此排程包含其他單位，僅能由管理員刪除。
                </span>
              )}
            </div>
          </>
        )}
      </section>
    </>
  );
}
