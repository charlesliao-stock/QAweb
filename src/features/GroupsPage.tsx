import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  query,
  limit,
} from "firebase/firestore";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { getFirebaseDb } from "../lib/firebase";
import { useAuth } from "../lib/auth";

type Tab = "units" | "users";

interface UnitRow {
  code: string;
  name: string;
  memberCount: number | null;
}

interface UserRow {
  staffId: string;
  name: string;
  unitCode: string;
  title: string;
  roles: string[];
  status: string;
}

interface RoleOption {
  id: string;
  name: string;
}

interface UnitForm {
  code: string;
  name: string;
}

interface UserForm {
  staffId: string;
  name: string;
  unitCode: string;
  title: string;
  hireDate: string;
  email: string;
  phone: string;
  roles: string[];
  mustChangePassword: boolean;
}

function emptyUnitForm(): UnitForm {
  return { code: "", name: "" };
}

function emptyUserForm(): UserForm {
  return {
    staffId: "",
    name: "",
    unitCode: "",
    title: "",
    hireDate: "",
    email: "",
    phone: "",
    roles: [],
    mustChangePassword: true,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "讀寫失敗，請檢查網路連線後再試";
}

export function GroupsPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  const { user } = useAuth();
  const isAdmin = (user?.roles ?? []).includes("系統管理員");
  const canManageUnits =
    isAdmin || (user?.roles ?? []).includes("品管執行幹事");

  const [tab, setTab] = useState<Tab>("units");

  // ---- 群組 ----
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [unitsLoading, setUnitsLoading] = useState(true);
  const [unitView, setUnitView] = useState<
    { kind: "list" } | { kind: "create" } | { kind: "edit"; code: string }
  >({ kind: "list" });
  const [unitForm, setUnitForm] = useState<UnitForm>(emptyUnitForm);
  const [unitError, setUnitError] = useState("");
  const [unitSaving, setUnitSaving] = useState(false);

  // ---- 人員 ----
  const [users, setUsers] = useState<UserRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [userView, setUserView] = useState<
    { kind: "list" } | { kind: "create" } | { kind: "edit"; staffId: string }
  >({ kind: "list" });
  const [userForm, setUserForm] = useState<UserForm>(emptyUserForm);
  const [userError, setUserError] = useState("");
  const [userSaving, setUserSaving] = useState(false);
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>([]);

  const loadRoles = useCallback(async () => {
    try {
      const snap = await getDocs(collection(getFirebaseDb(), "roles"));
      const list: RoleOption[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          name: typeof data.name === "string" ? data.name : d.id,
        };
      });
      setRoleOptions(list);
    } catch {
      setRoleOptions([]);
    }
  }, []);

  const loadUnits = useCallback(async () => {
    setUnitsLoading(true);
    try {
      const db = getFirebaseDb();
      const snap = await getDocs(collection(db, "units"));
      const list: UnitRow[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          code: d.id,
          name: typeof data.name === "string" ? data.name : "",
          memberCount: null,
        };
      });
      list.sort((a, b) => a.code.localeCompare(b.code, "zh-Hant"));
      // 管理員一次查全部人員計算各單位人數；非管理員無 users 查詢權限，顯示「—」
      try {
        const usnap = await getDocs(collection(db, "users"));
        const counts = new Map<string, number>();
        usnap.docs.forEach((d) => {
          const uc = d.data().unitCode;
          if (typeof uc === "string" && uc) {
            counts.set(uc, (counts.get(uc) ?? 0) + 1);
          }
        });
        list.forEach((u) => {
          u.memberCount = counts.get(u.code) ?? 0;
        });
      } catch {
        // 非管理員：維持 null
      }
      setUnits(list);
    } catch (error) {
      onAction(`讀取群組清單失敗：${toErrorMessage(error)}`);
    } finally {
      setUnitsLoading(false);
    }
  }, [onAction]);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const snap = await getDocs(collection(getFirebaseDb(), "users"));
      const list: UserRow[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          staffId: d.id,
          name: typeof data.name === "string" ? data.name : "",
          unitCode: typeof data.unitCode === "string" ? data.unitCode : "",
          title: typeof data.title === "string" ? data.title : "",
          roles: Array.isArray(data.roles) ? data.roles.map(String) : [],
          status: typeof data.status === "string" ? data.status : "在職",
        };
      });
      list.sort((a, b) => a.staffId.localeCompare(b.staffId, "zh-Hant"));
      setUsers(list);
    } catch (error) {
      onAction(`讀取人員清單失敗：${toErrorMessage(error)}`);
    } finally {
      setUsersLoading(false);
    }
  }, [onAction]);

  useEffect(() => {
    loadUnits();
    loadRoles();
  }, [loadUnits, loadRoles]);

  useEffect(() => {
    if (tab === "users" && isAdmin) {
      loadUsers();
    }
  }, [tab, isAdmin, loadUsers]);

  // ================= 群組 =================

  function openUnitCreate() {
    setUnitForm(emptyUnitForm());
    setUnitError("");
    setUnitView({ kind: "create" });
  }

  function openUnitEdit(code: string) {
    const row = units.find((u) => u.code === code);
    if (!row) return;
    setUnitForm({ code: row.code, name: row.name });
    setUnitError("");
    setUnitView({ kind: "edit", code });
  }

  function validateUnit(): string {
    if (unitView.kind === "create" && !unitForm.code.trim())
      return "請填寫單位代號";
    if (!unitForm.name.trim()) return "請填寫單位名稱";
    return "";
  }

  async function handleUnitSave() {
    const message = validateUnit();
    if (message) {
      setUnitError(message);
      return;
    }
    if (!user) {
      setUnitError("請先登入");
      return;
    }
    setUnitError("");
    setUnitSaving(true);
    try {
      const db = getFirebaseDb();
      const payload = {
        name: unitForm.name.trim(),
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      };
      if (unitView.kind === "create") {
        const code = unitForm.code.trim();
        const ref = doc(db, "units", code);
        const exists = await getDoc(ref);
        if (exists.exists()) {
          setUnitError(`單位代號 ${code} 已存在`);
          setUnitSaving(false);
          return;
        }
        await setDoc(ref, {
          ...payload,
          createdAt: serverTimestamp(),
          createdBy: user.staffId,
        });
        onAction(`已新增群組 ${code}`);
      } else if (unitView.kind === "edit") {
        // 代號不變，僅改名稱（規格：更名時代號不變）
        await updateDoc(doc(db, "units", unitView.code), payload);
        onAction(`群組 ${unitView.code} 已更新`);
      }
      setUnitView({ kind: "list" });
      await loadUnits();
    } catch (error) {
      setUnitError(`儲存失敗：${toErrorMessage(error)}`);
    } finally {
      setUnitSaving(false);
    }
  }

  async function handleUnitDelete(code: string) {
    if (!user) return;
    try {
      const db = getFirebaseDb();
      const memberSnap = await getDocs(
        query(
          collection(db, "users"),
          where("unitCode", "==", code),
          limit(1),
        ),
      );
      if (!memberSnap.empty) {
        onAction(`群組 ${code} 尚有人員歸屬，無法刪除（請先將人員移出或改派）`);
        return;
      }
    } catch {
      onAction("刪除前檢查人員歸屬失敗，請確認權限後再試");
      return;
    }
    const ok = window.confirm(`確定刪除群組 ${code}？此動作無法復原。`);
    if (!ok) return;
    try {
      await deleteDoc(doc(getFirebaseDb(), "units", code));
      onAction(`群組 ${code} 已刪除`);
      await loadUnits();
    } catch (error) {
      onAction(`刪除失敗：${toErrorMessage(error)}`);
    }
  }

  // ================= 人員 =================

  function openUserCreate() {
    setUserForm(emptyUserForm());
    setUserError("");
    setUserView({ kind: "create" });
  }

  function openUserEdit(staffId: string) {
    const row = users.find((u) => u.staffId === staffId);
    if (!row) return;
    setUserForm({
      staffId: row.staffId,
      name: row.name,
      unitCode: row.unitCode,
      title: row.title,
      hireDate: "",
      email: "",
      phone: "",
      roles: [...row.roles],
      mustChangePassword: true,
    });
    setUserError("");
    void (async () => {
      try {
        const snap = await getDoc(doc(getFirebaseDb(), "users", staffId));
        if (snap.exists()) {
          const data = snap.data();
          setUserForm((prev) => ({
            ...prev,
            hireDate: typeof data.hireDate === "string" ? data.hireDate : "",
            email: typeof data.email === "string" ? data.email : "",
            phone: typeof data.phone === "string" ? data.phone : "",
          }));
        }
      } catch {
        // 讀不到細節欄位不阻擋編輯
      }
    })();
    setUserView({ kind: "edit", staffId });
  }

  function toggleRole(roleName: string) {
    setUserForm((prev) => ({
      ...prev,
      roles: prev.roles.includes(roleName)
        ? prev.roles.filter((r) => r !== roleName)
        : [...prev.roles, roleName],
    }));
  }

  function validateUser(): string {
    if (userView.kind === "create" && !userForm.staffId.trim())
      return "請填寫職編";
    if (!userForm.name.trim()) return "請填寫姓名";
    return "";
  }

  async function handleUserSave() {
    const message = validateUser();
    if (message) {
      setUserError(message);
      return;
    }
    if (!user) {
      setUserError("請先登入");
      return;
    }
    setUserError("");
    setUserSaving(true);
    try {
      const db = getFirebaseDb();
      const payload = {
        name: userForm.name.trim(),
        unitCode: userForm.unitCode,
        title: userForm.title.trim(),
        hireDate: userForm.hireDate,
        email: userForm.email.trim(),
        phone: userForm.phone.trim(),
        roles: userForm.roles,
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      };
      if (userView.kind === "create") {
        const staffId = userForm.staffId.trim();
        const ref = doc(db, "users", staffId);
        const exists = await getDoc(ref);
        if (exists.exists()) {
          setUserError(`職編 ${staffId} 已存在`);
          setUserSaving(false);
          return;
        }
        await setDoc(ref, {
          ...payload,
          mustChangePassword: userForm.mustChangePassword,
          createdAt: serverTimestamp(),
          createdBy: user.staffId,
        });
        onAction(
          `已新增人員 ${staffId}。請再到 Firebase Console → Authentication 新增使用者，email 格式為 ${staffId}@nurseboard.internal`,
        );
      } else if (userView.kind === "edit") {
        // 職編（文件 ID）不可改；roles 由管理員維護（本頁僅管理員可見）
        await updateDoc(doc(db, "users", userView.staffId), payload);
        onAction(`人員 ${userView.staffId} 已更新`);
      }
      setUserView({ kind: "list" });
      await loadUsers();
    } catch (error) {
      setUserError(`儲存失敗：${toErrorMessage(error)}`);
    } finally {
      setUserSaving(false);
    }
  }

  async function handleToggleStatus(row: UserRow) {
    if (!user) return;
    const next = row.status === "停用" ? "在職" : "停用";
    if (row.staffId === user.staffId && next === "停用") {
      onAction("不能停用自己的帳號");
      return;
    }
    const ok = window.confirm(
      `確定將 ${row.staffId}（${row.name}）設為「${next}」？` +
        (next === "停用" ? "停用後該人員將無法登入。" : ""),
    );
    if (!ok) return;
    try {
      await updateDoc(doc(getFirebaseDb(), "users", row.staffId), {
        status: next,
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      });
      onAction(`人員 ${row.staffId} 已設為${next}`);
      await loadUsers();
    } catch (error) {
      onAction(`狀態變更失敗：${toErrorMessage(error)}`);
    }
  }

  const isUnitEditing = unitView.kind === "edit";
  const isUserEditing = userView.kind === "edit";
  const unitNameOf = (code: string) =>
    units.find((u) => u.code === code)?.name ?? code;

  return (
    <>
      <PageHeading
        page="groups"
        action={
          tab === "units" ? (
            unitView.kind === "list" && canManageUnits ? (
              <button className="button button-primary" onClick={openUnitCreate}>
                <Plus size={16} />
                新增群組
              </button>
            ) : unitView.kind !== "list" ? (
              <button
                className="button button-outline"
                onClick={() => setUnitView({ kind: "list" })}
              >
                <X size={15} />
                返回清單
              </button>
            ) : undefined
          ) : userView.kind === "list" && isAdmin ? (
            <button className="button button-primary" onClick={openUserCreate}>
              <Plus size={16} />
              新增人員
            </button>
          ) : userView.kind !== "list" ? (
            <button
              className="button button-outline"
              onClick={() => setUserView({ kind: "list" })}
            >
              <X size={15} />
              返回清單
            </button>
          ) : undefined
        }
      />

      <div className="tabs" style={{ marginBottom: 12 }}>
        <button
          className={`tab${tab === "units" ? " active" : ""}`}
          onClick={() => setTab("units")}
        >
          群組<span>{units.length}</span>
        </button>
        <button
          className={`tab${tab === "users" ? " active" : ""}`}
          onClick={() => setTab("users")}
        >
          人員{isAdmin && <span>{users.length}</span>}
        </button>
      </div>

      {tab === "units" ? (
        unitView.kind === "list" ? (
          unitsLoading ? (
            <section className="panel">
              <p className="settings-note">讀取中…</p>
            </section>
          ) : units.length === 0 ? (
            <EmptyState
              title="尚無群組"
              description="使用右上角「新增群組」建立第一個單位，單位代號即為群組識別碼。"
            />
          ) : (
            <section className="panel data-panel">
              <div className="table-scroll">
                <table className="permission-table">
                  <thead>
                    <tr>
                      <th>單位代號</th>
                      <th>單位名稱</th>
                      <th>所屬人員數</th>
                      {canManageUnits && <th>操作</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {units.map((row) => (
                      <tr key={row.code}>
                        <td>
                          <b>{row.code}</b>
                        </td>
                        <td>{row.name}</td>
                        <td>
                          {row.memberCount === null ? "—" : `${row.memberCount} 人`}
                        </td>
                        {canManageUnits && (
                          <td>
                            <button
                              className="text-button"
                              onClick={() => openUnitEdit(row.code)}
                            >
                              <Pencil size={13} /> 編輯
                            </button>{" "}
                            <button
                              className="text-button"
                              onClick={() => handleUnitDelete(row.code)}
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
              {!canManageUnits && (
                <p className="settings-note">
                  群組維護限品管執行幹事或系統管理員。
                </p>
              )}
            </section>
          )
        ) : (
          <section className="panel data-panel indicator-form">
            <SectionTitle
              title={isUnitEditing ? `編輯群組 ${unitForm.code}` : "新增群組"}
              note={isUnitEditing ? "單位代號不可變更（更名時代號不變）" : ""}
            />
            {unitError && <div className="login-error">{unitError}</div>}
            <div className="form-grid">
              <div className="form-field">
                <label className="field-label">單位代號 *</label>
                <input
                  className="text-input"
                  value={unitForm.code}
                  disabled={isUnitEditing}
                  placeholder="例如 9B"
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
                  placeholder="例如 9B 病房"
                  onChange={(e) =>
                    setUnitForm((prev) => ({ ...prev, name: e.target.value }))
                  }
                />
              </div>
            </div>
            <div className="form-actions">
              <button
                className="button button-primary"
                disabled={unitSaving}
                onClick={handleUnitSave}
              >
                {unitSaving ? "儲存中…" : isUnitEditing ? "儲存修改" : "建立群組"}
              </button>
              <button
                className="button button-outline"
                onClick={() => setUnitView({ kind: "list" })}
              >
                取消
              </button>
            </div>
          </section>
        )
      ) : !isAdmin ? (
        <section className="panel">
          <div className="empty-state-block">
            <b>僅系統管理員可管理人員</b>
            <p>如需新增或異動人員資料，請聯絡系統管理員。</p>
          </div>
        </section>
      ) : userView.kind === "list" ? (
        usersLoading ? (
          <section className="panel">
            <p className="settings-note">讀取中…</p>
          </section>
        ) : users.length === 0 ? (
          <EmptyState
            title="尚無人員"
            description="使用右上角「新增人員」建立第一筆人員資料，職編即為登入帳號。"
          />
        ) : (
          <section className="panel data-panel">
            <div className="table-scroll">
              <table className="permission-table">
                <thead>
                  <tr>
                    <th>職編</th>
                    <th>姓名</th>
                    <th>單位</th>
                    <th>職稱</th>
                    <th>角色</th>
                    <th>狀態</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((row) => (
                    <tr key={row.staffId}>
                      <td>
                        <b>{row.staffId}</b>
                      </td>
                      <td>{row.name}</td>
                      <td>
                        {row.unitCode
                          ? `${row.unitCode}${unitNameOf(row.unitCode) !== row.unitCode ? ` ${unitNameOf(row.unitCode)}` : ""}`
                          : "—"}
                      </td>
                      <td>{row.title || "—"}</td>
                      <td>
                        {row.roles.length > 0
                          ? row.roles.map((r) => (
                              <span
                                key={r}
                                className="status-pill muted"
                                style={{ marginRight: 4 }}
                              >
                                {r}
                              </span>
                            ))
                          : "—"}
                      </td>
                      <td>
                        <span
                          className={`status-pill ${row.status === "停用" ? "danger" : "success"}`}
                        >
                          {row.status}
                        </span>
                      </td>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => openUserEdit(row.staffId)}
                        >
                          <Pencil size={13} /> 編輯
                        </button>{" "}
                        <button
                          className="text-button"
                          onClick={() => handleToggleStatus(row)}
                        >
                          {row.status === "停用" ? "啟用" : "停用"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )
      ) : (
        <section className="panel data-panel indicator-form">
          <SectionTitle
            title={isUserEditing ? `編輯人員 ${userForm.staffId}` : "新增人員"}
            note={
              isUserEditing
                ? "職編不可變更"
                : "儲存後請再到 Firebase Console → Authentication 建立登入帳號"
            }
          />
          {userError && <div className="login-error">{userError}</div>}
          <div className="form-grid">
            <div className="form-field">
              <label className="field-label">職編 *</label>
              <input
                className="text-input"
                value={userForm.staffId}
                disabled={isUserEditing}
                placeholder="例如 A12345（即登入帳號）"
                onChange={(e) =>
                  setUserForm((prev) => ({ ...prev, staffId: e.target.value }))
                }
              />
            </div>
            <div className="form-field">
              <label className="field-label">姓名 *</label>
              <input
                className="text-input"
                value={userForm.name}
                placeholder="例如 王小明"
                onChange={(e) =>
                  setUserForm((prev) => ({ ...prev, name: e.target.value }))
                }
              />
            </div>
            <div className="form-field">
              <label className="field-label">單位</label>
              <div className="select-wrap">
                <select
                  value={userForm.unitCode}
                  onChange={(e) =>
                    setUserForm((prev) => ({ ...prev, unitCode: e.target.value }))
                  }
                >
                  <option value="">— 未指定 —</option>
                  {units.map((u) => (
                    <option key={u.code} value={u.code}>
                      {u.code} {u.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
            <div className="form-field">
              <label className="field-label">職稱</label>
              <input
                className="text-input"
                value={userForm.title}
                placeholder="例如 護理師"
                onChange={(e) =>
                  setUserForm((prev) => ({ ...prev, title: e.target.value }))
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
            {!isUserEditing && (
              <div className="form-field">
                <label className="field-label">首次登入強制改密碼</label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={userForm.mustChangePassword}
                    onChange={(e) =>
                      setUserForm((prev) => ({
                        ...prev,
                        mustChangePassword: e.target.checked,
                      }))
                    }
                  />
                  <span>啟用（建議保持開啟）</span>
                </label>
              </div>
            )}
          </div>

          <SectionTitle title="角色" note="一人可兼任多角色，權限取聯集" />
          {roleOptions.length === 0 ? (
            <p className="settings-note">
              尚未載入角色清單（請先到「系統管理」執行系統初始化）。
            </p>
          ) : (
            <div className="form-grid">
              {roleOptions.map((r) => (
                <label className="check-row" key={r.id}>
                  <input
                    type="checkbox"
                    checked={userForm.roles.includes(r.name)}
                    onChange={() => toggleRole(r.name)}
                  />
                  <span>{r.name}</span>
                </label>
              ))}
            </div>
          )}

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
              onClick={() => setUserView({ kind: "list" })}
            >
              取消
            </button>
          </div>
        </section>
      )}
    </>
  );
}
