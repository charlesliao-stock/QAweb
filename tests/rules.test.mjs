// P0 rules 回歸測試（v1.85.5）：對 Firestore emulator 跑真實規則。
//
// 執行方式（本機需有 Java 11+ 與 firebase-tools；一次性安裝測試依賴）：
//   1. pnpm add -D @firebase/rules-unit-testing@4.0.1
//   2. npx firebase emulators:start --only firestore
//   3. 另開終端：pnpm test:rules
// 測試用 @firebase/rules-unit-testing（firebase@11），不寫入真實專案、不灌寫入。
// 注意：本測試在 2026-11-17 的雲端沙箱跑不起來——該環境的 emulator
// data plane（gRPC／REST）一律回 500 http2 exception，與規則本身無關；
// 在開發者本機（可正常跑 emulator 的環境）可直接執行。
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc, deleteDoc, serverTimestamp } from "firebase/firestore";
import { readFileSync } from "node:fs";

const PROJECT_ID = "p0-rules-test";
const RULES = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");

let pass = 0;
let fail = 0;
async function check(name, p) {
  try {
    await p;
    pass++;
    console.log(`  PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name} :: ${e.code ?? e.message}`);
  }
}

const baseTask = (over = {}) => ({
  indicatorId: "IND1",
  year: 2026,
  month: 11,
  unitId: "U1",
  reviewerId: "2222222",
  caseCount: 2,
  deadline: "2026-11-30",
  status: "pending",
  scheduleCategory: "periodic",
  schedulePeriod: "2026-11",
  indicatorVersionAtSchedule: "v1",
  thresholdAtSchedule: 0.8,
  thresholdRuleAtSchedule: ">=",
  scheduleStartYear: 2026,
  scheduleStartMonth: 11,
  scheduleEndYear: 2026,
  scheduleEndMonth: 11,
  createdAt: serverTimestamp(),
  ...over,
});

const baseRecord = (over = {}) => ({
  taskId: "taskC",
  indicatorId: "IND1",
  unitId: "U1",
  reviewerId: "2222222",
  year: 2026,
  month: 11,
  reviewDate: "2026-11-15",
  reviewerEmpNo: "2222222",
  reviewerName: "審查員A",
  reviewedPersonEmpNo: "9999999",
  reviewedPersonName: "受審者",
  uniqueKey: "",
  bedNo: "1",
  auditItem: "項目",
  answers: [],
  totalScore: 1,
  maxScore: 1,
  rate: 1,
  submittedAt: serverTimestamp(),
  submittedBy: "2222222",
  ...over,
});

