import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { getFirebaseDb } from "../lib/firebase";
import { useAuth } from "../lib/auth";
import {
  TEN_STEP_TITLES,
  emptyTenSteps,
  normalizeQuestions,
  normalizeTenSteps,
  primaryThreshold,
  type AuditQuestion,
  type NamedThreshold,
  type OptionSet,
  type SubIndicator,
  type TenSteps,
} from "../lib/indicators";

export type IndicatorStatus =
  | "草稿"
  | "送審"
  | "核准"
  | "退回"
  | "啟用"
  | "停用";

const STATUSES: IndicatorStatus[] = [
  "草稿",
  "送審",
  "核准",
  "退回",
  "啟用",
  "停用",
];

const STATUS_PILL: Record<IndicatorStatus, string> = {
  草稿: "muted",
  送審: "info",
  核准: "success",
  退回: "danger",
  啟用: "success",
  停用: "warning",
};

const QUESTION_OPTION_LABELS: Record<OptionSet, string> = {
  "yes-no-na": "是／否／不適用",
  "yes-no": "是／否",
};

interface StaffOption {
  staffId: string;
  name: string;
  unitCode: string;
}

interface IndicatorRow {
  code: string;
  name: string;
  groupId: string;
  owners: string[];
  mainThreshold: number;
  status: IndicatorStatus;
  version: string;
}

interface VersionRow {
  id: string;
  version: string;
  status: string;
  effectiveDate: string;
  createdBy: string;
  createdAtText: string;
}

interface IndicatorForm {
  groupId: string;
  code: string;
  name: string;
  owners: string[];
  ownerSearch: string;
  resultName: string;
  applicableUnitsText: string;
  cycle: string;
  status: IndicatorStatus;
  steps: TenSteps;
  questions: AuditQuestion[];
}

const RESULT_NAMES = ["符合率", "正確率", "完整率", "達成率"];

function emptyForm(): IndicatorForm {
  const steps = emptyTenSteps();
  steps.step5.thresholds = [{ name: "主閾值", value: NaN }];
  return {
    groupId: "",
    code: "",
    name: "",
    owners: [],
    ownerSearch: "",
    resultName: "符合率",
    applicableUnitsText: "",
    cycle: "每月",
    status: "草稿",
    steps,
    questions: [],
  };
}

function nextVersion(version: string): string {
  const m = /^v(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) return "v1.1";
  return `v${m[1]}.${Number(m[2]) + 1}`;
}

function splitList(text: string): string[] {
  return text
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "讀寫失敗，請檢查網路連線後再試";
}

