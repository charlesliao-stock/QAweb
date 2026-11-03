import { useCallback, useEffect, useState } from "react";
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
import { TEN_STEPS_TITLES } from "../lib/seed";

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

export type QuestionOptions = "yes-no-na" | "yes-no";

const QUESTION_OPTION_LABELS: Record<QuestionOptions, string> = {
  "yes-no-na": "是／否／不適用",
  "yes-no": "是／否",
};

export interface AuditQuestion {
  text: string;
  options: QuestionOptions;
}

interface IndicatorRow {
  code: string;
  name: string;
  group: string;
  owners: string[];
  resultName: string;
  threshold: number;
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
  code: string;
  name: string;
  group: string;
  ownersText: string;
  resultName: string;
  thresholdText: string;
  applicableUnitsText: string;
  cycle: string;
  status: IndicatorStatus;
  steps: string[];
  questions: AuditQuestion[];
}

const RESULT_NAMES = ["符合率", "正確率", "完整率", "達成率"];

function emptyForm(): IndicatorForm {
  return {
    code: "",
    name: "",
    group: "",
    ownersText: "",
    resultName: "符合率",
    thresholdText: "",
    applicableUnitsText: "",
    cycle: "每月",
    status: "草稿",
    steps: TEN_STEPS_TITLES.map(() => ""),
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

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(getFirebaseDb(), "indicators"));
      const list: IndicatorRow[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          code: d.id,
          name: typeof data.name === "string" ? data.name : "",
          group: typeof data.group === "string" ? data.group : "",
          owners: Array.isArray(data.owners) ? data.owners.map(String) : [],
          resultName:
            typeof data.resultName === "string" ? data.resultName : "符合率",
          threshold: typeof data.threshold === "number" ? data.threshold : 0,
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
    loadList();
  }, [loadList]);

  function setField<K extends keyof IndicatorForm>(key: K, value: IndicatorForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
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
      const stepsRecord: Record<string, string> =
        data.steps && typeof data.steps === "object" ? data.steps : {};
      const questions: AuditQuestion[] = Array.isArray(data.questions)
        ? data.questions.map((q: { text?: unknown; options?: unknown }) => ({
            text: typeof q.text === "string" ? q.text : "",
            options: q.options === "yes-no" ? "yes-no" : "yes-no-na",
          }))
        : [];
      setForm({
        code: snap.id,
        name: typeof data.name === "string" ? data.name : "",
        group: typeof data.group === "string" ? data.group : "",
        ownersText: Array.isArray(data.owners) ? data.owners.join(", ") : "",
        resultName:
          typeof data.resultName === "string" ? data.resultName : "符合率",
        thresholdText:
          typeof data.threshold === "number" ? String(data.threshold) : "",
        applicableUnitsText: Array.isArray(data.applicableUnits)
          ? data.applicableUnits.join(", ")
          : "",
        cycle: typeof data.cycle === "string" ? data.cycle : "每月",
        status: STATUSES.includes(data.status) ? data.status : "草稿",
        steps: TEN_STEPS_TITLES.map((t) =>
          typeof stepsRecord[t] === "string" ? stepsRecord[t] : "",
        ),
        questions,
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
              createdAtText: createdAt ? createdAt.toLocaleString("zh-Hant") : "",
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

  function validate(): string {
    if (view.kind === "create" && !form.code.trim()) return "請填寫指標編號";
    if (!form.name.trim()) return "請填寫指標名稱";
    if (!form.thresholdText.trim()) return "閾值為必填，請填寫百分比數字";
    const threshold = Number(form.thresholdText);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100)
      return "閾值須為 0～100 的數字（代表百分比）";
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
      const threshold = Number(form.thresholdText);
      const stepsRecord: Record<string, string> = {};
      TEN_STEPS_TITLES.forEach((title, i) => {
        stepsRecord[title] =
          title === "閾值" ? `${threshold}%` : form.steps[i].trim();
      });
      const questions = form.questions.map((q) => ({
        text: q.text.trim(),
        options: q.options,
      }));
      const base = {
        name: form.name.trim(),
        group: form.group.trim(),
        owners: splitList(form.ownersText),
        resultName: form.resultName,
        threshold,
        applicableUnits: splitList(form.applicableUnitsText),
        cycle: form.cycle.trim() || "每月",
        status: form.status,
        steps: stepsRecord,
        questions,
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      };

      if (view.kind === "create") {
        const ref = doc(db, "indicators", form.code.trim());
        const exists = await getDoc(ref);
        if (exists.exists()) {
          setFormError(`指標編號 ${form.code.trim()} 已存在`);
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
        // 同步建立 v1.0 版本快照
        await setDoc(doc(db, "indicators", form.code.trim(), "versions", "v1.0"), {
          version: "v1.0",
          status: form.status,
          threshold,
          steps: stepsRecord,
          questions,
          effectiveDate: new Date().toISOString().slice(0, 10),
          note: "初版",
          createdAt: serverTimestamp(),
          createdBy: user.staffId,
        });
        onAction(`已新增指標 ${form.code.trim()}`);
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
            steps: stepsRecord,
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

  function addQuestion() {
    setForm((prev) => ({
      ...prev,
      questions: [...prev.questions, { text: "", options: "yes-no-na" }],
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
            description="使用右上角「新增指標」建立第一支指標，閾值為必填。"
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
                    <th>閾值</th>
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
                      <td>{row.group || "—"}</td>
                      <td>{row.owners.length > 0 ? row.owners.join("、") : "—"}</td>
                      <td>{row.threshold}%</td>
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
                : "閾值為必填（百分比）"
            }
          />
          {formError && <div className="login-error">{formError}</div>}

          <div className="form-grid">
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
              <label className="field-label">分類組別</label>
              <input
                className="text-input"
                value={form.group}
                placeholder="例如 病房組"
                onChange={(e) => setField("group", e.target.value)}
              />
            </div>
            <div className="form-field">
              <label className="field-label">負責人（可多位，以逗號分隔職編）</label>
              <input
                className="text-input"
                value={form.ownersText}
                placeholder="例如 A12345, B67890"
                onChange={(e) => setField("ownersText", e.target.value)}
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
            <div className="form-field">
              <label className="field-label">閾值（百分比） *</label>
              <input
                className="text-input"
                type="number"
                min={0}
                max={100}
                value={form.thresholdText}
                placeholder="例如 90（代表 90%）"
                onChange={(e) => setField("thresholdText", e.target.value)}
              />
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

          <SectionTitle title="10 steps" note="全院統一標題；閾值自動帶入上方設定" />
          {TEN_STEPS_TITLES.map((title, i) =>
            title === "閾值" ? (
              <div className="form-field" key={title}>
                <label className="field-label">{title}（自動帶入）</label>
                <input
                  className="text-input"
                  value={form.thresholdText ? `${form.thresholdText}%` : ""}
                  disabled
                  placeholder="由上方閾值自動帶入"
                />
              </div>
            ) : (
              <div className="form-field" key={title}>
                <label className="field-label">{title}</label>
                <textarea
                  className="text-input"
                  value={form.steps[i]}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      steps: prev.steps.map((s, si) => (si === i ? e.target.value : s)),
                    }))
                  }
                />
              </div>
            ),
          )}

          <SectionTitle
            title="審核表題目"
            note="每題獨立設定選項組合"
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
              <div className="question-row" key={i}>
                <input
                  className="text-input"
                  value={q.text}
                  placeholder={`第 ${i + 1} 題題目文字`}
                  onChange={(e) => updateQuestion(i, { text: e.target.value })}
                />
                <div className="select-wrap">
                  <select
                    value={q.options}
                    onChange={(e) =>
                      updateQuestion(i, {
                        options: e.target.value as QuestionOptions,
                      })
                    }
                  >
                    {(
                      Object.keys(QUESTION_OPTION_LABELS) as QuestionOptions[]
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
