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

export interface SubIndicator {
  name: string;
  numerator: string;
  denominator: string;
}

export interface NamedThreshold {
  name: string;
  value: number;
}

export interface AuditQuestion {
  text: string;
  optionSet: OptionSet;
  guidance: string;
  /** 題組／指標項目（選填；用於分段顯示，例如「確認病人」「給藥前」） */
  group: string;
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

/** 舊題目格式（options 欄位）轉新格式 */
export function normalizeQuestions(raw: unknown): AuditQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((q) => {
    const r = (q ?? {}) as Record<string, unknown>;
    return {
      text: asString(r.text),
      optionSet: r.optionSet === "yes-no" || r.options === "yes-no" ? "yes-no" : "yes-no-na",
      guidance: asString(r.guidance),
      group: asString(r.group),
    };
  });
}
