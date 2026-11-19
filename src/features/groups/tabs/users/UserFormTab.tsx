import { Modal, ErrorState, SectionTitle, FormSelect, MaskedNameInput } from "../../../../components/ui";
import { ChevronDown, X, Plus, Pencil, Trash2 } from "lucide-react";
import type { GroupsCtx } from "../../hooks/useGroupsCtx";

export function UserFormTab({ ctx }: { ctx: GroupsCtx }) {
  const { tab, userView, isUserEditing, userForm, resetMembershipAddArea, setUserView, userError, userErrorRef, masterLoadError, titlesLoadError, rolesLoadError, levelsLoadError, loadMaster, loadTitles, loadRoles, loadLevels, setUserForm, units, reviewerRoleSelected, userTitleLevelId, setUserTitleLevelId, titleLevels, titles, membershipAddLevelId, setMembershipAddLevelId, setMembershipAddRoleName, roleLevels, setMembershipAddGroupId, membershipAddIsCommittee, membershipAddIsUnit, membershipAddGroupId, setMembershipError, groups, membershipAddRoleName, setMembershipAddRoles, roleOptions, membershipAddRoles, toggleMembershipAddRole, membershipEditingGroupId, groupNameOf, membershipError, handleMembershipAddOrUpdate, cancelMembershipEdit, membershipRowGroupLabel, startMembershipEdit, removeMembershipByGroup, userSaving, handleUserSave } = ctx;

  return <>{tab === "users" && userView.kind !== "list" && (
        <Modal
          title={isUserEditing ? `編輯人員 ${userForm.staffId}` : "新增人員"}
          note={isUserEditing ? "職編不可變更" : "儲存後請再到 Firebase Console → Authentication 建立登入帳號"}
          onClose={() => {
            resetMembershipAddArea();
            setUserView({ kind: "list" });
          }}
          wide
        >
        <div className="user-long-form">
          {userError && (
            <div ref={userErrorRef} className="login-error form-error-summary" role="alert" tabIndex={-1}>
              <b>請修正以下問題</b>
              <span>{userError}</span>
            </div>
          )}
          {/* v1.88.2：三區塊編號導覽列（1. 基本資料／2. 職稱／3. 品管組與角色）已拿掉 */}
          {(masterLoadError || titlesLoadError || rolesLoadError || levelsLoadError) && (
            <ErrorState
              title="人員表單參考資料載入失敗"
              description={[masterLoadError, titlesLoadError, rolesLoadError, levelsLoadError].filter(Boolean).join("；")}
              onRetry={() => { void Promise.all([loadMaster(), loadTitles(), loadRoles(), loadLevels()]); }}
            />
          )}
          <section id="user-form-basic" className="user-form-step" tabIndex={-1}>
            <SectionTitle title="基本資料" note="* 為必填欄位。" />
            <div className="user-form-fields">
          <div className="form-field">
            <label className="field-label">職編 *</label>
            <input
              className="text-input"
              aria-required="true"
              value={userForm.staffId}
              disabled={isUserEditing}
              placeholder="例如 A12345（即登入帳號）"
              onChange={(e) =>
                setUserForm((prev) => ({ ...prev, staffId: e.target.value }))
              }
            />
          </div>
          <FormSelect label="單位" value={userForm.unitCode}
                onChange={(e) => {
                  const nextUnitCode = e.target.value;
                  setUserForm((prev) => ({ ...prev, unitCode: nextUnitCode }));
                }}>
                <option value="">— 未指定 —</option>
                {units.map((u) => (
                  <option key={u.code} value={u.code}>
                    {u.name ? `${u.code}｜${u.name}` : u.code}
                  </option>
                ))}
              </FormSelect>
          <div className="form-field">
            <label className="field-label">姓名 *</label>
            <MaskedNameInput
              className="text-input"
              aria-required="true"
              value={userForm.name}
              placeholder="例如 王O明"
              onChange={(next) =>
                setUserForm((prev) => ({ ...prev, name: next }))
              }
            />
          </div>
          <div className="form-field">
            <label className="field-label">Email</label>
            <input
              className="text-input"
              type="email"
              value={userForm.email}
              placeholder="例如 name@example.com（供通知與重設密碼）"
              onChange={(e) =>
                setUserForm((prev) => ({ ...prev, email: e.target.value }))
              }
            />
          </div>
          <div className="form-field">
            <label className="field-label">到職日</label>
            <input
              className="text-input"
              type="date"
              value={userForm.hireDate}
              onChange={(e) =>
                setUserForm((prev) => ({ ...prev, hireDate: e.target.value }))
              }
            />
          </div>
          <div className="form-field">
            <label className="field-label">電話</label>
            <input
              className="text-input"
              value={userForm.phone}
              placeholder="例如 0912-345-678"
              onChange={(e) =>
                setUserForm((prev) => ({ ...prev, phone: e.target.value }))
              }
            />
          </div>
          {reviewerRoleSelected && (
            <div className="form-field">
              <label className="field-label" htmlFor="reviewer-access-expiry">審查員授權效期</label>
              <input
                id="reviewer-access-expiry"
                className="text-input"
                type="date"
                value={userForm.reviewerAccessExpiresAt}
                onChange={(event) => setUserForm((prev) => ({
                  ...prev,
                  reviewerAccessExpiresAt: event.target.value,
                }))}
              />
              <p className="settings-note">留白為永久有效（預設）；設定日期後，審查員權限於該日結束後失效。</p>
            </div>
          )}
          {!isUserEditing && (
            <div className="form-field user-form-note">
              <p className="settings-note">登入帳號為職編，認證信寄到「職編去掉開頭的 0＋@kmuh.org.tw」；新增後由每小時對帳建立登入帳號，該員在登入頁按「開通帳號」自行設定密碼；刪除或停用人員時，登入帳號也會一併刪除或停用。</p>
            </div>
          )}
            </div>
          </section>

          <section id="user-form-title" className="user-form-step" tabIndex={-1}>
            <SectionTitle title="職稱" note="先選層級，再選該層級的職稱。" />
            {/* v1.87.0：督導負責單位已搬到職稱成員管理頁的督導頁設定，人員編輯不再設 */}
            <div className="user-form-fields">
          <FormSelect label="層級" value={userTitleLevelId}
                onChange={(e) => {
                  setUserTitleLevelId(e.target.value);
                  setUserForm((prev) => ({ ...prev, titleId: "", title: "", titleUnitCodes: [] }));
                }}>
                <option value="">請選擇層級</option>
                {titleLevels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
                <option value="__ungrouped__">未分層級</option>
              </FormSelect>
          <div className="form-field">
            <label className="field-label">職稱</label>
            <div className="select-wrap">
              <select
                value={userForm.titleId}
                disabled={!userTitleLevelId}
                onChange={(e) => {
                  const title = titles.find((item) => item.id === e.target.value);
                  setUserForm((prev) => ({
                    ...prev,
                    titleId: title?.id ?? "",
                    title: title?.name ?? "",
                    // v1.58.0：換職稱時清空負責單位，改由新職稱的條件決定
                    titleUnitCodes: [],
                  }));
                }}
              >
                <option value="">
                  {userTitleLevelId ? "請選擇職稱" : "請先選擇層級"}
                </option>
                {titles
                  .filter((t) =>
                    userTitleLevelId === "__ungrouped__"
                      ? !t.levelId
                      : t.levelId === userTitleLevelId,
                  )
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
              <ChevronDown size={15} />
            </div>
            {userForm.titleId ? (
              <p className="settings-note">
                已選：{userForm.title}{" "}
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    setUserForm((prev) => ({ ...prev, titleId: "", title: "", titleUnitCodes: [] }))
                  }
                >
                  移除重選
                </button>
              </p>
            ) : (
              <p className="settings-note">可留白：新帳號預設為一般使用者，職稱與角色之後再賦予。</p>
            )}
          </div>
            </div>
          </section>

          <section id="user-form-roles" className="user-form-step" tabIndex={-1}>
        <SectionTitle
          title="品管組與角色"
          note="上方加入、下方列表；每個品管組的角色與權限各自隔離，加入後即顯示於列表，按「儲存修改」才生效。"
        />
        {/* v1.52.0：分工表式——上方加入區＋下方角色列表（每群組一列，可編輯／刪除） */}
        <div className="panel" style={{ padding: 12, marginBottom: 8 }}>
          {/* v1.57.0 A6：群組→層級→角色三層下拉；選角色後進下方已選列，可多重 */}
          <div className="user-form-fields">
            <FormSelect label="層級" value={membershipAddLevelId}
                  onChange={(e) => {
                    const next = e.target.value;
                    setMembershipAddLevelId(next);
                    setMembershipAddRoleName("");
                    // v1.88.1：切到委員會層級不選品管組，清掉殘留的品管組選擇
                    // v1.88.2：切到單位層級亦不選品管組，比照清除
                    if (
                      next === "rl-committee" ||
                      next === "rl-unit" ||
                      roleLevels.find((l) => l.id === next)?.name === "委員會" ||
                      roleLevels.find((l) => l.id === next)?.name === "單位"
                    ) {
                      setMembershipAddGroupId("");
                    }
                  }}>
                  <option value="">請選擇層級</option>
                  {roleLevels.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                  <option value="__ungrouped__">未分層級</option>
                </FormSelect>
            {/* v1.88.1：委員會在品管組之上，選委員會層級不顯示品管組下拉、不要求選擇
                v1.88.2：單位層級亦不顯示，範圍以基本資料的所屬單位為準 */}
            {!membershipAddIsCommittee && !membershipAddIsUnit && (
            <FormSelect label="品管組" value={membershipAddGroupId}
                  onChange={(e) => {
                    // v1.51.0：切換群組不得清空已勾角色（加入區群組與角色為獨立 state）
                    setMembershipAddGroupId(e.target.value);
                    setMembershipError("");
                  }}>
                  <option value="">請選擇品管組</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </FormSelect>
            )}
            <FormSelect label="角色" value={membershipAddRoleName}
                  disabled={!membershipAddLevelId}
                  onChange={(e) => {
                    const name = e.target.value;
                    if (name) {
                      setMembershipAddRoles((prev) =>
                        prev.includes(name) ? prev : [...prev, name],
                      );
                      setMembershipAddRoleName("");
                    }
                  }}>
                  <option value="">
                    {membershipAddLevelId ? "請選擇角色" : "請先選擇層級"}
                  </option>
                  {roleOptions
                    .filter(
                      (r) =>
                        (membershipAddLevelId === "__ungrouped__"
                          ? !r.levelId
                          : r.levelId === membershipAddLevelId) &&
                        !membershipAddRoles.includes(r.name),
                    )
                    .map((r) => (
                      <option key={r.id} value={r.name}>
                        {r.name}
                      </option>
                    ))}
                </FormSelect>
          </div>
          {membershipAddRoles.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                alignItems: "center",
                margin: "4px 0",
              }}
            >
              <span className="settings-note">已選：</span>
              {membershipAddRoles.map((r) => (
                <span key={r} className="status-pill muted">
                  {r}{" "}
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`移除 ${r}`}
                    onClick={() => toggleMembershipAddRole(r)}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {membershipEditingGroupId !== null && (
            <p className="settings-note">
              正在編輯：{groupNameOf(membershipEditingGroupId)}
              （按「更新」寫回原列；角色全取消會刪除該品管組）
            </p>
          )}
          {membershipError && <div className="login-error">{membershipError}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              className="button button-primary button-sm"
              onClick={handleMembershipAddOrUpdate}
            >
              {membershipEditingGroupId === null ? (
                <>
                  <Plus size={14} /> 加入
                </>
              ) : (
                "更新"
              )}
            </button>
            {membershipEditingGroupId !== null && (
              <button
                className="button button-outline button-sm"
                onClick={cancelMembershipEdit}
              >
                取消編輯
              </button>
            )}
          </div>
        </div>
        <div className="panel" style={{ padding: 12 }}>
          <p className="settings-note" style={{ marginTop: 0 }}>
            {userForm.memberships.length} 個品管組・
            {userForm.memberships.reduce((n, m) => n + m.roles.length, 0)} 個角色
          </p>
          {userForm.memberships.length === 0 ? (
            <p className="settings-note">尚無品管組＋角色，請由上方加入。</p>
          ) : (
            <div className="table-scroll">
              <table className="permission-table">
                <thead>
                  <tr>
                    <th>群組</th>
                    <th>角色</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {userForm.memberships.map((m) => (
                    <tr key={m.groupId}>
                      <td>
                        <b>{membershipRowGroupLabel(m)}</b>
                      </td>
                      <td>
                        {m.roles.map((r) => (
                          <span
                            key={r}
                            className="status-pill muted"
                            style={{ marginRight: 4 }}
                          >
                            {r}
                          </span>
                        ))}
                      </td>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => startMembershipEdit(m.groupId)}
                        >
                          <Pencil size={13} /> 編輯
                        </button>{" "}
                        <button
                          className="text-button"
                          onClick={() => removeMembershipByGroup(m.groupId)}
                        >
                          <Trash2 size={13} /> 刪除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="form-actions">
          <button
            className="button button-primary"
            disabled={userSaving}
            onClick={handleUserSave}
          >
            {userSaving ? "儲存中…" : isUserEditing ? "儲存修改" : "建立人員"}
          </button>
          <button
            className="button button-outline"
            onClick={() => {
              resetMembershipAddArea();
              setUserView({ kind: "list" });
            }}
          >
            取消
          </button>
        </div>
          </section>
        </div>
        </Modal>
      )}</>;
}
