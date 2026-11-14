import { useEffect, useMemo, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import { FilterPanel, ListPanel, SortableTh, useTableSort } from "../components/ui";
import {
  grantReviewerRole,
  isFirebaseReviewerRoleWriteEnabled,
  readFirebaseGroupsForReviewerManagement,
  readFirebaseUsersForReviewerManagement,
  type FirebaseGroupOption,
  type FirebaseProfile,
  type FirebaseUserRow,
} from "../lib/firebase";
import { useOrgMeta } from "../lib/useOrgMeta";
import { isReviewerRole } from "../lib/roleIdentity";

type SortKey = "staffId" | "name" | "groups" | "unitCode" | "status";

function groupLabel(
  person: FirebaseUserRow,
  groupNames: Map<string, string>,
): string {
  return person.groupIds.length
    ? person.groupIds.map((id) => groupNames.get(id) ?? id).join("、")
    : "未指定組別";
}

export function ReviewerManagement({
  profile,
  onAction,
}: {
  profile: FirebaseProfile | null;
  onAction: (message: string) => void;
}) {
  const [people, setPeople] = useState<FirebaseUserRow[]>([]);
  const [groupOptions, setGroupOptions] = useState<FirebaseGroupOption[]>([]);
  const [groupFilter, setGroupFilter] = useState("");
  const [search, setSearch] = useState("");
  const [candidateSearch, setCandidateSearch] = useState("");
  const [showAddDialog, setShowAddDialog] = useState(false);
  /** v1.58.0：授予審查員時明確指定的群組（寫入該群組分工表，不再產生全域角色） */
  const [grantGroupId, setGrantGroupId] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState("");
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  // v1.40.5：審查員名單改以角色類別判斷，不再比對「審查員」名稱
  const orgMeta = useOrgMeta();
  const isSystemAdmin = profile?.roles.includes("系統管理員") ?? false;
  const canWriteRoles = isFirebaseReviewerRoleWriteEnabled();

  useEffect(() => {
    let active = true;
    if (!isSystemAdmin) {
      setLoading(false);
      return () => {
        active = false;
      };
    }
    setLoading(true);
    Promise.all([
      readFirebaseUsersForReviewerManagement(),
      readFirebaseGroupsForReviewerManagement().catch(() => []),
    ])
      .then(([result, groupResult]) => {
        if (active) {
          setPeople(result);
          setGroupOptions(groupResult);
          setError("");
        }
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "無法讀取 users 人員清單，請檢查 Firestore Rules。",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isSystemAdmin]);

  const groupNames = useMemo(
    () => new Map(groupOptions.map((group) => [group.id, group.name])),
    [groupOptions],
  );
  const groups = useMemo(() => {
    const options = new Map(
      groupOptions.map((group) => [group.id, group.name]),
    );
    people
      .flatMap((person) => person.groupIds)
      .forEach((id) => {
        if (!options.has(id)) options.set(id, id);
      });
    return [...options.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
  }, [groupOptions, people]);
  const filteredPeople = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return people
      .filter((person) =>
        groupFilter ? person.groupIds.includes(groupFilter) : true,
      )
      .filter((person) =>
        `${person.staffId} ${person.name} ${groupLabel(person, groupNames)} ${person.unitCode} ${person.roles.join(" ")}`
          .toLocaleLowerCase()
          .includes(query),
      )
      .filter((person) => isReviewerRole(person.roles, orgMeta.roleMeta))
  }, [people, groupFilter, search, groupNames, orgMeta.roleMeta]);

  const { sortedRows: sortedPeople, sort, toggleSort } = useTableSort<
    FirebaseUserRow,
    SortKey
  >(
    filteredPeople,
    {
      staffId: (p) => p.staffId,
      name: (p) => p.name,
      groups: (p) => groupLabel(p, groupNames),
      unitCode: (p) => p.unitCode,
      status: (p) => p.status,
    },
    { key: "name", direction: "asc" },
  );

  const candidates = useMemo(() => {
    const query = candidateSearch.trim().toLocaleLowerCase();
    return people
      .filter((person) => !isReviewerRole(person.roles, orgMeta.roleMeta))
      .filter((person) => person.status !== "停用")
      .filter((person) =>
        groupFilter ? person.groupIds.includes(groupFilter) : true,
      )
      .filter((person) =>
        `${person.staffId} ${person.name} ${groupLabel(person, groupNames)} ${person.unitCode}`
          .toLocaleLowerCase()
          .includes(query),
      )
      .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
  }, [people, groupFilter, candidateSearch, groupNames, orgMeta.roleMeta]);

  const addReviewer = async (person: FirebaseUserRow) => {
    if (!canWriteRoles) {
      setActionError("角色寫入目前關閉；需先完成 Firestore Rules 驗收。");
      return;
    }
    // v1.58.0：授予前必須先選群組，角色寫入該群組分工表
    if (!grantGroupId) {
      setActionError("請先選擇授予群組。");
      return;
    }
    setSavingId(person.staffId);
    setActionError("");
    try {
      const grantedRole = await grantReviewerRole(
        person.staffId,
        {
          staffId: profile?.staffId ?? "",
          name: profile?.name ?? "",
        },
        grantGroupId,
      );
      setPeople((current) =>
        current.map((item) =>
          item.staffId === person.staffId
            ? {
                ...item,
                roles: [...new Set([...item.roles, grantedRole])],
                groupIds: [...new Set([...item.groupIds, grantGroupId])],
              }
            : item,
        ),
      );
      onAction(`已授予 ${person.name} ${grantedRole}角色`);
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? `${cause.message} 請確認 Firestore Rules 僅允許系統管理員更新 users.roles。`
          : "授予審查員角色失敗；請確認 Firestore Rules。",
      );
    } finally {
      setSavingId("");
    }
  };

  if (!isSystemAdmin) {
    return (
      <section className="panel not-connected-state" role="alert">
        <h2>此管理功能限系統管理員使用</h2>
        <p>請使用具備「系統管理員」角色的 Firebase 帳號。</p>
      </section>
    );
  }

  return (
    <>
      <FilterPanel
        title="篩選條件"
        actions={
          (groupFilter || search) && (
            <button
              type="button"
              className="button button-outline"
              onClick={() => {
                setGroupFilter("");
                setSearch("");
              }}
            >
              清除篩選
            </button>
          )
        }
      >
        <label className="reviewer-group-control">
          <span className="field-label">組別</span>
          <span className="select-wrap">
            <select
              value={groupFilter}
              onChange={(event) => setGroupFilter(event.target.value)}
            >
              <option value="">全部組別</option>
              {groups.map((group) => (
                <option value={group.id} key={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </span>
        </label>
        <label className="search-box reviewer-search">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜尋職編、姓名、組別或單位"
            aria-label="搜尋審查員"
          />
        </label>
      </FilterPanel>

      <ListPanel
        title="審查員管理"
        count={sortedPeople.length}
        actions={
          <button
            type="button"
            className="button button-primary"
            onClick={() => {
              setCandidateSearch("");
              setGrantGroupId("");
              setActionError("");
              setShowAddDialog(true);
            }}
            disabled={loading || Boolean(error)}
          >
            <Plus size={16} />
            加入審查員
          </button>
        }
      >
        <p className="reviewer-management-note">
          授予角色會將「審查員」寫入所選群組的分工表，再由分工表衍生
          users.roles；不建立 Firebase Auth 帳號。實際寫入必須由
          Firestore Rules 限定系統管理員。
        </p>
        {!canWriteRoles && (
          <p className="reviewer-safe-mode-note" role="status">
            人員清單可供檢視；授予角色的寫入目前預設關閉。完成 Firestore Rules
            驗收後，才可設定 `FIREBASE_REVIEWER_ROLE_WRITES=true` 啟用。
          </p>
        )}
        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}
        {actionError && (
          <p className="login-error" role="alert">
            {actionError}
          </p>
        )}
        <table className="data-table reviewer-table">
          <thead>
            <tr>
              <SortableTh label="職編" sortKey="staffId" sort={sort} onSort={toggleSort} />
              <SortableTh label="姓名" sortKey="name" sort={sort} onSort={toggleSort} />
              <SortableTh label="組別" sortKey="groups" sort={sort} onSort={toggleSort} />
              <SortableTh label="所屬單位" sortKey="unitCode" sort={sort} onSort={toggleSort} />
              <SortableTh label="帳號狀態" sortKey="status" sort={sort} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {sortedPeople.map((person) => (
              <tr key={person.staffId}>
                <td>{person.staffId}</td>
                <td>
                  <b>{person.name}</b>
                </td>
                <td>{groupLabel(person, groupNames)}</td>
                <td>{person.unitCode || "未指定"}</td>
                <td>
                  <span
                    className={`status-pill ${person.status === "停用" ? "muted" : "success"}`}
                  >
                    {person.status || "未設定"}
                  </span>
                </td>
              </tr>
            ))}
            {!loading && !error && sortedPeople.length === 0 && (
              <tr>
                <td colSpan={5} className="reviewer-empty">
                  {people.some((person) => isReviewerRole(person.roles, orgMeta.roleMeta))
                    ? "沒有符合組別或搜尋條件的審查員。"
                    : "目前尚未授予任何人審查員角色。"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {loading && (
          <p className="reviewer-loading" role="status">
            正在讀取 users 人員清單…
          </p>
        )}
      </ListPanel>

      {showAddDialog && (
        <div
          className="reviewer-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowAddDialog(false);
          }}
        >
          <section
            className="panel reviewer-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reviewer-modal-title"
          >
            <div className="reviewer-modal-head">
              <div>
                <h2 id="reviewer-modal-title">加入既有人員為審查員</h2>
                <p>請先選擇授予群組，再選取人員授予「審查員」角色。</p>
              </div>
              <button
                className="icon-button"
                aria-label="關閉"
                onClick={() => setShowAddDialog(false)}
              >
                <X size={17} />
              </button>
            </div>
            {/* v1.58.0：授予前明確指定群組，寫入該群組分工表 */}
            <label className="reviewer-group-control">
              <span>授予群組 *</span>
              <select
                value={grantGroupId}
                onChange={(event) => setGrantGroupId(event.target.value)}
              >
                <option value="">請選擇群組</option>
                {groupOptions.map((group) => (
                  <option value={group.id} key={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
            {!grantGroupId && (
              <p className="reviewer-management-note">
                尚未選擇授予群組；選取群組後才能授予角色。
              </p>
            )}
            <label className="search-box reviewer-candidate-search">
              <Search size={16} />
              <input
                autoFocus
                value={candidateSearch}
                onChange={(event) => setCandidateSearch(event.target.value)}
                placeholder="搜尋職編、姓名、組別或單位"
              />
            </label>
            <div className="reviewer-candidate-list">
              {candidates.map((person) => (
                <div className="reviewer-candidate" key={person.staffId}>
                  <div>
                    <b>{person.name}</b>
                    <span>
                      {person.staffId} · {groupLabel(person, groupNames)} ·{" "}
                      {person.unitCode || "未指定單位"}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="button button-outline"
                    disabled={Boolean(savingId) || !canWriteRoles || !grantGroupId}
                    onClick={() => void addReviewer(person)}
                  >
                    <Plus size={14} />
                    {savingId === person.staffId
                      ? "授權中…"
                      : canWriteRoles
                        ? "授予角色"
                        : "待 Rules 驗收"}
                  </button>
                </div>
              ))}
              {!loading && candidates.length === 0 && (
                <div className="empty-state">找不到可加入的既有人員</div>
              )}
            </div>
            <p className="reviewer-management-note">
              若儲存遭拒，代表目前 Firestore Rules 尚未授權管理員更新
              users.roles；請勿為了讓按鈕成功而開放所有登入者寫入。
            </p>
          </section>
        </div>
      )}
    </>
  );
}

