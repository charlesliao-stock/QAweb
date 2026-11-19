import { Modal, FormSelect } from "../../../../components/ui";
import type { GroupsCtx } from "../../hooks/useGroupsCtx";

export function UnitFormTab({ ctx }: { ctx: GroupsCtx }) {
  const { tab, unitView, isUnitEditing, unitForm, setUnitView, unitError, setUnitForm, groups, units, unitSaving, handleUnitSave } = ctx;

  return <>{tab === "units" && unitView.kind !== "list" && (
        <Modal
          title={isUnitEditing ? `編輯單位 ${unitForm.code}` : "新增單位"}
          note={isUnitEditing ? "單位代號不可變更（更名時代號不變）" : undefined}
          onClose={() => setUnitView({ kind: "list" })}
        >
          {unitError && <div className="login-error">{unitError}</div>}
          <div className="form-grid">
            <div className="form-field">
              <label className="field-label">單位代號 *</label>
              <input
                className="text-input"
                value={unitForm.code}
                disabled={isUnitEditing}
                placeholder="例如 9A"
                onChange={(e) =>
                  setUnitForm((prev) => ({ ...prev, code: e.target.value }))
                }
              />
            </div>
            <div className="form-field">
              <label className="field-label">單位名稱 *</label>
              <input
                className="text-input"
                value={unitForm.name}
                placeholder="例如 9A病房"
                onChange={(e) =>
                  setUnitForm((prev) => ({ ...prev, name: e.target.value }))
                }
              />
            </div>
            <FormSelect label="所屬品管組" value={unitForm.groupId}
                  onChange={(e) =>
                    setUnitForm((prev) => ({ ...prev, groupId: e.target.value }))
                  }>
                  <option value="">— 未分類 —</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </FormSelect>
            <div className="form-field">
              <label className="field-label" htmlFor="merged-from-units">合併自舊單位（可複選）</label>
              <select
                id="merged-from-units"
                className="text-input"
                multiple
                size={Math.min(5, Math.max(3, units.length))}
                value={unitForm.mergedFromUnitCodes}
                onChange={(event) => setUnitForm((prev) => ({
                  ...prev,
                  mergedFromUnitCodes: Array.from(event.target.selectedOptions, (option) => option.value),
                }))}
              >
                {units.filter((candidate) => candidate.code !== unitForm.code && (
                  unitForm.mergedFromUnitCodes.includes(candidate.code) ||
                  !units.some((other) => other.code !== unitForm.code && other.mergedFromUnitCodes.includes(candidate.code))
                )).map((candidate) => (
                  <option key={candidate.code} value={candidate.code}>{candidate.name}（{candidate.code}）</option>
                ))}
              </select>
              <p className="settings-note">選取後，新單位護理長可在分析中查看合併前歷史資料；不會授予個人明細下鑽權限。</p>
            </div>
          </div>
          <div className="form-actions">
            <button
              className="button button-primary"
              disabled={unitSaving}
              onClick={handleUnitSave}
            >
              {unitSaving ? "儲存中…" : isUnitEditing ? "儲存修改" : "建立單位"}
            </button>
            <button
              className="button button-outline"
              onClick={() => setUnitView({ kind: "list" })}
            >
              取消
            </button>
          </div>
        </Modal>
      )}</>;
}
