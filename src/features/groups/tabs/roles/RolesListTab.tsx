import { SectionTitle, FormSelect, LoadingState, ErrorState, EmptyState } from "../../../../components/ui";
import type { GroupsCtx } from "../../hooks/useGroupsCtx";

export function RolesListTab({ ctx }: { ctx: GroupsCtx }) {
  const { isAdmin, roleCreateOpen, roleCreateError, newRoleName, setNewRoleName, newRoleLevelId, setNewRoleLevelId, roleLevels, roleCreateSaving, handleRoleCreate, setRoleCreateOpen, rolesLoading, levelsLoading, rolesLoadError, levelsLoadError, loadRoles, loadLevels, roleRows, renderLevelCreate, roleSections, renderLevelHead, renderRoleTable } = ctx;

  return (
    (
            !isAdmin ? (
              <section className="panel">
                <div className="empty-state-block">
                  <b>僅系統管理員可建立或管理角色</b>
                  <p>如需新增或異動角色成員，請聯絡系統管理員。</p>
                </div>
              </section>
            ) : roleCreateOpen ? (
              <section className="panel data-panel indicator-form">
                <SectionTitle title="新增角色" note="新角色預設無權限，建立後請至權限管理設定權限。角色以名稱唯一；跨品管組／跨單位設定請到權限管理。" />
                {roleCreateError && <div className="login-error">{roleCreateError}</div>}
                <div className="form-field" style={{ maxWidth: 420 }}>
                  <label className="field-label">角色名稱 *</label>
                  <input
                    className="text-input"
                    value={newRoleName}
                    placeholder="輸入角色名稱"
                    onChange={(event) => setNewRoleName(event.target.value)}
                  />
                  <p className="settings-note">身分（審查員／召集人／執行幹事）由名稱關鍵字推導，範圍由層級決定。</p>
                </div>
                <FormSelect label="層級" maxWidth={420} value={newRoleLevelId}
                      onChange={(event) => setNewRoleLevelId(event.target.value)}>
                      <option value="">— 未分層級 —</option>
                      {roleLevels.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </FormSelect>
                <div className="form-actions">
                  <button className="button button-primary" disabled={roleCreateSaving} onClick={handleRoleCreate}>
                    {roleCreateSaving ? "建立中…" : "建立角色"}
                  </button>
                  <button className="button button-outline" onClick={() => setRoleCreateOpen(false)}>
                    取消
                  </button>
                </div>
              </section>
            ) : rolesLoading || levelsLoading ? (
              <LoadingState label="角色與層級資料載入中…" />
            ) : rolesLoadError || levelsLoadError ? (
              <ErrorState
                title="角色資料載入失敗"
                description={rolesLoadError || levelsLoadError}
                onRetry={() => { void Promise.all([loadRoles(), loadLevels()]); }}
              />
            ) : roleRows.length === 0 ? (
              <EmptyState
                title="尚無角色"
                description="使用右上角「新增角色」或「批次上傳」建立角色。"
              />
            ) : (
              <section className="panel data-panel">
                {renderLevelCreate("role")}
                {roleSections.map((section) => (
                  <div className="level-section" key={section.level?.id ?? "ungrouped"}>
                    {renderLevelHead(
                      "role",
                      section.level,
                      section.items.reduce((n, r) => n + (r.memberCount ?? 0), 0),
                    )}
                    {renderRoleTable(section.items)}
                  </div>
                ))}
                <div className="panel-inset">
                  <p className="settings-note">
                    角色以名稱唯一；可在此新增角色、管理成員或刪除角色。成員管理與刪除限系統管理員。角色權限請到「組織與設定 → 權限管理」設定（按名稱共用）。
                  </p>
                </div>
              </section>
            )
          )
  );
}
