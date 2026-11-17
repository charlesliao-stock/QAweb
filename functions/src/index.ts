import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret, defineString } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import nodemailer from "nodemailer";

initializeApp();
const db = getFirestore();
const SMTP_HOST = defineString("SMTP_HOST", { default: "" });
const SMTP_PORT = defineString("SMTP_PORT", { default: "587" });
const SMTP_USER = defineSecret("SMTP_USER");
const SMTP_PASSWORD = defineSecret("SMTP_PASSWORD");
const SMTP_FROM = defineString("SMTP_FROM", { default: "" });
const EMAIL_ENABLED = defineString("REVIEW_SUMMARY_EMAIL_ENABLED", { default: "false" });

type Scope = "unit" | "all";
type Raw = Record<string, unknown>;
interface Answer { questionId: string; itemText: string; optionLabel: string }
interface Source { id: string; data: Raw }
interface Bucket {
  indicatorId: string;
  scheduleStartYear: number;
  scheduleStartMonth: number;
  indicatorVersion: string;
}
const text = (value: unknown): string => typeof value === "string" ? value : "";
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function bucketOf(data: Raw | undefined): Bucket | null {
  if (!data) return null;
  const bucket: Bucket = {
    indicatorId: text(data.indicatorId),
    scheduleStartYear: num(data.scheduleStartYear) ?? 0,
    scheduleStartMonth: num(data.scheduleStartMonth) ?? 0,
    indicatorVersion: text(data.indicatorVersionAtSchedule),
  };
  if (!bucket.indicatorId || !bucket.indicatorVersion || bucket.scheduleStartYear < 1 ||
      bucket.scheduleStartMonth < 1 || bucket.scheduleStartMonth > 12) return null;
  return bucket;
}
function bucketKey(bucket: Bucket): string {
  return [bucket.indicatorId, bucket.scheduleStartYear, bucket.scheduleStartMonth, bucket.indicatorVersion]
    .map((part) => encodeURIComponent(String(part))).join("__");
}
function summaryId(data: Raw, scope: Scope): string {
  const year = num(data.scheduleStartYear) ?? 0;
  const month = num(data.scheduleStartMonth) ?? 0;
  const unitId = text(data.unitId);
  return [encodeURIComponent(text(data.indicatorId)), `${year}-${String(month).padStart(2, "0")}`,
    encodeURIComponent(text(data.indicatorVersionAtSchedule)), scope,
    scope === "all" ? "all" : encodeURIComponent(unitId)].join("__");
}
function eligibleSource({ id, data }: Source): {
  id: string; bucket: Bucket; rate: number; threshold: number; unitId: string;
  scheduleEndYear: number | null; scheduleEndMonth: number | null; answers: Answer[];
} | null {
  const bucket = bucketOf(data);
  const rate = num(data.rate);
  const threshold = num(data.thresholdAtSchedule);
  const unitId = text(data.unitId);
  const scheduleEndYear = num(data.scheduleEndYear);
  const scheduleEndMonth = num(data.scheduleEndMonth);
  if (!bucket || rate === null || threshold === null || !unitId ||
      scheduleEndYear === null || scheduleEndYear < 1 || scheduleEndMonth === null || scheduleEndMonth < 1 || scheduleEndMonth > 12 ||
      text(data.thresholdRuleAtSchedule) !== ">=" || !Array.isArray(data.answers)) return null;
  const answers = data.answers.flatMap((raw): Answer[] => {
    if (!raw || typeof raw !== "object") return [];
    const answer = raw as Raw;
    const questionId = text(answer.questionId);
    return questionId ? [{ questionId, itemText: text(answer.itemText), optionLabel: text(answer.optionLabel) }] : [];
  });
  return {
    id, bucket, rate, threshold, unitId,
    scheduleEndYear,
    scheduleEndMonth,
    answers,
  };
}
function buildSummaries(sources: Source[]): Raw[] {
  const unique = new Map<string, NonNullable<ReturnType<typeof eligibleSource>>>();
  for (const source of sources) {
    const item = eligibleSource(source);
    if (item) unique.set(item.id, item);
  }
  const groups = new Map<string, Raw>();
  for (const source of unique.values()) {
    const { bucket, rate, threshold, unitId, answers } = source;
    for (const scope of ["unit", "all"] as const) {
      const summaryData: Raw = {
        indicatorId: bucket.indicatorId,
        scheduleStartYear: bucket.scheduleStartYear,
        scheduleStartMonth: bucket.scheduleStartMonth,
        scheduleStartKey: bucket.scheduleStartYear * 100 + bucket.scheduleStartMonth,
        indicatorVersion: bucket.indicatorVersion,
        scope,
        unitId: scope === "unit" ? unitId : null,
        threshold,
      };
      const id = summaryId({ ...summaryData, indicatorVersionAtSchedule: bucket.indicatorVersion }, scope);
      let group = groups.get(id);
      if (!group) {
        group = {
          id,
          ...summaryData,
          scheduleEndYear: source.scheduleEndYear ?? undefined,
          scheduleEndMonth: source.scheduleEndMonth ?? undefined,
          thresholdRule: ">=",
          passedCount: 0,
          totalCount: 0,
          questionOptions: [] as Raw[],
          _questions: new Map<string, Raw>(),
        };
        groups.set(id, group);
      } else if (group.threshold !== threshold || group.scheduleEndYear !== source.scheduleEndYear || group.scheduleEndMonth !== source.scheduleEndMonth) {
        throw new Error(`排程快照不一致，拒絕彙總：${bucket.indicatorId}/${bucket.scheduleStartYear}-${bucket.scheduleStartMonth}/${bucket.indicatorVersion}`);
      }
      group.totalCount = Number(group.totalCount) + 1;
      if (rate >= threshold) group.passedCount = Number(group.passedCount) + 1;
      const questionMap = group._questions as Map<string, Raw>;
      const latestAnswers = new Map<string, Answer>();
      for (const answer of answers) latestAnswers.set(answer.questionId, answer);
      for (const answer of latestAnswers.values()) {
        let question = questionMap.get(answer.questionId);
        if (!question) {
          question = { questionId: answer.questionId, itemText: answer.itemText, yes: 0, no: 0, notApplicable: 0, reasonCounts: {} };
          questionMap.set(answer.questionId, question);
        }
        if (answer.optionLabel === "是") question.yes = Number(question.yes) + 1;
        else if (answer.optionLabel === "否") question.no = Number(question.no) + 1;
        else if (answer.optionLabel === "不適用") question.notApplicable = Number(question.notApplicable) + 1;
      }
    }
  }
  return [...groups.values()].map((group) => {
    const questions = group._questions as Map<string, Raw>;
    delete group._questions;
    group.questionOptions = [...questions.values()].sort((a, b) => text(a.questionId).localeCompare(text(b.questionId), "zh-Hant"));
    return group;
  });
}
function bucketRecords(bucket: Bucket) {
  return db.collection("reviewRecords")
    .where("indicatorId", "==", bucket.indicatorId)
    .where("scheduleStartYear", "==", bucket.scheduleStartYear)
    .where("scheduleStartMonth", "==", bucket.scheduleStartMonth)
    .where("indicatorVersionAtSchedule", "==", bucket.indicatorVersion);
}
function bucketSummaries(bucket: Bucket) {
  return db.collection("reviewSummaries")
    .where("indicatorId", "==", bucket.indicatorId)
    .where("scheduleStartYear", "==", bucket.scheduleStartYear)
    .where("scheduleStartMonth", "==", bucket.scheduleStartMonth)
    .where("indicatorVersion", "==", bucket.indicatorVersion);
}
async function commitSummarySet(summaries: Raw[], oldDocs: { id: string; ref: any }[]): Promise<void> {
  const nextIds = new Set(summaries.map((summary) => text(summary.id)));
  const operations: Array<{ type: "delete"; ref: FirebaseFirestore.DocumentReference } | { type: "set"; ref: FirebaseFirestore.DocumentReference; data: Raw }> = [];
  for (const oldDoc of oldDocs) if (!nextIds.has(oldDoc.id)) operations.push({ type: "delete", ref: oldDoc.ref });
  for (const summary of summaries) {
    const { id, ...data } = summary;
    operations.push({
      type: "set",
      ref: db.collection("reviewSummaries").doc(text(id)),
      data: { ...data, precomputedAt: FieldValue.serverTimestamp(), refreshStatus: "ready" },
    });
  }
  for (let offset = 0; offset < operations.length; offset += 400) {
    const batch = db.batch();
    for (const operation of operations.slice(offset, offset + 400)) {
      if (operation.type === "delete") batch.delete(operation.ref);
      else batch.set(operation.ref, operation.data);
    }
    await batch.commit();
  }
}
async function refreshBucket(bucket: Bucket): Promise<void> {
  const [records, existingSummaries] = await Promise.all([bucketRecords(bucket).get(), bucketSummaries(bucket).get()]);
  const sources = records.docs.map((document) => ({ id: document.id, data: document.data() as Raw }));
  await commitSummarySet(buildSummaries(sources), existingSummaries.docs);
}
async function refreshExistingSummaryBuckets(before: Raw | undefined, after: Raw | undefined): Promise<Bucket[]> {
  const buckets = new Map<string, Bucket>();
  for (const data of [before, after]) {
    const bucket = bucketOf(data);
    if (bucket) buckets.set(bucketKey(bucket), bucket);
  }
  for (const bucket of buckets.values()) {
    // 初次建摘要只由每月 11 日工作建立；記錄增刪改只刷新已存在的摘要。
    const existing = await bucketSummaries(bucket).limit(1).get();
    if (!existing.empty) await refreshBucket(bucket);
  }
  return [...buckets.values()];
}
function endedMonthRecords(year: number, month: number) {
  return db.collection("reviewRecords")
    .where("scheduleEndYear", "==", year)
    .where("scheduleEndMonth", "==", month);
}
async function refreshEndedMonth(year: number, month: number): Promise<void> {
  const [records, oldSummaries] = await Promise.all([
    endedMonthRecords(year, month).get(),
    db.collection("reviewSummaries").where("scheduleEndYear", "==", year).where("scheduleEndMonth", "==", month).get(),
  ]);
  const summaries = buildSummaries(records.docs.map((document) => ({ id: document.id, data: document.data() as Raw })));
  await commitSummarySet(summaries, oldSummaries.docs);
}

