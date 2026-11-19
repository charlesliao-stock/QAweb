import type { IndicatorLite, UserLite } from "../model/types";
import { useState, useMemo } from "react";
import { tempCycleMonths, type TempCycleMonth } from "../../../lib/cycle";
import { useCaseCountInput, CalendarMonthPicker } from "./pickers";
import { defaultSelfAuditReviewers, previewTempTaskCount } from "../model/pure";
import { getFirebaseDb } from "../../../lib/firebase";
import { createTempSchedule, parseCaseCount } from "../../../lib/scheduling";
import { pad2 } from "../../../lib/ym";
import { toErrorMessage } from "../../../lib/errors";
import { Modal } from "./Modal";
import { FormSelect } from "../../../components/ui";
import { staffLabel } from "../../../lib/mask";
import { Check } from "lucide-react";

/* ================= 自審（護理長，臨時排程） ================= */

export function SelfAuditDialog({
  indicators,
  userUnitCode,
  userUnitName,
  unitUsers,
  usersMap,
  actor,
  deadlineDay,
  onAction,
  onClose,
  onDone,
}: {
  indicators: IndicatorLite[];
  userUnitCode: string;
  userUnitName: string;
  unitUsers: UserLite[];
  usersMap: Map<string, string>;
  actor: { id: string; name: string };
  deadlineDay: number;
  onAction: (m: string) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const [indicatorId, setIndicatorId] = useState(
    () => indicators.find((i) => i.status === "啟用")?.id ?? "",
  );
  // v1.17：自審指標選擇器只列「啟用」的指標
  const activeIndicators = indicators.filter((i) => i.status === "啟用");
  // v1.88.19：自審同為臨時排程，月份選項＝今年 12 個月＋明年 1 月，共 13 個月。
  const selfMonthOptions = useMemo(
    () => tempCycleMonths("year", new Date().getFullYear()),
    [],
  );
  const [months, setMonths] = useState<TempCycleMonth[]>([]);
  const caseCount = useCaseCountInput();
  const [reviewerIds, setReviewerIds] = useState<string[]>(() =>
    defaultSelfAuditReviewers(unitUsers, userUnitCode),
  );
  const [saving, setSaving] = useState(false);
  // v1.60.0：常駐錯誤區（與加審對話框一致）
  const [submitError, setSubmitError] = useState<string | null>(null);

  function toggleReviewer(id: string) {
    setReviewerIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  const previewTasks = previewTempTaskCount(months, [userUnitCode], reviewerIds);

  async function handleConfirm() {
    // v1.60.0：防重入（與加審對話框一致）
    if (saving) return;
    setSubmitError(null);
    if (!indicatorId) {
      onAction("請選擇指標");
      return;
    }
    if (months.length === 0) {
      onAction("請至少選擇一個審查月份");
      return;
    }
    if (reviewerIds.length === 0) {
      onAction("請至少選擇一位審核員");
      return;
    }
    setSaving(true);
    try {
      const db = getFirebaseDb();
      const cc =
        caseCount.value.trim() === "" ? null : Number(caseCount.value);
      const { taskCount } = await createTempSchedule(db, {
        indicatorId,
        unitIds: [userUnitCode],
        months: [...new Set(months.map((m) => m.month))].sort(
          (a, b) => a - b,
        ),
        // v1.88.19：明確曆年月（13 個月可跨曆年），任務曆年以此為準。
        calendarMonths: months.map((m) => `${m.year}/${pad2(m.month)}`),
        caseCount: parseCaseCount(cc),
        reviewerIds: [...reviewerIds],
        selfReview: true,
        actor,
        deadlineDay,
      });
      const indName =
        indicators.find((i) => i.id === indicatorId)?.name ?? indicatorId;
      onAction(`已建立自審排程（臨時）：${indName}・${taskCount} 筆任務`);
      onDone();
    } catch (error) {
      const msg = `自審失敗：${toErrorMessage(error)}`;
      setSubmitError(msg);
      console.error("[自審失敗]", error);
      onAction(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title="新增自審"
      note="護理長為自己單位建立的臨時自審排程（清單年別欄顯示「自審」標籤）"
      onClose={onClose}
    >
      <FormSelect label="指標" maxWidth={320} value={indicatorId}
            onChange={(e) => setIndicatorId(e.target.value)}>
            {activeIndicators.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}（{i.id}）
              </option>
            ))}
          </FormSelect>

      <div className="form-field">
        <label className="field-label">受審單位（鎖定）</label>
        <p>
          <b>{userUnitName}</b>
          <span className="muted-text">（{userUnitCode}）</span>
        </p>
      </div>

      <div className="form-field">
        <label className="field-label">
          審查月份（可複選）
          {months.length > 0 && `：已選 ${months.length} 個月`}
        </label>
        <CalendarMonthPicker
          options={selfMonthOptions}
          selected={months}
          onChange={setMonths}
          disabled={false}
        />
        <p className="settings-note">
          提供今年全部 12 個月＋明年 1 月，共 13 個月可選。
        </p>
      </div>

      <div className="form-field">
        <label className="field-label">
          審查件數
          <span className="muted-text">（留白＝未設定）</span>
        </label>
        <span className="case-count-field">
          <input
            type="number"
            min={1}
            step={1}
            value={caseCount.value}
            placeholder="未設定"
            onChange={(e) => caseCount.onInput(e.target.value)}
            aria-label="審查件數"
          />
          件
        </span>
      </div>

      <div className="form-field">
        <label className="field-label">
          審核員（可複選；預設為自己單位在職人員）
        </label>
        {unitUsers.length === 0 ? (
          <p className="settings-note">自己單位尚無在職人員資料。</p>
        ) : (
          <div className="unit-check-grid">
            {unitUsers.map((u) => (
              <label key={u.id} className="check-row">
                <input
                  type="checkbox"
                  checked={reviewerIds.includes(u.id)}
                  onChange={() => toggleReviewer(u.id)}
                />
                <span>
                  {staffLabel(u.id, usersMap.get(u.id) ?? "")}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="form-field">
        <label className="field-label">預覽</label>
        <p>
          <b>{previewTasks}</b> 筆任務
          <span className="muted-text">
            （{months.length} 個月 × 1 單位 × {reviewerIds.length}{" "}
            位審核員）
          </span>
        </p>
      </div>

      {submitError && (
        <div className="form-error" role="alert">
          {submitError}
        </div>
      )}

      <div className="form-actions">
        <button
          className="button button-primary"
          disabled={saving || previewTasks === 0 || !indicatorId}
          onClick={handleConfirm}
        >
          {saving ? "建立中…" : (
            <>
              <Check size={15} /> 確認自審
            </>
          )}
        </button>
        <button className="button button-ghost" onClick={onClose}>
          取消
        </button>
      </div>
    </Modal>
  );
}
