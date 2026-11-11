import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Ban,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  Pencil,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getDocsFromServer,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "../lib/db";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { getFirebaseDb } from "../lib/firebase";
import { getCachedRefCollection } from "../lib/refCache";
import { getDocsCacheFirst } from "../lib/cacheFirst";
import { useAuth } from "../lib/auth";
import { maskName } from "../lib/mask";
import { logAudit } from "../lib/audit";
import {
  TEN_STEP_TITLES,
  alignThresholds,
  compareIndicatorRows,
  createQuestionGroup,
  displayThreshold,
  emptyAuditQuestion,
  emptyTenSteps,
  filterIndicators,
  hasAuditQuestionFor,
  indicatorCodeOf,
  indicatorDocId,
  isBasicCompleteFor,
  meetsEnableConditions,
  mergeQuestionGroups,
  moveQuestionInList,
  moveQuestionToGroupInList,
  newQid,
  normalizeQuestions,
  normalizeTenSteps,
  optionLabelsOf,
  parseIndicatorDocId,
  primaryThreshold,
  removeQuestionGroupFromList,
  renameQuestionGroupInList,
  validateBasicThreshold,
  OPTION_SET_LABELS,
  type AuditQuestion,
  type IndicatorSortKey,
  type NamedThreshold,
  type OptionSet,
  type QuestionGroup,
  type SubIndicator,
  type TenSteps,
} from "../lib/indicators";
import {
  auditTemplateRows,
  basicTemplateRows,
  parseAuditSheet,
  parseBasicSheet,
  validateAuditRows,
  validateBasicRows,
} from "../lib/import";
import { downloadTemplate, readSheetFile } from "../lib/sheetFile";
import {
  mergeImportedAuditForm,
  resolveAuditImportGroup,
  type ImportedAuditForm,
} from "../lib/auditFormImport";

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
  /** Firestore 文件 ID（v1.21：`${groupId}__${code}` 複合 ID） */
  id: string;
  /** 指標編號（組別內唯一；顯示層只顯示此值） */
  code: string;
  name: string;
  groupId: string;
  owners: string[];
  mainThreshold: number;
  /** 基本資料閾值（v1.15.1）；null＝未填，清單顯示時 fallback 主閾值 */
  basicThreshold: number | null;
  status: IndicatorStatus;
  version: string;
  /** 是否具備啟用條件（v1.45.0：基本資料完成＋審核表至少一題；供清單列 [啟用] 按鈕顯示判定） */
  canEnable: boolean;
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
  /** 基本資料閾值（v1.17 起必填；""＝未填） */
  basicThreshold: number | "";
  owners: string[];
  status: IndicatorStatus;
  steps: TenSteps;
  questions: AuditQuestion[];
  auditItems: string[];
  /** 題目分組（「啟用題目分組」開關控制；不是每一份指標都有） */
  questionGroups: QuestionGroup[];
  useQuestionGroups: boolean;
  groupScoring: boolean;
  /** 需要病人床號（v1.15.0）：審查表單顯示床號欄位且列為必填 */
  requireBedNo: boolean;
  /** 需要受審人員資料（v1.17）：審查表單顯示「職編」欄位且列為必填 */
  requireReviewee: boolean;
}