async function notifyAdmins(error: unknown, jobId: string): Promise<void> {
  const users = await db.collection("users").get();
  const admins = users.docs.filter((user) => Array.isArray(user.get("roles")) && (user.get("roles") as unknown[]).includes("系統管理員"));
  const message = `品質審查摘要預計算失敗兩次（工作 ${jobId}）。請檢查 Cloud Functions 與資料；${error instanceof Error ? error.message : String(error)}`;
  for (let offset = 0; offset < admins.length; offset += 400) {
    const batch = db.batch();
    for (const user of admins.slice(offset, offset + 400)) {
      batch.set(db.collection("notifications").doc(`${jobId}_${user.id}`), {
        userId: user.id, type: "reviewSummaryFailure", title: "品質摘要重算失敗", message,
        createdAt: FieldValue.serverTimestamp(), read: false, jobId,
      });
    }
    await batch.commit();
  }
  if (EMAIL_ENABLED.value() !== "true" || !SMTP_HOST.value() || !SMTP_USER.value() || !SMTP_PASSWORD.value() || !SMTP_FROM.value()) return;
  const port = Number(SMTP_PORT.value()) || 587;
  const transport = nodemailer.createTransport({ host: SMTP_HOST.value(), port, secure: port === 465, auth: { user: SMTP_USER.value(), pass: SMTP_PASSWORD.value() } });
  for (const user of admins) {
    const email = text(user.get("email"));
    if (!email) {
      await db.collection("notifications").doc(`${jobId}_${user.id}`).set({ message: `${message} 請先在個人資料補上電子郵件，以接收後續通知。` }, { merge: true });
      continue;
    }
    try { await transport.sendMail({ from: SMTP_FROM.value(), to: email, subject: "品質審查摘要重算失敗", text: message }); }
    catch (mailError) { logger.error("Admin email notification failed", { uid: user.id, error: mailError }); }
  }
}
interface RetryJob {
  type: "bucket" | "month";
  bucket?: Bucket;
  year?: number;
  month?: number;
  attempts: number;
}
async function enqueueRetry(id: string, job: Omit<RetryJob, "attempts">, error: unknown): Promise<void> {
  const reference = db.collection("reviewSummaryRetries").doc(id);
  if ((await reference.get()).exists) return;
  await reference.set({ ...job, attempts: 1, status: "pending", nextAttemptAt: Date.now() + 86_400_000, lastError: String(error), createdAt: FieldValue.serverTimestamp() });
}
async function runRetry(job: RetryJob): Promise<void> {
  if (job.type === "bucket" && job.bucket) return refreshBucket(job.bucket);
  if (job.type === "month" && typeof job.year === "number" && typeof job.month === "number") return refreshEndedMonth(job.year, job.month);
  throw new Error("摘要重試工作缺少有效範圍");
}
async function retryPending(): Promise<void> {
  const due = await db.collection("reviewSummaryRetries").where("status", "==", "pending").where("nextAttemptAt", "<=", Date.now()).get();
  for (const document of due.docs) {
    const job = document.data() as RetryJob;
    try {
      await runRetry(job);
      await document.ref.set({ status: "done", completedAt: FieldValue.serverTimestamp() }, { merge: true });
    } catch (error) {
      const attempts = Number(job.attempts || 1) + 1;
      if (attempts >= 2) {
        await document.ref.set({ status: "failed", attempts, lastError: String(error), failedAt: FieldValue.serverTimestamp() }, { merge: true });
        await notifyAdmins(error, document.id);
      } else {
        await document.ref.set({ attempts, lastError: String(error), nextAttemptAt: Date.now() + 86_400_000 }, { merge: true });
      }
    }
  }
}

