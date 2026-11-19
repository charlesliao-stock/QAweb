import { type PickerOption, OptionMultiPicker } from "./pickers";
import { useState, useMemo } from "react";
import { Modal } from "./Modal";
import { reviewMonthToYm, fmtYm } from "../../../lib/ym";
import { Check } from "lucide-react";

/**
 * v1.88.16：分工總覽編輯彈窗（主表＋加審對話框共用）。
 * 審查員唯讀（列的 key，不可改；要換人請刪除後重新加入）；
 * 只改負責單位與審查月份，儲存時只改本地 state、按 reviewerId 原地取代
 * （取代語意：取消勾選的單位／月份要消失，絕對不能用附加新列或聯集合併）。
 * 單位全空且未勾不限單位時，彈窗內擋下不關閉。
 * scheduleMonths 不傳時（加審對話框）不顯示月份區，reviewMonths 原值由呼叫端保留。
 */
export function AssignmentEditModal({
  reviewerLabel,
  unitOptions,
  groupMap,
  initialUnits,
  initialUnlimited,
  allowUnlimited,
  scheduleMonths,
  initialMonths,
  onSave,
  onClose,
  layer,
}: {
  reviewerLabel: string;
  unitOptions: PickerOption[];
  groupMap: Map<string, string>;
  initialUnits: string[];
  initialUnlimited: boolean;
  /** 受限者不提供不限單位 */
  allowUnlimited: boolean;
  /** 主表才有（該期排程曆月 "yyyy/mm"）；對話框不傳＝不編輯月份 */
  scheduleMonths?: string[];
  /** 該列既有審查月份（缺值＝全部月份） */
  initialMonths?: string[];
  onSave: (next: {
    units: string[];
    unlimited: boolean;
    /** 主表：缺值＝全部月份；對話框：忽略（呼叫端保留原值） */
    reviewMonths: string[] | undefined;
  }) => void;
  onClose: () => void;
  layer?: 1 | 2 | 3;
}) {
  const [units, setUnits] = useState<string[]>(initialUnits);
  const [unlimited, setUnlimited] = useState(initialUnlimited);
  const [months, setMonths] = useState<string[]>(() => [
    ...new Set(initialMonths ?? []),
  ].sort());
  const [allMonths, setAllMonths] = useState(
    (initialMonths ?? []).length === 0,
  );
  const [error, setError] = useState<string | null>(null);

  // 月份候選＝排程曆月 ∪ 該列既有月份（排程異動後，舊月份仍可保留、不被洗掉）
  const monthCandidates = useMemo(() => {
    if (scheduleMonths == null) return [];
    return [...new Set([...scheduleMonths, ...months])].sort();
  }, [scheduleMonths, months]);

  function toggleUnit(id: string) {
    setUnits((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function toggleMonth(m: string) {
    if (allMonths) {
      // 勾任一月份即取消「全部月份」
      setAllMonths(false);
      setMonths([m]);
      return;
    }
    const next = months.includes(m)
      ? months.filter((x) => x !== m)
      : [...months, m];
    if (next.length === 0) {
      // 全部取消則回到「全部月份」
      setAllMonths(true);
      setMonths([]);
    } else {
      setMonths(next);
    }
  }

  function toggleAllMonths(next: boolean) {
    setAllMonths(next);
    // 勾選時保留 months state（取消勾選可恢復原清單）；儲存時以 allMonths 為準
  }

  function save() {
    if (!unlimited && units.length === 0) {
      setError("請至少選一個負責單位，或勾選不限單位。");
      return;
    }
    onSave({
      units: unlimited ? [] : [...units],
      unlimited,
      reviewMonths:
        scheduleMonths == null
          ? undefined
          : allMonths
            ? undefined
            : [...months].sort(),
    });
  }

  return (
    <Modal
      title={`編輯分工：${reviewerLabel}`}
      note="審查員不可更改；要換人請刪除後重新加入。儲存只改畫面，按「儲存分工表」／「確認加審」才生效。"
      onClose={onClose}
      medium
      layer={layer}
    >
      <label className="check-row" style={{ marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={unlimited}
          // v1.88.5：單位排程者不提供不限單位。
          disabled={!allowUnlimited}
          onChange={(e) => setUnlimited(e.target.checked)}
        />
        <b>不限單位</b>
        <span className="muted-text">
          （勾選後不選負責單位；單位顯示為 NA，審查時不用選單位）
          {!allowUnlimited && "；單位召集人／執行幹事僅能為自己單位排程，不提供此選項"}
        </span>
      </label>
      <OptionMultiPicker
        title="負責單位"
        options={unitOptions}
        groupMap={groupMap}
        selected={units}
        onToggle={toggleUnit}
        onToggleAll={(ids, select) =>
          setUnits((prev) =>
            select
              ? [...prev, ...ids.filter((id) => !prev.includes(id))]
              : prev.filter((id) => !ids.includes(id)),
          )
        }
        disabled={unlimited}
        searchPlaceholder="搜尋單位名稱或代碼"
      />
      {scheduleMonths != null && (
        <div style={{ marginTop: 12 }}>
          <b>審查月份</b>
          <label className="check-row" style={{ marginTop: 6 }}>
            <input
              type="checkbox"
              checked={allMonths}
              onChange={(e) => toggleAllMonths(e.target.checked)}
            />
            全部月份
          </label>
          {monthCandidates.length === 0 ? (
            <p className="settings-note">
              本期排程尚未設定審查月份，請先到「排程／單位設定」設定月份。
            </p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", marginTop: 6 }}>
              {monthCandidates.map((m) => {
                const ym = reviewMonthToYm(m);
                return (
                  <label key={m} className="check-row">
                    <input
                      type="checkbox"
                      checked={!allMonths && months.includes(m)}
                      onChange={() => toggleMonth(m)}
                    />
                    {ym ? fmtYm(ym.year, ym.month) : m}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions">
        <button className="button button-primary" onClick={save}>
          <Check size={15} /> 儲存
        </button>
        <button className="button button-ghost" onClick={onClose}>
          取消
        </button>
      </div>
    </Modal>
  );
}
