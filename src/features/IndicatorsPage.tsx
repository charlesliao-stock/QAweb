import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Pencil, Plus, Trash2, X } from "lucide-react";
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
} from "../lib/db";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { getFirebaseDb } from "../lib/firebase";
import { useAuth } from "../lib/auth";
import { maskName } from "../lib/mask";
import { logAudit } from "../lib/audit";
import {
  TEN_STEP_TITLES,
  alignThresholds,
  emptyAuditQuestion,
  emptyTenSteps,
  mergeQuestionGroups,
  newQid,
  normalizeQuestions,
  normalizeTenSteps,
  primaryThreshold,
  type AuditQuestion,
  type NamedThreshold,
  type QuestionGroup,
  type QuestionOption,
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

/** 指標表單的三個頁籤：基本資料 / 10 Steps / 審核表 */
type FormTab = "basic" | "steps" | "audit";

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
  status: IndicatorStatus;
  steps: TenSteps;
  questions: AuditQuestion[];
  /** 題目分組（「啟用題目分組」開關控制；不是每一份指標都有） */
  questionGroups: QuestionGroup[];
  useQuestionGroups: boolean;
  /** 需要病人床號（v1.15.0）：審查表單顯示床號欄位且列為必填 */
  requireBedNo: boolean;
}

function emptyForm(): IndicatorForm {
  const steps = emptyTenSteps();
  // 閾值與步驟四「指標」一一對應：無指標時無閾值列，新增指標時同步產生
  steps.step5.thresholds = [];
  return {
    groupId: "",
    code: "",
    name: "",
    owners: [],
    ownerSearch: "",
    status: "草稿",
    steps,
    questions: [],
    questionGroups: [],
    useQuestionGroups: false,
    requireBedNo: false,
  };
}