export function IndicatorsPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  const { user } = useAuth();
  const [view, setView] = useState<
    { kind: "list" } | { kind: "create" } | { kind: "edit"; code: string }
  >({ kind: "list" });
  const [rows, setRows] = useState<IndicatorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<IndicatorForm>(emptyForm);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [hasReviewData, setHasReviewData] = useState(false);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [groupMap, setGroupMap] = useState<Map<string, string>>(new Map());
  const [staffMap, setStaffMap] = useState<Map<string, StaffOption>>(new Map());
  const [staffLoaded, setStaffLoaded] = useState(false);

  const loadMeta = useCallback(async () => {
    try {
      const gsnap = await getDocs(collection(getFirebaseDb(), "groups"));
      const gm = new Map<string, string>();
      gsnap.docs.forEach((d) => {
        const n = d.data().name;
        if (typeof n === "string") gm.set(d.id, n);
      });
      setGroupMap(gm);
    } catch {
      /* 群組讀取失敗時下拉為空，表單會提示 */
    }
    try {
      const usnap = await getDocs(collection(getFirebaseDb(), "users"));
      const sm = new Map<string, StaffOption>();
      usnap.docs.forEach((d) => {
        const data = d.data();
        sm.set(d.id, {
          staffId: d.id,
          name: typeof data.name === "string" ? data.name : d.id,
          unitCode: typeof data.unitCode === "string" ? data.unitCode : "",
        });
      });
      setStaffMap(sm);
      setStaffLoaded(true);
    } catch {
      setStaffLoaded(false);
    }
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(getFirebaseDb(), "indicators"));
      const list: IndicatorRow[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          code: d.id,
          name: typeof data.name === "string" ? data.name : "",
          groupId: typeof data.groupId === "string" ? data.groupId : "",
          owners: Array.isArray(data.owners) ? data.owners.map(String) : [],
          mainThreshold: primaryThreshold(data),
          status: STATUSES.includes(data.status) ? data.status : "草稿",
          version: typeof data.version === "string" ? data.version : "v1.0",
        };
      });
      list.sort((a, b) => a.code.localeCompare(b.code, "zh-Hant"));
      setRows(list);
    } catch (error) {
      onAction(`讀取指標清單失敗：${toErrorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, [onAction]);

  useEffect(() => {
    loadMeta();
    loadList();
  }, [loadMeta, loadList]);

  function setField<K extends keyof IndicatorForm>(
    key: K,
    value: IndicatorForm[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function setStep<K extends keyof TenSteps>(key: K, value: TenSteps[K]) {
    setForm((prev) => ({ ...prev, steps: { ...prev.steps, [key]: value } }));
  }

  async function checkReviewData(code: string): Promise<boolean> {
    try {
      const snap = await getDocs(
        query(
          collection(getFirebaseDb(), "reviews"),
          where("indicatorId", "==", code),
          limit(1),
        ),
      );
      return !snap.empty;
    } catch {
      return false;
    }
  }

  async function openCreate() {
    setForm(emptyForm());
    setFormError("");
    setHasReviewData(false);
    setVersions([]);
    setView({ kind: "create" });
  }

  async function openEdit(code: string) {
    setFormError("");
    try {
      const snap = await getDoc(doc(getFirebaseDb(), "indicators", code));
      if (!snap.exists()) {
        onAction("找不到該指標");
        return;
      }
      const data = snap.data();
      const steps = normalizeTenSteps(data.tenSteps, data.steps);
      if (
        steps.step5.thresholds.length === 0 &&
        typeof data.threshold === "number"
      ) {
        steps.step5.thresholds = [{ name: "主閾值", value: data.threshold }];
      }
      let groupId = typeof data.groupId === "string" ? data.groupId : "";
      if (!groupId && typeof data.group === "string" && data.group) {
        const found = [...groupMap.entries()].find(
          ([, name]) => name === data.group,
        );
        if (found) groupId = found[0];
      }
      setForm({
        groupId,
        code: snap.id,
        name: typeof data.name === "string" ? data.name : "",
        owners: Array.isArray(data.owners) ? data.owners.map(String) : [],
        ownerSearch: "",
        resultName:
          typeof data.resultName === "string" ? data.resultName : "符合率",
        applicableUnitsText: Array.isArray(data.applicableUnits)
          ? data.applicableUnits.join(", ")
          : "",
        cycle: typeof data.cycle === "string" ? data.cycle : "每月",
        status: STATUSES.includes(data.status) ? data.status : "草稿",
        steps,
        questions: normalizeQuestions(data.questions),
      });
      const locked = await checkReviewData(snap.id);
      setHasReviewData(locked);
      try {
        const vsnap = await getDocs(
          query(
            collection(getFirebaseDb(), "indicators", snap.id, "versions"),
            orderBy("createdAt", "desc"),
          ),
        );
        setVersions(
          vsnap.docs.map((v) => {
            const vd = v.data();
            const createdAt = vd.createdAt?.toDate?.();
            return {
              id: v.id,
              version: typeof vd.version === "string" ? vd.version : v.id,
              status: typeof vd.status === "string" ? vd.status : "",
              effectiveDate:
                typeof vd.effectiveDate === "string" ? vd.effectiveDate : "",
              createdBy: typeof vd.createdBy === "string" ? vd.createdBy : "",
              createdAtText: createdAt
                ? createdAt.toLocaleString("zh-Hant")
                : "",
            };
          }),
        );
      } catch {
        setVersions([]);
      }
      setView({ kind: "edit", code: snap.id });
    } catch (error) {
      onAction(`讀取指標失敗：${toErrorMessage(error)}`);
    }
  }

  // ---- 負責人 autocomplete ----
  const ownerSuggestions = useMemo(() => {
    const q = form.ownerSearch.trim().toLowerCase();
    if (!q || !staffLoaded) return [];
    return [...staffMap.values()]
      .filter(
        (s) =>
          !form.owners.includes(s.staffId) &&
          (s.staffId.toLowerCase().includes(q) ||
            s.name.toLowerCase().includes(q)),
      )
      .slice(0, 8);
  }, [form.ownerSearch, form.owners, staffMap, staffLoaded]);

  function addOwner(staffId: string) {
    setForm((prev) => ({
      ...prev,
      owners: prev.owners.includes(staffId)
        ? prev.owners
        : [...prev.owners, staffId],
      ownerSearch: "",
    }));
  }

  function removeOwner(staffId: string) {
    setForm((prev) => ({
      ...prev,
      owners: prev.owners.filter((id) => id !== staffId),
    }));
  }

  function ownerLabel(staffId: string): string {
    const s = staffMap.get(staffId);
    return s && s.name !== staffId ? `${s.name}（${staffId}）` : staffId;
  }

  // ---- 題目 / 子指標 / 閾值 ----
  function addQuestion() {
    setForm((prev) => ({
      ...prev,
      questions: [
        ...prev.questions,
        { text: "", optionSet: "yes-no-na" as OptionSet, guidance: "", group: "" },
      ],
    }));
  }

  function updateQuestion(index: number, patch: Partial<AuditQuestion>) {
    setForm((prev) => ({
      ...prev,
      questions: prev.questions.map((q, i) =>
        i === index ? { ...q, ...patch } : q,
      ),
    }));
  }

  function removeQuestion(index: number) {
    setForm((prev) => ({
      ...prev,
      questions: prev.questions.filter((_, i) => i !== index),
    }));
  }

  function addSubIndicator() {
    setForm((prev) => ({
      ...prev,
      steps: {
        ...prev.steps,
        step4: {
          ...prev.steps.step4,
          subIndicators: [
            ...prev.steps.step4.subIndicators,
            { name: "", numerator: "", denominator: "" },
          ],
        },
      },
    }));
  }

  function updateSubIndicator(index: number, patch: Partial<SubIndicator>) {
    setForm((prev) => ({
      ...prev,
      steps: {
        ...prev.steps,
        step4: {
          ...prev.steps.step4,
          subIndicators: prev.steps.step4.subIndicators.map((s, i) =>
            i === index ? { ...s, ...patch } : s,
          ),
        },
      },
    }));
  }

  function removeSubIndicator(index: number) {
    setForm((prev) => ({
      ...prev,
      steps: {
        ...prev.steps,
        step4: {
          ...prev.steps.step4,
          subIndicators: prev.steps.step4.subIndicators.filter(
            (_, i) => i !== index,
          ),
        },
      },
    }));
  }

  function addThreshold() {
    setForm((prev) => ({
      ...prev,
      steps: {
        ...prev.steps,
        step5: {
          thresholds: [
            ...prev.steps.step5.thresholds,
            { name: "", value: NaN },
          ],
        },
      },
    }));
  }

  function updateThreshold(index: number, patch: Partial<NamedThreshold>) {
    setForm((prev) => ({
      ...prev,
      steps: {
        ...prev.steps,
        step5: {
          thresholds: prev.steps.step5.thresholds.map((t, i) =>
            i === index ? { ...t, ...patch } : t,
          ),
        },
      },
    }));
  }

  function removeThreshold(index: number) {
    setForm((prev) => ({
      ...prev,
      steps: {
        ...prev.steps,
        step5: {
          thresholds: prev.steps.step5.thresholds.filter((_, i) => i !== index),
        },
      },
    }));
  }

  function activeThresholds(): NamedThreshold[] {
    return form.steps.step5.thresholds.filter(
      (t) => t.name.trim() !== "" || Number.isFinite(t.value),
    );
  }

  function validate(): string {
    if (!form.groupId) return "請選擇分類組別";
    if (view.kind === "create" && !form.code.trim()) return "請填寫指標編號";
    if (!form.name.trim()) return "請填寫指標名稱";
    if (form.owners.length === 0) return "請選擇至少一位負責人";
    const thresholds = activeThresholds();
    if (thresholds.length === 0) return "請至少新增一筆閾值";
    for (const [i, t] of thresholds.entries()) {
      if (!t.name.trim()) return `第 ${i + 1} 筆閾值請填寫名稱`;
      if (!Number.isFinite(t.value) || t.value < 0 || t.value > 100)
        return `第 ${i + 1} 筆閾值須為 0～100 的數字（代表百分比）`;
    }
    for (const [i, q] of form.questions.entries()) {
      if (!q.text.trim()) return `第 ${i + 1} 題尚未填寫題目文字`;
    }
    return "";
  }

  async function handleSave() {
    const message = validate();
    if (message) {
      setFormError(message);
      return;
    }
    if (!user) {
      setFormError("請先登入");
      return;
    }
    setFormError("");
    setSaving(true);
    try {
      const db = getFirebaseDb();
      const thresholds = activeThresholds().map((t) => ({
        name: t.name.trim(),
        value: t.value,
      }));
      const steps: TenSteps = {
        step1: form.steps.step1.trim(),
        step2: form.steps.step2.trim(),
        step3: form.steps.step3.trim(),
        step4: {
          basis: form.steps.step4.basis.trim(),
          subIndicators: form.steps.step4.subIndicators
            .filter(
              (s) =>
                s.name.trim() !== "" ||
                s.numerator.trim() !== "" ||
                s.denominator.trim() !== "",
            )
            .map((s) => ({
              name: s.name.trim(),
              numerator: s.numerator.trim(),
              denominator: s.denominator.trim(),
            })),
        },
        step5: { thresholds },
        step6: {
          caseCount: form.steps.step6.caseCount.trim(),
          auditors: form.steps.step6.auditors.trim(),
          auditDate: form.steps.step6.auditDate.trim(),
          auditMethod: form.steps.step6.auditMethod.trim(),
        },
        step7: form.steps.step7.trim(),
        step8: form.steps.step8.trim(),
        step9: form.steps.step9.trim(),
        step10: form.steps.step10.trim(),
      };
      const questions = form.questions.map((q) => ({
        text: q.text.trim(),
        optionSet: q.optionSet,
        guidance: q.guidance.trim(),
        group: q.group.trim(),
      }));
      const threshold = thresholds[0]?.value ?? 0;
      const base = {
        name: form.name.trim(),
        groupId: form.groupId,
        owners: form.owners,
        resultName: form.resultName,
        threshold,
        applicableUnits: splitList(form.applicableUnitsText),
        cycle: form.cycle.trim() || "每月",
        status: form.status,
        tenSteps: steps,
        questions,
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      };

      if (view.kind === "create") {
        const code = form.code.trim();
        const ref = doc(db, "indicators", code);
        const exists = await getDoc(ref);
        if (exists.exists()) {
          setFormError(`指標編號 ${code} 已存在`);
          setSaving(false);
          return;
        }
        await setDoc(ref, {
          ...base,
          version: "v1.0",
          hasReviewData: false,
          createdAt: serverTimestamp(),
          createdBy: user.staffId,
        });
        await setDoc(doc(db, "indicators", code, "versions", "v1.0"), {
          version: "v1.0",
          status: form.status,
          threshold,
          tenSteps: steps,
          questions,
          effectiveDate: new Date().toISOString().slice(0, 10),
          note: "初版",
          createdAt: serverTimestamp(),
          createdBy: user.staffId,
        });
        onAction(`已新增指標 ${code}`);
      } else {
        const code = view.kind === "edit" ? view.code : "";
        if (!code) {
          setFormError("狀態異常，請重新開啟編輯");
          setSaving(false);
          return;
        }
        if (hasReviewData) {
          const ok = window.confirm(
            "此指標已有審查資料（含草稿），依版本控管規則將以新版本儲存，原版本保留。確定繼續？",
          );
          if (!ok) {
            setSaving(false);
            return;
          }
          const current = rows.find((r) => r.code === code);
          const newVersion = nextVersion(current?.version ?? "v1.0");
          await setDoc(doc(db, "indicators", code, "versions", newVersion), {
            version: newVersion,
            status: form.status,
            threshold,
            tenSteps: steps,
            questions,
            effectiveDate: new Date().toISOString().slice(0, 10),
            note: "審查資料鎖定後修訂",
            createdAt: serverTimestamp(),
            createdBy: user.staffId,
          });
          await updateDoc(doc(db, "indicators", code), {
            ...base,
            version: newVersion,
            hasReviewData: true,
          });
          onAction(`已儲存為新版本 ${newVersion}`);
        } else {
          await updateDoc(doc(db, "indicators", code), base);
          onAction("已儲存指標修改");
        }
      }
      setView({ kind: "list" });
      await loadList();
    } catch (error) {
      setFormError(`儲存失敗：${toErrorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivate(code: string) {
    if (!user) return;
    const locked = await checkReviewData(code);
    if (locked) {
      onAction("此指標已有審查資料，無法停用");
      return;
    }
    const ok = window.confirm(
      `確定將指標 ${code} 設為停用？（僅標記停用，不會刪除資料）`,
    );
    if (!ok) return;
    try {
      await updateDoc(doc(getFirebaseDb(), "indicators", code), {
        status: "停用",
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      });
      onAction(`指標 ${code} 已停用`);
      await loadList();
    } catch (error) {
      onAction(`停用失敗：${toErrorMessage(error)}`);
    }
  }

  const isEditing = view.kind === "edit";

  return (
    <>
      <PageHeading
        page="indicators"
        action={
          view.kind === "list" ? (
            <button className="button button-primary" onClick={openCreate}>
              <Plus size={16} />
              新增指標
            </button>
          ) : (
            <button
              className="button button-outline"
              onClick={() => setView({ kind: "list" })}
            >
              <X size={15} />
              返回清單
            </button>
          )
        }
      />

      {view.kind === "list" ? (
        loading ? (
          <section className="panel">
            <p className="settings-note">讀取中…</p>
          </section>
        ) : rows.length === 0 ? (
          <EmptyState
            title="尚無指標"
            description="使用右上角「新增指標」建立第一支指標，分類組別、編號、名稱、負責人與閾值為必填。"
          />
        ) : (
          <section className="panel data-panel">
            <div className="table-scroll">
              <table className="permission-table">
                <thead>
                  <tr>
                    <th>編號</th>
                    <th>名稱</th>
                    <th>組別</th>
                    <th>負責人</th>
                    <th>主閾值</th>
                    <th>版本</th>
                    <th>狀態</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.code}>
                      <td>
                        <b>{row.code}</b>
                      </td>
                      <td>{row.name}</td>
                      <td>{groupMap.get(row.groupId) || "—"}</td>
                      <td>
                        {row.owners.length > 0
                          ? row.owners.map(ownerLabel).join("、")
                          : "—"}
                      </td>
                      <td>{row.mainThreshold}%</td>
                      <td>{row.version}</td>
                      <td>
                        <span className={`status-pill ${STATUS_PILL[row.status]}`}>
                          {row.status}
                        </span>
                      </td>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => openEdit(row.code)}
                        >
                          <Pencil size={13} /> 編輯
                        </button>{" "}
                        {row.status !== "停用" && (
                          <button
                            className="text-button"
                            onClick={() => handleDeactivate(row.code)}
                          >
                            <Trash2 size={13} /> 停用
                          </button>
                        )}
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
            title={isEditing ? `編輯指標 ${form.code}` : "新增指標"}
            note={
              isEditing && hasReviewData
                ? "此指標已有審查資料，儲存時將自動產生新版本"
                : undefined
            }
          />
          {formError && <div className="login-error">{formError}</div>}

          <SectionTitle title="基本資料" />
          <div className="form-grid">
            <div className="form-field">
              <label className="field-label">分類組別 *</label>
              <div className="select-wrap">
                <select
                  value={form.groupId}
                  onChange={(e) => setField("groupId", e.target.value)}
                >
                  <option value="">請選擇組別</option>
                  {[...groupMap.entries()].map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
            <div className="form-field">
              <label className="field-label">指標編號 *</label>
              <input
                className="text-input"
                value={form.code}
                disabled={isEditing}
                placeholder="例如 QI-001"
                onChange={(e) => setField("code", e.target.value)}
              />
            </div>
            <div className="form-field">
              <label className="field-label">指標名稱 *</label>
              <input
                className="text-input"
                value={form.name}
                placeholder="例如 手部衛生遵從率"
                onChange={(e) => setField("name", e.target.value)}
              />
            </div>
            <div className="form-field">
              <label className="field-label">結果名稱</label>
              <div className="select-wrap">
                <select
                  value={form.resultName}
                  onChange={(e) => setField("resultName", e.target.value)}
                >
                  {RESULT_NAMES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
            <div className="form-field" style={{ gridColumn: "1 / -1" }}>
              <label className="field-label">
                負責人 *（輸入職編或姓名搜尋，可多選）
              </label>
              {form.owners.length > 0 && (
                <div className="chip-row">
                  {form.owners.map((id) => (
                    <span className="chip" key={id}>
                      {ownerLabel(id)}
                      <button
                        type="button"
                        aria-label={`移除 ${ownerLabel(id)}`}
                        onClick={() => removeOwner(id)}
                      >
                        <X size={13} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="suggest-wrap">
                <input
                  className="text-input"
                  value={form.ownerSearch}
                  placeholder="輸入職編或姓名搜尋…"
                  onChange={(e) => setField("ownerSearch", e.target.value)}
                />
                {ownerSuggestions.length > 0 && (
                  <ul className="suggest-list">
                    {ownerSuggestions.map((s) => (
                      <li key={s.staffId}>
                        <button type="button" onClick={() => addOwner(s.staffId)}>
                          {s.name}（{s.staffId}）
                          {s.unitCode ? `・${s.unitCode}` : ""}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {!staffLoaded && (
                <p className="settings-note">
                  人員清單載入失敗（可能無查詢權限），請確認帳號角色後重試。
                </p>
              )}
            </div>
            <div className="form-field">
              <label className="field-label">適用單位（以逗號分隔代號）</label>
              <input
                className="text-input"
                value={form.applicableUnitsText}
                placeholder="例如 9B, 10B"
                onChange={(e) => setField("applicableUnitsText", e.target.value)}
              />
            </div>
            <div className="form-field">
              <label className="field-label">稽核週期</label>
              <input
                className="text-input"
                value={form.cycle}
                placeholder="例如 每月"
                onChange={(e) => setField("cycle", e.target.value)}
              />
            </div>
            <div className="form-field">
              <label className="field-label">狀態</label>
              <div className="select-wrap">
                <select
                  value={form.status}
                  onChange={(e) =>
                    setField("status", e.target.value as IndicatorStatus)
                  }
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
          </div>

          <SectionTitle title="10 steps" note="全院統一標題" />
          {(
            [
              ["step1", 1],
              ["step2", 2],
              ["step3", 3],
            ] as const
          ).map(([key, n]) => (
            <div className="form-field" key={key}>
              <label className="field-label">
                {n}. {TEN_STEP_TITLES[n - 1]}
              </label>
              <textarea
                className="text-input"
                value={form.steps[key]}
                onChange={(e) => setStep(key, e.target.value)}
              />
            </div>
          ))}

          <div className="form-field">
            <label className="field-label">4. {TEN_STEP_TITLES[3]}（標準依據）</label>
            <textarea
              className="text-input"
              value={form.steps.step4.basis}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  steps: {
                    ...prev.steps,
                    step4: { ...prev.steps.step4, basis: e.target.value },
                  },
                }))
              }
            />
          </div>
          <div className="sub-block">
            <SectionTitle
              title="指標"
              note="可自行新增；公式預覽為「分子／分母 ×100%」"
              action={
                <button className="text-button" onClick={addSubIndicator}>
                  <Plus size={14} /> 新增指標
                </button>
              }
            />
            {form.steps.step4.subIndicators.length === 0 ? (
              <p className="settings-note">尚未新增指標。</p>
            ) : (
              form.steps.step4.subIndicators.map((s, i) => (
                <div key={i}>
                  <div className="sub-indicator-row">
                    <input
                      className="text-input"
                      value={s.name}
                      placeholder="指標名稱"
                      onChange={(e) =>
                        updateSubIndicator(i, { name: e.target.value })
                      }
                    />
                    <input
                      className="text-input"
                      value={s.numerator}
                      placeholder="分子（自由輸入）"
                      onChange={(e) =>
                        updateSubIndicator(i, { numerator: e.target.value })
                      }
                    />
                    <input
                      className="text-input"
                      value={s.denominator}
                      placeholder="分母（自由輸入）"
                      onChange={(e) =>
                        updateSubIndicator(i, { denominator: e.target.value })
                      }
                    />
                    <button
                      className="icon-button"
                      aria-label="刪除指標"
                      onClick={() => removeSubIndicator(i)}
                    >
                      <X size={15} />
                    </button>
                  </div>
                  <div className="formula-preview">
                    {s.name.trim() || `指標 ${i + 1}`}：
                    <b>
                      {s.numerator.trim() || "分子"}／
                      {s.denominator.trim() || "分母"} ×100%
                    </b>
                  </div>
                </div>
              ))
            )}
          </div>

          <SectionTitle
            title={`5. ${TEN_STEP_TITLES[4]}（閾值）`}
            note="至少一筆；第一筆為主閾值，用於達標判斷"
            action={
              <button className="text-button" onClick={addThreshold}>
                <Plus size={14} /> 新增閾值
              </button>
            }
          />
          {form.steps.step5.thresholds.map((t, i) => (
            <div key={i}>
              <div className="threshold-row">
                <input
                  className="text-input"
                  value={t.name}
                  placeholder={i === 0 ? "主閾值名稱" : "閾值名稱"}
                  onChange={(e) => updateThreshold(i, { name: e.target.value })}
                />
                <input
                  className="text-input"
                  type="number"
                  min={0}
                  max={100}
                  placeholder="0～100"
                  value={Number.isFinite(t.value) ? String(t.value) : ""}
                  onChange={(e) =>
                    updateThreshold(i, {
                      value:
                        e.target.value === "" ? NaN : Number(e.target.value),
                    })
                  }
                />
                <button
                  className="icon-button"
                  aria-label="刪除閾值"
                  onClick={() => removeThreshold(i)}
                >
                  <X size={15} />
                </button>
              </div>
              {i === 0 && (
                <span className="main-threshold-tag">
                  主閾值，用於達標判斷
                </span>
              )}
            </div>
          ))}

          <div className="form-field" style={{ marginTop: 14 }}>
            <label className="field-label">6. {TEN_STEP_TITLES[5]}（資料收集）</label>
          </div>
          <div className="form-grid">
            <div className="form-field">
              <label className="field-label">個案數</label>
              <input
                className="text-input"
                value={form.steps.step6.caseCount}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    steps: {
                      ...prev.steps,
                      step6: { ...prev.steps.step6, caseCount: e.target.value },
                    },
                  }))
                }
              />
            </div>
            <div className="form-field">
              <label className="field-label">審核人員</label>
              <input
                className="text-input"
                value={form.steps.step6.auditors}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    steps: {
                      ...prev.steps,
                      step6: { ...prev.steps.step6, auditors: e.target.value },
                    },
                  }))
                }
              />
            </div>
            <div className="form-field">
              <label className="field-label">審核日期</label>
              <input
                className="text-input"
                value={form.steps.step6.auditDate}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    steps: {
                      ...prev.steps,
                      step6: { ...prev.steps.step6, auditDate: e.target.value },
                    },
                  }))
                }
              />
            </div>
            <div className="form-field">
              <label className="field-label">審核方式</label>
              <input
                className="text-input"
                value={form.steps.step6.auditMethod}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    steps: {
                      ...prev.steps,
                      step6: { ...prev.steps.step6, auditMethod: e.target.value },
                    },
                  }))
                }
              />
            </div>
          </div>

          {(
            [
              ["step7", 7],
              ["step8", 8],
              ["step9", 9],
              ["step10", 10],
            ] as const
          ).map(([key, n]) => (
            <div className="form-field" key={key}>
              <label className="field-label">
                {n}. {TEN_STEP_TITLES[n - 1]}
              </label>
              <textarea
                className="text-input"
                value={form.steps[key]}
                onChange={(e) => setStep(key, e.target.value)}
              />
            </div>
          ))}

          <SectionTitle
            title="審核表題目"
            note="每題含題目、選項組合與審核指引（審查員填寫時的判斷依據）"
            action={
              <button className="text-button" onClick={addQuestion}>
                <Plus size={14} /> 新增題目
              </button>
            }
          />
          {form.questions.length === 0 ? (
            <p className="settings-note">
              尚未建立題目（未建立審核表仍可進行審查，依規格書）。
            </p>
          ) : (
            form.questions.map((q, i) => (
              <div className="question-block" key={i}>
                <div className="question-row">
                  <input
                    className="text-input"
                    value={q.text}
                    placeholder={`第 ${i + 1} 題題目文字`}
                    onChange={(e) => updateQuestion(i, { text: e.target.value })}
                  />
                  <div className="select-wrap">
                    <select
                      value={q.optionSet}
                      onChange={(e) =>
                        updateQuestion(i, {
                          optionSet: e.target.value as OptionSet,
                        })
                      }
                    >
                      {(
                        Object.keys(QUESTION_OPTION_LABELS) as OptionSet[]
                      ).map((k) => (
                        <option key={k} value={k}>
                          {QUESTION_OPTION_LABELS[k]}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={15} />
                  </div>
                  <button
                    className="icon-button"
                    aria-label="刪除題目"
                    onClick={() => removeQuestion(i)}
                  >
                    <X size={15} />
                  </button>
                </div>
                <textarea
                  className="text-input"
                  value={q.guidance}
                  placeholder="審核指引（審查員填寫時的判斷依據）"
                  onChange={(e) =>
                    updateQuestion(i, { guidance: e.target.value })
                  }
                />
                <input
                  className="text-input question-group-input"
                  value={q.group}
                  placeholder="題組（選填，例如：確認病人、給藥前）"
                  onChange={(e) => updateQuestion(i, { group: e.target.value })}
                />
              </div>
            ))
          )}

          {isEditing && versions.length > 0 && (
            <>
              <SectionTitle title="版本紀錄" note="歷史版本快照" />
              <div className="table-scroll">
                <table className="permission-table">
                  <thead>
                    <tr>
                      <th>版本</th>
                      <th>狀態</th>
                      <th>生效日</th>
                      <th>建立者</th>
                      <th>建立時間</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v) => (
                      <tr key={v.id}>
                        <td>
                          <b>{v.version}</b>
                        </td>
                        <td>{v.status}</td>
                        <td>{v.effectiveDate || "—"}</td>
                        <td>{v.createdBy || "—"}</td>
                        <td>{v.createdAtText || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div className="form-actions">
            <button
              className="button button-primary"
              disabled={saving}
              onClick={handleSave}
            >
              {saving ? "儲存中…" : isEditing ? "儲存修改" : "建立指標"}
            </button>
            <button
              className="button button-outline"
              onClick={() => setView({ kind: "list" })}
            >
              取消
            </button>
          </div>
        </section>
      )}
    </>
  );
}