function emptyForm(): IndicatorForm {
  const steps = emptyTenSteps();
  // 閾值與步驟四「指標」一一對應：無指標時無閾值列，新增指標時同步產生
  steps.step5.thresholds = [];
  return {
    groupId: "",
    code: "",
    name: "",
    basicThreshold: "",
    owners: [],
    status: "草稿",
    steps,
    questions: [],
    auditItems: [],
    questionGroups: [],
    useQuestionGroups: false,
    groupScoring: false,
    requireBedNo: true,
    requireReviewee: true,
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

/** 審核表編輯值（單筆表單＋批次新增共用，v1.18 抽取） */
export interface AuditFormValue {
  questions: AuditQuestion[];
  auditItems: string[];
  questionGroups: QuestionGroup[];
  useQuestionGroups: boolean;
  groupScoring: boolean;
  requireBedNo: boolean;
  requireReviewee: boolean;
}

export function emptyAuditFormValue(): AuditFormValue {
  return {
    questions: [],
    auditItems: [],
    questionGroups: [],
    useQuestionGroups: false,
    groupScoring: false,
    requireBedNo: true,
    requireReviewee: true,
  };
}

function OptionListEditor({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  function addValue() {
    const value = draft.trim();
    if (!value || values.includes(value)) return;
    onChange([...values, value]);
    setDraft("");
  }
  return (
    <div className="audit-option-editor">
      {values.length > 0 && (
        <div className="audit-option-chips">
          {values.map((value) => (
            <span className="chip" key={value}>
              {value}
              <button
                type="button"
                aria-label={`移除${label}：${value}`}
                onClick={() =>
                  onChange(values.filter((item) => item !== value))
                }
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="audit-option-add">
        <input
          className="text-input"
          value={draft}
          placeholder={placeholder}
          aria-label={`新增${label}`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addValue();
            }
          }}
        />
        <button
          type="button"
          className="button button-outline"
          onClick={addValue}
          disabled={!draft.trim() || values.includes(draft.trim())}
        >
          <Plus size={14} />
          新增
        </button>
      </div>
    </div>
  );
}

/** 負責人多選（職編／姓名搜尋；單筆表單＋批次新增共用，v1.18 抽取） */
function OwnerMultiSelect({
  staffMap,
  staffLoaded,
  owners,
  onChange,
}: {
  staffMap: Map<string, StaffOption>;
  staffLoaded: boolean;
  owners: string[];
  onChange: (owners: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const suggestions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || !staffLoaded) return [];
    return [...staffMap.values()]
      .filter(
        (s) =>
          !owners.includes(s.staffId) &&
          (s.staffId.toLowerCase().includes(q) ||
            s.name.toLowerCase().includes(q)),
      )
      .slice(0, 8);
  }, [search, owners, staffMap, staffLoaded]);

  function ownerLabel(staffId: string): string {
    const s = staffMap.get(staffId);
    return s && s.name !== staffId
      ? `${maskName(s.name)}（${staffId}）`
      : staffId;
  }

  return (
    <>
      {owners.length > 0 && (
        <div className="chip-row">
          {owners.map((id) => (
            <span className="chip" key={id}>
              {ownerLabel(id)}
              <button
                type="button"
                aria-label={`移除 ${ownerLabel(id)}`}
                onClick={() => onChange(owners.filter((x) => x !== id))}
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
          value={search}
          placeholder="輸入職編或姓名搜尋…"
          onChange={(e) => setSearch(e.target.value)}
        />
        {suggestions.length > 0 && (
          <ul className="suggest-list">
            {suggestions.map((s) => (
              <li key={s.staffId}>
                <button
                  type="button"
                  onClick={() => {
                    onChange([...owners, s.staffId]);
                    setSearch("");
                  }}
                >
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
    </>
  );
}

/**
 * 審核表編輯器（v1.18 自單筆表單抽取，單筆＋批次共用）：
 * 題目分組開關＋分組管理＋題目橫向表格＋需要病人床號／受審人員資料。
 */
function AuditFormEditor({
  value,
  onChange,
}: {
  value: AuditFormValue;
  onChange: (patch: Partial<AuditFormValue>) => void;
}) {
  function groupNameOf(groupId: string | null): string {
    if (!groupId) return "";
    return value.questionGroups.find((g) => g.id === groupId)?.name ?? "";
  }

  function addQuestion(groupId: string | null) {
    const q = emptyAuditQuestion(groupId, groupNameOf(groupId));
    onChange({ questions: [...value.questions, q] });
  }

  function updateQuestion(id: string, patch: Partial<AuditQuestion>) {
    onChange({
      questions: value.questions.map((q) =>
        q.id === id ? { ...q, ...patch } : q,
      ),
    });
  }

  function removeQuestion(id: string) {
    onChange({ questions: value.questions.filter((q) => q.id !== id) });
  }

  /** 題目在所屬區段（同分組或未分組）內上／下移 */
  function moveQuestion(id: string, dir: -1 | 1) {
    onChange({ questions: moveQuestionInList(value.questions, id, dir) });
  }

  /** 題目跨分組移動（下拉選擇目標，含「未分組」） */
  function moveQuestionToGroup(id: string, targetGroupId: string | null) {
    onChange({
      questions: moveQuestionToGroupInList(
        value.questions,
        value.questionGroups,
        id,
        targetGroupId,
      ),
    });
  }

  /**
   * 題目分組開關（v1.22）：關閉僅隱藏分組顯示，分組資訊（questionGroups
   * 與題目歸屬）完整保留，重開後恢復；不刪除任何資料。
   */
  function toggleQuestionGroups() {
    onChange({ useQuestionGroups: !value.useQuestionGroups });
  }

  /**
   * 新增分組（v1.22）：只新增一個新分組。未分組題目只是「無分組題目」的
   * 虛擬顯示區，不是真正的 QuestionGroup，此處不產生額外的未分組群組。
   */
  function addQuestionGroup() {
    onChange({
      questionGroups: [
        ...value.questionGroups,
        createQuestionGroup(value.questionGroups),
      ],
    });
  }

  function renameQuestionGroup(id: string, name: string) {
    onChange(
      renameQuestionGroupInList(
        value.questionGroups,
        value.questions,
        id,
        name,
      ),
    );
  }

  function moveQuestionGroup(id: string, dir: -1 | 1) {
    const gs = [...value.questionGroups].sort((a, b) => a.order - b.order);
    const idx = gs.findIndex((g) => g.id === id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= gs.length) return;
    [gs[idx], gs[j]] = [gs[j], gs[idx]];
    onChange({ questionGroups: gs.map((g, i) => ({ ...g, order: i })) });
  }

  /**
   * 刪除分組（v1.22）：其下題目移回「未分組」，題目本身不刪除。
   */
  function removeQuestionGroup(id: string) {
    const count = value.questions.filter((q) => q.groupId === id).length;
    if (
      !window.confirm(
        count > 0
          ? `刪除此分組後，其下 ${count} 個題目將移回「未分組」，確定嗎？`
          : "確定刪除此分組嗎？",
      )
    ) {
      return;
    }
    onChange(
      removeQuestionGroupFromList(value.questionGroups, value.questions, id),
    );
  }

  const sortedQuestionGroups = useMemo(
    () => [...value.questionGroups].sort((a, b) => a.order - b.order),
    [value.questionGroups],
  );

  /**
   * 審核表題目橫向表格：
   * 欄位＝分組（僅分組開關開時，用「移動到」下拉選分組）／題目／選項／審核指引／操作
   */
  function renderQuestionTable(qs: AuditQuestion[]) {
    return (
      <div className="table-scroll">
        <table className="permission-table">
          <thead>
            <tr>
              {value.useQuestionGroups && <th>分組</th>}
              <th>題目</th>
              <th>選項</th>
              <th>審核指引</th>
              <th>常見錯誤（可複選）</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {qs.map((q) => {
              const gid = q.groupId ?? null;
              const section = value.questions.filter(
                (x) => (x.groupId ?? null) === gid,
              );
              const pos = section.findIndex((x) => x.id === q.id);
              return (
                <tr key={q.id}>
                  {value.useQuestionGroups && (
                    <td>
                      <div className="select-wrap">
                        <select
                          value={q.groupId ?? ""}
                          aria-label="移動到分組"
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
                    </td>
                  )}
                  <td>
                    <input
                      className="text-input"
                      value={q.itemText}
                      placeholder="指標項目"
                      aria-label="題目"
                      onChange={(e) =>
                        updateQuestion(q.id, { itemText: e.target.value })
                      }
                    />
                  </td>
                  <td>
                    <div className="select-wrap">
                      <select
                        value={q.optionSet}
                        aria-label="選項"
                        onChange={(e) =>
                          updateQuestion(q.id, {
                            optionSet: e.target.value as OptionSet,
                          })
                        }
                      >
                        {(Object.keys(OPTION_SET_LABELS) as OptionSet[]).map(
                          (s) => (
                            <option key={s} value={s}>
                              {OPTION_SET_LABELS[s]}
                            </option>
                          ),
                        )}
                      </select>
                      <ChevronDown size={15} />
                    </div>
                  </td>
                  <td>
                    <input
                      className="text-input"
                      value={q.guidance}
                      placeholder="審核指引（審查員填寫時的判斷依據）"
                      aria-label="審核指引"
                      onChange={(e) =>
                        updateQuestion(q.id, { guidance: e.target.value })
                      }
                    />
                  </td>
                  <td>
                    <OptionListEditor
                      label="常見錯誤"
                      values={q.commonErrors ?? []}
                      placeholder="輸入後按 Enter"
                      onChange={(commonErrors) =>
                        updateQuestion(q.id, { commonErrors })
                      }
                    />
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
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
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <>
      <SectionTitle
        title="審核表題目"
        note="每題含指標項目、選項與審核指引（審查員填寫時的判斷依據）"
      />
      <button
        type="button"
        className={`mode-toggle${value.useQuestionGroups ? " on" : ""}`}
        onClick={toggleQuestionGroups}
        aria-pressed={value.useQuestionGroups}
      >
        <span>啟用題目分組</span>
        <span className="toggle-track" />
      </button>
      <p className="settings-note">
        開啟後可建立多個分組、一個分組下可建多個題目；關閉僅隱藏分組顯示，分組與題目歸屬保留，重新開啟後恢復。
      </p>
      <button
        type="button"
        className={`mode-toggle${value.groupScoring ? " on" : ""}`}
        onClick={() => onChange({ groupScoring: !value.groupScoring })}
        aria-pressed={value.groupScoring}
        disabled={!value.useQuestionGroups}
        title={!value.useQuestionGroups ? "請先啟用題目分組" : undefined}
      >
        <span>啟用分組計分</span>
        <span className="toggle-track" />
      </button>
      <p className="settings-note">
        開啟後審查結果將依各分組獨立計分；需先啟用題目分組。關閉時維持指標整體計分。
      </p>
      <label className="check-row" style={{ marginTop: 8 }}>
        <input
          type="checkbox"
          checked={value.requireBedNo}
          onChange={(e) => onChange({ requireBedNo: e.target.checked })}
        />
        <span>
          需要病人床號
          <span className="muted-text">
            （勾選後，審查表單會顯示「病人床號」欄位並列為必填）
          </span>
        </span>
      </label>
      <label className="check-row" style={{ marginTop: 8 }}>
        <input
          type="checkbox"
          checked={value.requireReviewee}
          onChange={(e) => onChange({ requireReviewee: e.target.checked })}
        />
        <span>
          需要受審人員資料
          <span className="muted-text">
            （勾選後，審查表單會顯示「職編」欄位並列為必填）
          </span>
        </span>
      </label>
      <div className="audit-items-setting">
        <label className="field-label">審核項目（單選）</label>
        <p className="settings-note">
          可設定多個審核項目；審查時選擇其中一項。
        </p>
        <OptionListEditor
          label="審核項目"
          values={value.auditItems}
          placeholder="輸入後按 Enter"
          onChange={(auditItems) => onChange({ auditItems })}
        />
      </div>
      {value.useQuestionGroups ? (
        <>
          <div className="group-actions">
            <button className="text-button" onClick={addQuestionGroup}>
              <Plus size={14} /> 新增分組
            </button>
          </div>
          {sortedQuestionGroups.map((g, gi) => {
            const qs = value.questions.filter((x) => x.groupId === g.id);
            return (
              <div className="question-group-block" key={g.id}>
                <div className="question-group-head">
                  <input
                    className="text-input"
                    value={g.name}
                    placeholder="分組名稱"
                    onChange={(e) => renameQuestionGroup(g.id, e.target.value)}
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
                    disabled={gi === sortedQuestionGroups.length - 1}
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
                {renderQuestionTable(qs)}
                <button
                  className="text-button"
                  onClick={() => addQuestion(g.id)}
                >
                  <Plus size={14} /> 在此分組新增題目
                </button>
              </div>
            );
          })}
          {/*
            未分組題目（v1.22）：只是「無分組題目」的虛擬顯示區，不是真正的
            QuestionGroup——僅在有未分組題目時渲染、與真分組區分樣式、不顯示
            刪除按鈕；「新增題目」移至表格下方。
          */}
          {value.questions.filter((x) => !x.groupId).length > 0 && (
            <div className="question-group-block ungrouped">
              <div className="question-group-head">
                <b>未分組題目</b>
                <span className="settings-note">（虛擬顯示區，非分組）</span>
                <span className="settings-note">
                  {value.questions.filter((x) => !x.groupId).length} 題
                </span>
              </div>
              {renderQuestionTable(value.questions.filter((x) => !x.groupId))}
              <button className="text-button" onClick={() => addQuestion(null)}>
                <Plus size={14} /> 新增題目
              </button>
            </div>
          )}
          {value.questions.filter((x) => !x.groupId).length === 0 && (
            <div className="group-actions">
              <button className="text-button" onClick={() => addQuestion(null)}>
                <Plus size={14} /> 新增未分組題目
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          {value.questions.length === 0 ? (
            <p className="settings-note">
              尚未建立題目（未建立審核表仍可進行審查，依規格書）。
            </p>
          ) : (
            renderQuestionTable(value.questions)
          )}
          <div className="group-actions">
            <button className="text-button" onClick={() => addQuestion(null)}>
              <Plus size={14} /> 新增題目
            </button>
          </div>
        </>
      )}
    </>
  );
}

export function IndicatorsPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  const { user } = useAuth();
  const [view, setView] = useState<
    { kind: "list" } | { kind: "create" } | { kind: "edit"; id: string }
  >({ kind: "list" });
  const [rows, setRows] = useState<IndicatorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchKw, setSearchKw] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [sortKey, setSortKey] = useState<IndicatorSortKey>("code");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [form, setForm] = useState<IndicatorForm>(emptyForm);
  const [formError, setFormError] = useState("");
  const [formTab, setFormTab] = useState<FormTab>("basic");
  const [saving, setSaving] = useState(false);
  const [hasReviewData, setHasReviewData] = useState(false);
  /**
   * 載入時是否已符合啟用條件（v1.22）：單筆儲存後若「新符合」啟用條件
   * 才提示是否啟用；新指標視為不符合。
   */
  const [wasEnableEligible, setWasEnableEligible] = useState(false);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
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
      const gsnap = await getCachedRefCollection("groups", () =>
        getDocsCacheFirst(collection(getFirebaseDb(), "groups")),
      );
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
      const usnap = await getCachedRefCollection("users", () =>
        getDocsFromServer(collection(getFirebaseDb(), "users")),
      );
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
      const snap = await getCachedRefCollection("indicators", () =>
        getDocsCacheFirst(collection(getFirebaseDb(), "indicators")),
      );
      const list: IndicatorRow[] = snap.docs.map((d) => {
        const data = d.data();
        const groupId = typeof data.groupId === "string" ? data.groupId : "";
        const code =
          parseIndicatorDocId(d.id)?.code ??
          (typeof data.code === "string" ? data.code : d.id);
        const name = typeof data.name === "string" ? data.name : "";
        const basicThreshold =
          typeof data.basicThreshold === "number"
            ? data.basicThreshold
            : null;
        const owners: string[] = Array.isArray(data.owners)
          ? data.owners.map(String)
          : [];
        return {
          id: d.id,
          code,
          name,
          groupId,
          owners,
          mainThreshold: primaryThreshold(data),
          basicThreshold,
          status: STATUSES.includes(data.status) ? data.status : "草稿",
          version: typeof data.version === "string" ? data.version : "v1.0",
          // v1.45.0：清單列 [啟用] 按鈕只在具備啟用條件時顯示；清單已讀回整份文件，不另讀取
          canEnable: meetsEnableConditions(
            {
              groupId,
              code,
              name,
              basicThreshold: basicThreshold ?? "",
              owners,
            },
            normalizeQuestions(data.questions).questions,
            false,
          ),
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

  /** 清單排序切換（沿用審查員頁籤 ▲▼ 模式） */
  function toggleSort(key: IndicatorSortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(1);
    }
  }

  /** 搜尋（編號＋名稱）＋排序後的清單列 */
  const visibleRows = useMemo(() => {
    const byGroup = groupFilter
      ? rows.filter((row) => row.groupId === groupFilter)
      : rows;
    const filtered = filterIndicators(byGroup, searchKw);
    const groupNameOf = (id: string) => groupMap.get(id) || "";
    return [...filtered].sort((a, b) =>
      compareIndicatorRows(a, b, sortKey, sortDir, groupNameOf),
    );
  }, [rows, searchKw, groupFilter, sortKey, sortDir, groupMap]);

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

  /** 清單負責人欄顯示：姓名（職編） */
  function ownerLabel(staffId: string): string {
    const s = staffMap.get(staffId);
    return s && s.name !== staffId
      ? `${maskName(s.name)}（${staffId}）`
      : staffId;
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

  /**
   * v1.45.0：該指標是否尚在排程中。
   * 新集合 indicatorSchedules（一列＝指標＋類別＋週期；排程頁的「刪除排程」即刪此文件）
   * 或舊集合 indicatorYearSchedules（審查總覽頁仍直接讀舊集合）任一有文件即視為排程中。
   * 查詢失敗回 false（視為未排程，不擋）。
   */
  async function checkScheduled(docId: string): Promise<boolean> {
    try {
      const db = getFirebaseDb();
      const snap = await getDocs(
        query(
          collection(db, "indicatorSchedules"),
          where("indicatorId", "==", docId),
          limit(1),
        ),
      );
      if (!snap.empty) return true;
      const legacy = await getDocs(
        query(
          collection(db, "indicatorYearSchedules"),
          where("indicatorId", "==", docId),
          limit(1),
        ),
      );
      return !legacy.empty;
    } catch {
      return false;
    }
  }

  async function openCreate() {
    setForm(emptyForm());
    setFormError("");
    setFormTab("basic");
    setHasReviewData(false);
    setWasEnableEligible(false);
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
        groupId: q.groupId && groupIds.has(q.groupId) ? q.groupId : null,
        groupName:
          q.groupId && groupIds.has(q.groupId)
            ? (mergedGroups.find((g) => g.id === q.groupId)?.name ?? "")
            : "",
      }));
      setForm({
        groupId,
        code: indicatorCodeOf(snap.id),
        name: typeof data.name === "string" ? data.name : "",
        basicThreshold:
          typeof data.basicThreshold === "number" ? data.basicThreshold : "",
        owners: Array.isArray(data.owners) ? data.owners.map(String) : [],
        status: STATUSES.includes(data.status) ? data.status : "草稿",
        steps,
        questions,
        auditItems: Array.isArray(data.auditItems)
          ? data.auditItems.map(String).filter(Boolean)
          : [],
        questionGroups: mergedGroups,
        useQuestionGroups,
        groupScoring: data.groupScoring === true,
        requireBedNo: data.requireBedNo === true,
        // v1.17：舊資料缺值視為 false（不主動回寫，下次存檔才寫入）
        requireReviewee: data.requireReviewee === true,
      });
      // v1.22：記下載入時是否已符合啟用條件，供儲存後「新符合」提示判定
      setWasEnableEligible(
        meetsEnableConditions(
          {
            groupId,
            code: indicatorCodeOf(snap.id),
            name: typeof data.name === "string" ? data.name : "",
            basicThreshold:
              typeof data.basicThreshold === "number"
                ? data.basicThreshold
                : "",
            owners: Array.isArray(data.owners) ? data.owners.map(String) : [],
          },
          questions,
          false,
        ),
      );
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
      setView({ kind: "edit", id: snap.id });
    } catch (error) {
      onAction(`讀取指標失敗：${toErrorMessage(error)}`);
    }
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
          thresholds: prev.steps.step5.thresholds.filter((_, i) => i !== index),
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

  /** 基本資料六欄是否皆有效（狀態「啟用」的前置條件之一） */
  function isBasicComplete(): boolean {
    return isBasicCompleteFor(
      {
        groupId: form.groupId,
        code: form.code,
        name: form.name,
        basicThreshold: form.basicThreshold,
        owners: form.owners,
      },
      view.kind === "create",
    );
  }

  /** 審核表是否至少一題（有題目文字；「啟用」的前置條件之二） */
  function hasAuditQuestion(): boolean {
    return hasAuditQuestionFor(form.questions);
  }

  /** 是否可切到「啟用」：基本資料六欄全填＋審核表至少一題 */
  function canEnable(): boolean {
    return isBasicComplete() && hasAuditQuestion();
  }

  /** 驗證表單：回傳錯誤訊息與錯誤欄位所在的頁籤（成功時訊息為空）。 */
  function validate(): { message: string; tab: FormTab | null } {
    if (!form.groupId) return { message: "請選擇分類組別", tab: "basic" };
    if (view.kind === "create" && !form.code.trim())
      return { message: "請填寫指標編號", tab: "basic" };
    if (!form.name.trim()) return { message: "請填寫指標名稱", tab: "basic" };
    const thErr = validateBasicThreshold(form.basicThreshold);
    if (thErr) return { message: thErr, tab: "basic" };
    if (form.owners.length === 0)
      return { message: "請選擇至少一位負責人", tab: "basic" };
    // 10 Steps：v1.17 起取消所有必填
    for (const [i, q] of form.questions.entries()) {
      const where =
        form.useQuestionGroups && q.groupName
          ? `第 ${i + 1} 題（${q.groupName}）`
          : `第 ${i + 1} 題`;
      if (!q.itemText.trim())
        return { message: `${where}尚未填寫指標項目`, tab: "audit" };
    }
    if (form.status === "啟用" && !canEnable())
      return {
        message: "啟用前需完成基本資料（六欄）與審核表（至少一題）",
        tab: "basic",
      };
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
      // 閾值與步驟四「指標」一一對應：名稱取自指標名稱
      //（v1.17 起 10 Steps 取消必填；非有限值正規化為 0，避免寫入 NaN）
      const thresholds = form.steps.step4.subIndicators.map((s, i) => {
        const v = form.steps.step5.thresholds[i]?.value;
        return {
          name: s.name.trim(),
          value: typeof v === "number" && Number.isFinite(v) ? v : 0,
        };
      });
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
      // v1.22：分組資訊一律保存（分組開關關閉僅隱藏顯示，不刪除資料）
      const questions = form.questions.map((q, i) => ({
        id: q.id,
        itemText: q.itemText.trim(),
        optionSet: q.optionSet,
        guidance: q.guidance.trim(),
        commonErrors: (q.commonErrors ?? [])
          .map((item) => item.trim())
          .filter(Boolean),
        groupId: q.groupId,
        groupName: q.groupName.trim(),
        order: i,
      }));
      const questionGroups = [...form.questionGroups]
        .sort((a, b) => a.order - b.order)
        .map((g, i) => ({
          id: g.id,
          name: g.name.trim() || `分組 ${i + 1}`,
          order: i,
        }));
      // v1.17：頂層 threshold 改寫基本資料閾值（必填，驗證已確保為數字）
      const basicThreshold =
        typeof form.basicThreshold === "number" ? form.basicThreshold : 0;
      const base = {
        name: form.name.trim(),
        groupId: form.groupId,
        owners: form.owners,
        threshold: basicThreshold,
        basicThreshold,
        status: form.status,
        tenSteps: steps,
        questions,
        auditItems: form.auditItems.map((item) => item.trim()).filter(Boolean),
        questionGroups,
        useQuestionGroups: form.useQuestionGroups,
        groupScoring: form.groupScoring,
        requireBedNo: form.requireBedNo,
        requireReviewee: form.requireReviewee,
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      };

      let savedDocId = "";
      if (view.kind === "create") {
        const code = form.code.trim();
        // v1.21：文件 ID＝`${groupId}__${code}`；code 另存欄位供顯示
        const docId = indicatorDocId(form.groupId, code);
        savedDocId = docId;
        const ref = doc(db, "indicators", docId);
        const exists = await getDoc(ref);
        if (exists.exists()) {
          setFormTab("basic");
          showFormError(`指標編號 ${code} 在此組別已存在`);
          setSaving(false);
          return;
        }
        await setDoc(ref, {
          ...base,
          code,
          version: "v1.0",
          hasReviewData: false,
          createdAt: serverTimestamp(),
          createdBy: user.staffId,
        });
        await setDoc(doc(db, "indicators", docId, "versions", "v1.0"), {
          version: "v1.0",
          status: form.status,
          threshold: basicThreshold,
          tenSteps: steps,
          questions,
          auditItems: form.auditItems
            .map((item) => item.trim())
            .filter(Boolean),
          questionGroups,
          useQuestionGroups: form.useQuestionGroups,
          groupScoring: form.groupScoring,
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
          targetId: docId,
          detail: form.name.trim(),
        });
      } else {
        const docId = view.kind === "edit" ? view.id : "";
        if (!docId) {
          showFormError("狀態異常，請重新開啟編輯");
          setSaving(false);
          return;
        }
        savedDocId = docId;
        if (hasReviewData) {
          const ok = window.confirm(
            "此指標已有審查資料（含草稿），依版本控管規則將以新版本儲存，原版本保留。確定繼續？",
          );
          if (!ok) {
            setSaving(false);
            return;
          }
          const current = rows.find((r) => r.id === docId);
          const newVersion = nextVersion(current?.version ?? "v1.0");
          await setDoc(doc(db, "indicators", docId, "versions", newVersion), {
            version: newVersion,
            status: form.status,
            threshold: basicThreshold,
            tenSteps: steps,
            questions,
            auditItems: form.auditItems
              .map((item) => item.trim())
              .filter(Boolean),
            effectiveDate: new Date().toISOString().slice(0, 10),
            note: "審查資料鎖定後修訂",
            createdAt: serverTimestamp(),
            createdBy: user.staffId,
          });
          await updateDoc(doc(db, "indicators", docId), {
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
            targetId: docId,
            detail: `新版本 ${newVersion}：${form.name.trim()}`,
          });
        } else {
          await updateDoc(doc(db, "indicators", docId), base);
          onAction("已儲存指標修改");
          logAudit(db, {
            actor: user.staffId,
            actorName: user.name,
            action: "編輯指標",
            targetType: "indicator",
            targetId: docId,
            detail: form.name.trim(),
          });
        }
      }
      // v1.22：儲存後自動提示啟用（僅單筆表單）——僅在「新符合」啟用條件
      // （儲存前不符合、儲存後符合）且狀態非「啟用」時提示一次；已符合者
      // 再次儲存不再提示。
      const nowEligible = canEnable();
      if (!wasEnableEligible && nowEligible && form.status !== "啟用") {
        const ok = window.confirm(
          "基本資料與審核表皆已完成，是否將此指標設為啟用？",
        );
        if (ok && savedDocId) {
          await updateDoc(doc(db, "indicators", savedDocId), {
            status: "啟用",
            updatedAt: serverTimestamp(),
            updatedBy: user.staffId,
          });
          logAudit(db, {
            actor: user.staffId,
            actorName: user.name,
            action: "啟用指標",
            targetType: "indicator",
            targetId: savedDocId,
            detail: form.name.trim(),
          });
          onAction(`已將指標 ${form.code.trim()} 設為啟用`);
        }
      }
      setWasEnableEligible(nowEligible);
      setView({ kind: "list" });
      await loadList();
    } catch (error) {
      showFormError(`儲存失敗：${toErrorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  /** v1.45.0：清單列 [啟用]。點擊時重驗啟用條件（防資料已變），符合才寫入。 */
  async function handleEnable(docId: string) {
    if (!user) return;
    try {
      const snap = await getDoc(doc(getFirebaseDb(), "indicators", docId));
      if (!snap.exists()) {
        onAction("找不到該指標");
        return;
      }
      const data = snap.data();
      const eligible = meetsEnableConditions(
        {
          groupId: typeof data.groupId === "string" ? data.groupId : "",
          code: indicatorCodeOf(snap.id),
          name: typeof data.name === "string" ? data.name : "",
          basicThreshold:
            typeof data.basicThreshold === "number"
              ? data.basicThreshold
              : "",
          owners: Array.isArray(data.owners) ? data.owners.map(String) : [],
        },
        normalizeQuestions(data.questions).questions,
        false,
      );
      if (!eligible) {
        onAction("此指標尚未完成基本資料與審核表，無法啟用");
        return;
      }
      await updateDoc(doc(getFirebaseDb(), "indicators", docId), {
        status: "啟用",
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      });
      onAction(`指標 ${indicatorCodeOf(docId)} 已啟用`);
      logAudit(getFirebaseDb(), {
        actor: user.staffId,
        actorName: user.name,
        action: "啟用指標",
        targetType: "indicator",
        targetId: docId,
      });
      await loadList();
    } catch (error) {
      onAction(`啟用失敗：${toErrorMessage(error)}`);
    }
  }

  async function handleDeactivate(docId: string) {
    if (!user) return;
    // v1.45.0：停用不再被審查資料擋（有資料但未列排程者可停用）；改擋「排程中」
    const scheduled = await checkScheduled(docId);
    if (scheduled) {
      onAction("此指標尚在排程中，請先停止排程才能停用");
      return;
    }
    const code = indicatorCodeOf(docId);
    const ok = window.confirm(
      `確定將指標 ${code} 設為停用？（僅標記停用，不會刪除資料）`,
    );
    if (!ok) return;
    try {
      await updateDoc(doc(getFirebaseDb(), "indicators", docId), {
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
        targetId: docId,
      });
      await loadList();
    } catch (error) {
      onAction(`停用失敗：${toErrorMessage(error)}`);
    }
  }

  /** v1.45.0：清單列 [刪除]。已有已審紀錄（reviewRecords）者擋下；無紀錄者確認後刪主檔＋版本子集合。 */
  async function handleDelete(docId: string) {
    if (!user) return;
    const code = indicatorCodeOf(docId);
    const hasData = await checkReviewData(docId);
    if (hasData) {
      onAction("此指標已有審查資料，無法刪除");
      return;
    }
    const ok = window.confirm(
      `確定刪除指標 ${code}？（將一併刪除版本紀錄，此操作無法復原）`,
    );
    if (!ok) return;
    try {
      const db = getFirebaseDb();
      // Firestore 無級聯刪除：先刪 versions 子集合各文件，再刪主檔
      const vsnap = await getDocs(
        collection(db, "indicators", docId, "versions"),
      );
      for (const v of vsnap.docs) {
        await deleteDoc(doc(db, "indicators", docId, "versions", v.id));
      }
      await deleteDoc(doc(db, "indicators", docId));
      logAudit(db, {
        actor: user.staffId,
        actorName: user.name,
        action: "刪除指標",
        targetType: "indicator",
        targetId: docId,
        detail: code,
      });
      onAction(`指標 ${code} 已刪除`);
      await loadList();
    } catch (error) {
      onAction(`刪除失敗：${toErrorMessage(error)}`);
    }
  }

  const isEditing = view.kind === "edit";

  return (
    <>
      <PageHeading
        page="indicators"
        action={
          view.kind !== "list" ? (
            <button
              className="button button-outline"
              onClick={() => setView({ kind: "list" })}
            >
              <X size={15} />
              返回清單
            </button>
          ) : undefined
        }
      />

      {view.kind === "list" && (
        <div className="indicator-filter-row" role="search">
          <div className="select-wrap indicator-filter-group">
            <select
              value={groupFilter}
              aria-label="依組別篩選"
              onChange={(e) => setGroupFilter(e.target.value)}
            >
              <option value="">全部組別</option>
              {[...groupMap.entries()]
                .sort((a, b) => a[1].localeCompare(b[1], "zh-Hant"))
                .map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
            </select>
            <ChevronDown size={15} />
          </div>
          <input
            className="text-input indicator-filter-search"
            placeholder="搜尋編號／指標名稱"
            aria-label="依編號或指標名稱篩選"
            value={searchKw}
            onChange={(e) => setSearchKw(e.target.value)}
          />
          <div className="indicator-filter-actions">
            <button className="button button-primary" onClick={openCreate}>
              <Plus size={16} />
              新增指標
            </button>
            <button
              className="button button-outline"
              onClick={() => setBatchOpen(true)}
            >
              <Plus size={16} />
              批次新增
            </button>
          </div>
        </div>
      )}

      {view.kind === "list" ? (
        loading ? (
          <section className="panel">
            <p className="settings-note">讀取中…</p>
          </section>
        ) : rows.length === 0 ? (
          <EmptyState
            title="尚無指標"
            description="使用上方工具列的「新增指標」建立第一支指標，分類組別、編號、名稱、負責人與閾值為必填。"
          />
        ) : (
          <section className="panel data-panel">
            <div className="table-scroll">
              <table className="permission-table">
                <thead>
                  <tr>
                    <th>
                      <button
                        type="button"
                        className="th-sort"
                        onClick={() => toggleSort("code")}
                        title="依編號排序"
                      >
                        編號
                        {sortKey === "code" && (sortDir === 1 ? " ▲" : " ▼")}
                      </button>
                    </th>
                    <th>
                      <button
                        type="button"
                        className="th-sort"
                        onClick={() => toggleSort("name")}
                        title="依名稱排序"
                      >
                        指標名稱
                        {sortKey === "name" && (sortDir === 1 ? " ▲" : " ▼")}
                      </button>
                    </th>
                    <th>
                      <button
                        type="button"
                        className="th-sort"
                        onClick={() => toggleSort("group")}
                        title="依組別排序"
                      >
                        組別
                        {sortKey === "group" && (sortDir === 1 ? " ▲" : " ▼")}
                      </button>
                    </th>
                    <th>負責人</th>
                    <th>
                      <button
                        type="button"
                        className="th-sort"
                        onClick={() => toggleSort("threshold")}
                        title="依閾值排序"
                      >
                        閾值
                        {sortKey === "threshold" &&
                          (sortDir === 1 ? " ▲" : " ▼")}
                      </button>
                    </th>
                    <th>
                      <button
                        type="button"
                        className="th-sort"
                        onClick={() => toggleSort("status")}
                        title="依狀態排序"
                      >
                        狀態
                        {sortKey === "status" && (sortDir === 1 ? " ▲" : " ▼")}
                      </button>
                    </th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="muted-text">
                        沒有符合篩選條件的指標
                      </td>
                    </tr>
                  ) : (
                    visibleRows.map((row) => (
                      <tr key={row.id}>
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
                        <td>
                          {displayThreshold(
                            row.basicThreshold,
                            row.mainThreshold,
                          )}
                          %
                        </td>
                        <td>
                          <span
                            className={`status-pill ${STATUS_PILL[row.status]}`}
                          >
                            {row.status}
                          </span>
                        </td>
                        <td>
                          <button
                            className="text-button"
                            onClick={() => openEdit(row.id)}
                          >
                            <Pencil size={13} /> 編輯
                          </button>{" "}
                          {/* v1.45.0：操作列按狀態只顯示適用按鈕。
                              草稿／送審／核准／退回／停用：[啟用]（僅具備啟用條件時）＋[刪除]；
                              啟用：[停用]；啟用中不顯示 [啟用] 與 [刪除]（須先停用才能刪）。 */}
                          {row.status !== "啟用" && row.canEnable && (
                            <button
                              className="text-button"
                              onClick={() => handleEnable(row.id)}
                            >
                              <Check size={13} /> 啟用
                            </button>
                          )}{" "}
                          {row.status === "啟用" && (
                            <button
                              className="text-button"
                              onClick={() => handleDeactivate(row.id)}
                            >
                              <Ban size={13} /> 停用
                            </button>
                          )}{" "}
                          {row.status !== "啟用" && (
                            <button
                              className="text-button"
                              onClick={() => handleDelete(row.id)}
                            >
                              <Trash2 size={13} /> 刪除
                            </button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
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
            <div
              className="login-error"
              ref={formErrorRef}
              aria-live="assertive"
            >
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
              <SectionTitle title="基本資料" note="六欄皆為必填" />
              <div className="form-stack">
                <div className="form-field">
                  <label className="field-label">組別 *</label>
                  <div className="select-wrap">
                    <select
                      value={form.groupId}
                      disabled={isEditing}
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
                  <label className="field-label">閾值（%） *</label>
                  <input
                    className="text-input"
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    placeholder="1～100 的正整數"
                    value={
                      typeof form.basicThreshold === "number" &&
                      Number.isFinite(form.basicThreshold)
                        ? String(form.basicThreshold)
                        : ""
                    }
                    onChange={(e) =>
                      setField(
                        "basicThreshold",
                        e.target.value === "" ? "" : Number(e.target.value),
                      )
                    }
                  />
                </div>
                <div className="form-field">
                  <label className="field-label">
                    負責人 *（輸入職編或姓名搜尋，可多選）
                  </label>
                  <OwnerMultiSelect
                    staffMap={staffMap}
                    staffLoaded={staffLoaded}
                    owners={form.owners}
                    onChange={(owners) => setField("owners", owners)}
                  />
                </div>
                <div className="form-field">
                  <label className="field-label">狀態 *</label>
                  <div className="select-wrap">
                    <select
                      value={form.status}
                      onChange={(e) =>
                        setField("status", e.target.value as IndicatorStatus)
                      }
                    >
                      {STATUSES.map((s) => (
                        <option
                          key={s}
                          value={s}
                          disabled={s === "啟用" && !canEnable()}
                        >
                          {s}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={15} />
                  </div>
                  {!canEnable() && (
                    <p className="settings-note">
                      需完成基本資料（六欄）與審核表（至少一題）才能啟用。
                    </p>
                  )}
                </div>
              </div>
            </>
          )}

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
                          step6: {
                            ...prev.steps.step6,
                            caseCount: e.target.value,
                          },
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
                          step6: {
                            ...prev.steps.step6,
                            auditors: e.target.value,
                          },
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
                          step6: {
                            ...prev.steps.step6,
                            auditDate: e.target.value,
                          },
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
                          step6: {
                            ...prev.steps.step6,
                            auditMethod: e.target.value,
                          },
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
            </>
          )}

          {formTab === "audit" && (
            <>
              <AuditFormEditor
                value={{
                  questions: form.questions,
                  auditItems: form.auditItems,
                  questionGroups: form.questionGroups,
                  useQuestionGroups: form.useQuestionGroups,
                  groupScoring: form.groupScoring,
                  requireBedNo: form.requireBedNo,
                  requireReviewee: form.requireReviewee,
                }}
                onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
              />

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

      {batchOpen && (
        <BatchAddDialog
          groupMap={groupMap}
          staffMap={staffMap}
          staffLoaded={staffLoaded}
          existingCodes={new Set(
            rows
              .filter((row) => row.groupId && row.code.trim())
              .map((row) => indicatorDocId(row.groupId, row.code.trim())),
          )}
          existingIndicatorIds={new Map(
            rows
              .filter((row) => row.groupId && row.code.trim())
              .map((row) => [
                indicatorDocId(row.groupId, row.code.trim()),
                row.id,
              ]),
          )}
          user={user ? { staffId: user.staffId, name: user.name } : null}
          onAction={onAction}
          onClose={() => setBatchOpen(false)}
          onDone={() => {
            setBatchOpen(false);
            loadList();
          }}
        />
      )}
    </>
  );
}

/* ================= 批次新增指標（v1.18） ================= */

interface BatchRow {
  key: string;
  groupId: string;
  code: string;
  name: string;
  /** 閾值（必填、>0 正整數、≤100；""＝未填） */
  threshold: number | "";
  owners: string[];
  audit: AuditFormValue;
  showAudit: boolean;
  errors: Record<string, string>;
}

function emptyBatchRow(): BatchRow {
  return {
    key: newQid(),
    groupId: "",
    code: "",
    name: "",
    threshold: "",
    owners: [],
    audit: emptyAuditFormValue(),
    showAudit: false,
    errors: {},
  };
}

function batchRowHasContent(row: BatchRow): boolean {
  return Boolean(
    row.groupId ||
      row.code.trim() ||
      row.name.trim() ||
      row.threshold !== "" ||
      row.owners.length > 0 ||
      row.audit.questions.length > 0,
  );
}

interface ExistingAuditImport {
  indicatorId: string;
  groupId: string;
  groupName: string;
  code: string;
  name: string;
  originalAudit: AuditFormValue;
  originalSignature: string;
  importedAudit: AuditFormValue;
}

interface PreparedExistingAuditImport extends ExistingAuditImport {
  currentAudit: AuditFormValue;
  latestData: Record<string, unknown>;
  hasReviewData: boolean;
}

interface BatchSavePlan {
  newRows: BatchRow[];
  existing: PreparedExistingAuditImport[];
}

function auditFormFromIndicatorData(
  data: Record<string, unknown>,
): AuditFormValue {
  const normalized = normalizeQuestions(data.questions);
  const questionGroups = mergeQuestionGroups(
    data.questionGroups,
    normalized.groups,
  );
  const groupIds = new Set(questionGroups.map((group) => group.id));
  const questions = normalized.questions.map((question) => {
    const validGroup = question.groupId && groupIds.has(question.groupId);
    return {
      ...question,
      groupId: validGroup ? question.groupId : null,
      groupName: validGroup
        ? (questionGroups.find((group) => group.id === question.groupId)
            ?.name ?? "")
        : "",
    };
  });
  return {
    questions,
    auditItems: Array.isArray(data.auditItems)
      ? data.auditItems.map(String).filter(Boolean)
      : [],
    questionGroups,
    useQuestionGroups:
      typeof data.useQuestionGroups === "boolean"
        ? data.useQuestionGroups
        : normalized.useGroups,
    groupScoring: data.groupScoring === true,
    requireBedNo: data.requireBedNo === true,
    requireReviewee: data.requireReviewee === true,
  };
}

function auditFormSignature(form: AuditFormValue): string {
  return JSON.stringify({
    questionGroups: form.questionGroups
      .map(({ id, name, order }) => ({ id, name, order }))
      .sort((a, b) => a.order - b.order),
    questions: form.questions
      .map((question) => ({
        id: question.id,
        itemText: question.itemText,
        optionSet: question.optionSet,
        guidance: question.guidance,
        commonErrors: question.commonErrors ?? [],
        groupId: question.groupId,
        groupName: question.groupName,
        order: question.order,
      }))
      .sort((a, b) => a.order - b.order),
    useQuestionGroups: form.useQuestionGroups,
  });
}

function importedAuditPart(form: AuditFormValue): ImportedAuditForm {
  return {
    questions: form.questions,
    questionGroups: form.questionGroups,
    useQuestionGroups: form.useQuestionGroups,
    groupScoring: form.groupScoring,
  };
}

function BatchAddDialog({
  groupMap,
  staffMap,
  staffLoaded,
  existingCodes,
  existingIndicatorIds,
  user,
  onAction,
  onClose,
  onDone,
}: {
  groupMap: Map<string, string>;
  staffMap: Map<string, StaffOption>;
  staffLoaded: boolean;
  existingCodes: Set<string>;
  existingIndicatorIds: Map<string, string>;
  user: { staffId: string; name: string } | null;
  onAction: (m: string) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const [rows, setRows] = useState<BatchRow[]>(() => [emptyBatchRow()]);
  const [saving, setSaving] = useState(false);
  const [existingAuditImports, setExistingAuditImports] = useState<
    ExistingAuditImport[]
  >([]);
  const [saveChoice, setSaveChoice] = useState<BatchSavePlan | null>(null);

  // v1.20：匯入（基本資料／審核表，Excel／CSV）＋範本下載
  const [importSummary, setImportSummary] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  // v1.28 階段 5（A2）：xlsx 動態載入，首次讀 .xlsx 檔要多等一次 chunk 下載，顯示讀取中
  const [importing, setImporting] = useState(false);
  const basicFileRef = useRef<HTMLInputElement>(null);
  const auditFileRef = useRef<HTMLInputElement>(null);

  /** 組別名稱（或代號）→組別 id（匯入驗證用） */
  const groupByName = useMemo(() => {
    const m = new Map<string, string>();
    groupMap.forEach((name, id) => {
      if (!m.has(name)) m.set(name, id);
      if (!m.has(id)) m.set(id, id);
    });
    return m;
  }, [groupMap]);

  async function handleImportBasic(file: File) {
    setImportSummary(null);
    setImportErrors([]);
    setImporting(true);
    try {
      const sheet = await readSheetFile(file);
      const { headerErrors, data } = parseBasicSheet(sheet);
      if (headerErrors.length > 0) {
        setImportErrors(headerErrors);
        onAction("基本資料匯入失敗：標題列不符，請下載範本對照");
        return;
      }
      if (data.length === 0) {
        setImportErrors(["檔案內無資料列"]);
        return;
      }
      const codeSet = new Set<string>([...existingCodes]);
      rows.forEach((r) => {
        const c = r.code.trim();
        if (c && r.groupId) codeSet.add(indicatorDocId(r.groupId, c));
      });
      const results = validateBasicRows(data, {
        groupByName,
        existingCodes: codeSet,
        staffHas: (id) => staffMap.has(id),
        staffLoaded,
      });
      const ok = results.filter((r) => r.ok && r.values);
      const bad = results.filter((r) => !r.ok);
      if (ok.length > 0) {
        setRows((prev) => [
          ...prev,
          ...ok.map((r) => {
            const v = r.values!;
            const row = emptyBatchRow();
            row.groupId = v.groupId;
            row.code = v.code;
            row.name = v.name;
            row.threshold = v.threshold;
            row.owners = v.owners;
            return row;
          }),
        ]);
      }
      setImportErrors(
        bad.map((r) => `第 ${r.lineNo} 列：${r.errors.join("；")}`),
      );
      const msg = `基本資料匯入：成功 ${ok.length} 列、失敗 ${bad.length} 列`;
      setImportSummary(msg);
      onAction(msg);
    } catch (error) {
      setImportErrors([`讀取檔案失敗：${toErrorMessage(error)}`]);
    } finally {
      setImporting(false);
    }
  }

  async function handleImportAudit(file: File) {
    setImportSummary(null);
    setImportErrors([]);
    setImporting(true);
    setSaveChoice(null);
    try {
      const sheet = await readSheetFile(file);
      const { headerErrors, data } = parseAuditSheet(sheet);
      if (headerErrors.length > 0) {
        setImportErrors(headerErrors);
        onAction("審核表匯入失敗：標題列不符，請下載範本對照");
        return;
      }
      if (data.length === 0) {
        setImportErrors(["檔案內無資料列"]);
        return;
      }

      const groupOptions = [...groupMap.entries()].map(([id, name]) => ({
        id,
        name,
      }));
      const resolutionByLine = new Map<
        number,
        ReturnType<typeof resolveAuditImportGroup>
      >();
      const normalizedData = data.map((row) => {
        const resolution = resolveAuditImportGroup(
          row.indicatorGroup,
          groupOptions,
        );
        resolutionByLine.set(row.lineNo, resolution);
        return {
          ...row,
          indicatorGroup: resolution.ok
            ? resolution.groupName
            : row.indicatorGroup.trim(),
        };
      });

      const pairByKey = new Map<
        string,
        { groupId: string; groupName: string; code: string }
      >();
      for (const row of data) {
        const resolution = resolutionByLine.get(row.lineNo);
        const code = row.code.trim();
        if (!resolution?.ok || !code) continue;
        const key = indicatorDocId(resolution.groupId, code);
        pairByKey.set(key, {
          groupId: resolution.groupId,
          groupName: resolution.groupName,
          code,
        });
      }

      // 以複合文件 ID 精確讀取既有指標；組別名稱／編號不會跨組誤配。
      const db = getFirebaseDb();
      const existingByKey = new Map<string, ExistingAuditImport>();
      for (const [key, pair] of pairByKey) {
        const existingId =
          existingIndicatorIds.get(key) ?? indicatorDocId(pair.groupId, pair.code);
        const snap = await getDoc(
          doc(db, "indicators", existingId),
        );
        if (!snap.exists()) {
          if (existingIndicatorIds.has(key))
            throw new Error(
              `既有指標 ${pair.groupName}／${pair.code} 已不存在，請重新整理指標清單`,
            );
          continue;
        }
        const raw = snap.data() as Record<string, unknown>;
        const parsedId = parseIndicatorDocId(snap.id);
        if (
          (typeof raw.groupId === "string" && raw.groupId !== pair.groupId) ||
          (typeof raw.code === "string" && raw.code.trim() !== pair.code) ||
          (parsedId &&
            (parsedId.groupId !== pair.groupId || parsedId.code !== pair.code))
        ) {
          throw new Error(
            `既有指標 ${pair.groupName}／${pair.code} 的文件資料不一致，請先檢查指標主檔`,
          );
        }
        const originalAudit = auditFormFromIndicatorData(raw);
        existingByKey.set(key, {
          indicatorId: snap.id,
          groupId: pair.groupId,
          groupName: pair.groupName,
          code: pair.code,
          name: typeof raw.name === "string" ? raw.name : pair.code,
          originalAudit,
          originalSignature: auditFormSignature(originalAudit),
          importedAudit: emptyAuditFormValue(),
        });
      }

      // 驗證範圍包含本次批次新增列和已存在的精確目標。
      const batchByCode = new Map<string, string[]>();
      const addBatchTarget = (code: string, groupId: string) => {
        const trimmedCode = code.trim();
        const groupName = groupMap.get(groupId) || "";
        if (!trimmedCode || !groupName) return;
        const list = batchByCode.get(trimmedCode) ?? [];
        if (!list.includes(groupName)) list.push(groupName);
        batchByCode.set(trimmedCode, list);
      };
      rows.forEach((row) => addBatchTarget(row.code, row.groupId));
      for (const target of existingByKey.values())
        addBatchTarget(target.code, target.groupId);

      const validation = validateAuditRows(normalizedData, { batchByCode });
      const results = validation.map((result) => {
        const resolution = resolutionByLine.get(result.lineNo);
        if (!resolution || resolution.ok) return result;
        const reason =
          resolution.reason === "missing"
            ? "組別未填"
            : resolution.reason === "ambiguous"
              ? `組別「${data.find((row) => row.lineNo === result.lineNo)?.indicatorGroup.trim() || ""}」不唯一，請填組別 ID`
              : `找不到組別「${data.find((row) => row.lineNo === result.lineNo)?.indicatorGroup.trim() || ""}」`;
        return {
          ...result,
          ok: false,
          errors: [...new Set([...result.errors, reason])],
          values: null,
        };
      });
      const ok = results.filter((r) => r.ok && r.values);
      const bad = results.filter((r) => !r.ok);

      const importedByKey = new Map<string, AuditFormValue>();
      const addImportedQuestion = (
        audit: AuditFormValue,
        value: NonNullable<(typeof ok)[number]["values"]>,
      ) => {
        let groupId: string | null = null;
        let groupName = "";
        if (value.groupName) {
          const existingGroup = audit.questionGroups.find(
            (group) => group.name.trim() === value.groupName,
          );
          if (existingGroup) {
            groupId = existingGroup.id;
            groupName = existingGroup.name;
          } else {
            const group = {
              id: newQid(),
              name: value.groupName,
              order: audit.questionGroups.length,
            };
            audit.questionGroups = [...audit.questionGroups, group];
            groupId = group.id;
            groupName = group.name;
          }
          audit.useQuestionGroups = true;
        }
        const question = emptyAuditQuestion(groupId, groupName);
        question.itemText = value.itemText;
        question.optionSet = value.optionSet;
        question.guidance = value.guidance;
        question.order = audit.questions.length;
        audit.questions = [...audit.questions, question];
      };

      for (const result of ok) {
        const value = result.values!;
        const resolution = resolutionByLine.get(result.lineNo);
        if (!resolution?.ok) continue;
        const key = indicatorDocId(resolution.groupId, value.code);
        const imported = importedByKey.get(key) ?? emptyAuditFormValue();
        addImportedQuestion(imported, value);
        importedByKey.set(key, imported);
      }

      if (ok.length > 0) {
        setRows((prev) => {
          const next = prev.map((r) => ({
            ...r,
            audit: {
              ...r.audit,
              questions: [...r.audit.questions],
              questionGroups: [...r.audit.questionGroups],
            },
          }));
          for (const [key, imported] of importedByKey) {
            if (existingByKey.has(key)) continue;
            const target = pairByKey.get(key);
            if (!target) continue;
            const idx = next.findIndex(
              (row) =>
                row.code.trim() === target.code &&
                row.groupId === target.groupId,
            );
            if (idx < 0) continue;
            const row = next[idx];
            const merged = mergeImportedAuditForm(
              importedAuditPart(row.audit),
              importedAuditPart(imported),
              "append",
            );
            next[idx] = {
              ...row,
              audit: { ...row.audit, ...merged },
              showAudit: true,
            };
          }
          return next;
        });
      }

      const existingImports = [...importedByKey.entries()]
        .filter(([key]) => existingByKey.has(key))
        .map(([key, imported]) => ({
          ...existingByKey.get(key)!,
          importedAudit: imported,
        }));
      if (existingImports.length > 0) {
        setExistingAuditImports((previous) => {
          const byId = new Map(
            previous.map((target) => [target.indicatorId, target]),
          );
          for (const target of existingImports) {
            const old = byId.get(target.indicatorId);
            if (!old) {
              byId.set(target.indicatorId, target);
              continue;
            }
            const merged = mergeImportedAuditForm(
              importedAuditPart(old.importedAudit),
              importedAuditPart(target.importedAudit),
              "append",
            );
            byId.set(target.indicatorId, {
              ...old,
              importedAudit: { ...old.importedAudit, ...merged },
            });
          }
          return [...byId.values()];
        });
      }

      setImportErrors(
        bad.map((r) => `第 ${r.lineNo} 列：${r.errors.join("；")}`),
      );
      const msg = `審核表匯入：成功 ${ok.length} 題、比對既有指標 ${existingImports.length} 支、失敗 ${bad.length} 列`;
      setImportSummary(msg);
      onAction(msg);
    } catch (error) {
      setImportErrors([`讀取檔案失敗：${toErrorMessage(error)}`]);
    } finally {
      setImporting(false);
    }
  }

  function updateRow(
    key: string,
    patch: Partial<BatchRow>,
    clearErrKeys: string[] = [],
  ) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const errors = { ...r.errors };
        for (const k of clearErrKeys) delete errors[k];
        return { ...r, ...patch, errors };
      }),
    );
  }

  function removeRow(key: string) {
    setRows((prev) =>
      prev.length <= 1 ? prev : prev.filter((r) => r.key !== key),
    );
  }

  function validateRow(
    r: BatchRow,
    codeCounts: Map<string, number>,
  ): Record<string, string> {
    const errs: Record<string, string> = {};
    if (!r.groupId) errs.groupId = "請選擇組別";
    const code = r.code.trim();
    // v1.21：編號唯一以 (groupId, code) 計；不同組別同編號不報錯
    const dupKey = r.groupId ? indicatorDocId(r.groupId, code) : code;
    if (!code) errs.code = "請填寫編號";
    else if ((codeCounts.get(dupKey) ?? 0) > 1) errs.code = "批次內編號重複";
    else if (existingCodes.has(dupKey)) errs.code = "編號已存在";
    if (!r.name.trim()) errs.name = "請填寫指標名稱";
    const thErr = validateBasicThreshold(r.threshold);
    if (thErr) errs.threshold = thErr;
    if (r.owners.length === 0) errs.owners = "請選擇至少一位負責人";
    r.audit.questions.forEach((q, i) => {
      if (!q.itemText.trim())
        errs[`q_${q.id}`] = `第 ${i + 1} 題尚未填寫指標項目`;
    });
    return errs;
  }

  async function handleSave() {
    if (!user) {
      onAction("請先登入");
      return;
    }
    const activeRows = rows.filter(batchRowHasContent);
    if (activeRows.length === 0 && existingAuditImports.length === 0) {
      onAction("請先新增指標或匯入審核表");
      return;
    }
    const codeCounts = new Map<string, number>();
    for (const r of activeRows) {
      const c = r.code.trim();
      if (!c) continue;
      const k = r.groupId ? indicatorDocId(r.groupId, c) : c;
      codeCounts.set(k, (codeCounts.get(k) ?? 0) + 1);
    }
    let hasError = false;
    const checked = activeRows.map((r) => {
      const errors = validateRow(r, codeCounts);
      if (Object.keys(errors).length > 0) {
        hasError = true;
        const qErr = Object.keys(errors).some((k) => k.startsWith("q_"));
        return { ...r, errors, showAudit: r.showAudit || qErr };
      }
      return { ...r, errors };
    });
    const checkedByKey = new Map(checked.map((row) => [row.key, row]));
    setRows((previous) =>
      previous.map((row) => checkedByKey.get(row.key) ?? row),
    );
    if (hasError) {
      onAction("批次資料有誤（紅字標示），請修正後再儲存");
      return;
    }
    setSaving(true);
    try {
      const preparedExisting = await prepareExistingAuditImports();
      const plan: BatchSavePlan = {
        newRows: checked,
        existing: preparedExisting,
      };
      const requiresDecision = preparedExisting.some(
        (target) =>
          target.currentAudit.questions.length > 0 || target.hasReviewData,
      );
      if (requiresDecision) {
        setSaveChoice(plan);
        return;
      }
      await commitBatchSave(plan, "replace");
    } catch (error) {
      onAction(
        `批次新增失敗：${error instanceof Error ? error.message : "讀寫失敗"}`,
      );
    } finally {
      setSaving(false);
    }
  }

  async function prepareExistingAuditImports(): Promise<
    PreparedExistingAuditImport[]
  > {
    const db = getFirebaseDb();
    return Promise.all(
      existingAuditImports.map(async (target) => {
        const snapshot = await getDoc(doc(db, "indicators", target.indicatorId));
        if (!snapshot.exists())
          throw new Error(
            `找不到既有指標 ${target.groupName}／${target.code}，請重新匯入審核表`,
          );
        const latestData = snapshot.data() as Record<string, unknown>;
        const parsedId = parseIndicatorDocId(snapshot.id);
        const latestGroupId =
          typeof latestData.groupId === "string"
            ? latestData.groupId
            : (parsedId?.groupId ?? target.groupId);
        const latestCode =
          typeof latestData.code === "string"
            ? latestData.code.trim()
            : (parsedId?.code ?? target.code);
        if (latestGroupId !== target.groupId || latestCode !== target.code)
          throw new Error(
            `既有指標 ${target.groupName}／${target.code} 的組別或編號已變更，請重新匯入`,
          );

        const currentAudit = auditFormFromIndicatorData(latestData);
        if (auditFormSignature(currentAudit) !== target.originalSignature)
          throw new Error(
            `指標 ${target.groupName}／${target.code} 的審核表在預覽後已變更，請重新匯入以免覆蓋他人修改`,
          );

        // 查詢失敗時中止，不把未知狀態誤當成沒有歷史審查。
        const reviewSnapshot = await getDocs(
          query(
            collection(db, "reviewRecords"),
            where("indicatorId", "==", target.indicatorId),
            limit(1),
          ),
        );
        return {
          ...target,
          currentAudit,
          latestData,
          hasReviewData:
            latestData.hasReviewData === true || !reviewSnapshot.empty,
        };
      }),
    );
  }

  async function commitBatchSave(
    plan: BatchSavePlan,
    mode: "replace" | "append",
  ) {
    if (!user) throw new Error("請先登入");
    const db = getFirebaseDb();
    const totalTargets = plan.newRows.length + plan.existing.length;
    if (totalTargets === 0) throw new Error("沒有可儲存的指標或審核表");
    // 每個目標最多三次寫入（主檔、版本、稽核），低於 Firestore 的 500 次限制。
    if (totalTargets > 150)
      throw new Error("單次最多儲存 150 支指標，請分批匯入");

    // 使用者選擇取代/追加後再次檢查，避免預覽期間他人修改遭覆蓋。
    const refreshed = await prepareExistingAuditImports();
    const refreshedById = new Map(
      refreshed.map((target) => [target.indicatorId, target]),
    );
    for (const target of plan.existing) {
      const latest = refreshedById.get(target.indicatorId);
      if (!latest || latest.hasReviewData !== target.hasReviewData)
        throw new Error("既有審查資料狀態已變更，請重新按儲存確認");
    }

    const batch = writeBatch(db);
    const writeAudit = (action: string, targetId: string, detail: string) => {
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user.staffId,
        actorName: user.name,
        action,
        targetType: "indicator",
        targetId,
        detail,
        createdAt: serverTimestamp(),
      });
    };

    for (const row of plan.newRows) {
      const code = row.code.trim();
      const indicatorId = indicatorDocId(row.groupId, code);
      const ref = doc(db, "indicators", indicatorId);
      const exists = await getDoc(ref);
      if (exists.exists()) throw new Error(`指標編號 ${code} 在此組別已存在`);

      const basicThreshold = typeof row.threshold === "number" ? row.threshold : 0;
      const questions = row.audit.questions.map((question, order) => ({
        id: question.id,
        itemText: question.itemText.trim(),
        optionSet: question.optionSet,
        guidance: question.guidance.trim(),
        commonErrors: (question.commonErrors ?? [])
          .map((item) => item.trim())
          .filter(Boolean),
        groupId: question.groupId,
        groupName: question.groupName.trim(),
        order,
      }));
      const questionGroups = [...row.audit.questionGroups]
        .sort((a, b) => a.order - b.order)
        .map((group, order) => ({
          id: group.id,
          name: group.name.trim() || `分組 ${order + 1}`,
          order,
        }));
      const steps = emptyTenSteps();
      steps.step5.thresholds = [];
      batch.set(ref, {
        code,
        name: row.name.trim(),
        groupId: row.groupId,
        owners: row.owners,
        threshold: basicThreshold,
        basicThreshold,
        status: "草稿",
        tenSteps: steps,
        questions,
        auditItems: row.audit.auditItems
          .map((item) => item.trim())
          .filter(Boolean),
        questionGroups,
        useQuestionGroups: row.audit.useQuestionGroups,
        groupScoring: row.audit.groupScoring,
        requireBedNo: row.audit.requireBedNo,
        requireReviewee: row.audit.requireReviewee,
        version: "v1.0",
        hasReviewData: false,
        createdAt: serverTimestamp(),
        createdBy: user.staffId,
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      });
      batch.set(doc(db, "indicators", indicatorId, "versions", "v1.0"), {
        version: "v1.0",
        status: "草稿",
        threshold: basicThreshold,
        tenSteps: steps,
        questions,
        auditItems: row.audit.auditItems
          .map((item) => item.trim())
          .filter(Boolean),
        questionGroups,
        useQuestionGroups: row.audit.useQuestionGroups,
        groupScoring: row.audit.groupScoring,
        effectiveDate: new Date().toISOString().slice(0, 10),
        note: "初版",
        createdAt: serverTimestamp(),
        createdBy: user.staffId,
      });
      writeAudit("建立指標", indicatorId, row.name.trim());
    }

    for (const plannedTarget of plan.existing) {
      const target = refreshedById.get(plannedTarget.indicatorId)!;
      const mergeMode =
        target.currentAudit.questions.length > 0 ? mode : "replace";
      const merged = mergeImportedAuditForm(
        importedAuditPart(target.currentAudit),
        importedAuditPart(target.importedAudit),
        mergeMode,
      );
      const questions = merged.questions.map((question, order) => ({
        id: question.id,
        itemText: question.itemText.trim(),
        optionSet: question.optionSet,
        guidance: question.guidance.trim(),
        commonErrors: (question.commonErrors ?? [])
          .map((item) => item.trim())
          .filter(Boolean),
        groupId: question.groupId,
        groupName: question.groupName.trim(),
        order,
      }));
      const questionGroups = [...merged.questionGroups]
        .sort((a, b) => a.order - b.order)
        .map((group, order) => ({ ...group, order }));
      const indicatorRef = doc(db, "indicators", target.indicatorId);
      let versionDetail = "";
      if (target.hasReviewData) {
        const currentVersion =
          typeof target.latestData.version === "string"
            ? target.latestData.version
            : "v1.0";
        const newVersion = nextVersion(currentVersion);
        batch.set(
          doc(db, "indicators", target.indicatorId, "versions", newVersion),
          {
            version: newVersion,
            status:
              typeof target.latestData.status === "string"
                ? target.latestData.status
                : "草稿",
            threshold: primaryThreshold(target.latestData),
            tenSteps: target.latestData.tenSteps ?? emptyTenSteps(),
            questions,
            auditItems: Array.isArray(target.latestData.auditItems)
              ? target.latestData.auditItems.map(String).filter(Boolean)
              : [],
            questionGroups,
            useQuestionGroups: merged.useQuestionGroups,
            groupScoring: merged.groupScoring,
            effectiveDate: new Date().toISOString().slice(0, 10),
            note: `批次匯入審核表（${mergeMode === "replace" ? "取代" : "追加"}）`,
            createdAt: serverTimestamp(),
            createdBy: user.staffId,
          },
        );
        batch.update(indicatorRef, {
          questions,
          questionGroups,
          useQuestionGroups: merged.useQuestionGroups,
          groupScoring: merged.groupScoring,
          version: newVersion,
          hasReviewData: true,
          updatedAt: serverTimestamp(),
          updatedBy: user.staffId,
        });
        versionDetail = `，新版本 ${newVersion}`;
      } else {
        batch.update(indicatorRef, {
          questions,
          questionGroups,
          useQuestionGroups: merged.useQuestionGroups,
          groupScoring: merged.groupScoring,
          updatedAt: serverTimestamp(),
          updatedBy: user.staffId,
        });
      }
      writeAudit(
        "匯入審核表",
        target.indicatorId,
        `${mergeMode === "replace" ? "取代" : "追加"}：${target.currentAudit.questions.length} 題 → ${questions.length} 題${versionDetail}`,
      );
    }

    await batch.commit();
    const summary = [
      plan.newRows.length ? `建立 ${plan.newRows.length} 支新指標` : "",
      plan.existing.length ? `更新 ${plan.existing.length} 支既有指標審核表` : "",
    ]
      .filter(Boolean)
      .join("；");
    onAction(`批次儲存完成：${summary}`);
    onDone();
  }

  async function handleSaveChoice(mode: "replace" | "append") {
    if (!saveChoice) return;
    setSaving(true);
    try {
      await commitBatchSave(saveChoice, mode);
      setSaveChoice(null);
    } catch (error) {
      setSaveChoice(null);
      onAction(
        `批次儲存失敗：${error instanceof Error ? error.message : "讀寫失敗"}`,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="reviewer-modal-backdrop" onClick={onClose}>
      <div
        className="reviewer-modal panel batch-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="批次新增指標"
      >
        <div className="reviewer-modal-head">
          <div>
            <h2>批次新增指標</h2>
            <p>
              新增指標須填基本資料；匯入既有指標的審核表時，依組別及指標編號匹配並先預覽。若原審核表已有題目，按儲存後可選擇取代或追加。
            </p>
          </div>
          <button
            className="button button-ghost"
            onClick={onClose}
            aria-label="關閉"
          >
            <X size={16} />
          </button>
        </div>
        <div className="batch-toolbar">
          <button
            className="button button-outline button-sm"
            onClick={() => setRows((prev) => [...prev, emptyBatchRow()])}
          >
            <Plus size={14} /> 新增一列
          </button>
          <button
            className="button button-outline button-sm"
            onClick={() => basicFileRef.current?.click()}
            disabled={importing}
          >
            <Upload size={14} /> 匯入基本資料
          </button>
          <button
            className="button button-outline button-sm"
            onClick={() => {
              // v1.28 階段 5：downloadTemplate 為 async；xlsx 元件載入失敗時退回 CSV，提示使用者
              void downloadTemplate(
                basicTemplateRows(),
                "基本資料",
                "指標基本資料範本",
              ).then((fmt) => {
                if (fmt === "csv")
                  onAction("Excel 元件載入失敗，已改下載 CSV 範本");
              });
            }}
          >
            <Download size={14} /> 下載基本資料範本
          </button>
          <button
            className="button button-outline button-sm"
            onClick={() => auditFileRef.current?.click()}
            disabled={importing}
          >
            <Upload size={14} /> 匯入審核表
          </button>
          <button
            className="button button-outline button-sm"
            onClick={() => {
              void downloadTemplate(
                auditTemplateRows(),
                "審核表",
                "指標審核表範本",
              ).then((fmt) => {
                if (fmt === "csv")
                  onAction("Excel 元件載入失敗，已改下載 CSV 範本");
              });
            }}
          >
            <Download size={14} /> 下載審核表範本
          </button>
          <span className="muted-text">
            新指標 {rows.filter(batchRowHasContent).length} 列
          </span>
          {importing && (
            <span className="muted-text" role="status">
              讀取檔案中…
            </span>
          )}
          <input
            ref={basicFileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            style={{ display: "none" }}
            aria-label="匯入基本資料檔案"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void handleImportBasic(f);
            }}
          />
          <input
            ref={auditFileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            style={{ display: "none" }}
            aria-label="匯入審核表檔案"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void handleImportAudit(f);
            }}
          />
        </div>
        {importSummary && (
          <p className="settings-note" role="status">
            {importSummary}
          </p>
        )}
        {importErrors.length > 0 && (
          <div style={{ maxHeight: 160, overflow: "auto", marginBottom: 8 }}>
            {importErrors.map((msg, i) => (
              <div key={i} className="field-error">
                {msg}
              </div>
            ))}
          </div>
        )}
        {existingAuditImports.length > 0 && (
          <section className="batch-existing-audit-preview">
            <h3>既有指標審核表匯入預覽</h3>
            <p className="muted-text">
              已找到 {existingAuditImports.length} 支指標；以下變更尚未儲存。按儲存後，原審核表已有題目時會再詢問取代或追加。
            </p>
            <div className="batch-existing-audit-list">
              {existingAuditImports.map((target) => (
                <article
                  className="batch-existing-audit-card"
                  key={target.indicatorId}
                >
                  <div className="batch-existing-audit-heading">
                    <strong>{target.name}</strong>
                    <span>
                      {target.groupName}／{target.code}
                    </span>
                  </div>
                  <p>
                    原審核表 {target.originalAudit.questions.length} 題；本次匯入 {target.importedAudit.questions.length} 題
                  </p>
                  <details>
                    <summary>預覽本次匯入題目</summary>
                    <ol>
                      {target.importedAudit.questions.map((question) => (
                        <li key={question.id}>
                          <strong>{question.itemText}</strong>
                          <div className="muted-text">
                            分組：{question.groupName || "未分組"}；選項：
                            {optionLabelsOf(question.optionSet).join("、")}
                          </div>
                          {question.guidance && (
                            <div className="muted-text">
                              指引：{question.guidance}
                            </div>
                          )}
                        </li>
                      ))}
                    </ol>
                  </details>
                </article>
              ))}
            </div>
          </section>
        )}
        <div className="table-scroll">
          <table className="permission-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th>組別 *</th>
                <th>編號 *</th>
                <th>指標名稱 *</th>
                <th>閾值% *</th>
                <th>負責人 *</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <Fragment key={r.key}>
                  <tr>
                    <td>{ri + 1}</td>
                    <td>
                      <div className="select-wrap">
                        <select
                          value={r.groupId}
                          aria-label={`第${ri + 1}列組別`}
                          onChange={(e) =>
                            updateRow(r.key, { groupId: e.target.value }, [
                              "groupId",
                            ])
                          }
                        >
                          <option value="">請選擇</option>
                          {[...groupMap.entries()].map(([id, name]) => (
                            <option key={id} value={id}>
                              {name}
                            </option>
                          ))}
                        </select>
                        <ChevronDown size={15} />
                      </div>
                      {r.errors.groupId && (
                        <div className="field-error">{r.errors.groupId}</div>
                      )}
                    </td>
                    <td>
                      <input
                        className="text-input"
                        value={r.code}
                        placeholder="QI-001"
                        aria-label={`第${ri + 1}列編號`}
                        onChange={(e) =>
                          updateRow(r.key, { code: e.target.value }, ["code"])
                        }
                      />
                      {r.errors.code && (
                        <div className="field-error">{r.errors.code}</div>
                      )}
                    </td>
                    <td>
                      <input
                        className="text-input"
                        value={r.name}
                        placeholder="指標名稱"
                        aria-label={`第${ri + 1}列指標名稱`}
                        onChange={(e) =>
                          updateRow(r.key, { name: e.target.value }, ["name"])
                        }
                      />
                      {r.errors.name && (
                        <div className="field-error">{r.errors.name}</div>
                      )}
                    </td>
                    <td>
                      <input
                        className="text-input"
                        type="number"
                        min={1}
                        max={100}
                        step={1}
                        style={{ width: 90 }}
                        placeholder="1–100"
                        aria-label={`第${ri + 1}列閾值`}
                        value={
                          typeof r.threshold === "number" &&
                          Number.isFinite(r.threshold)
                            ? String(r.threshold)
                            : ""
                        }
                        onChange={(e) =>
                          updateRow(
                            r.key,
                            {
                              threshold:
                                e.target.value === ""
                                  ? ""
                                  : Number(e.target.value),
                            },
                            ["threshold"],
                          )
                        }
                      />
                      {r.errors.threshold && (
                        <div className="field-error">{r.errors.threshold}</div>
                      )}
                    </td>
                    <td style={{ minWidth: 230 }}>
                      <OwnerMultiSelect
                        staffMap={staffMap}
                        staffLoaded={staffLoaded}
                        owners={r.owners}
                        onChange={(owners) =>
                          updateRow(r.key, { owners }, ["owners"])
                        }
                      />
                      {r.errors.owners && (
                        <div className="field-error">{r.errors.owners}</div>
                      )}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button
                        className="text-button"
                        onClick={() =>
                          updateRow(r.key, { showAudit: !r.showAudit })
                        }
                      >
                        {r.showAudit
                          ? "收合審核表"
                          : `審核表（${r.audit.questions.length}題）`}
                      </button>{" "}
                      <button
                        className="icon-button"
                        aria-label={`刪除第${ri + 1}列`}
                        disabled={rows.length <= 1}
                        onClick={() => removeRow(r.key)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                  {r.showAudit && (
                    <tr>
                      <td colSpan={7}>
                        <AuditFormEditor
                          value={r.audit}
                          onChange={(patch) =>
                            updateRow(
                              r.key,
                              { audit: { ...r.audit, ...patch } },
                              Object.keys(r.errors).filter((k) =>
                                k.startsWith("q_"),
                              ),
                            )
                          }
                        />
                        {Object.entries(r.errors)
                          .filter(([k]) => k.startsWith("q_"))
                          .map(([k, msg]) => (
                            <div key={k} className="field-error">
                              {msg}
                            </div>
                          ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <div className="form-actions">
          <button
            className="button button-primary"
            disabled={saving || !!saveChoice}
            onClick={handleSave}
          >
            {saving
              ? "儲存中…"
              : `儲存批次（新指標 ${rows.filter(batchRowHasContent).length} 支、既有審核表 ${existingAuditImports.length} 支）`}
          </button>
          <button className="button button-ghost" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
      {saveChoice && (
        <div
          className="reviewer-modal-backdrop batch-save-choice-backdrop"
          onClick={(event) => {
            event.stopPropagation();
            if (!saving) setSaveChoice(null);
          }}
        >
          <div
            className="reviewer-modal panel batch-save-choice"
            role="dialog"
            aria-modal="true"
            aria-label="選擇既有審核表處理方式"
            onClick={(event) => event.stopPropagation()}
          >
            <h2>選擇審核表儲存方式</h2>
            {saveChoice.existing.some(
              (target) => target.currentAudit.questions.length > 0,
            ) ? (
              <p>
                本次有既有審核表含有題目。請選擇此批所有既有指標的處理方式：取代原有整份審核表，或將匯入題目追加在後。
              </p>
            ) : (
              <p>原審核表目前沒有題目，確認後將儲存匯入的審核題目。</p>
            )}
            {saveChoice.existing.some((target) => target.hasReviewData) && (
              <p className="settings-note">
                部分指標已有審查歷史；系統將依版本控管建立新版本，保留既有歷史審查資料。
              </p>
            )}
            <div className="batch-save-choice-actions">
              {saveChoice.existing.some(
                (target) => target.currentAudit.questions.length > 0,
              ) ? (
                <>
                  <button
                    className="button button-outline"
                    disabled={saving}
                    onClick={() => void handleSaveChoice("replace")}
                  >
                    取代原有整份審核表
                  </button>
                  <button
                    className="button button-primary"
                    disabled={saving}
                    onClick={() => void handleSaveChoice("append")}
                  >
                    追加到原有審核表後
                  </button>
                </>
              ) : (
                <button
                  className="button button-primary"
                  disabled={saving}
                  onClick={() => void handleSaveChoice("replace")}
                >
                  確認儲存審核表
                </button>
              )}
              <button
                className="button button-ghost"
                disabled={saving}
                onClick={() => setSaveChoice(null)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
