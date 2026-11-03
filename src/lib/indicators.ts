/** 指標資料模型（需求規格書 v2.1＋2026-11-03 新規格） */

export const TEN_STEP_TITLES = [
  "負責單位",
  "照護範圍",
  "照護面",
  "標準依據",
  "閾值",
  "資料收集",
  "評值",
  "採取行動",
  "評估活動之有效性",
  "溝通",
] as const;

export type OptionSet = "yes-no-na" | "yes-no";

/** 審核表題目的評分選項（顯示文字＋分數，可自由增刪改） */
export interface QuestionOption {
  label: string;
  score: number;
}

/** 題目分組（由「啟用題目分組」開關控制；不是每一份指標都有） */
export interface QuestionGroup {
  id: string;
  name: string;
  order: number;
}

export interface AuditQuestion {
  id: string;
  /** 指標項目（必填） */
  itemText: string;
  options: QuestionOption[];
  /** 審核指引（多行） */
  guidance: string;
  /** 所屬題目分組 id；null＝未分組（扁平） */
  groupId: string | null;
  /** 分組名稱（冗餘儲存，讀取容錯） */
  groupName: string;
  /** 全域排序 */
  order: number;
}

/** 題目 id／分組 id 產生器（前端暫用，存檔時一併寫入） */
export function newQid(): string {
  return `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 新題目預設選項：0 分／1 分 */
export function defaultQuestionOptions(): QuestionOption[] {
  return [
    { label: "0 分", score: 0 },
    { label: "1 分", score: 1 },
  ];
}

export function emptyAuditQuestion(
  groupId: string | null,
  groupName: string,
): AuditQuestion {
  return {
    id: newQid(),
    itemText: "",
    options: defaultQuestionOptions(),
    guidance: "",
    groupId,
    groupName,
    order: 0,
  };
}

export interface SubIndicator {
  name: string;
  numerator: string;
  denominator: string;
}

export interface NamedThreshold {
  name: string;
  value: number;
}

/**
 * 閾值與步驟四「指標」一一對應：多退少補（保留既有值）。
 * 步驟四增刪指標時呼叫此函式，讓步驟五的閾值列數同步。
 * 補齊的新列 value 為 NaN（表單顯示為空）；存檔前驗證會確保皆為 0～100 的數字。
 */
export function alignThresholds(
  thresholds: NamedThreshold[],
  count: number,
): NamedThreshold[] {
  const list = thresholds.slice(0, count);
  while (list.length < count) list.push({ name: "", value: NaN });
  return list;
}

export interface TenSteps {
  step1: string;
  step2: string;
  step3: string;
  step4: { basis: string; subIndicators: SubIndicator[] };
  step5: { thresholds: NamedThreshold[] };
  step6: { caseCount: string; auditors: string; auditDate: string; auditMethod: string };
  step7: string;
  step8: string;
  step9: string;
  step10: string;
}

export function emptyTenSteps(): TenSteps {
  return {
    step1: "",
    step2: "",
    step3: "",
    step4: { basis: "", subIndicators: [] },
    step5: { thresholds: [] },
    step6: { caseCount: "", auditors: "", auditDate: "", auditMethod: "" },
    step7: "",
    step8: "",
    step9: "",
    step10: "",
  };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asSubIndicators(v: unknown): SubIndicator[] {
  if (!Array.isArray(v)) return [];
  return v.map((s) => {
    const r = (s ?? {}) as Record<string, unknown>;
    return {
      name: asString(r.name),
      numerator: asString(r.numerator),
      denominator: asString(r.denominator),
    };
  });
}

function asThresholds(v: unknown): NamedThreshold[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((t) => {
      const r = (t ?? {}) as Record<string, unknown>;
      const num = Number(r.value);
      return {
        name: asString(r.name),
        value: Number.isFinite(num) ? num : 0,
      };
    })
    .filter((t) => t.name !== "" || t.value !== 0);
}

/**
 * 正規化 tenSteps：支援新結構；舊資料（title-keyed steps 物件或頂層 threshold 數字）
 * 盡量對應轉換，缺失欄位給預設空值。
 */
export function normalizeTenSteps(raw: unknown, legacy?: unknown): TenSteps {
  const base = emptyTenSteps();
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    base.step1 = asString(r.step1);
    base.step2 = asString(r.step2);
    base.step3 = asString(r.step3);
    if (r.step4 && typeof r.step4 === "object") {
      const s4 = r.step4 as Record<string, unknown>;
      base.step4 = {
        basis: asString(s4.basis),
        subIndicators: asSubIndicators(s4.subIndicators),
      };
    }
    if (r.step5 && typeof r.step5 === "object") {
      const s5 = r.step5 as Record<string, unknown>;
      const th = asThresholds(s5.thresholds);
      base.step5 = { thresholds: th.length > 0 ? th : base.step5.thresholds };
    }
    if (r.step6 && typeof r.step6 === "object") {
      const s6 = r.step6 as Record<string, unknown>;
      base.step6 = {
        caseCount: asString(s6.caseCount),
        auditors: asString(s6.auditors),
        auditDate: asString(s6.auditDate),
        auditMethod: asString(s6.auditMethod),
      };
    }
    base.step7 = asString(r.step7);
    base.step8 = asString(r.step8);
    base.step9 = asString(r.step9);
    base.step10 = asString(r.step10);
    return base;
  }
  // 舊格式：steps 為 {標題: 內容} 物件
  if (legacy && typeof legacy === "object") {
    const l = legacy as Record<string, unknown>;
    base.step1 = asString(l["負責單位"]);
    base.step2 = asString(l["照護範圍"]);
    base.step3 = asString(l["照護面"]);
    base.step4 = { basis: asString(l["標準依據"]), subIndicators: [] };
    base.step7 = asString(l["評值"]);
    base.step8 = asString(l["採取行動"]);
    base.step9 = asString(l["評估活動之有效性"]);
    base.step10 = asString(l["溝通"]);
  }
  return base;
}

/** 第一筆為主閾值，用於達標判斷與列表顯示 */
export function primaryThreshold(
  ind: { tenSteps?: unknown } | null | undefined,
): number {
  const ts = normalizeTenSteps(ind?.tenSteps);
  return ts.step5.thresholds[0]?.value ?? 0;
}

function asQuestionOptions(v: unknown, optionSet?: unknown): QuestionOption[] {
  if (Array.isArray(v)) {
    const list = v
      .map((o) => {
        const r = (o ?? {}) as Record<string, unknown>;
        const num = Number(r.score);
        return {
          label: asString(r.label),
          score: Number.isFinite(num) ? num : 0,
        };
      })
      .filter((o) => o.label !== "");
    if (list.length > 0) return list;
  }
  // 舊格式 optionSet 轉換：是＝1 分、否／不適用＝0 分
  const set = optionSet === "yes-no" || optionSet === "yes-no-na" ? optionSet : "yes-no-na";
  return set === "yes-no"
    ? [
        { label: "是", score: 1 },
        { label: "否", score: 0 },
      ]
    : [
        { label: "是", score: 1 },
        { label: "否", score: 0 },
        { label: "不適用", score: 0 },
      ];
}

export interface NormalizedQuestions {
  questions: AuditQuestion[];
  /** 由題目 groupId／舊 group 字串推導出的分組（供合併用） */
  groups: QuestionGroup[];
  /** 是否有任何題目帶分組（舊資料推斷用） */
  useGroups: boolean;
}

/**
 * 正規化審核表題目：
 * - 新格式：{id, itemText, options:[{label,score}], guidance, groupId, groupName, order}
 * - 舊格式：{text, optionSet, guidance, group} → 轉新格式；
 *   舊 group 字串（題組名）會轉為真正的分組並啟用分組。
 */
export function normalizeQuestions(raw: unknown): NormalizedQuestions {
  if (!Array.isArray(raw)) return { questions: [], groups: [], useGroups: false };
  const groupByName = new Map<string, QuestionGroup>();
  const questions: AuditQuestion[] = raw.map((q, i) => {
    const r = (q ?? {}) as Record<string, unknown>;
    const isNew =
      typeof r.itemText === "string" || Array.isArray(r.options);
    let groupId: string | null = null;
    let groupName = "";
    if (isNew) {
      groupId = typeof r.groupId === "string" && r.groupId ? r.groupId : null;
      groupName = asString(r.groupName);
    } else {
      const g = asString(r.group);
      if (g) {
        let grp = groupByName.get(g);
        if (!grp) {
          grp = { id: newQid(), name: g, order: groupByName.size };
          groupByName.set(g, grp);
        }
        groupId = grp.id;
        groupName = g;
      }
    }
    if (groupId && groupName && !groupByName.has(groupName)) {
      groupByName.set(groupName, {
        id: groupId,
        name: groupName,
        order: groupByName.size,
      });
    }
    const ord = Number(r.order);
    return {
      id: asString(r.id) || newQid(),
      itemText: isNew ? asString(r.itemText) : asString(r.text),
      options: asQuestionOptions(r.options, r.optionSet),
      guidance: asString(r.guidance),
      groupId,
      groupName,
      order: Number.isFinite(ord) ? ord : i,
    };
  });
  questions.sort((a, b) => a.order - b.order);
  const groups = [...groupByName.values()].sort((a, b) => a.order - b.order);
  return {
    questions,
    groups,
    useGroups: questions.some((q) => q.groupId !== null),
  };
}

function asQuestionGroups(v: unknown): QuestionGroup[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((g, i) => {
      const r = (g ?? {}) as Record<string, unknown>;
      const ord = Number(r.order);
      return {
        id: asString(r.id) || newQid(),
        name: asString(r.name),
        order: Number.isFinite(ord) ? ord : i,
      };
    })
    .filter((g) => g.id !== "")
    .sort((a, b) => a.order - b.order);
}

/**
 * 合併分組：已儲存的 questionGroups 為主（含無題目的空分組），
 * 再補上題目中引用到但分組表沒有的（容錯）。
 */
export function mergeQuestionGroups(
  stored: unknown,
  derived: QuestionGroup[],
): QuestionGroup[] {
  const list = asQuestionGroups(stored);
  const ids = new Set(list.map((g) => g.id));
  for (const g of derived) {
    if (!ids.has(g.id)) {
      list.push({ ...g, order: list.length });
      ids.add(g.id);
    }
  }
  return list.sort((a, b) => a.order - b.order);
}
