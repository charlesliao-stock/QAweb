import { Modal, FormSelect } from "../../../../components/ui";
import type { GroupsCtx } from "../../hooks/useGroupsCtx";

export function RoleEditDialog({ ctx }: { ctx: GroupsCtx }) {
  const { editingRole, setEditingRoleId, roleEditError, roleEditName, setRoleEditName, roleEditLevelId, setRoleEditLevelId, roleLevels, roleEditSaving, handleRoleRename } = ctx;

  return <>{editingRole && (
        <Modal
          title={`編輯角色「${editingRole.name}」`}
          note="角色以名稱唯一；改名會同步更新所有持有此角色的人員與權限範本。改層級影響範圍時權限範本一併遷移。身分由名稱關鍵字推導。跨設定請到權限管理。"
          onClose={() => setEditingRoleId("")}
        >
          {roleEditError && <div className="login-error">{roleEditError}</div>}
          <div className="form-field" style={{ maxWidth: 320 }}>
            <label className="field-label">角色名稱 *</label>
            <input
              className="text-input"
              value={roleEditName}
              placeholder="輸入角色名稱"
              onChange={(event) => setRoleEditName(event.target.value)}
            />
          </div>
          <FormSelect label="層級" maxWidth={320} value={roleEditLevelId}
                onChange={(event) => setRoleEditLevelId(event.target.value)}>
                <option value="">— 未分層級 —</option>
                {roleLevels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </FormSelect>
          <div className="form-actions">
            <button
              className="button button-primary"
              disabled={roleEditSaving}
              onClick={handleRoleRename}
            >
              {roleEditSaving ? "儲存中…" : "儲存修改"}
            </button>
            <button
              className="button button-outline"
              onClick={() => setEditingRoleId("")}
            >
              取消
            </button>
          </div>
        </Modal>
      )}</>;
}
