import { sortByOrder, groupByLevel, type OrgLevel, sortedLevels, isSupervisorTitleName } from "../../../lib/orgLevels";
import { Pencil, Trash2, Plus } from "lucide-react";
import type { TitleRow, RoleRow } from "../model/types";
import { SortableTh, FormSelect } from "../../../components/ui";
import { maskName } from "../../../lib/mask";
import { BatchImporter } from "../components/BatchImporter";
import { MemberChecklist } from "../components/MemberChecklist";
import type { GroupsPageProps } from "../model/pageProps";
import type { useGroupsState } from "./useGroupsState";
import type { useGroupsDerived } from "./useGroupsDerived";
import type { useGroupsLoaders } from "./useGroupsLoaders";
import type { useGroupsOrgActions } from "./useGroupsOrgActions";
import type { useGroupsUserActions } from "./useGroupsUserActions";
import type { useGroupsMemberActions } from "./useGroupsMemberActions";
import type { useGroupsImporters } from "./useGroupsImporters";

export function useGroupsPanels(props: GroupsPageProps, prev: ReturnType<typeof useGroupsState> & ReturnType<typeof useGroupsDerived> & ReturnType<typeof useGroupsLoaders> & ReturnType<typeof useGroupsOrgActions> & ReturnType<typeof useGroupsUserActions> & ReturnType<typeof useGroupsMemberActions> & ReturnType<typeof useGroupsImporters>) {
  const { onOpenMemberPage, memberPage, onAction, onBackToGroups } = props;
  const { listSortKey, sortedRows, titles, titleLevels, roleRows, roleLevels, levelEdit, isAdmin, setLevelEdit, levelBusy, handleLevelRename, handleLevelMove, handleLevelDelete, levelCreateTarget, setLevelCreateTarget, setNewLevelName, setLevelError, newLevelName, levelError, handleLevelCreate, tableSort, toggleSort, handleItemMove, openTitleEdit, handleTitleDelete, openRoleEdit, openRoleMembers, handleRoleDelete, managingRole, childRolesFor, ROLE_MEMBER_UNIT_HEADER, ROLE_MEMBER_HEADER, groups, roleAddSearch, setRoleAddSearch, roleAddGroupId, setRoleAddGroupId, roleAddUnitCode, setRoleAddUnitCode, units, roleCandidates, roleAddChecked, setRoleAddChecked, roleBusy, handleRoleMembersAdd, validateRoleMemberRows, importRoleMemberRows, loadUsers, roleMembers, groupNameOf, unitLabelOf, roleMemberChecked, setRoleMemberChecked, handleRoleMembersRemove, managingTitle, childTitlesFor, titleMemberSearch, setTitleMemberSearch, titleUnitFilter, setTitleUnitFilter, titleUnitSearched, setAppliedTitleUnitFilter, setTitleUnitSearched, TITLE_MEMBER_HEADER, validateTitleMemberRows, importTitleMemberRows, filteredTitleMembers, titleMemberChecked, setTitleMemberChecked, handleTitleMembersRemove, titleBusy, titleAddSearch, setTitleAddSearch, titleCandidates, titleAddChecked, setTitleAddChecked, handleTitleMembersAdd, managingGroupId, groupUnits, groupUnitChecked, setGroupUnitChecked, handleGroupUnitsRemove, groupBusy, groupUnitAddSearch, setGroupUnitAddSearch, groupUnitCandidates, handleGroupUnitAdd, GROUP_UNIT_HEADER, validateGroupUnitRows, importGroupUnitRows, loadMaster, managingUnitCode, unitAddSearch, setUnitAddSearch, unitCandidates, unitBusy, handleUnitMemberAdd, unitMembers, unitMemberChecked, setUnitMemberChecked, handleUnitMembersRemove, titleUnitSupervisor, titleUnitAddSearch, setTitleUnitAddSearch, titleUnitCandidates, titleUnitAddChecked, setTitleUnitAddChecked, titleUnitBusy, handleTitleUnitsAdd, TITLE_UNIT_HEADER, validateTitleUnitRows, importTitleUnitRows, titleUnits, titleUnitChecked, setTitleUnitChecked, handleTitleUnitsRemove } = prev;

  // ---- v1.55.0：職稱／角色按層級分組 ----
  // v1.88.8 補項：未點本表欄位時按層級內 order 排（上下順序即階層）；
  // 點了職稱名稱／使用人數才改按該欄位排（上移／下移只認 order，不認畫面列序）。
  const sortedTitleRows =
    listSortKey === "title-name" || listSortKey === "title-count"
      ? sortedRows(
          titles,
          listSortKey,
          (row, key) =>
            key === "title-count" ? (row.userCount ?? -1) : row.name,
        )
      : sortByOrder(titles);
  const titleSections = groupByLevel(sortedTitleRows, titleLevels);
  const sortedRoleRows =
    listSortKey === "role-name" || listSortKey === "role-count"
      ? sortedRows(
          roleRows,
          listSortKey,
          (row, key) =>
            key === "role-count" ? (row.memberCount ?? -1) : row.name,
        )
      : sortByOrder(roleRows);
  const roleSections = groupByLevel(sortedRoleRows, roleLevels);

  /** 層級區段標題（層級名＋人數小計＋更名／排序／刪除；未分層級不顯示操作） */
  function renderLevelHead(
    target: "title" | "role",
    level: OrgLevel | null,
    memberCount: number,
  ) {
    const levels = target === "title" ? titleLevels : roleLevels;
    const sorted = sortedLevels(levels);
    const idx = level ? sorted.findIndex((l) => l.id === level.id) : -1;
    const isEditing =
      levelEdit?.target === target && levelEdit?.id === level?.id;
    const canEdit = target === "title" ? isAdmin : isAdmin;
    return (
      <div className="level-section-head">
        {isEditing ? (
          <>
            <input
              className="text-input"
              style={{ maxWidth: 200 }}
              value={levelEdit.name}
              onChange={(e) =>
                setLevelEdit((prev) =>
                  prev ? { ...prev, name: e.target.value } : prev,
                )
              }
            />
            <button
              className="button button-primary button-sm"
              disabled={levelBusy}
              onClick={handleLevelRename}
            >
              儲存
            </button>
            <button
              className="button button-outline button-sm"
              onClick={() => setLevelEdit(null)}
            >
              取消
            </button>
          </>
        ) : (
          <>
            <b>{level ? level.name : "未分層級"}</b>
            <span className="settings-note">{memberCount} 人</span>
            {level && canEdit && (
              <>
                <button
                  className="text-button"
                  onClick={() =>
                    setLevelEdit({ target, id: level.id, name: level.name })
                  }
                >
                  <Pencil size={13} /> 更名
                </button>
                <button
                  className="text-button"
                  disabled={idx <= 0}
                  onClick={() => handleLevelMove(target, level.id, -1)}
                >
                  上移
                </button>
                <button
                  className="text-button"
                  disabled={idx < 0 || idx >= sorted.length - 1}
                  onClick={() => handleLevelMove(target, level.id, 1)}
                >
                  下移
                </button>
                <button
                  className="text-button"
                  onClick={() => handleLevelDelete(target, level)}
                >
                  <Trash2 size={13} /> 刪除
                </button>
              </>
            )}
          </>
        )}
      </div>
    );
  }

  /** 新增層級（區段上方的小按鈕＋展開表單） */
  function renderLevelCreate(target: "title" | "role") {
    const canEdit = target === "title" ? isAdmin : isAdmin;
    if (!canEdit) return null;
    if (levelCreateTarget !== target) {
      return (
        <div className="panel-inset">
          <button
            className="button button-outline button-sm"
            onClick={() => {
              setLevelCreateTarget(target);
              setNewLevelName("");
              setLevelError("");
            }}
          >
            <Plus size={14} /> 新增層級
          </button>
        </div>
      );
    }
    return (
      <div className="panel-inset">
        <div className="form-field" style={{ maxWidth: 320 }}>
          <label className="field-label">新層級名稱</label>
          <input
            className="text-input"
            value={newLevelName}
            placeholder="例如 督導"
            onChange={(e) => setNewLevelName(e.target.value)}
          />
        </div>
        {levelError && <div className="login-error">{levelError}</div>}
        <div className="form-actions">
          <button
            className="button button-primary button-sm"
            disabled={levelBusy}
            onClick={handleLevelCreate}
          >
            建立層級
          </button>
          <button
            className="button button-outline button-sm"
            onClick={() => {
              setLevelCreateTarget(null);
              setLevelError("");
            }}
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  function renderTitleTable(rows: TitleRow[]) {
    return (
      <div className="table-scroll">
        <table className="permission-table">
          <thead>
            <tr>
              <SortableTh label="職稱名稱" sortKey="title-name" sort={tableSort} onSort={toggleSort} />
              <SortableTh label="使用人數" sortKey="title-count" sort={tableSort} onSort={toggleSort} />
              {isAdmin && <th>操作</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.id}>
                <td>
                  <b>{row.name}</b>
                </td>
                <td>
                  {row.userCount === null ? "—" : `${row.userCount} 人`}
                </td>
                {isAdmin && (
                  <td>
                    <button
                      className="text-button"
                      disabled={i === 0}
                      onClick={() => handleItemMove("title", row.id, -1)}
                    >
                      上移
                    </button>{" "}
                    <button
                      className="text-button"
                      disabled={i === rows.length - 1}
                      onClick={() => handleItemMove("title", row.id, 1)}
                    >
                      下移
                    </button>{" "}
                    <button
                      className="text-button"
                      onClick={() => openTitleEdit(row.id)}
                    >
                      <Pencil size={13} /> 編輯
                    </button>{" "}
                    {isAdmin && (
                      <button
                        className="text-button"
                        onClick={() =>
                          onOpenMemberPage?.({ kind: "title", id: row.id })
                        }
                      >
                        成員管理
                      </button>
                    )}{" "}
                    <button
                      className="text-button"
                      onClick={() => handleTitleDelete(row)}
                    >
                      <Trash2 size={13} /> 刪除
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function renderRoleTable(rows: RoleRow[]) {
    return (
      <div className="table-scroll">
        <table className="permission-table">
          <thead>
            <tr>
              <SortableTh label="角色名稱" sortKey="role-name" sort={tableSort} onSort={toggleSort} />
              <SortableTh label="成員數" sortKey="role-count" sort={tableSort} onSort={toggleSort} />
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.id}>
                <td>
                  <b>{row.name}</b>
                </td>
                <td>
                  {row.memberCount === null ? "—" : `${row.memberCount} 人`}
                </td>
                <td>
                  {isAdmin ? (
                    <>
                      <button
                        className="text-button"
                        disabled={i === 0}
                        onClick={() => handleItemMove("role", row.id, -1)}
                      >
                        上移
                      </button>{" "}
                      <button
                        className="text-button"
                        disabled={i === rows.length - 1}
                        onClick={() => handleItemMove("role", row.id, 1)}
                      >
                        下移
                      </button>{" "}
                      <button
                        className="text-button"
                        onClick={() => openRoleEdit(row.id)}
                      >
                        <Pencil size={13} /> 編輯
                      </button>{" "}
                      <button
                        className="text-button"
                        onClick={() => openRoleMembers(row.id)}
                      >
                        成員管理
                      </button>{" "}
                      <button
                        className="text-button"
                        onClick={() => handleRoleDelete(row)}
                      >
                        <Trash2 size={13} /> 刪除
                      </button>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // v1.86.0：成員／單位管理改跳獨立頁（App 以 PageId 切頁進入；以下三者只在獨立頁渲染，寫入邏輯不變）
  function renderRoleMemberPanel() {
    if (!managingRole) return null;
    // v1.87.0：委員會層級（層級 id rl-committee 或層級名「委員會」）不選品管組
    const roleLevel = roleLevels.find((l) => l.id === managingRole.levelId);
    const committeeLevel =
      managingRole.levelId === "rl-committee" || roleLevel?.name === "委員會";
    // v1.88.8 補項：下層角色＝同層級內 order 緊鄰的下一個（與職稱同規則）
    const childRoles = childRolesFor(managingRole);
    const parentRoleName =
      memberPage?.parent?.kind === "role"
        ? (roleRows.find((r) => r.id === memberPage.parent!.id)?.name ?? "")
        : "";
    const roleImportHeader =
      managingRole.scope === "unit" ? ROLE_MEMBER_UNIT_HEADER : ROLE_MEMBER_HEADER;
    const roleImportSample =
      managingRole.scope === "unit"
        ? [roleImportHeader, ["0000001", "王小明", "加護病房", managingRole.name]]
        : [
            roleImportHeader,
            ["0000001", "王小明", committeeLevel ? "" : (groups[0]?.name ?? "病房組")],
          ];
    return (
      <section className="panel data-panel">
        <div className="panel-inset">
        {/* v1.87.0：加入區移到既有成員清單上方 */}
        <div className="form-field" style={{ maxWidth: 320 }}>
          <label className="field-label">加入人員（搜尋＋全選）</label>
          <input
            className="text-input"
            placeholder="輸入職編或姓名搜尋"
            value={roleAddSearch}
            onChange={(e) => setRoleAddSearch(e.target.value)}
          />
        </div>
        {/* v1.40.3：非單位級角色一律可指定群組加入，不再只對寫死名單顯示群組選單；v1.87.0：委員會角色不顯示 */}
        {managingRole.scope !== "unit" && !committeeLevel && (
            <FormSelect label="適用品管組 *" maxWidth={320} value={roleAddGroupId}
                  onChange={(e) => setRoleAddGroupId(e.target.value)}>
                  <option value="">請選擇品管組</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </FormSelect>
          )}
        {committeeLevel && (
          <p className="settings-note">
            委員會角色：成員適用全院，不選品管組。
          </p>
        )}
        {managingRole.scope === "unit" && (
          <>
            <FormSelect label="選擇單位" maxWidth={320} value={roleAddUnitCode}
                  onChange={(e) => setRoleAddUnitCode(e.target.value)}>
                  <option value="">全部單位（依各人所屬單位）</option>
                  {units.map((u) => (
                    <option key={u.code} value={u.code}>
                      {u.code} {u.name}
                    </option>
                  ))}
                </FormSelect>
            <p className="settings-note">
              單位級角色：先選單位再設定該單位角色的人員；未選單位時，加入以各人所屬單位的品管組計（無所屬單位品管組者無法加入）。
            </p>
          </>
        )}
        {roleAddSearch.trim() !== "" &&
          (roleCandidates.length === 0 ? (
            <p className="settings-note">無符合的在職人員。</p>
          ) : (
            <>
              <div className="table-scroll">
                <table className="permission-table">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input
                          type="checkbox"
                          checked={
                            roleCandidates.length > 0 &&
                            roleCandidates.every((u) =>
                              roleAddChecked.includes(u.staffId),
                            )
                          }
                          onChange={(e) =>
                            setRoleAddChecked(
                              e.target.checked
                                ? roleCandidates.map((u) => u.staffId)
                                : [],
                            )
                          }
                          aria-label="全選"
                        />
                      </th>
                      <th>職編</th>
                      <th>姓名</th>
                      <th>所屬單位</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roleCandidates.map((u) => (
                      <tr key={u.staffId}>
                        <td>
                          <input
                            type="checkbox"
                            checked={roleAddChecked.includes(u.staffId)}
                            onChange={(e) =>
                              setRoleAddChecked((prev) =>
                                e.target.checked
                                  ? [...prev, u.staffId]
                                  : prev.filter((x) => x !== u.staffId),
                              )
                            }
                            aria-label={`選擇 ${u.staffId}`}
                          />
                        </td>
                        <td>{u.staffId}</td>
                        <td>{maskName(u.name)}</td>
                        <td>{u.unitCode || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="form-actions">
                <button
                  className="button button-primary"
                  disabled={roleAddChecked.length === 0 || roleBusy}
                  onClick={handleRoleMembersAdd}
                >
                  加入所選（{roleAddChecked.length}）
                </button>
              </div>
            </>
        ))}
        <div className="form-actions">
          <BatchImporter
            sampleBaseName={`角色「${managingRole.name}」成員範例`}
            sampleRows={roleImportSample}
            header={roleImportHeader}
            validateRows={validateRoleMemberRows}
            importRows={importRoleMemberRows}
            sampleNote={
              committeeLevel
                ? "範本欄位：職編、姓名、適用品管組（委員會角色適用全院，適用品管組欄位可留白）；人員須已存在於人員資料。"
                : managingRole.scope === "unit"
                  ? "範本欄位：職編、姓名、單位、角色（角色固定為該頁角色）；人員須已存在於人員資料。"
                  : "範本欄位：職編、姓名、適用品管組（角色固定為該頁角色）；人員須已存在於人員資料。"
            }
            onDone={() => loadUsers()}
            onAction={onAction}
          />
        </div>
        <MemberChecklist
          title={`角色「${managingRole.name}」的成員`}
          note="勾選＋全選可批次移除（同時從 memberships 移除該角色）"
          idLabel="職編"
          nameLabel="姓名"
          // v1.88.19：B——「單位／品管組」合併欄拆成兩欄，欄位順序照
          // 「品管組、角色、單位、職編、姓名」（勾選框仍在最左、批次移出保留）
          leadingColumns={[
            { key: "group", label: "品管組" },
            { key: "role", label: "角色" },
            { key: "unit", label: "單位" },
          ]}
          items={roleMembers.map((u) => ({
            id: u.staffId,
            label: maskName(u.name),
            fields: {
              group: [...new Set(
                u.memberships
                  .filter((membership) => membership.roles.includes(managingRole.name))
                  .map((membership) => groupNameOf(membership.groupId)),
              )].join("、"),
              role: managingRole.name,
              unit: unitLabelOf(u.unitCode),
            },
          }))}
          checked={roleMemberChecked}
          onToggle={(id, next) =>
            setRoleMemberChecked((prev) =>
              next ? [...prev, id] : prev.filter((x) => x !== id),
            )
          }
          onToggleAll={(next) =>
            setRoleMemberChecked(
              next ? roleMembers.map((u) => u.staffId) : [],
            )
          }
          onRemoveSelected={handleRoleMembersRemove}
          removeLabel="批次移出"
          busy={roleBusy}
        />
        {/* v1.88.8 補項：角色下層（同層級內 order 緊鄰的下一個；上在上管下在下） */}
        {childRoles.length > 0 ? (
          <div className="form-field">
            <label className="field-label">下層成員管理</label>
            <p className="settings-note">
              加入即把人指定為下層角色。
            </p>
            <div className="form-actions">
              {childRoles.map((child) => (
                <button
                  key={child.id}
                  className="button button-outline"
                  onClick={() =>
                    onOpenMemberPage?.({
                      kind: "role",
                      id: child.id,
                      parent: { kind: "role", id: managingRole.id },
                    })
                  }
                >
                  「{child.name}」成員管理
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="form-actions">
          <button
            className="button button-outline"
            onClick={() => onBackToGroups?.()}
          >
            {parentRoleName
              ? `返回「${parentRoleName}」成員管理`
              : "返回人員管理"}
          </button>
        </div>
        </div>
      </section>
    );
  }

  function renderTitleMemberPanel() {
    if (!managingTitle) return null;
    // v1.88.8：下層職稱（同層級內 order 緊鄰的下一個；護理長/副護理長→護理師、護理師→護士）
    const childTitles = childTitlesFor(managingTitle);
    // v1.88.8：督導以職稱名稱認定（層級已併回部級，不再認層級 id）
    const isSupervisorTitle =
      isSupervisorTitleName(managingTitle.name) ||
      managingTitle.levelId === "tl-supervisor";
    const parentTitleName =
      memberPage?.parent?.kind === "title"
        ? (titles.find((t) => t.id === memberPage.parent!.id)?.name ?? "")
        : "";
    // v1.88.16：督導負責單位顯示（titleUnitCodes →「代號 名稱」以「、」連接；無則 —）
    const supervisorUnitsLabel = (codes: string[] | undefined) =>
      (codes ?? []).length > 0
        ? (codes ?? [])
            .map((code) => {
              const unitRow = units.find((x) => x.code === code);
              return unitRow ? `${code} ${unitRow.name}` : code;
            })
            .join("、")
        : "—";
    return (
      <section className="panel data-panel">
        <div className="panel-inset">
          {/* v1.88.16：工具列上移——搜尋方框（搜現有成員）＋下載範例檔＋批次上傳 */}
          <div
            className="form-actions"
            style={{ marginTop: 0, flexWrap: "wrap", alignItems: "flex-end" }}
          >
            <div style={{ maxWidth: 320, flex: "1 1 220px" }}>
              <label className="field-label">搜尋成員</label>
              <input
                className="text-input"
                style={{ marginBottom: 0 }}
                placeholder="輸入職編或姓名搜尋"
                value={titleMemberSearch}
                onChange={(e) => setTitleMemberSearch(e.target.value)}
              />
            </div>
            {/* v1.88.19：單位篩選器（同「人員」頁籤列全部單位；預設不篩選；
                第一次按「搜尋」才生效，之後改選單位即時生效） */}
            <div style={{ maxWidth: 240, flex: "1 1 180px" }}>
              <FormSelect
                label="單位"
                value={titleUnitFilter}
                aria-label="依單位篩選職稱成員"
                onChange={(e) => {
                  const v = e.target.value;
                  setTitleUnitFilter(v);
                  if (titleUnitSearched) setAppliedTitleUnitFilter(v);
                }}
              >
                <option value="">全部單位</option>
                {units.map((unit) => (
                  <option key={unit.code} value={unit.code}>
                    {unit.name}（{unit.code}）
                  </option>
                ))}
              </FormSelect>
            </div>
            <button
              type="button"
              className="button button-outline"
              onClick={() => {
                setAppliedTitleUnitFilter(titleUnitFilter);
                setTitleUnitSearched(true);
              }}
            >
              搜尋
            </button>
            <BatchImporter
              sampleBaseName={`職稱「${managingTitle.name}」成員範例`}
              sampleRows={[TITLE_MEMBER_HEADER, ["0000001", "王小明"]]}
              header={TITLE_MEMBER_HEADER}
              validateRows={validateTitleMemberRows}
              importRows={importTitleMemberRows}
              sampleNote="範本欄位：職編、姓名（職稱固定為該頁職稱）；人員須已存在於人員資料。"
              onDone={() => loadUsers()}
              onAction={onAction}
            />
          </div>
          {/* v1.88.16：成員表與「下屬管理 — 負責單位」表併成一張人員管理表
              （勾選／職編／姓名／負責單位／操作；非督導職稱負責單位與操作欄皆顯示 —） */}
          <MemberChecklist
            title={`職稱「${managingTitle.name}」的成員`}
            note="加入即轉任此職稱（一人一職稱）；移除即清除職稱"
            emptyText={
              titleMemberSearch.trim() !== ""
                ? "無符合搜尋條件的成員。"
                : "尚無成員。"
            }
            idLabel="職編"
            nameLabel="姓名"
            columns={[
              // v1.88.19：「單位」＝所屬單位，只顯示代號；「負責單位」維持督導負責單位
              { key: "homeUnit", label: "單位" },
              { key: "unit", label: "負責單位" },
            ]}
            actionLabel="操作"
            rowActionLabel="負責單位管理"
            onRowAction={
              isSupervisorTitle
                ? (staffId: string) =>
                    onOpenMemberPage?.({
                      kind: "title-units",
                      id: staffId,
                      parent: {
                        kind: "title",
                        id: managingTitle.id,
                      },
                    })
                : undefined
            }
            items={filteredTitleMembers.map((u) => ({
              id: u.staffId,
              label: maskName(u.name),
              fields: {
                homeUnit: u.unitCode || "—",
                unit: isSupervisorTitle
                  ? supervisorUnitsLabel(u.titleUnitCodes)
                  : "—",
              },
            }))}
            checked={titleMemberChecked}
            onToggle={(id, next) =>
              setTitleMemberChecked((prev) =>
                next ? [...prev, id] : prev.filter((x) => x !== id),
              )
            }
            onToggleAll={(next) =>
              setTitleMemberChecked(
                next ? filteredTitleMembers.map((u) => u.staffId) : [],
              )
            }
            onRemoveSelected={handleTitleMembersRemove}
            removeLabel="批次移出"
            busy={titleBusy}
          />
          {/* v1.88.8 補項：職稱下層（同層級內 order 緊鄰的下一個；護理長/副護理長→護理師、護理師→護士） */}
          {childTitles.length > 0 ? (
            <div className="form-field">
              <label className="field-label">下層成員管理</label>
              <p className="settings-note">
                加入即把人轉任下層職稱。
              </p>
              <div className="form-actions">
                {childTitles.map((child) => (
                  <button
                    key={child.id}
                    className="button button-outline"
                    onClick={() =>
                      onOpenMemberPage?.({
                        kind: "title",
                        id: child.id,
                        parent: { kind: "title", id: managingTitle.id },
                      })
                    }
                  >
                    「{child.name}」成員管理
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="form-field" style={{ maxWidth: 320 }}>
            <label className="field-label">加入人員（搜尋＋全選）</label>
            <input
              className="text-input"
              placeholder="輸入職編或姓名搜尋"
              value={titleAddSearch}
              onChange={(e) => setTitleAddSearch(e.target.value)}
            />
          </div>
          {titleAddSearch.trim() !== "" &&
            (titleCandidates.length === 0 ? (
              <p className="settings-note">無符合的在職人員。</p>
            ) : (
              <>
                <div className="table-scroll">
                  <table className="permission-table">
                    <thead>
                      <tr>
                        <th style={{ width: 36 }}>
                          <input
                            type="checkbox"
                            checked={
                              titleCandidates.length > 0 &&
                              titleCandidates.every((u) =>
                                titleAddChecked.includes(u.staffId),
                              )
                            }
                            onChange={(e) =>
                              setTitleAddChecked(
                                e.target.checked
                                  ? titleCandidates.map((u) => u.staffId)
                                  : [],
                              )
                            }
                            aria-label="全選"
                          />
                        </th>
                        <th>職編</th>
                        <th>姓名</th>
                        <th>現職稱</th>
                      </tr>
                    </thead>
                    <tbody>
                      {titleCandidates.map((u) => (
                        <tr key={u.staffId}>
                          <td>
                            <input
                              type="checkbox"
                              checked={titleAddChecked.includes(u.staffId)}
                              onChange={(e) =>
                                setTitleAddChecked((prev) =>
                                  e.target.checked
                                    ? [...prev, u.staffId]
                                    : prev.filter((x) => x !== u.staffId),
                                )
                              }
                              aria-label={`選擇 ${u.staffId}`}
                            />
                          </td>
                          <td>{u.staffId}</td>
                          <td>{maskName(u.name)}</td>
                          <td>{u.title || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="form-actions">
                  <button
                    className="button button-primary"
                    disabled={titleAddChecked.length === 0 || titleBusy}
                    onClick={handleTitleMembersAdd}
                  >
                    加入所選（{titleAddChecked.length}）
                  </button>
                </div>
              </>
            ))}
          <div className="form-actions">
            <button
              className="button button-outline"
              onClick={() => onBackToGroups?.()}
            >
              {parentTitleName
                ? `返回「${parentTitleName}」成員管理`
                : "返回人員管理"}
            </button>
          </div>
        </div>
      </section>
    );
  }

  function renderGroupUnitPanel() {
    if (!managingGroupId) return null;
    const managingGroupName =
      groups.find((g) => g.id === managingGroupId)?.name ?? "";
    return (
      <section className="panel data-panel">
        <div className="panel-inset divided">
          <MemberChecklist
            title={`品管組「${managingGroupName}」的單位`}
            note="加入／移除單位（改 unit.groupId）"
            emptyText="此品管組尚無單位。"
            items={groupUnits.map((u) => ({
              id: u.code,
              label: u.name,
            }))}
            checked={groupUnitChecked}
            onToggle={(id, next) =>
              setGroupUnitChecked((prev) =>
                next
                  ? [...prev, id]
                  : prev.filter((x) => x !== id),
              )
            }
            onToggleAll={(next) =>
              setGroupUnitChecked(
                next ? groupUnits.map((u) => u.code) : [],
              )
            }
            onRemoveSelected={handleGroupUnitsRemove}
            removeLabel="批次移出"
            busy={groupBusy}
          />
          <div className="form-field" style={{ maxWidth: 320 }}>
            <label className="field-label">加入單位</label>
            <input
              className="text-input"
              placeholder="輸入單位代號或名稱搜尋"
              value={groupUnitAddSearch}
              onChange={(e) => setGroupUnitAddSearch(e.target.value)}
            />
          </div>
          {groupUnitAddSearch.trim() !== "" &&
            (groupUnitCandidates.length === 0 ? (
              <p className="settings-note">無符合的單位。</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>單位代號</th>
                      <th>單位名稱</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupUnitCandidates.map((u) => (
                      <tr key={u.code}>
                        <td>{u.code}</td>
                        <td>{u.name}</td>
                        <td>
                          <button
                            className="text-button"
                            disabled={groupBusy}
                            onClick={() => handleGroupUnitAdd(u.code)}
                          >
                            <Plus size={13} /> 加入
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          <div className="form-actions">
            <BatchImporter
              sampleBaseName={`品管組「${managingGroupName}」單位範例`}
              sampleRows={[
                GROUP_UNIT_HEADER,
                ["加護病房", "加護病房", managingGroupName],
              ]}
              header={GROUP_UNIT_HEADER}
              validateRows={validateGroupUnitRows}
              importRows={importGroupUnitRows}
              sampleNote="範本欄位：單位代號、單位名稱、所屬品管組（品管組固定為該頁品管組）；單位須已存在於單位資料。"
              onDone={() => loadMaster()}
              onAction={onAction}
            />
          </div>
          <div className="form-actions">
            <button
              className="button button-outline"
              onClick={() => onBackToGroups?.()}
            >
                    返回人員管理
            </button>
          </div>
        </div>
      </section>
    );
  }

  /** v1.86.1：單位成員管理改跳獨立頁（原內嵌面板已移入 renderUnitMemberPanel）；v1.87.0：加入區移到既有成員清單上方 */
  function renderUnitMemberPanel() {
    if (!managingUnitCode) return null;
    return (
      <section className="panel data-panel">
        <div className="panel-inset divided">
          <div className="form-field" style={{ maxWidth: 320 }}>
            <label className="field-label">加入人員</label>
            <input
              className="text-input"
              placeholder="輸入職編或姓名搜尋"
              value={unitAddSearch}
              onChange={(e) => setUnitAddSearch(e.target.value)}
            />
          </div>
          {unitAddSearch.trim() !== "" &&
            (unitCandidates.length === 0 ? (
              <p className="settings-note">無符合的在職人員。</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>職編</th>
                      <th>姓名</th>
                      <th>所屬單位</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unitCandidates.map((u) => (
                      <tr key={u.staffId}>
                        <td>{u.staffId}</td>
                        <td>{maskName(u.name)}</td>
                        <td>{u.unitCode || "—"}</td>
                        <td>
                          <button
                            className="text-button"
                            disabled={unitBusy}
                            onClick={() =>
                              handleUnitMemberAdd(u.staffId)
                            }
                          >
                            <Plus size={13} /> 加入
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          <MemberChecklist
            title={`單位 ${managingUnitCode} 的成員`}
            note="加入／移除人員（改 person.unitCode）"
            items={unitMembers.map((u) => ({
              id: u.staffId,
              label: maskName(u.name),
              sub: u.title || undefined,
            }))}
            checked={unitMemberChecked}
            onToggle={(id, next) =>
              setUnitMemberChecked((prev) =>
                next ? [...prev, id] : prev.filter((x) => x !== id),
              )
            }
            onToggleAll={(next) =>
              setUnitMemberChecked(
                next ? unitMembers.map((u) => u.staffId) : [],
              )
            }
            onRemoveSelected={handleUnitMembersRemove}
            removeLabel="批次移出"
            busy={unitBusy}
          />
          <div className="form-actions">
            <button
              className="button button-outline"
              onClick={() => onBackToGroups?.()}
            >
              返回人員管理
            </button>
          </div>
        </div>
      </section>
    );
  }

  /** v1.87.0：督導負責單位管理獨立頁（由職稱成員管理頁的督導頁進入） */
  function renderTitleUnitPanel() {
    if (!titleUnitSupervisor) return null;
    const sup = titleUnitSupervisor;
    const parentTitleName =
      memberPage?.parent?.kind === "title"
        ? (titles.find((t) => t.id === memberPage.parent!.id)?.name ?? "")
        : "";
    return (
      <section className="panel data-panel">
        <div className="panel-inset divided">
          <div className="form-field" style={{ maxWidth: 320 }}>
            <label className="field-label">加入負責單位</label>
            <input
              className="text-input"
              placeholder="輸入單位代號或名稱搜尋"
              value={titleUnitAddSearch}
              onChange={(e) => setTitleUnitAddSearch(e.target.value)}
            />
          </div>
          {titleUnitAddSearch.trim() !== "" &&
            (titleUnitCandidates.length === 0 ? (
              <p className="settings-note">無符合的單位。</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input
                          type="checkbox"
                          checked={
                            titleUnitCandidates.length > 0 &&
                            titleUnitCandidates.every((u) =>
                              titleUnitAddChecked.includes(u.code),
                            )
                          }
                          onChange={(e) =>
                            setTitleUnitAddChecked(
                              e.target.checked
                                ? titleUnitCandidates.map((u) => u.code)
                                : [],
                            )
                          }
                          aria-label="全選"
                        />
                      </th>
                      <th>單位代號</th>
                      <th>單位名稱</th>
                    </tr>
                  </thead>
                  <tbody>
                    {titleUnitCandidates.map((u) => (
                      <tr key={u.code}>
                        <td>
                          <input
                            type="checkbox"
                            checked={titleUnitAddChecked.includes(u.code)}
                            onChange={(e) =>
                              setTitleUnitAddChecked((prev) =>
                                e.target.checked
                                  ? [...prev, u.code]
                                  : prev.filter((x) => x !== u.code),
                              )
                            }
                            aria-label={`選擇 ${u.code}`}
                          />
                        </td>
                        <td>{u.code}</td>
                        <td>{u.name}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          {titleUnitCandidates.length > 0 && (
            <div className="form-actions">
              <button
                className="button button-primary"
                disabled={titleUnitAddChecked.length === 0 || titleUnitBusy}
                onClick={handleTitleUnitsAdd}
              >
                加入所選（{titleUnitAddChecked.length}）
              </button>
            </div>
          )}
          <div className="form-actions">
            <BatchImporter
              sampleBaseName={`督導「${maskName(sup.name)}」負責單位範例`}
              sampleRows={[TITLE_UNIT_HEADER, ["加護病房", "加護病房"]]}
              header={TITLE_UNIT_HEADER}
              validateRows={validateTitleUnitRows}
              importRows={importTitleUnitRows}
              sampleNote="範本欄位：單位代號、單位名稱；單位須已存在於單位資料。"
              onDone={() => loadUsers()}
              onAction={onAction}
            />
          </div>
          <MemberChecklist
            title={`督導 ${maskName(sup.name)}（${sup.staffId}）的負責單位`}
            note="加入／移除單位（寫入該督導的 titleUnitCodes）"
            emptyText="此督導尚無負責單位。"
            items={titleUnits.map((u) => ({
              id: u.code,
              label: u.name,
            }))}
            checked={titleUnitChecked}
            onToggle={(id, next) =>
              setTitleUnitChecked((prev) =>
                next ? [...prev, id] : prev.filter((x) => x !== id),
              )
            }
            onToggleAll={(next) =>
              setTitleUnitChecked(
                next ? titleUnits.map((u) => u.code) : [],
              )
            }
            onRemoveSelected={handleTitleUnitsRemove}
            removeLabel="批次移出"
            busy={titleUnitBusy}
          />
          <div className="form-actions">
            <button
              className="button button-outline"
              onClick={() => onBackToGroups?.()}
            >
              {parentTitleName
                ? `返回「${parentTitleName}」成員管理`
                : "返回人員管理"}
            </button>
          </div>
        </div>
      </section>
    );
  }

  return {
    renderRoleMemberPanel,
    renderTitleMemberPanel,
    renderGroupUnitPanel,
    renderTitleUnitPanel,
    renderUnitMemberPanel,
    renderLevelCreate,
    titleSections,
    renderLevelHead,
    renderTitleTable,
    roleSections,
    renderRoleTable,
  };
}
