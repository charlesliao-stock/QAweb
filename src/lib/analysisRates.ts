/**
 * 結果分析達閾值率聚合（v1.25.0 新增；v1.27.0 改單位率定義）。
 * 純函式，可單元測試。
 *
 * - 達閾值＝紀錄 rate ≥ 指標閾值。紀錄無自帶達標旗標，一律以當前指標閾值
 *   計算（rate 為 v1.17 選項集得分％；匯入的紀錄 source="import" 同樣計入）。
 * - 所有的正確率，不論人或單位，都是「審查達閾值數／總審查數」。
 * - 人次率＝合併計算（達閾值總人次／總審查人次）。
 * - 單位達閾值率（每單位）＝單位內受審且達閾值人次／該單位總受審人次；
 *   一個單位「達閾值」＝該單位率 ≥ 指標閾值。
 * - 單位率＝達閾值單位數／總審查單位數（取代 v1.25.0 的各單位率平均）。
 *   指標分析摘要的單位正確率以 unit-period 計：一個單位在兩個期間欄
 *   受審＝兩筆審查。
 * - 矩陣格格式：正確率＋（正確數／審查數），例 75%(3/4)。
 * - 分組／逐題明細（v1.44.0）：人次模式與主格同口徑（分組達標人次／總人次，
 *   每人先算分組 rate 再判達標）；單位模式 v1.49.0 起亦與主格同口徑（推翻
 *   v1.44.0 決策 2B 的彙總作答率判定）：每人先算分組 rate 再判達標，再算
 *   每單位達標人次／該單位總人次 ≥ 閾值該單位才達標。
 */
import type { AuditQuestion } from "./indicators";
import { mergeNoteParts } from "./import";
import { maskName } from "./mask";

export interface AnalysisAnswer {
  questionId: string;
  itemText: string;
  optionLabel: string;
  score: number;
  excluded?: boolean;
  /** 該題從指標原因詞庫勾選的原因；分析僅計入已列詞庫項目。 */
  commonErrors?: string[];
  /** 該題補充說明（審查員備註未通過原因；v1.41.1，查詢畫面顯示用） */
  note?: string;
}

export interface AnalysisRecord {
  indicatorId: string;
  /** 審查任務 ID；用於將加審紀錄精確連回 reviewTasks。 */
  taskId?: string;
  unitId: string;
  year: number;
  month: number;
  /** 正確率％（一位小數）；滿分 0 時為 null */
  rate: number | null;
  /** 排程建立時固定的閾值；舊／外部匯入紀錄可能缺值。 */
  thresholdAtSchedule?: number;
  /** 審查任務建立時的指標版本；舊紀錄可能缺值。 */
  indicatorVersion?: string;
  answers: AnalysisAnswer[];
  /** 被審人員職編（v1.27.0 下探 L2 用） */
  personEmpNo: string;
  /** 被審人員姓名（顯示時遮罩） */
  personName: string;
  /** 病人床號（v1.40.2 L2 表頭下行；指標未要求床號或舊紀錄可能缺值） */
  bedNo?: string;
}

export interface PassRate {
  pass: number;
  total: number;
  /** ％（一位小數）；無資料回 null */
  rate: number | null;
}