function nextVersion(version: string): string {
  const m = /^v(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) return "v1.1";
  return `v${m[1]}.${Number(m[2]) + 1}`;
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
  const [formTab, setFormTab] = useState<FormTab>("basic");
  const [saving, setSaving] = useState(false);
  const [hasReviewData, setHasReviewData] = useState(false);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [groupMap, setGroupMap] = useState<Map<string, string>>(new Map());
  const [staffMap, setStaffMap] = useState<Map<string, StaffOption>>(new Map());
  const [staffLoaded, setStaffLoaded] = useState(false);
  const formErrorRef = useRef<HTMLDivElement>(null);

  /**
   * 顯示表單錯誤並捲動到可視範圍。
   * 表單很長（基本資料＋10 steps＋審核表）、按鈕在最下方，
   * 錯誤訊息若只出現在頂端，使用者會以為「點了沒反應」。
   */
  function showFormError(message: string) {
    setFormError(message);
    window.setTimeout(() => {
      formErrorRef.current?.scrollIntoView?.({
        behavior: "smooth",
        block: "center",
      });
    }, 60);
  }

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
          collection(getFirebaseDb(), "reviewRecords"),
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
    setFormTab("basic");
    setHasReviewData(false);
    setVersions([]);
    setView({ kind: "create" });
  }

  async function openEdit(code: string) {
    setFormError("");
    setFormTab("basic");
    try {
      const snap = await getDoc(doc(getFirebaseDb(), "indicators", code));
      if (!snap.exists()) {
        onAction("找不到該指標");
        return;
      }
      const data = snap.data();
      const steps = normalizeTenSteps(data.tenSteps, data.steps);
      if (
        steps.step4.subIndicators.length > 0 &&
        steps.step5.thresholds.length === 0 &&
        typeof data.threshold === "number"
      ) {
        steps.step5.thresholds = [{ name: "主閾值", value: data.threshold }];
      }
      // 閾值與步驟四「指標」一一對應：多退少補（保留既有值）
      steps.step5.thresholds = alignThresholds(
        steps.step5.thresholds,
        steps.step4.subIndicators.length,
      );
      let groupId = typeof data.groupId === "string" ? data.groupId : "";
      if (!groupId && typeof data.group === "string" && data.group) {
        const found = [...groupMap.entries()].find(
          ([, name]) => name === data.group,
        );
        if (found) groupId = found[0];
      }
      const nq = normalizeQuestions(data.questions);
      const mergedGroups = mergeQuestionGroups(data.questionGroups, nq.groups);
      const groupIds = new Set(mergedGroups.map((g) => g.id));
      const useQuestionGroups =
        typeof data.useQuestionGroups === "boolean"
          ? data.useQuestionGroups
          : nq.useGroups;
      const questions = nq.questions.map((q) => ({
        ...q,
        // 分組表沒有的 groupId 視為未分組（容錯，避免題目消失）
        groupId:
          q.groupId && groupIds.has(q.groupId) ? q.groupId : null,
        groupName:
          q.groupId && groupIds.has(q.groupId)
            ? (mergedGroups.find((g) => g.id === q.groupId)?.name ?? "")
            : "",
      }));
      setForm({
        groupId,
        code: snap.id,
        name: typeof data.name === "string" ? data.name : "",
        owners: Array.isArray(data.owners) ? data.owners.map(String) : [],
        ownerSearch: "",
        status: STATUSES.includes(data.status) ? data.status : "草稿",
        steps,
        questions,
        questionGroups: mergedGroups,
        useQuestionGroups,
        requireBedNo: data.requireBedNo === true,
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
    return s && s.name !== staffId ? `${maskName(s.name)}（${staffId}）` : staffId;
  }

  // ---- 審核表題目 / 分組 / 選項 ----
  function groupNameOf(groupId: string | null): string {
    if (!groupId) return "";
    return form.questionGroups.find((g) => g.id === groupId)?.name ?? "";
  }

  function addQuestion(groupId: string | null) {
    const q = emptyAuditQuestion(groupId, groupNameOf(groupId));
    setForm((prev) => ({ ...prev, questions: [...prev.questions, q] }));
  }

  function updateQuestion(id: string, patch: Partial<AuditQuestion>) {
    setForm((prev) => ({
      ...prev,
      questions: prev.questions.map((q) =>
        q.id === id ? { ...q, ...patch } : q,
      ),
    }));
  }

  function removeQuestion(id: string) {
    setForm((prev) => ({
      ...prev,
      questions: prev.questions.filter((q) => q.id !== id),
    }));
  }

  /** 題目在所屬區段（同分組或未分組）內上／下移 */
  function moveQuestion(id: string, dir: -1 | 1) {
    setForm((prev) => {
      const qs = [...prev.questions];
      const idx = qs.findIndex((q) => q.id === id);
      if (idx < 0) return prev;
      const gid = qs[idx].groupId;
      const sectionIdx: number[] = [];
      qs.forEach((q, i) => {
        if ((q.groupId ?? null) === (gid ?? null)) sectionIdx.push(i);
      });
      const pos = sectionIdx.indexOf(idx);
      const swap = pos + dir;
      if (swap < 0 || swap >= sectionIdx.length) return prev;
      const j = sectionIdx[swap];
      [qs[idx], qs[j]] = [qs[j], qs[idx]];
      return { ...prev, questions: qs };
    });
  }

  /** 題目跨分組移動（下拉選擇目標，含「未分組」） */
  function moveQuestionToGroup(id: string, targetGroupId: string | null) {
    setForm((prev) => {
      const q = prev.questions.find((x) => x.id === id);
      if (!q) return prev;
      const rest = prev.questions.filter((x) => x.id !== id);
      const gname = targetGroupId
        ? (prev.questionGroups.find((g) => g.id === targetGroupId)?.name ?? "")
        : "";
      return {
        ...prev,
        questions: [
          ...rest,
          { ...q, groupId: targetGroupId, groupName: gname },
        ],
      };
    });
  }

  function toggleQuestionGroups() {
    if (!form.useQuestionGroups) {
      setForm((prev) => ({ ...prev, useQuestionGroups: true }));
      return;
    }
    const hasGroupData =
      form.questionGroups.length > 0 ||
      form.questions.some((q) => q.groupId !== null);
    if (
      hasGroupData &&
      !window.confirm("關閉後分組將取消、題目保留為扁平清單，確定嗎？")
    ) {
      return;
    }
    setForm((prev) => ({
      ...prev,
      useQuestionGroups: false,
      questionGroups: [],
      questions: prev.questions.map((q) => ({
        ...q,
        groupId: null,
        groupName: "",
      })),
    }));
  }

  function addQuestionGroup() {
    const g: QuestionGroup = {
      id: newQid(),
      name: `分組 ${form.questionGroups.length + 1}`,
      order: form.questionGroups.length,
    };
    setForm((prev) => ({
      ...prev,
      questionGroups: [...prev.questionGroups, g],
    }));
  }

  function renameQuestionGroup(id: string, name: string) {
    setForm((prev) => ({
      ...prev,
      questionGroups: prev.questionGroups.map((g) =>
        g.id === id ? { ...g, name } : g,
      ),
      questions: prev.questions.map((q) =>
        q.groupId === id ? { ...q, groupName: name } : q,
      ),
    }));
  }

  function moveQuestionGroup(id: string, dir: -1 | 1) {
    setForm((prev) => {
      const gs = [...prev.questionGroups].sort((a, b) => a.order - b.order);
      const idx = gs.findIndex((g) => g.id === id);
      const j = idx + dir;
      if (idx < 0 || j < 0 || j >= gs.length) return prev;
      [gs[idx], gs[j]] = [gs[j], gs[idx]];
      return {
        ...prev,
        questionGroups: gs.map((g, i) => ({ ...g, order: i })),
      };
    });
  }

  function removeQuestionGroup(id: string) {
    const count = form.questions.filter((q) => q.groupId === id).length;
    if (
      !window.confirm(
        count > 0
          ? `刪除此分組將一併刪除其下 ${count} 個題目，確定嗎？`
          : "確定刪除此分組嗎？",
      )
    ) {
      return;
    }
    setForm((prev) => ({
      ...prev,
      questionGroups: prev.questionGroups
        .filter((g) => g.id !== id)
        .map((g, i) => ({ ...g, order: i })),
      questions: prev.questions.filter((q) => q.groupId !== id),
    }));
  }

  // ---- 題目選項 ----
  function addQuestionOption(qid: string) {
    setForm((prev) => ({
      ...prev,
      questions: prev.questions.map((q) =>
        q.id === qid
          ? {
              ...q,
              options: [
                ...q.options,
                {
                  label: "",
                  score: q.options.length,
                },
              ],
            }
          : q,
      ),
    }));
  }

  function updateQuestionOption(
    qid: string,
    oi: number,
    patch: Partial<QuestionOption>,
  ) {
    setForm((prev) => ({
      ...prev,
      questions: prev.questions.map((q) =>
        q.id === qid
          ? {
              ...q,
              options: q.options.map((o, i) =>
                i === oi ? { ...o, ...patch } : o,
              ),
            }
          : q,
      ),
    }));
  }

  function removeQuestionOption(qid: string, oi: number) {
    setForm((prev) => ({
      ...prev,
      questions: prev.questions.map((q) => {
        if (q.id !== qid || q.options.length <= 1) return q;
        return { ...q, options: q.options.filter((_, i) => i !== oi) };
      }),
    }));
  }

  const sortedQuestionGroups = useMemo(
    () =>
      [...form.questionGroups].sort((a, b) => a.order - b.order),
    [form.questionGroups],
  );

  /** 單一題目編輯區塊（指標項目→選項→審核指引） */
  function renderQuestion(q: AuditQuestion) {
    const n = form.questions.findIndex((x) => x.id === q.id) + 1;
    const gid = q.groupId ?? null;
    const section = form.questions.filter(
      (x) => (x.groupId ?? null) === gid,
    );
    const pos = section.findIndex((x) => x.id === q.id);
    return (
      <div className="question-block" key={q.id}>
        <div className="question-row">
          <input
            className="text-input"
            value={q.itemText}
            placeholder={`第 ${n} 題指標項目`}
            onChange={(e) =>
              updateQuestion(q.id, { itemText: e.target.value })
            }
          />
          <button
            className="icon-button"
            aria-label="題目上移"
            disabled={pos <= 0}
            onClick={() => moveQuestion(q.id, -1)}
          >
            <ChevronUp size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="題目下移"
            disabled={pos >= section.length - 1}
            onClick={() => moveQuestion(q.id, 1)}
          >
            <ChevronDown size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="刪除題目"
            onClick={() => removeQuestion(q.id)}
          >
            <X size={15} />
          </button>
        </div>
        <div className="question-options">
          <div className="settings-note">選項（顯示文字＋分數）</div>
          {q.options.map((o, oi) => (
            <div className="option-row" key={oi}>
              <input
                className="text-input"
                value={o.label}
                placeholder={`選項 ${oi + 1} 文字`}
                onChange={(e) =>
                  updateQuestionOption(q.id, oi, { label: e.target.value })
                }
              />
              <input
                className="text-input option-score"
                type="number"
                value={Number.isFinite(o.score) ? o.score : ""}
                placeholder="分數"
                onChange={(e) =>
                  updateQuestionOption(q.id, oi, {
                    score: e.target.value === "" ? NaN : Number(e.target.value),
                  })
                }
              />
              <button
                className="icon-button"
                aria-label="刪除選項"
                disabled={q.options.length <= 1}
                onClick={() => removeQuestionOption(q.id, oi)}
              >
                <X size={15} />
              </button>
            </div>
          ))}
          <button
            className="text-button"
            onClick={() => addQuestionOption(q.id)}
          >
            <Plus size={14} /> 新增選項
          </button>
        </div>
        <textarea
          className="text-input"
          value={q.guidance}
          placeholder="審核指引（審查員填寫時的判斷依據）"
          onChange={(e) =>
            updateQuestion(q.id, { guidance: e.target.value })
          }
        />
        {form.useQuestionGroups && (
          <div className="question-move-row">
            <span className="settings-note">移動到：</span>
            <div className="select-wrap">
              <select
                value={q.groupId ?? ""}
                onChange={(e) =>
                  moveQuestionToGroup(q.id, e.target.value || null)
                }
              >
                <option value="">未分組</option>
                {sortedQuestionGroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} />
            </div>
          </div>
        )}
      </div>
    );
  }

  // ---- 步驟四「指標」 / 步驟五「閾值」（兩者一一對應、同步增刪） ----
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
        step5: {
          ...prev.steps.step5,
          thresholds: [
            ...prev.steps.step5.thresholds,
            { name: "", value: NaN },
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
        step5: {
          ...prev.steps.step5,
          thresholds: prev.steps.step5.thresholds.filter(
            (_, i) => i !== index,
          ),
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

  /** 驗證表單：回傳錯誤訊息與錯誤欄位所在的頁籤（成功時訊息為空）。 */
  function validate(): { message: string; tab: FormTab | null } {
    if (!form.groupId) return { message: "請選擇分類組別", tab: "basic" };
    if (view.kind === "create" && !form.code.trim())
      return { message: "請填寫指標編號", tab: "basic" };
    if (!form.name.trim()) return { message: "請填寫指標名稱", tab: "basic" };
    if (form.owners.length === 0)
      return { message: "請選擇至少一位負責人", tab: "basic" };
    const nIndicators = form.steps.step4.subIndicators.length;
    if (nIndicators === 0)
      return { message: "請在步驟四「指標」至少新增一支指標", tab: "steps" };
    for (let i = 0; i < nIndicators; i++) {
      const v = form.steps.step5.thresholds[i]?.value;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100)
        return {
          message: `指標 ${i + 1} 的閾值須為 0～100 的數字（代表百分比）`,
          tab: "steps",
        };
    }
    for (const [i, q] of form.questions.entries()) {
      const where =
        form.useQuestionGroups && q.groupName
          ? `第 ${i + 1} 題（${q.groupName}）`
          : `第 ${i + 1} 題`;
      if (!q.itemText.trim())
        return { message: `${where}尚未填寫指標項目`, tab: "audit" };
      if (q.options.length === 0)
        return { message: `${where}至少需要一個選項`, tab: "audit" };
      for (const [oi, o] of q.options.entries()) {
        if (!o.label.trim())
          return {
            message: `${where}第 ${oi + 1} 個選項尚未填寫文字`,
            tab: "audit",
          };
        if (!Number.isFinite(o.score))
          return {
            message: `${where}第 ${oi + 1} 個選項分數須為數字`,
            tab: "audit",
          };
      }
    }
    return { message: "", tab: null };
  }

  async function handleSave() {
    const validation = validate();
    if (validation.message) {
      // 錯誤欄位若不在目前頁籤，先自動切到該頁籤再顯示錯誤
      if (validation.tab && validation.tab !== formTab)
        setFormTab(validation.tab);
      showFormError(validation.message);
      return;
    }
    if (!user) {
      showFormError("請先登入");
      return;
    }
    setFormError("");
    setSaving(true);
    try {
      const db = getFirebaseDb();
      // 閾值與步驟四「指標」一一對應：名稱取自指標名稱（驗證已確保每列皆為 0～100 的數字）
      const thresholds = form.steps.step4.subIndicators.map((s, i) => ({
        name: s.name.trim(),
        value: form.steps.step5.thresholds[i]?.value ?? NaN,
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
      const questions = form.questions.map((q, i) => ({
        id: q.id,
        itemText: q.itemText.trim(),
        options: q.options.map((o) => ({
          label: o.label.trim(),
          score: o.score,
        })),
        guidance: q.guidance.trim(),
        groupId: form.useQuestionGroups ? q.groupId : null,
        groupName: form.useQuestionGroups ? q.groupName.trim() : "",
        order: i,
      }));
      const questionGroups = form.useQuestionGroups
        ? [...form.questionGroups]
            .sort((a, b) => a.order - b.order)
            .map((g, i) => ({
              id: g.id,
              name: g.name.trim() || `分組 ${i + 1}`,
              order: i,
            }))
        : [];
      const threshold = thresholds[0]?.value ?? 0;
      const base = {
        name: form.name.trim(),
        groupId: form.groupId,
        owners: form.owners,
        threshold,
        status: form.status,
        tenSteps: steps,
        questions,
        questionGroups,
        useQuestionGroups: form.useQuestionGroups,
        requireBedNo: form.requireBedNo,
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      };

      if (view.kind === "create") {
        const code = form.code.trim();
        const ref = doc(db, "indicators", code);
        const exists = await getDoc(ref);
        if (exists.exists()) {
          setFormTab("basic");
          showFormError(`指標編號 ${code} 已存在`);
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
        logAudit(db, {
          actor: user.staffId,
          actorName: user.name,
          action: "建立指標",
          targetType: "indicator",
          targetId: code,
          detail: form.name.trim(),
        });
      } else {
        const code = view.kind === "edit" ? view.code : "";
        if (!code) {
          showFormError("狀態異常，請重新開啟編輯");
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
          logAudit(db, {
            actor: user.staffId,
            actorName: user.name,
            action: "編輯指標",
            targetType: "indicator",
            targetId: code,
            detail: `新版本 ${newVersion}：${form.name.trim()}`,
          });
        } else {
          await updateDoc(doc(db, "indicators", code), base);
          onAction("已儲存指標修改");
          logAudit(db, {
            actor: user.staffId,
            actorName: user.name,
            action: "編輯指標",
            targetType: "indicator",
            targetId: code,
            detail: form.name.trim(),
          });
        }
      }
      setView({ kind: "list" });
      await loadList();
    } catch (error) {
      showFormError(`儲存失敗：${toErrorMessage(error)}`);
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
      logAudit(getFirebaseDb(), {
        actor: user.staffId,
        actorName: user.name,
        action: "停用指標",
        targetType: "indicator",
        targetId: code,
      });
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
          {formError && (
            <div className="login-error" ref={formErrorRef} aria-live="assertive">
              {formError}
            </div>
          )}

          <div className="tabs" style={{ marginBottom: 12 }}>
            <button
              type="button"
              className={`tab${formTab === "basic" ? " active" : ""}`}
              onClick={() => setFormTab("basic")}
            >
              指標基本資料
            </button>
            <button
              type="button"
              className={`tab${formTab === "steps" ? " active" : ""}`}
              onClick={() => setFormTab("steps")}
            >
              10 Steps
            </button>
            <button
              type="button"
              className={`tab${formTab === "audit" ? " active" : ""}`}
              onClick={() => setFormTab("audit")}
            >
              審核表
            </button>
          </div>

          {formTab === "basic" && (
            <>
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
                          {maskName(s.name)}（{s.staffId}）
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
          </>)}

          {formTab === "steps" && (
            <>
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
            <label className="field-label">4. {TEN_STEP_TITLES[3]}</label>
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
              note="可自行新增；每支指標自動編號，公式呈現為「分子／分母 ×100%」"
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
                <div key={i} className="indicator-card">
                  <div className="indicator-head">
                    <span className="indicator-num">{i + 1}</span>
                    <input
                      className="text-input"
                      value={s.name}
                      placeholder="指標名稱"
                      onChange={(e) =>
                        updateSubIndicator(i, { name: e.target.value })
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
                  <div className="indicator-formula">
                    <div className="fraction">
                      <input
                        className="text-input fraction-input"
                        value={s.numerator}
                        placeholder="分子（自由輸入）"
                        onChange={(e) =>
                          updateSubIndicator(i, {
                            numerator: e.target.value,
                          })
                        }
                      />
                      <div className="fraction-bar" aria-hidden="true" />
                      <input
                        className="text-input fraction-input"
                        value={s.denominator}
                        placeholder="分母（自由輸入）"
                        onChange={(e) =>
                          updateSubIndicator(i, {
                            denominator: e.target.value,
                          })
                        }
                      />
                    </div>
                    <span className="fraction-times">×100%</span>
                  </div>
                </div>
              ))
            )}
          </div>

          <SectionTitle
            title={`5. ${TEN_STEP_TITLES[4]}`}
            note="每支指標一列、自動編號（與步驟四對應）；第一筆為主閾值，用於達標判斷"
          />
          {form.steps.step4.subIndicators.length === 0 ? (
            <p className="settings-note">
              請先在步驟四新增指標，閾值會依指標自動產生對應列。
            </p>
          ) : (
            form.steps.step4.subIndicators.map((s, i) => {
              const v = form.steps.step5.thresholds[i]?.value;
              return (
                <div key={i}>
                  <div className="threshold-row">
                    <span className="threshold-num">{i + 1}</span>
                    <span className="threshold-name">
                      {s.name.trim() || `指標 ${i + 1}`}
                    </span>
                    <input
                      className="text-input"
                      type="number"
                      min={0}
                      max={100}
                      placeholder="0～100"
                      value={
                        typeof v === "number" && Number.isFinite(v)
                          ? String(v)
                          : ""
                      }
                      onChange={(e) =>
                        updateThreshold(i, {
                          value:
                            e.target.value === ""
                              ? NaN
                              : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                  {i === 0 && (
                    <span className="main-threshold-tag">
                      主閾值，用於達標判斷
                    </span>
                  )}
                </div>
              );
            })
          )}

          <div className="form-field" style={{ marginTop: 14 }}>
            <label className="field-label">6. {TEN_STEP_TITLES[5]}</label>
          </div>
          <div className="form-stack">
            <div className="form-field">
              <label className="field-label">1.個案數</label>
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
              <label className="field-label">2.審核人員</label>
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
              <label className="field-label">3.審核日期</label>
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
              <label className="field-label">4.審核方式</label>
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
          </>)}

          {formTab === "audit" && (
            <>
              <SectionTitle
                title="審核表題目"
                note="每題含指標項目、選項與審核指引（審查員填寫時的判斷依據）"
              />
              <button
                type="button"
                className={`mode-toggle${form.useQuestionGroups ? " on" : ""}`}
                onClick={toggleQuestionGroups}
                aria-pressed={form.useQuestionGroups}
              >
                <span>啟用題目分組</span>
                <span className="toggle-track" />
              </button>
              <p className="settings-note">
                開啟後可建立多個分組、一個分組下可建多個題目；關閉則分組取消、題目保留為扁平清單。
              </p>
              <label className="check-row" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={form.requireBedNo}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      requireBedNo: e.target.checked,
                    }))
                  }
                />
                <span>
                  需要病人床號
                  <span className="muted-text">
                    （勾選後，審查表單會顯示「病人床號」欄位並列為必填）
                  </span>
                </span>
              </label>
              {form.useQuestionGroups ? (
                <>
                  <div className="group-actions">
                    <button
                      className="text-button"
                      onClick={addQuestionGroup}
                    >
                      <Plus size={14} /> 新增分組
                    </button>
                  </div>
                  {sortedQuestionGroups.map((g, gi) => {
                    const qs = form.questions.filter(
                      (x) => x.groupId === g.id,
                    );
                    return (
                      <div className="question-group-block" key={g.id}>
                        <div className="question-group-head">
                          <input
                            className="text-input"
                            value={g.name}
                            placeholder="分組名稱"
                            onChange={(e) =>
                              renameQuestionGroup(g.id, e.target.value)
                            }
                          />
                          <span className="settings-note">{qs.length} 題</span>
                          <button
                            className="icon-button"
                            aria-label="分組上移"
                            disabled={gi === 0}
                            onClick={() => moveQuestionGroup(g.id, -1)}
                          >
                            <ChevronUp size={15} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label="分組下移"
                            disabled={
                              gi === sortedQuestionGroups.length - 1
                            }
                            onClick={() => moveQuestionGroup(g.id, 1)}
                          >
                            <ChevronDown size={15} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label="刪除分組"
                            onClick={() => removeQuestionGroup(g.id)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                        {qs.map((q) => renderQuestion(q))}
                        <button
                          className="text-button"
                          onClick={() => addQuestion(g.id)}
                        >
                          <Plus size={14} /> 在此分組新增題目
                        </button>
                      </div>
                    );
                  })}
                  <div className="question-group-block">
                    <div className="question-group-head">
                      <b>未分組題目</b>
                      <button
                        className="text-button"
                        onClick={() => addQuestion(null)}
                      >
                        <Plus size={14} /> 新增題目
                      </button>
                    </div>
                    {form.questions
                      .filter((x) => !x.groupId)
                      .map((q) => renderQuestion(q))}
                  </div>
                </>
              ) : (
                <>
                  <div className="group-actions">
                    <button
                      className="text-button"
                      onClick={() => addQuestion(null)}
                    >
                      <Plus size={14} /> 新增題目
                    </button>
                  </div>
                  {form.questions.length === 0 ? (
                    <p className="settings-note">
                      尚未建立題目（未建立審核表仍可進行審查，依規格書）。
                    </p>
                  ) : (
                    form.questions.map((q) => renderQuestion(q))
                  )}
                </>
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
