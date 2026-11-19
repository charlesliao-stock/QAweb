import { Modal } from "../../../../components/ui";
import type { GroupsCtx } from "../../hooks/useGroupsCtx";

export function GroupFormTab({ ctx }: { ctx: GroupsCtx }) {
  const { tab, groupView, isGroupEditing, setGroupView, groupError, groupForm, setGroupForm, groupSaving, handleGroupSave } = ctx;

  return <>{tab === "groups" && groupView.kind !== "list" && (
        <Modal
          title={isGroupEditing ? "編輯品管組" : "新增品管組"}
          note="品管組名稱不可重複（例如：病房組）"
          onClose={() => setGroupView({ kind: "list" })}
        >
          {groupError && <div className="login-error">{groupError}</div>}
          <div className="form-grid">
            <div className="form-field">
              <label className="field-label">品管組名稱 *</label>
              <input
                className="text-input"
                value={groupForm.name}
                placeholder="例如 病房組"
                onChange={(e) =>
                  setGroupForm({ name: e.target.value })
                }
              />
            </div>
          </div>
          <div className="form-actions">
            <button
              className="button button-primary"
              disabled={groupSaving}
              onClick={handleGroupSave}
            >
              {groupSaving ? "儲存中…" : isGroupEditing ? "儲存修改" : "建立品管組"}
            </button>
            <button
              className="button button-outline"
              onClick={() => setGroupView({ kind: "list" })}
            >
              取消
            </button>
          </div>
        </Modal>
      )}</>;
}
