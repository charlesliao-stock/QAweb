/**
 * v1.11.0 測試：用 esbuild 把純函式 lib 打包後在 node 跑斷言。
 * 涵蓋：逐件累計／完成判斷、雙頁籤分類、查詢列表（schema 相容）。
 * 執行：node scripts/test-v1.11.mjs
 */
import { build } from "esbuild";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

const dir = mkdtempSync(join(tmpdir(), "qatest-"));
/* v1.16 起 scheduling.ts 接入 ./db（firebase）做寫入持久化；純函式測試不需要它，
 * 用 stub 擋掉以免把 firebase/firestore（含 grpc）拖進 node bundle。 */
const stubPlugin = {
  name: "stub-db-audit",
  setup(build) {
    build.onResolve({ filter: /^\.\/(db|audit)$/ }, (args) => ({ path: args.path, namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents:
        "export const collection=()=>{throw new Error('stub')};export const deleteDoc=async()=>{};export const doc=()=>{throw new Error('stub')};export const getDoc=async()=>({exists:()=>false});export const getDocs=async()=>({docs:[]});export const query=()=>({});export const serverTimestamp=()=>null;export const setDoc=async()=>{};export const where=()=>({});export const writeBatch=()=>({set(){},delete(){},commit:async()=>{}});export const logAudit=async()=>{};",
      loader: "js",
    }));
  },
};
for (const [src, out] of [
  ["src/lib/reviewProgress.ts", "rp.mjs"],
  ["src/lib/reviewRecords.ts", "rr.mjs"],
  ["src/lib/scheduling.ts", "sch.mjs"],
]) {
  await build({
    entryPoints: [src],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: join(dir, out),
    logLevel: "silent",
    plugins: [stubPlugin],
  });
}
const rp = await import(pathToFileURL(join(dir, "rp.mjs")).href);
const rr = await import(pathToFileURL(join(dir, "rr.mjs")).href);
const sch = await import(pathToFileURL(join(dir, "sch.mjs")).href);

let pass = 0;
const fails = [];
function t(name, cond) {
  if (cond) pass++;
  else fails.push(name);
}

/* ---- 逐件累計／完成判斷 ---- */
t("requiredCases(null)＝1", rp.requiredCases(null) === 1);
t("requiredCases(30)＝30", rp.requiredCases(30) === 30);
t("requiredCases(0)＝1", rp.requiredCases(0) === 1);
t("reviewCaseDocId 三位補零", rp.reviewCaseDocId("t1", 3) === "t1_c003");
t("reviewCaseDocId 兩位數", rp.reviewCaseDocId("t1", 12) === "t1_c012");
t("完成：30/30", rp.isTaskComplete(30, 30) === true);
t("未完成：29/30", rp.isTaskComplete(29, 30) === false);
t("caseCount null 視為 1：1 件即完成", rp.isTaskComplete(1, null) === true);
t("caseCount null：0 件未完成", rp.isTaskComplete(0, null) === false);
t("nextCaseSeq(0)＝1", rp.nextCaseSeq(0) === 1);
t("nextCaseSeq(5)＝6", rp.nextCaseSeq(5) === 6);

/* ---- 雙頁籤分類 ---- */
t("達標→done 頁籤", rp.taskTab(30, 30, false) === "done");
t("未達標→pending 頁籤", rp.taskTab(5, 30, false) === "pending");
t("0 件未完成→pending 頁籤（v1.12.2 起 legacyDone 參數已移除）", rp.taskTab(0, null) === "pending");
t("caseCount null 且 1 件→done 頁籤", rp.taskTab(1, null, false) === "done");
t("progressLabel 12/30", rp.progressLabel(12, 30) === "12/30");
t("progressLabel 0/1", rp.progressLabel(0, null) === "0/1");

/* ---- 查詢列表／schema 相容 ---- */
t("舊 doc id 保留：taskId", rr.reviewRecordDocId("t1") === "t1");
const sc = rr.computeReviewScore([
  { score: 2, maxOptionScore: 2 },
  { score: 1, maxOptionScore: 2 },
]);
t(
  "computeReviewScore 3/4＝75%",
  sc.totalScore === 3 && sc.maxScore === 4 && sc.rate === 75,
);
const sc0 = rr.computeReviewScore([{ score: 0, maxOptionScore: 0 }]);
t("computeReviewScore 滿分 0→rate null", sc0.rate === null);
t("isOverdue 既有行為", sch.isOverdue("2000-01-01", "pending") === true);
t("isOverdue done 不逾期", sch.isOverdue("2000-01-01", "done") === false);

console.log(`通過 ${pass} 項，失敗 ${fails.length} 項`);
if (fails.length > 0) {
  console.error("失敗項目：");
  fails.forEach((f) => console.error(" - " + f));
  process.exit(1);
}
