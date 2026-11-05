/** 審查執行紀錄（v1.10.0 新增；v1.11.0 起改為逐件：一 task 可有多筆） */

import type { AuditQuestion } from "./indicators";

/** 單題作答快照 */
export interface ReviewAnswer {
  /** 題目 id（指標審核表題目） */
  questionId: string;
  /** 指標項目文字（快照，題目日後修改不影響已送紀錄） */
  itemText: string;
  /** 選擇的選項文字（快照；v1.17 起為 是／否／不適用） */
  optionLabel: string;
  /** 該選項分數（v1.17：是＝1、否＝0、不適用＝0 但 excluded=true） */
  score: number;
  /** v1.17 新增：不適用＝不計入分子分母 */
  excluded?: boolean;
  /** 該題備註（v1.15.0 新增，選填） */
  note?: string;
}

export interface ReviewRecord {
  taskId: string;
  indicatorId: string;
  unitId: string;
  reviewerId: string;
  year: number;
  month: number;
  /** 件次（v1.11.0 起逐件；舊格式單筆為 null，統計時視為第 1 件） */
  caseSeq: number | null;
  /** 審查日期 YYYY-MM-DD（v1.11.0 新增） */
  reviewDate: string;
  /** 審查人員職編（v1.11.0 新增；可能與任務指派的審查員不同人） */
  reviewerEmpNo: string;
  /** 審查人員姓名（v1.11.0 新增，快照） */
  reviewerName: string;
  /** 受審人員職編（v1.15.0 新增，必填） */
  reviewedPersonEmpNo: string;
  /** 受審人員姓名（v1.15.0 新增，快照） */
  reviewedPersonName: string;
  /** 病人床號（v1.15.0 新增；僅指標 requireBedNo 時必填） */
  bedNo: string;
  answers: ReviewAnswer[];
  totalScore: number;
  maxScore: number;
  /** 正確率（總得分÷總滿分×100%，四捨五入到小數 1 位；滿分為 0 時為 null） */
  rate: number | null;
  submittedAt: unknown;
  /** 送出者職編 */
  submittedBy: string;
}

/**
 * reviewRecords 的舊 doc id 即 taskId（一 task 一筆，upsert；v1.10.0 格式）。
 * v1.11.0 起逐件寫入請用 reviewProgress.reviewCaseDocId(taskId, seq)。
 */
export function reviewRecordDocId(taskId: string): string {
  return taskId;
}

/**
 * 計算審查得分（純函式；v1.16 前舊模型保留相容）。
 * selections：每題 {得分, 該題滿分（選項中最高分）}。
 * 回傳總得分／總滿分／正確率（滿分 0 → null）。
 */
export function computeReviewScore(
  selections: { score: number; maxOptionScore: number }[],
): { totalScore: number; maxScore: number; rate: number | null } {
  const totalScore = selections.reduce((n, s) => n + s.score, 0);
  const maxScore = selections.reduce((n, s) => n + s.maxOptionScore, 0);
  const rate =
    maxScore > 0 ? Math.round((totalScore / maxScore) * 1000) / 10 : null;
  return { totalScore, maxScore, rate };
}

/**
 * 計算審查得分（v1.17 選項集模型，純函式）。
 * 每題：是＝1 分（計入分子分母）、否＝0 分（計入分母）、
 * 不適用＝excluded（分子分母皆排除）。
 * 回傳總得分／計入題數／正確率（計入 0 題 → null）。
 */
export function computeOptionSetScore(
  selections: { score: number; excluded: boolean }[],
): { totalScore: number; maxScore: number; rate: number | null } {
  const counted = selections.filter((s) => !s.excluded);
  const totalScore = counted.reduce((n, s) => n + s.score, 0);
  const maxScore = counted.length;
  const rate =
    maxScore > 0 ? Math.round((totalScore / maxScore) * 1000) / 10 : null;
  return { totalScore, maxScore, rate };
}

/* ================= 檢視用逐題明細純函式（v1.24） ================= */

/** 檢視用逐題明細列：以作答快照為準，對照指標題目取分組與指引 */
export interface ReviewViewRow {
  questionId: string;
  /** 全域題號（依指標題目順序；快照無對應題目時為 0，不顯示編號） */
  num: number;
  itemText: string;
  optionLabel: string;
  /** 每題備註（選填；快照的 note） */
  note: string;
  guidance: string;
  groupId: string | null;
  groupName: string;
}

/** 檢視用分組區段：一個組別一段；未分組／無對應題目者自成一段 */
export interface ReviewViewSection {
  groupId: string | null;
  groupName: string;
  rows: ReviewViewRow[];
}

/**
 * 由作答快照解析檢視用分組明細（v1.24，純函式）：
 * - 按指標題目順序排列；分組與指引以當前指標題目為準
 * - 快照無對應題目（題目已刪）者排在最後、歸入未分組，題目文字取快照
 * - showGroups=false 時全部為一段、不顯示分組
 */
export function resolveReviewViewSections(
  questions: AuditQuestion[],
  answers: ReviewAnswer[],
  showGroups: boolean,
): ReviewViewSection[] {
  if (answers.length === 0) return [];
  const numById = new Map(questions.map((q, i) => [q.id, i + 1]));
  const qById = new Map(questions.map((q) => [q.id, q]));
  const rows: ReviewViewRow[] = answers.map((a) => {
    const q = qById.get(a.questionId);
    return {
      questionId: a.questionId,
      num: numById.get(a.questionId) ?? 0,
      itemText: a.itemText,
      optionLabel: a.optionLabel,
      note: (a.note ?? "").trim(),
      guidance: q?.guidance ?? "",
      groupId: showGroups ? (q?.groupId ?? null) : null,
      groupName:
        showGroups && q?.groupId ? q.groupName || "未命名分組" : "",
    };
  });
  // 有對應題號者依題號排，無對應者排最後（維持作答順序）
  rows.sort((a, b) => (a.num || Infinity) - (b.num || Infinity));
  const sections: ReviewViewSection[] = [];
  const byKey = new Map<string, ReviewViewSection>();
  for (const r of rows) {
    const key = r.groupId ?? "";
    let sec = byKey.get(key);
    if (!sec) {
      sec = { groupId: r.groupId, groupName: r.groupName, rows: [] };
      byKey.set(key, sec);
      sections.push(sec);
    }
    sec.rows.push(r);
  }
  return sections;
}