/** 格格式：75%(3/4)；無資料回 —；space=true 時為 75% (3/4) */
export function formatPassRate(pr: PassRate, space = false): string {
  if (pr.rate == null) return "—";
  const r =
    Number.isInteger(pr.rate) ? String(pr.rate) : pr.rate.toFixed(1);
  return space ? `${r}% (${pr.pass}/${pr.total})` : `${r}%(${pr.pass}/${pr.total})`;
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** 單筆達閾值：rate 非 null 且 ≥ 閾值；閾值未設定（<=0）視為不達標 */
export function isPassing(rate: number | null, threshold: number): boolean {
  return typeof rate === "number" && threshold > 0 && rate >= threshold;
}

/** 合併人次率：達閾值總人次／總審查人次 */
export function passRateOf(
  records: AnalysisRecord[],
  threshold: number,
): PassRate {
  const total = records.length;
  const pass = records.filter((r) =>
    isPassing(r.rate, typeof r.thresholdAtSchedule === "number" ? r.thresholdAtSchedule : threshold),
  ).length;
  return {
    pass,
    total,
    rate: total > 0 ? round1((pass / total) * 100) : null,
  };
}

/** 單位是否達閾值：該單位率非 null、閾值 > 0 且 ≥ 閾值 */
export function isUnitPassing(unitRate: number | null, threshold: number): boolean {
  return typeof unitRate === "number" && threshold > 0 && unitRate >= threshold;
}

function groupByUnit(
  records: AnalysisRecord[],
): Map<string, AnalysisRecord[]> {
  const byUnit = new Map<string, AnalysisRecord[]>();
  for (const r of records) {
    const arr = byUnit.get(r.unitId);
    if (arr) arr.push(r);
    else byUnit.set(r.unitId, [r]);
  }
  return byUnit;
}

/**
 * 單位率＝達閾值單位數／總審查單位數（單一期間欄內）。
 * 一個單位達閾值＝該單位內達閾值人次／總受審人次 ≥ 指標閾值。
 */
export function unitPassRate(
  records: AnalysisRecord[],
  threshold: number,
): PassRate {
  let pass = 0;
  let total = 0;
  for (const rs of groupByUnit(records).values()) {
    const pr = passRateOf(rs, threshold);
    total += 1;
    if (isUnitPassing(pr.rate, threshold)) pass += 1;
  }
  return {
    pass,
    total,
    rate: total > 0 ? round1((pass / total) * 100) : null,
  };
}

/**
 * unit-period 彙總（指標分析摘要用）：一個單位在兩個期間欄受審＝兩筆審查。
 * 逐欄算單位率（達閾值單位數／該欄單位數），再合併計數。
 */
export function unitPeriodPassRate(
  records: AnalysisRecord[],
  columns: { months: { year: number; month: number }[] }[],
  threshold: number,
): PassRate {
  let pass = 0;
  let total = 0;
  for (const col of columns) {
    const r = unitPassRate(recordsInMonths(records, col.months), threshold);
    pass += r.pass;
    total += r.total;
  }
  return {
    pass,
    total,
    rate: total > 0 ? round1((pass / total) * 100) : null,
  };
}

export interface ScoringBreakdownRow {
  key: string;
  label: string;
  /** 人次模式＝達標人次數；單位模式＝達標單位期間數 */
  yes: number;
  /** 人次模式＝總人次數；單位模式＝單位期間數 */
  valid: number;
  rate: number | null;
  isTotal: boolean;
}

/** 分組／逐題的題組定義：有分組按 groupId 分組（未分組題目併為一列），無分組逐題一列。 */
function scoringSections(questions: AuditQuestion[]): {
  key: string;
  label: string;
  ids: Set<string>;
}[] {
  const orderedQuestions = [...questions].sort((a, b) => a.order - b.order);
  const hasGroups = orderedQuestions.some((question) => Boolean(question.groupId));
  const sections = new Map<string, { label: string; ids: Set<string> }>();
  for (const question of orderedQuestions) {
    const key = hasGroups
      ? `group-${question.groupId || "__ungrouped__"}`
      : `question-${question.id}`;
    let section = sections.get(key);
    if (!section) {
      section = {
        label: hasGroups
          ? question.groupId
            ? question.groupName || "未命名分組"
            : "未分組項目"
          : question.itemText || "未命名項目",
        ids: new Set<string>(),
      };
      sections.set(key, section);
    }
    section.ids.add(question.id);
  }
  return [...sections].map(([key, section]) => ({ key, ...section }));
}

/**
 * 人次模式分組／逐題計分（v1.44.0，1A 口徑）：與主格 passRateOf 同口徑。
 * 每人先算該分組 rate＝該組是題數／該組（是＋否）題數，再判 ≥ 閾值；
 * 分子＝分組達標人次，分母＝總人次。全不適用者分組 rate 為 null→不達標，
 * 仍計入分母。閾值逐筆優先用排程快照 thresholdAtSchedule，無快照（匯入
 * 紀錄）用指標閾值；閾值 ≤0 視為不達標。指標整體列直接取 passRateOf，
 * 保證與主格一致。無分組時逐題列：該題答「是」的人次／總人次。
 */
export function personScoringBreakdownRows(
  records: AnalysisRecord[],
  questions: AuditQuestion[],
  threshold: number,
): ScoringBreakdownRow[] {
  const total = passRateOf(records, threshold);
  const result: ScoringBreakdownRow[] = [{
    key: "indicator-total",
    label: "",
    yes: total.pass,
    valid: total.total,
    rate: total.rate,
    isTotal: true,
  }];
  const thresholdOf = (record: AnalysisRecord): number =>
    typeof record.thresholdAtSchedule === "number" ? record.thresholdAtSchedule : threshold;
  /** 單筆紀錄在指定題組內的（是，否）；excluded（不適用／空值）不列入。 */
  const sectionCounts = (record: AnalysisRecord, ids: Set<string>) => {
    let yes = 0;
    let no = 0;
    for (const answer of record.answers) {
      if (!ids.has(answer.questionId) || answer.excluded) continue;
      if (answer.optionLabel === "是") yes += 1;
      else if (answer.optionLabel === "否") no += 1;
    }
    return { yes, no };
  };
  const pushRow = (key: string, label: string, pass: number, valid: number) => {
    result.push({
      key,
      label,
      yes: pass,
      valid,
      rate: valid > 0 ? round1((pass / valid) * 100) : null,
      isTotal: false,
    });
  };
  const knownIds = new Set(questions.map((question) => question.id));
  const hasGroups = questions.some((question) => Boolean(question.groupId));
  for (const section of scoringSections(questions)) {
    let pass = 0;
    if (hasGroups) {
      for (const record of records) {
        const { yes, no } = sectionCounts(record, section.ids);
        const rate = yes + no > 0 ? round1((yes / (yes + no)) * 100) : null;
        if (isPassing(rate, thresholdOf(record))) pass += 1;
      }
    } else {
      // 無分組逐題列：該題答「是」的人次／總人次。
      for (const record of records) {
        const hit = record.answers.some((answer) =>
          section.ids.has(answer.questionId) && !answer.excluded && answer.optionLabel === "是",
        );
        if (hit) pass += 1;
      }
    }
    pushRow(section.key, section.label, pass, records.length);
  }
  if (hasGroups) {
    const historicalIds = new Set<string>();
    for (const record of records) {
      for (const answer of record.answers) {
        if (!knownIds.has(answer.questionId)) historicalIds.add(answer.questionId);
      }
    }
    if (historicalIds.size > 0) {
      let pass = 0;
      for (const record of records) {
        const { yes, no } = sectionCounts(record, historicalIds);
        const rate = yes + no > 0 ? round1((yes / (yes + no)) * 100) : null;
        if (isPassing(rate, thresholdOf(record))) pass += 1;
      }
      pushRow("historical-questions", "其他／歷史題目", pass, records.length);
    }
  } else {
    const historical = new Map<string, { label: string; ids: Set<string> }>();
    for (const record of records) {
      for (const answer of record.answers) {
        if (knownIds.has(answer.questionId)) continue;
        const key = `${answer.questionId}\u0000${answer.itemText}`;
        let entry = historical.get(key);
        if (!entry) {
          entry = { label: answer.itemText || "未命名項目", ids: new Set([answer.questionId]) };
          historical.set(key, entry);
        }
        entry.ids.add(answer.questionId);
      }
    }
    for (const [key, entry] of historical) {
      let pass = 0;
      for (const record of records) {
        const hit = record.answers.some((answer) =>
          entry.ids.has(answer.questionId) && !answer.excluded && answer.optionLabel === "是",
        );
        if (hit) pass += 1;
      }
      pushRow(`historical-${key}`, `歷史題目：${entry.label}`, pass, records.length);
    }
  }
  return result;
}

/**
 * 單位模式分組／逐題計分（v1.49.0，與主格同口徑；推翻 v1.44.0 決策 2B
 * 「單位模式維持彙總作答率判定」）：每人先算該分組 rate＝該組是題數／
 * 該組（是＋否）題數，再判 ≥ 閾值；每單位期間再算該分組達標人次／該單位
 * 該分組有適用題的人次，≥ 閾值該單位該分組才達標。分子＝達標單位期間數，
 * 分母＝有該分組有效作答的單位期間數。某人該分組全部不適用＝不計入該單位
 * 的分母（B 法；全不適用者未就該分組受審）；某單位該分組
 * 完全無有效作答＝該單位不計入該分組的分母。閾值逐筆優先用排程快照
 * thresholdAtSchedule，無快照（匯入紀錄）用指標閾值；單位層判定用指標
 * 閾值（與主格 unitPassRate 一致）；閾值 ≤0 視為不達標。總列不動。
 * 無分組時逐題列用同一口徑：該題答「是」者為達標人次。
 */
export function unitScoringBreakdownRows(
  records: AnalysisRecord[],
  questions: AuditQuestion[],
  columns: { months: { year: number; month: number }[] }[],
  threshold: number,
): ScoringBreakdownRow[] {
  const total = unitPeriodPassRate(records, columns, threshold);
  const sections = scoringSections(questions);
  const result: ScoringBreakdownRow[] = [{
    key: "indicator-total",
    label: "",
    yes: total.pass,
    valid: total.total,
    rate: total.rate,
    isTotal: true,
  }];
  const thresholdOf = (record: AnalysisRecord): number =>
    typeof record.thresholdAtSchedule === "number" ? record.thresholdAtSchedule : threshold;
  /** 單筆紀錄在指定題組內的（是，否）；excluded（不適用／空值）不列入。 */
  const sectionCounts = (record: AnalysisRecord, ids: Set<string>) => {
    let yes = 0;
    let no = 0;
    for (const answer of record.answers) {
      if (!ids.has(answer.questionId) || answer.excluded) continue;
      if (answer.optionLabel === "是") yes += 1;
      else if (answer.optionLabel === "否") no += 1;
    }
    return { yes, no };
  };
  const totals = new Map(
    sections.map((section) => [section.key, { ...section, pass: 0, valid: 0 }]),
  );
  for (const column of columns) {
    const byUnit = new Map<string, AnalysisRecord[]>();
    for (const record of recordsInMonths(records, column.months)) {
      const unitRecords = byUnit.get(record.unitId) ?? [];
      unitRecords.push(record);
      byUnit.set(record.unitId, unitRecords);
    }
    for (const section of sections) {
      for (const unitRecords of byUnit.values()) {
        // B 法：單位分母只計該分組有適用題的人次；全不適用者不計入分母。
        // 該單位期間至少一筆有該分組有效作答才計入分母。
        const applicable = unitRecords.filter((record) => {
          const { yes, no } = sectionCounts(record, section.ids);
          return yes + no > 0;
        });
        if (applicable.length === 0) continue;
        const row = totals.get(section.key)!;
        row.valid += 1;
        let pass = 0;
        for (const record of applicable) {
          const { yes, no } = sectionCounts(record, section.ids);
          const rate = yes + no > 0 ? round1((yes / (yes + no)) * 100) : null;
          if (isPassing(rate, thresholdOf(record))) pass += 1;
        }
        if (isUnitPassing(round1((pass / applicable.length) * 100), threshold)) row.pass += 1;
      }
    }
  }
  for (const [key, row] of totals) {
    result.push({
      key,
      label: row.label,
      yes: row.pass,
      valid: row.valid,
      rate: row.valid > 0 ? round1((row.pass / row.valid) * 100) : null,
      isTotal: false,
    });
  }
  return result;
}

/** 下探 L1 的單位清單：該指標該期間欄內有審查紀錄的單位（依單位代號排序） */
export function unitsForDrill(
  records: AnalysisRecord[],
  months: { year: number; month: number }[],
): string[] {
  const ids = new Set(
    recordsInMonths(records, months).map((r) => r.unitId),
  );
  return [...ids].sort((a, b) => a.localeCompare(b, "zh-Hant"));
}

export interface PersonOptionRow {
  personEmpNo: string;
  personName: string;
  /** 病人床號：該欄對應單筆紀錄的床號（每欄＝一筆紀錄；無則 ""） */
  bedNo: string;
  year: number;
  month: number;
  /** 正確率％；滿分 0 時為 null */
  rate: number | null;
  passing: boolean;
  /** questionId → 選項標籤（是／否／不適用／未填為 ""） */
  answers: Map<string, string>;
  /** questionId → 該題補充說明（v1.41.1；無備註為 ""） */
  notes: Map<string, string>;
}

/**
 * 下探 L2：該單位該期間被審人員在各選項的審查結果。
 * 一筆紀錄＝一人一次審查（同一人在同一期間欄內多筆紀錄各列一行，
 * 以月份區分），依職編、年月排序。
 */
export function personOptionRows(
  records: AnalysisRecord[],
  threshold: number,
): PersonOptionRow[] {
  return [...records]
    .sort((a, b) =>
      a.personEmpNo.localeCompare(b.personEmpNo, "zh-Hant") ||
      a.year - b.year ||
      a.month - b.month,
    )
    .map((r) => ({
      personEmpNo: r.personEmpNo,
      personName: r.personName,
      bedNo: r.bedNo ?? "",
      year: r.year,
      month: r.month,
      rate: r.rate,
      passing: isPassing(r.rate, threshold),
      answers: new Map(r.answers.map((a) => [a.questionId, a.optionLabel])),
      notes: new Map(
        r.answers.map((a) => [a.questionId, (a.note ?? "").trim()]),
      ),
    }));
}

export interface TransposedPersonMatrix {
  /** 每欄一人（順序＝ personOptionRows 的順序）：欄位標頭顯示文字（職編/遮罩姓名；無姓名只顯示職編，無職編只顯示遮罩姓名） */
  headers: string[];
  /** 每欄對應紀錄的床號（與 headers 一一對應；無床號為 ""，表頭下行留空） */
  bedNos: string[];
  /** 每列一題：題目文字＋每欄的作答（是／否／不適用；無作答為 "—"） */
  rows: { questionId: string; itemText: string; values: string[]; notes: string[] }[];
  /** 最下方「正確率」列：每欄的得分（null 表無分數）與達閾值標示 */
  rates: { rate: number | null; passing: boolean }[];
}

/**
 * 下探 L2 轉置（v1.27.1）：直向＝選項（題目，每列一題），橫向＝人員
 * （每欄一人，順序維持 personOptionRows 的順序），中間＝審查結果。
 * 標頭為「職編/遮罩姓名」（半形斜線；v1.40.2），無姓名只顯示職編，
 * 無職編只顯示遮罩姓名；每欄下行另附該筆紀錄的床號（bedNos，v1.40.2）。
 */
export function transposePersonOptionRows(
  rows: PersonOptionRow[],
  questions: AuditQuestion[],
): TransposedPersonMatrix {
  return {
    headers: rows.map((r) => {
      const maskedName = maskName(r.personName);
      if (r.personEmpNo && maskedName) return `${r.personEmpNo}/${maskedName}`;
      return r.personEmpNo || maskedName || "—";
    }),
    bedNos: rows.map((r) => r.bedNo ?? ""),
    rows: questions.map((q) => ({
      questionId: q.id,
      itemText: q.itemText,
      values: rows.map((r) => r.answers.get(q.id) || "—"),
      // 補充說明與 values 一一對應（v1.41.1；無備註為 ""）
      notes: rows.map((r) => r.notes.get(q.id) ?? ""),
    })),
    rates: rows.map((r) => ({ rate: r.rate, passing: r.passing })),
  };
}

/**
 * 下探分組／逐題篩選（v1.50.0）：把分組明細列的 key（group-…／question-…／
 * historical-…）解析為題目 id 清單與種類。總列（indicator-total）回 null
 *（不篩選）。歷史題目以紀錄中的作答補齊 id（不在現行指標題目內者）。
 */
export interface DrillSection {
  ids: string[];
  kind: "group" | "question";
}

export function resolveDrillSection(
  questions: AuditQuestion[],
  key: string,
  records?: AnalysisRecord[],
): DrillSection | null {
  if (key === "indicator-total") return null;
  const sections = scoringSections(questions);
  const found = sections.find((s) => s.key === key);
  if (found) {
    return {
      ids: [...found.ids],
      kind: questions.some((q) => Boolean(q.groupId)) ? "group" : "question",
    };
  }
  if (key === "historical-questions" && records) {
    const knownIds = new Set(questions.map((q) => q.id));
    const ids = new Set<string>();
    for (const r of records) {
      for (const a of r.answers) {
        if (a.questionId && !knownIds.has(a.questionId)) ids.add(a.questionId);
      }
    }
    return { ids: [...ids], kind: "group" };
  }
  if (key.startsWith("historical-")) {
    const qid = key.slice("historical-".length).split("\u0000")[0];
    if (qid) return { ids: [qid], kind: "question" };
  }
  return null;
}

/** 單筆紀錄在指定題組內的（是，否）；excluded（不適用／空值）不列入。 */
function sectionCountsOf(record: AnalysisRecord, ids: Set<string>) {
  let yes = 0;
  let no = 0;
  for (const answer of record.answers) {
    if (!ids.has(answer.questionId) || answer.excluded) continue;
    if (answer.optionLabel === "是") yes += 1;
    else if (answer.optionLabel === "否") no += 1;
  }
  return { yes, no };
}

/**
 * 下探 L1 的分組／逐題正確率（v1.50.0）：人次口徑，與主格 passRateOf 同口徑。
 * 分組：每人先算該組 rate 再判 ≥ 閾值（全不適用＝不達標）；逐題：該題答「是」
 * 者為達標人次。閾值逐筆優先用排程快照 thresholdAtSchedule。
 */
export function sectionPassRateOf(
  records: AnalysisRecord[],
  ids: string[],
  kind: "group" | "question",
  threshold: number,
): PassRate {
  const idSet = new Set(ids);
  let pass = 0;
  for (const record of records) {
    const th =
      typeof record.thresholdAtSchedule === "number"
        ? record.thresholdAtSchedule
        : threshold;
    if (kind === "question") {
      const hit = record.answers.some(
        (a) => idSet.has(a.questionId) && !a.excluded && a.optionLabel === "是",
      );
      if (hit) pass += 1;
      continue;
    }
    const { yes, no } = sectionCountsOf(record, idSet);
    const rate = yes + no > 0 ? round1((yes / (yes + no)) * 100) : null;
    if (isPassing(rate, th)) pass += 1;
  }
  return {
    pass,
    total: records.length,
    rate: records.length > 0 ? round1((pass / records.length) * 100) : null,
  };
}

/** 原因詞庫下探（v1.50.0）：勾選指定原因的紀錄與作答（每筆紀錄每題一則）。 */
export interface CauseRecordEntry {
  record: AnalysisRecord;
  questionId: string;
  itemText: string;
  optionLabel: string;
}

export function causeRecordEntries(
  records: AnalysisRecord[],
  cause: string,
): CauseRecordEntry[] {
  const target = cause.trim();
  if (!target) return [];
  const entries: CauseRecordEntry[] = [];
  for (const record of records) {
    for (const answer of record.answers) {
      if ((answer.commonErrors ?? []).some((w) => w.trim() === target)) {
        entries.push({
          record,
          questionId: answer.questionId,
          itemText: answer.itemText,
          optionLabel: answer.optionLabel,
        });
      }
    }
  }
  entries.sort(
    (a, b) =>
      a.record.personEmpNo.localeCompare(b.record.personEmpNo, "zh-Hant") ||
      a.record.year - b.record.year ||
      a.record.month - b.record.month,
  );
  return entries;
}

/** 單筆補充說明（v1.41.1）：某筆紀錄某題的備註。 */
export interface RecordNoteEntry {
  personEmpNo: string;
  personName: string;
  year: number;
  month: number;
  questionId: string;
  itemText: string;
  optionLabel: string;
  note: string;
}

/**
 * 收集指定紀錄中有補充說明的作答（v1.41.1，純函式）：只收 note 非空者
 * （無備註不列入、不佔位）；依指標題目順序排列，無對應題目者排最後；
 * 同題依人員職編、年月排序。
 */
export function collectRecordNotes(
  records: AnalysisRecord[],
  questions: AuditQuestion[],
): RecordNoteEntry[] {
  const order = new Map(questions.map((q, i) => [q.id, i]));
  const entries: RecordNoteEntry[] = [];
  for (const r of records) {
    for (const a of r.answers) {
      const note = (a.note ?? "").trim();
      if (!note) continue;
      entries.push({
        personEmpNo: r.personEmpNo,
        personName: r.personName,
        year: r.year,
        month: r.month,
        questionId: a.questionId,
        itemText: a.itemText,
        optionLabel: a.optionLabel,
        note,
      });
    }
  }
  entries.sort(
    (x, y) =>
      (order.get(x.questionId) ?? Infinity) -
        (order.get(y.questionId) ?? Infinity) ||
      x.personEmpNo.localeCompare(y.personEmpNo, "zh-Hant") ||
      x.year - y.year ||
      x.month - y.month,
  );
  return entries;
}

/** 彙整後單筆補充說明（v1.43.0）：一筆紀錄的所有備註彙整為一則。 */
export interface ConsolidatedRecordNote {
  personEmpNo: string;
  personName: string;
  year: number;
  month: number;
  /** 彙整文字：單則備註時為備註原文；多則時每則附題號，如「第1題：xxx；第2題：yyy」 */
  note: string;
  /** 彙整的各則備註（題號依指標題目順序；無對應題目者題號為 0） */
  parts: { questionNo: number; itemText: string; optionLabel: string; note: string }[];
}

/**
 * 彙整指定紀錄的補充說明（v1.43.0，純函式）：每筆紀錄彙整為一則，只收
 * 有備註的紀錄（無備註不列入、不佔位）。單則備註時不加題號，多則時每則
 * 附題號（依指標題目順序；無對應題目者排最後、不加題號）；依人員職編、
 * 年月排序。審查執行頁來的紀錄（每題各有備註）與匯入的紀錄（備註在最
 * 後一題）皆以同一規則彙整，查詢畫面只顯示彙整後的一則。
 */
export function collectConsolidatedRecordNotes(
  records: AnalysisRecord[],
  questions: AuditQuestion[],
): ConsolidatedRecordNote[] {
  const order = new Map(questions.map((q, i) => [q.id, i]));
  const entries: ConsolidatedRecordNote[] = [];
  for (const r of records) {
    const parts = r.answers
      .map((a) => ({
        questionNo: (order.get(a.questionId) ?? -1) + 1,
        itemText: a.itemText,
        optionLabel: a.optionLabel,
        note: (a.note ?? "").trim(),
      }))
      .filter((p) => p.note !== "")
      // 題號 0（無對應題目）排最後
      .sort((x, y) => (x.questionNo || Infinity) - (y.questionNo || Infinity));
    if (parts.length === 0) continue;
    entries.push({
      personEmpNo: r.personEmpNo,
      personName: r.personName,
      year: r.year,
      month: r.month,
      note: mergeNoteParts(parts.map((p) => ({ questionNo: p.questionNo, note: p.note }))),
      parts,
    });
  }
  entries.sort(
    (x, y) =>
      x.personEmpNo.localeCompare(y.personEmpNo, "zh-Hant") ||
      x.year - y.year ||
      x.month - y.month,
  );
  return entries;
}

/** 曆年月鍵（過濾用） */
export function monthKey(year: number, month: number): number {
  return year * 100 + month;
}

/** 取出落在指定曆年月集合內的紀錄 */
export function recordsInMonths(
  records: AnalysisRecord[],
  months: { year: number; month: number }[],
): AnalysisRecord[] {
  const keys = new Set(months.map((m) => monthKey(m.year, m.month)));
  return records.filter((r) => keys.has(monthKey(r.year, r.month)));
}

/* ================= 各選項得分狀況（文件圖示／指標選項明細共用） ================= */

export interface OptionDetailRow {
  indicatorVersion?: string;
  questionId: string;
  itemText: string;
  order: number;
  yes: number;
  no: number;
  /** 不適用（含未填） */
  na: number;
  total: number;
  yesRate: number | null;
  noRate: number | null;
  naRate: number | null;
  /** 得分率＝是／（是＋否），％一位小數；是＋否＝0 回 null */
  scoreRate: number | null;
}

/**
 * 各選項得分狀況：列＝題目（依指標題目順序），欄＝是／否／不適用（人次＋比率）、
 * 得分率。只計入當前題目；已刪題目的作答不列入。
 */
export function optionDetailRows(
  records: AnalysisRecord[],
  questions: AuditQuestion[],
): OptionDetailRow[] {
  const counts = new Map<string, { yes: number; no: number; na: number }>();
  for (const r of records) {
    for (const a of r.answers) {
      const c = counts.get(a.questionId) ?? { yes: 0, no: 0, na: 0 };
      if (a.optionLabel === "是") c.yes += 1;
      else if (a.optionLabel === "否") c.no += 1;
      else c.na += 1;
      counts.set(a.questionId, c);
    }
  }
  return [...questions]
    .sort((a, b) => a.order - b.order)
    .map((q) => {
      const c = counts.get(q.id) ?? { yes: 0, no: 0, na: 0 };
      const total = c.yes + c.no + c.na;
      const pct = (n: number): number | null =>
        total > 0 ? round1((n / total) * 100) : null;
      return {
        questionId: q.id,
        itemText: q.itemText,
        order: q.order,
        yes: c.yes,
        no: c.no,
        na: c.na,
        total,
        yesRate: pct(c.yes),
        noRate: pct(c.no),
        naRate: pct(c.na),
        scoreRate:
          c.yes + c.no > 0
            ? round1((c.yes / (c.yes + c.no)) * 100)
            : null,
      };
    });
}


export interface QuestionErrorRow {
  indicatorVersion: string;
  sourceVersions?: string[];
  questionId: string;
  itemText: string;
  yes: number;
  no: number;
  notApplicable: number;
  validCount: number;
  errorRate: number | null;
}

/**
 * 錯題排行：以「否」為錯誤，「不適用」不納入錯誤率分母；
 * 跨版本按完全相同的題目文字合併排行並列出來源版本；僅供錯誤量排行，不代表版本等價／趨勢可合併。
 * 每筆紀錄同一題只計一次，重複 questionId 以最後一個答案為準。
 */
export function questionErrorRows(records: AnalysisRecord[]): QuestionErrorRow[] {
  const counts = new Map<string, QuestionErrorRow>();
  const versionsByText = new Map<string, Set<string>>();
  for (const record of records) {
    const version = record.indicatorVersion || "版本未記錄";
    const latest = new Map<string, AnalysisAnswer>();
    for (const answer of record.answers) {
      if (answer.questionId) latest.set(answer.questionId, answer);
    }
    for (const answer of latest.values()) {
      const itemText = (answer.itemText || "（題目文字未保存）").trim().replace(/\s+/g, " ");
      const key = itemText;
      const versions = versionsByText.get(key) ?? new Set<string>();
      versions.add(version);
      versionsByText.set(key, versions);
      const row = counts.get(key) ?? {
        indicatorVersion: version,
        questionId: answer.questionId,
        itemText,
        yes: 0,
        no: 0,
        notApplicable: 0,
        validCount: 0,
        errorRate: null,
      };
      if (answer.optionLabel === "是") row.yes += 1;
      else if (answer.optionLabel === "否") row.no += 1;
      else if (answer.optionLabel === "不適用") row.notApplicable += 1;
      counts.set(key, row);
    }
  }
  return [...counts.entries()]
    .map(([key, row]) => {
      const validCount = row.yes + row.no;
      const sourceVersions = [...(versionsByText.get(key) ?? [])].sort((a, b) => a.localeCompare(b, "zh-Hant"));
      return {
        ...row,
        sourceVersions,
        indicatorVersion: sourceVersions.length > 1 ? `跨版本（${sourceVersions.join("、")}）` : sourceVersions[0] ?? "版本未記錄",
        validCount,
        errorRate: validCount > 0 ? round1((row.no / validCount) * 100) : null,
      };
    })
    .sort(
      (a, b) =>
        b.no - a.no ||
        (b.errorRate ?? -1) - (a.errorRate ?? -1) ||
        a.indicatorVersion.localeCompare(b.indicatorVersion, "zh-Hant") ||
        a.itemText.localeCompare(b.itemText, "zh-Hant"),
    );
}

/** 由預存摘要的分組題目選項計數產生錯題排行，不讀逐筆審查資料。 */
export function questionErrorRowsFromSummaries(
  summaries: {
    indicatorVersion: string;
    questionOptions: {
      questionId: string;
      itemText: string;
      yes: number;
      no: number;
      notApplicable: number;
    }[];
  }[],
): QuestionErrorRow[] {
  const totals = new Map<string, QuestionErrorRow>();
  const versionsByText = new Map<string, Set<string>>();
  for (const summary of summaries) {
    for (const question of summary.questionOptions) {
      const itemText = (question.itemText || "（題目文字未保存）").trim().replace(/\s+/g, " ");
      const key = itemText;
      const versions = versionsByText.get(key) ?? new Set<string>();
      versions.add(summary.indicatorVersion || "版本未記錄");
      versionsByText.set(key, versions);
      const row = totals.get(key) ?? {
        indicatorVersion: summary.indicatorVersion || "版本未記錄",
        questionId: question.questionId,
        itemText,
        yes: 0,
        no: 0,
        notApplicable: 0,
        validCount: 0,
        errorRate: null,
      };
      row.yes += question.yes;
      row.no += question.no;
      row.notApplicable += question.notApplicable;
      totals.set(key, row);
    }
  }
  return [...totals.entries()]
    .map(([key, row]) => {
      const validCount = row.yes + row.no;
      const sourceVersions = [...(versionsByText.get(key) ?? [])].sort((a, b) => a.localeCompare(b, "zh-Hant"));
      return {
        ...row,
        sourceVersions,
        indicatorVersion: sourceVersions.length > 1 ? `跨版本（${sourceVersions.join("、")}）` : sourceVersions[0] ?? "版本未記錄",
        validCount,
        errorRate: validCount > 0 ? round1((row.no / validCount) * 100) : null,
      };
    })
    .sort(
      (a, b) =>
        b.no - a.no ||
        (b.errorRate ?? -1) - (a.errorRate ?? -1) ||
        a.indicatorVersion.localeCompare(b.indicatorVersion, "zh-Hant") ||
        a.itemText.localeCompare(b.itemText, "zh-Hant"),
    );
}