export const refreshReviewSummaryOnRecordWrite = onDocumentWritten(
  { document: "reviewRecords/{recordId}", region: "asia-east1" },
  async (event) => {
    const before = event.data?.before.exists ? event.data.before.data() as Raw : undefined;
    const after = event.data?.after.exists ? event.data.after.data() as Raw : undefined;
    const buckets = [bucketOf(before), bucketOf(after)].filter((bucket): bucket is Bucket => Boolean(bucket));
    if (buckets.length === 0) return; // 舊紀錄無不可變快照，避免以現行閾值錯算。
    try {
      await refreshExistingSummaryBuckets(before, after);
    } catch (error) {
      logger.error("Review summary refresh failed", { recordId: event.params.recordId, error });
      for (const [key, bucket] of new Map(buckets.map((bucket) => [bucketKey(bucket), bucket]))) {
        await enqueueRetry(`change_${event.id}_${key}`, { type: "bucket", bucket }, error);
      }
    }
  },
);

export const precomputeMonthlyReviewSummaries = onSchedule(
  { schedule: "0 8 * * *", timeZone: "Asia/Taipei", region: "asia-east1", secrets: [SMTP_USER, SMTP_PASSWORD] },
  async () => {
    await retryPending();
    const taipeiNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
    if (taipeiNow.getDate() !== 11) return;
    const previousMonth = new Date(taipeiNow.getFullYear(), taipeiNow.getMonth() - 1, 1);
    const year = previousMonth.getFullYear();
    const month = previousMonth.getMonth() + 1;
    try {
      await refreshEndedMonth(year, month);
    } catch (error) {
      const id = `monthly_${year}_${String(month).padStart(2, "0")}`;
      await enqueueRetry(id, { type: "month", year, month }, error);
      logger.error("Monthly review summary precompute failed", { year, month, error });
    }
  },
);
