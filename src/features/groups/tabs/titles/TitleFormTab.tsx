import { Modal, FormSelect } from "../../../../components/ui";
import type { GroupsCtx } from "../../hooks/useGroupsCtx";

export function TitleFormTab({ ctx }: { ctx: GroupsCtx }) {
  const { tab, titleView, isTitleEditing, setTitleView, titleError, titleForm, setTitleForm, titleLevels, titleSaving, handleTitleSave } = ctx;

  return <>{tab === "titles" && titleView.kind !== "list" && (
        <Modal
          title={isTitleEditing ? "編輯職稱" : "新增職稱"}
          note="職稱以名稱唯一；跨單位設定請到權限管理。"
          onClose={() => setTitleView({ kind: "list" })}
        >
          {titleError && <div className="login-error">{titleError}</div>}
          <div className="form-grid">
            <div className="form-field">
              <label className="field-label">職稱名稱 *</label>
              <input
                className="text-input"
                value={titleForm.name}
                placeholder="例如 護理長"
                onChange={(e) =>
                  setTitleForm((prev) => ({ ...prev, name: e.target.value }))
                }
              />
            </div>
            <FormSelect label="層級" value={titleForm.levelId}
                  onChange={(e) =>
                    setTitleForm((prev) => ({ ...prev, levelId: e.target.value }))
                  }>
                  <option value="">— 未分層級 —</option>
                  {titleLevels.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </FormSelect>
            <div className="form-field">
              <label className="field-label">主管層級（決定儀表板與結果範圍；不以名稱判斷）</label>
              <div className="form-grid">
                {(
                  [
                    ["isUnitHead", "單位主管"],
                    ["isDistrictHead", "轄區主管"],
                    ["isHospitalHead", "院級主管"],
                    ["isOfficer", "執行幹事"],
                    ["isConvener", "召集人"],
                  ] as const
                ).map(([key, label]) => (
                  <label className="check-row" key={key}>
                    <input
                      type="checkbox"
                      checked={titleForm[key]}
                      onChange={(e) =>
                        setTitleForm((prev) => ({
                          ...prev,
                          [key]: e.target.checked,
                        }))
                      }
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="form-actions">
            <button
              className="button button-primary"
              disabled={titleSaving}
              onClick={handleTitleSave}
            >
              {titleSaving ? "儲存中…" : isTitleEditing ? "儲存修改" : "建立職稱"}
            </button>
            <button
              className="button button-outline"
              onClick={() => setTitleView({ kind: "list" })}
            >
              取消
            </button>
          </div>
        </Modal>
      )}</>;
}