async function main() {
  const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: RULES, host: "127.0.0.1", port: 8080 },
  });

  // ---- seed（繞過規則）----
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users", "1111111"), { staffId: "1111111", roles: ["召集人"], name: "召集人A" });
    await setDoc(doc(db, "users", "2222222"), { staffId: "2222222", roles: [], name: "審查員A", title: "護理師", titleId: "T1", unitCode: "U1", memberships: [] });
    await setDoc(doc(db, "users", "3333333"), { staffId: "3333333", roles: [], name: "審查員B" });
    await setDoc(doc(db, "users", "admin"), { staffId: "admin", roles: ["系統管理員"], name: "管理員" });
    await setDoc(doc(db, "reviewQuotaGroups", "g1"), {
      quotaGroupId: "g1",
      slotIds: ["g1__slot__1", "g1__slot__2"],
    });
    await setDoc(doc(db, "reviewTasks", "taskA"), baseTask({ quotaGroupId: "g1", quotaCategory: "period" }));
    await setDoc(doc(db, "reviewTasks", "taskB"), baseTask({ reviewerId: "3333333" }));
    await setDoc(doc(db, "reviewTasks", "taskC"), baseTask({}));
    await setDoc(doc(db, "reviewTasks", "taskDel"), baseTask({ reviewerId: "3333333" }));
    await setDoc(doc(db, "reviewRecords", "recA"), baseRecord({}));
    await setDoc(doc(db, "reviewReservations", "lockA"), {
      uniqueKey: "lockA",
      ownerId: "2222222",
      targetCollection: "reviewRecords",
      targetId: "recX",
      taskId: "taskC",
      indicatorId: "IND1",
      intervalId: "i1",
      personEmpNo: "9999999",
      status: "submitted",
      createdAt: serverTimestamp(),
    });
    await setDoc(doc(db, "schedules", "schedDel"), { indicatorId: "IND1", category: "temp", period: "x" });
  });

  const unauth = testEnv.unauthenticatedContext();
  const ctxA = testEnv.authenticatedContext("2222222", { email: "2222222@kmuh.org.tw", staffId: "2222222" });
  const ctxB = testEnv.authenticatedContext("3333333", { email: "3333333@kmuh.org.tw", staffId: "3333333" });
  const ctxMgr = testEnv.authenticatedContext("1111111", { email: "1111111@kmuh.org.tw", staffId: "1111111" });
  const ctxAdmin = testEnv.authenticatedContext("admin", { email: "admin@kmuh.org.tw", staffId: "admin" });
  const dbU = unauth.firestore();
  const dbA = ctxA.firestore();
  const dbB = ctxB.firestore();
  const dbM = ctxMgr.firestore();
  const dbAdmin = ctxAdmin.firestore();

  console.log("== 未登入 ==");
  await check("未登入建 reviewTasks 應擋", assertFails(setDoc(doc(dbU, "reviewTasks", "x1"), baseTask())));
  await check("未登入建 reviewRecords 應擋", assertFails(setDoc(doc(dbU, "reviewRecords", "x1"), baseRecord())));
  await check("未登入建 mailLogs 應放行（設計如此）", assertSucceeds(setDoc(doc(dbU, "mailLogs", "m1"), { staffId: "930462", result: "sent", at: serverTimestamp() })));

  console.log("== reviewRecords create ==");
  await check("非本人建他人 reviewRecord 應擋", assertFails(setDoc(doc(dbA, "reviewRecords", "taskC_c002"), baseRecord({ reviewerId: "3333333" }))));
  await check("本人建自己 reviewRecord 應放行", assertSucceeds(setDoc(doc(dbA, "reviewRecords", "taskC_c001"), baseRecord())));
  await check("缺 uniqueKey 鍵應擋", assertFails(setDoc(doc(dbA, "reviewRecords", "taskC_c003"), (() => { const r = baseRecord(); delete r.uniqueKey; return r; })())));
  await check("佔用配額 slot ID 卻無 quotaGroupId 應擋", assertFails(setDoc(doc(dbA, "reviewRecords", "g1__slot__1"), baseRecord({ taskId: "taskA" }))));
  await check("配額紀錄帶有效 quotaGroupId 應放行", assertSucceeds(setDoc(doc(dbA, "reviewRecords", "g1__slot__2"), baseRecord({ taskId: "taskA", quotaGroupId: "g1", quotaSlotDocId: "g1__slot__2", quotaCaseNo: 1, version: 1 }))));
  await check("多寫白名單外欄位應擋", assertFails(setDoc(doc(dbA, "reviewRecords", "taskC_c004"), baseRecord({ forged: true }))));

  console.log("== reviewRecords update ==");
  await check("本人改自己紀錄應放行", assertSucceeds(updateDoc(doc(dbA, "reviewRecords", "recA"), { totalScore: 2, lastModifiedAt: serverTimestamp(), lastModifiedBy: "2222222" })));
  await check("非本人改他人紀錄應擋", assertFails(updateDoc(doc(dbB, "reviewRecords", "recA"), { totalScore: 3 })));
  await check("排程管理者改他人紀錄應放行（封存核准）", assertSucceeds(updateDoc(doc(dbM, "reviewRecords", "recA"), { totalScore: 4, lastModifiedAt: serverTimestamp(), lastModifiedBy: "1111111" })));
  await check("改快照欄位（indicatorId）應擋", assertFails(updateDoc(doc(dbA, "reviewRecords", "recA"), { indicatorId: "IND2" })));

  console.log("== reviewTasks ==");
  await check("排程管理者幫他人建任務應放行", assertSucceeds(setDoc(doc(dbM, "reviewTasks", "t-mgr"), baseTask({ reviewerId: "3333333" }))));
  await check("一般審查員幫他人建任務應擋", assertFails(setDoc(doc(dbA, "reviewTasks", "t-a"), baseTask({ reviewerId: "3333333" }))));
  await check("一般審查員建自己任務應放行", assertSucceeds(setDoc(doc(dbA, "reviewTasks", "t-self"), baseTask({}))));
  await check("非本人改他人任務狀態應擋", assertFails(updateDoc(doc(dbB, "reviewTasks", "taskC"), { status: "done", completedAt: serverTimestamp() })));
  await check("本人改自己任務狀態應放行", assertSucceeds(updateDoc(doc(dbA, "reviewTasks", "taskC"), { status: "done", completedAt: serverTimestamp() })));
  await check("非本人同步配額組任務狀態應放行（carve-out）", assertSucceeds(updateDoc(doc(dbB, "reviewTasks", "taskA"), { status: "done", completedAt: serverTimestamp() })));
  await check("配額同步改狀態以外欄位應擋", assertFails(updateDoc(doc(dbB, "reviewTasks", "taskA"), { status: "done", caseCount: 99 })));
  await check("一般審查員刪任務應擋", assertFails(deleteDoc(doc(dbA, "reviewTasks", "taskDel"))));
  await check("排程管理者刪任務應放行", assertSucceeds(deleteDoc(doc(dbM, "reviewTasks", "taskDel"))));

  console.log("== auditLogs ==");
  const validAudit = () => ({ actor: "2222222", actorName: "審查員A", action: "測試", targetType: "reviewRecord", targetId: "recA", detail: "ok", createdAt: serverTimestamp() });
  await check("有效稽核應放行", assertSucceeds(setDoc(doc(dbA, "auditLogs", "a1"), validAudit())));
  await check("多寫白名單外欄位應擋", assertFails(setDoc(doc(dbA, "auditLogs", "a2"), { ...validAudit(), forged: "x" })));
  await check("detail 超長（20000 字）應擋", assertFails(setDoc(doc(dbA, "auditLogs", "a3"), { ...validAudit(), detail: "x".repeat(20000) })));
  await check("缺 createdAt 應擋", assertFails(setDoc(doc(dbA, "auditLogs", "a4"), (() => { const a = validAudit(); delete a.createdAt; return a; })())));

  console.log("== users ==");
  await check("本人改自己職稱應擋", assertFails(updateDoc(doc(dbA, "users", "2222222"), { title: "護理長" })));
  await check("本人改自己姓名應放行", assertSucceeds(updateDoc(doc(dbA, "users", "2222222"), { name: "審查員A2" })));
  await check("管理員改他人職稱應放行", assertSucceeds(updateDoc(doc(dbAdmin, "users", "2222222"), { title: "護理長" })));

  console.log("== reviewReservations / schedules / capa ==");
  await check("非擁有者刪他人預約鎖應擋", assertFails(deleteDoc(doc(dbB, "reviewReservations", "lockA"))));
  await check("擁有者刪自己預約鎖應放行", assertSucceeds(deleteDoc(doc(dbA, "reviewReservations", "lockA"))));
  await check("一般審查員建 schedules 應擋", assertFails(setDoc(doc(dbA, "schedules", "s1"), { indicatorId: "IND1" })));
  await check("排程管理者建 schedules 應放行", assertSucceeds(setDoc(doc(dbM, "schedules", "s1"), { indicatorId: "IND1" })));
  await check("一般審查員刪 schedules 應擋", assertFails(deleteDoc(doc(dbA, "schedules", "schedDel"))));
  await check("管理員刪 schedules 應放行", assertSucceeds(deleteDoc(doc(dbAdmin, "schedules", "schedDel"))));
  await check("案件負責人建 capa 應放行", assertSucceeds(setDoc(doc(dbA, "capa", "c1"), { ownerId: "2222222", writerId: "3333333", title: "案" })));
  await check("無關人員建 capa 應擋", assertFails(setDoc(doc(dbB, "capa", "c2"), { ownerId: "2222222", writerId: "2222222", title: "案" })));

  console.log("== 管理員全權 ==");
  await check("管理員建他人 reviewTasks 應放行", assertSucceeds(setDoc(doc(dbAdmin, "reviewTasks", "t-admin"), baseTask({ reviewerId: "3333333" }))));
  await check("管理員刪 reviewRecords 應放行", assertSucceeds(deleteDoc(doc(dbAdmin, "reviewRecords", "recA"))));

  console.log(`\n結果：${pass} 通過，${fail} 失敗`);
  await testEnv.cleanup();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("測試執行錯誤：", e);
  process.exit(2);
});
