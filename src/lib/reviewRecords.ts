/** 審查執行紀錄（v1.10.0 新增；v1.11.0 起改為逐件：一 task 可有多筆） */

/** 單題作答快照 */
export interface ReviewAnswer {
  /** 題目 id（指標審核表題目） */
  questionId: string;
  /** 指標項目文字（快照，題目日後修改不影響已送紀錄） */
  itemText: string;
  /** 選擇的選項文字（快照） */
  optionLabel: string;
  /** 該選項分數 */
  score: number;
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
 * 計算審查得分（純函式）。
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
