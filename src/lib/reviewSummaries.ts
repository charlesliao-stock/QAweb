/**
 * 審查結果預存摘要的純資料模型與重算邏輯。
 *
 * 摘要鍵：指標 × 排程區間初始月份 × 指標版本 ×（單位／全院）。
 * 本模組只計算，不直接讀寫 Firestore；持久化、觸發器、定時任務與通知
 * 須由受控伺服器端實作，避免用戶端併發或重試造成重複計數。
 */
export type SummaryScope = "unit" | "all";

export interface SummaryAnswer {
  questionId: string;
  itemText: string;
  optionLabel: string;
}

/** 已完成且有效的目前版本審查紀錄，加上任務建立時的不可變快照。 */
export interface SummarySourceRecord {
  recordId: string;
  indicatorId: string;
  scheduleStartYear: number;
  scheduleStartMonth: number;
  indicatorVersion: string;
  thresholdAtSchedule: number;
  thresholdRuleAtSchedule: ">=";
  unitId: string;
  /** null／非有限值代表沒有有效結果，不納入總審查數。 */
  rate: number | null;
  answers: SummaryAnswer[];
}

export interface QuestionOptionSummary {
  questionId: string;
  itemText: string;
  yes: number;
  no: number;
  notApplicable: number;
  /** 保留未來原因詞庫統計欄位；目前未啟用，應保持空物件。 */
  reasonCounts: Record<string, number>;
}

export interface ReviewSummary {
  id: string;
  indicatorId: string;
  scheduleStartYear: number;
  scheduleStartMonth: number;
  scheduleStartKey: number;
  indicatorVersion: string;
  scope: SummaryScope;
  unitId: string | null;
  threshold: number;
  thresholdRule: ">=";
  passedCount: number;
  totalCount: number;
  questionOptions: QuestionOptionSummary[];
  /** 寫入端應使用 Firestore serverTimestamp。 */
  precomputedAt: unknown;
  /** 保留摘要失敗重試與通知流程的欄位空間。 */
  refreshStatus: "ready";
  refreshError?: never;
}

function summaryId(
  record: SummarySourceRecord,
  scope: SummaryScope,
): string {
  const unit = scope === "all" ? "all" : encodeURIComponent(record.unitId);
  return [
    encodeURIComponent(record.indicatorId),
    `${record.scheduleStartYear}-${String(record.scheduleStartMonth).padStart(2, "0")}`,
    encodeURIComponent(record.indicatorVersion),
    scope,
    unit,
  ].join("__");
}

/**
 * 從完整的「目前有效紀錄集合」重算摘要。
 * 同一 recordId 若重複出現，以輸入中最後一份為準；修正後須以最新紀錄
 * 取代舊紀錄後再呼叫，絕不以增量方式重複累加。
 */
export function buildReviewSummaries(
  sourceRecords: SummarySourceRecord[],
  precomputedAt: unknown,
): ReviewSummary[] {
  const latestById = new Map<string, SummarySourceRecord>();
  for (const record of sourceRecords) {
    if (record.recordId) latestById.set(record.recordId, record);
  }
  const valid = [...latestById.values()].filter(
    (record) =>
      Number.isFinite(record.rate) &&
      record.scheduleStartYear > 0 &&
      record.scheduleStartMonth >= 1 &&
      record.scheduleStartMonth <= 12 &&
      record.indicatorId.length > 0 &&
      record.indicatorVersion.length > 0 &&
      Number.isFinite(record.thresholdAtSchedule) &&
      record.unitId.length > 0,
  );

  const groups = new Map<string, {
    id: string;
    indicatorId: string;
    scheduleStartYear: number;
    scheduleStartMonth: number;
    indicatorVersion: string;
    scope: SummaryScope;
    unitId: string | null;
    threshold: number;
    totalCount: number;
    passedCount: number;
    questions: Map<string, QuestionOptionSummary>;
  }>();

  const ensure = (record: SummarySourceRecord, scope: SummaryScope) => {
    const id = summaryId(record, scope);
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        indicatorId: record.indicatorId,
        scheduleStartYear: record.scheduleStartYear,
        scheduleStartMonth: record.scheduleStartMonth,
        indicatorVersion: record.indicatorVersion,
        scope,
        unitId: scope === "unit" ? record.unitId : null,
        threshold: record.thresholdAtSchedule,
        totalCount: 0,
        passedCount: 0,
        questions: new Map(),
      };
      groups.set(id, group);
    }
    return group;
  };

  for (const record of valid) {
    for (const scope of ["unit", "all"] as const) {
      const group = ensure(record, scope);
      group.totalCount += 1;
      if (
        record.thresholdRuleAtSchedule === ">=" &&
        record.rate! >= record.thresholdAtSchedule
      ) {
        group.passedCount += 1;
      }
      // 同一份審查中同一題只計一次；若遇到重複答案，以最後作答為準。
      const latestAnswers = new Map<string, SummaryAnswer>();
      for (const answer of record.answers) {
        if (answer.questionId) latestAnswers.set(answer.questionId, answer);
      }
      for (const answer of latestAnswers.values()) {
        const row = group.questions.get(answer.questionId) ?? {
          questionId: answer.questionId,
          itemText: answer.itemText,
          yes: 0,
          no: 0,
          notApplicable: 0,
          reasonCounts: {},
        };
        if (answer.optionLabel === "是") row.yes += 1;
        else if (answer.optionLabel === "否") row.no += 1;
        else if (answer.optionLabel === "不適用") row.notApplicable += 1;
        group.questions.set(answer.questionId, row);
      }
    }
  }

  return [...groups.values()]
    .map((group) => ({
      id: group.id,
      indicatorId: group.indicatorId,
      scheduleStartYear: group.scheduleStartYear,
      scheduleStartMonth: group.scheduleStartMonth,
      scheduleStartKey: group.scheduleStartYear * 100 + group.scheduleStartMonth,
      indicatorVersion: group.indicatorVersion,
      scope: group.scope,
      unitId: group.unitId,
      threshold: group.threshold,
      thresholdRule: ">=" as const,
      passedCount: group.passedCount,
      totalCount: group.totalCount,
      questionOptions: [...group.questions.values()].sort(
        (a, b) => a.questionId.localeCompare(b.questionId, "zh-Hant"),
      ),
      precomputedAt,
      refreshStatus: "ready" as const,
    }))
    .sort((a, b) => a.id.localeCompare(b.id, "zh-Hant"));
}
