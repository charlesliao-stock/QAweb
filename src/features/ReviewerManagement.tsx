import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Plus, Search, X } from "lucide-react";
import { SectionTitle } from "../components/ui";
import {
  grantReviewerRole,
  isFirebaseReviewerRoleWriteEnabled,
  readFirebaseGroupsForReviewerManagement,
  readFirebaseUsersForReviewerManagement,
  type FirebaseGroupOption,
  type FirebaseProfile,
  type FirebaseUserRow,
} from "../lib/firebase";

type SortKey = "staffId" | "name" | "groups" | "unitCode" | "status";
type SortState = { key: SortKey; direction: "asc" | "desc" };

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
  const [sort, setSort] = useState<SortState>({
    key: "name",
    direction: "asc",
  });
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState("");
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
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
  const visiblePeople = useMemo(() => {
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
      .filter((person) => person.roles.includes("審查員"))
      .sort((a, b) => {
        const left =
          sort.key === "groups" ? groupLabel(a, groupNames) : a[sort.key];
        const right =
          sort.key === "groups" ? groupLabel(b, groupNames) : b[sort.key];
        const compared = left.localeCompare(right, "zh-Hant", {
          numeric: true,
          sensitivity: "base",
        });
        return sort.direction === "asc" ? compared : -compared;
      });
  }, [people, groupFilter, search, sort, groupNames]);

  const candidates = useMemo(() => {
    const query = candidateSearch.trim().toLocaleLowerCase();
    return people
      .filter((person) => !person.roles.includes("審查員"))
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
  }, [people, groupFilter, candidateSearch, groupNames]);

  const toggleSort = (key: SortKey) => {
    setSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "asc" ? "desc" : "asc",
          }
        : { key, direction: "asc" },
    );
  };

  const addReviewer = async (person: FirebaseUserRow) => {
    if (!canWriteRoles) {
      setActionError("角色寫入目前關閉；需先完成 Firestore Rules 驗收。");
      return;
    }
    setSavingId(person.staffId);
    setActionError("");
    try {
      await grantReviewerRole(person.staffId, {
        staffId: profile?.staffId ?? "",
        name: profile?.name ?? "",
      });
      setPeople((current) =>
        current.map((item) =>
          item.staffId === person.staffId
            ? { ...item, roles: [...new Set([...item.roles, "審查員"])] }
            : item,
        ),
      );
      onAction(`已授予 ${person.name} 審查員角色`);
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
      <section className="panel reviewer-management-panel">
        <SectionTitle
          title="審查員管理"
          note="既有 Firebase users 帳號 · 不建立新帳號"
        />
        <div className="reviewer-toolbar">
          <label className="reviewer-group-control">
            <span>組別</span>
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
          </label>
          <button
            type="button"
            className="button button-primary"
            onClick={() => {
              setCandidateSearch("");
              setActionError("");
              setShowAddDialog(true);
            }}
            disabled={loading || Boolean(error)}
          >
            <Plus size={16} />
            加入審查員
          </button>
          <label className="search-box reviewer-search">
            <Search size={16} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜尋職編、姓名、組別或單位"
              aria-label="搜尋審查員"
            />
          </label>
        </div>
        <p className="reviewer-management-note">
          授予角色只會將「審查員」加入既有 users.roles；不建立 Firebase Auth
          帳號，也不設定審查員負責的單位。單位指派仍是另一項設定。實際寫入必須由
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
        <div className="table-scroll">
          <table className="data-table reviewer-table">
            <thead>
              <tr>
                <SortHeader
                  label="職編"
                  active={sort.key === "staffId"}
                  direction={sort.direction}
                  onClick={() => toggleSort("staffId")}
                />
                <SortHeader
                  label="姓名"
                  active={sort.key === "name"}
                  direction={sort.direction}
                  onClick={() => toggleSort("name")}
                />
                <SortHeader
                  label="組別"
                  active={sort.key === "groups"}
                  direction={sort.direction}
                  onClick={() => toggleSort("groups")}
                />
                <SortHeader
                  label="所屬單位"
                  active={sort.key === "unitCode"}
                  direction={sort.direction}
                  onClick={() => toggleSort("unitCode")}
                />
                <SortHeader
                  label="帳號狀態"
                  active={sort.key === "status"}
                  direction={sort.direction}
                  onClick={() => toggleSort("status")}
                />
              </tr>
            </thead>
            <tbody>
              {visiblePeople.map((person) => (
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
              {!loading && !error && visiblePeople.length === 0 && (
                <tr>
                  <td colSpan={5} className="reviewer-empty">
                    {people.some((person) => person.roles.includes("審查員"))
                      ? "沒有符合組別或搜尋條件的審查員。"
                      : "目前尚未授予任何人審查員角色。"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && (
          <p className="reviewer-loading" role="status">
            正在讀取 users 人員清單…
          </p>
        )}
      </section>

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
                <p>依目前組別篩選結果；選取後只新增「審查員」角色。</p>
              </div>
              <button
                className="icon-button"
                aria-label="關閉"
                onClick={() => setShowAddDialog(false)}
              >
                <X size={17} />
              </button>
            </div>
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
                    disabled={Boolean(savingId) || !canWriteRoles}
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

function SortHeader({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction: "asc" | "desc";
  onClick: () => void;
}) {
  const Icon = active
    ? direction === "asc"
      ? ArrowUp
      : ArrowDown
    : ArrowUpDown;
  return (
    <th
      aria-sort={
        active ? (direction === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button type="button" className="reviewer-sort-button" onClick={onClick}>
        {label}
        <Icon size={14} aria-hidden="true" />
      </button>
    </th>
  );
}
