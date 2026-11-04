/**
 * v1.15.0 斷言測試：variant 判定、鎖定流程、個人聚合、柏拉圖、燈號、解鎖申請 ID。
 * 用 esbuild 將純函式打包後在 node 執行（不走 jsdom）。
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";

const ROOT = "/home/hatch/workspace/repos/QAweb";
const entry = `
import { getDashboardVariants } from "${ROOT}/src/lib/dashboardVariant";
import { shouldLockTask, unlockRequestDocId } from "${ROOT}/src/lib/scheduling";
import { personalTrend, weakTop3, lagLights, paretoTop3, staffAvgRate, unitPassRate, declineAlerts } from "${ROOT}/src/lib/dashboardStats";
import { requiredCases, correctTaskStatus } from "${ROOT}/src/lib/reviewProgress";
export { getDashboardVariants, shouldLockTask, correctTaskStatus, unlockRequestDocId, personalTrend, weakTop3, lagLights, paretoTop3, staffAvgRate, unitPassRate, declineAlerts, requiredCases };
`;
writeFileSync("/tmp/v115-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v115-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v115-test-bundle.cjs",
  logLevel: "silent",
});
const require2 = createRequire("/tmp/v115-test-bundle.cjs");
const L = require2("/tmp/v115-test-bundle.cjs");

let passed = 0;
let failed = 0;
function assert(name, cond) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("FAIL:", name);
  }
}

// ── 1. variant 判定 ──
{
  const v1 = L.getDashboardVariants({ roles: ["護理師"], title: "護理師", isAdmin: false });
  assert("護理師 → 只有 nurse", JSON.stringify(v1) === '["nurse"]');

  const v2 = L.getDashboardVariants({ roles: ["護理長", "審查員"], title: "副護理長", isAdmin: false });
  assert("護理長＞審查員優先序（護理師保底）", JSON.stringify(v2) === '["headNurse","reviewer","nurse"]');

  const v3 = L.getDashboardVariants({ roles: ["執行幹事", "召集人", "審查員"], title: "", isAdmin: false });
  assert("執行幹事＞召集人＞審查員（護理師保底）", JSON.stringify(v3) === '["officer","convener","reviewer","nurse"]');

  const v4 = L.getDashboardVariants({ roles: ["系統管理員"], title: "", isAdmin: true });
  assert("isAdmin 七種全開", v4.length === 7 && v4[0] === "director");

  const v5 = L.getDashboardVariants({ roles: [], title: "科主任", isAdmin: false });
  assert("職稱含主任 → director", JSON.stringify(v5) === '["director","nurse"]');

  const v6 = L.getDashboardVariants({ roles: [], title: "督導", isAdmin: false });
  assert("職稱含督導 → supervisor", JSON.stringify(v6) === '["supervisor","nurse"]');

  const v7 = L.getDashboardVariants({ roles: ["護理師"], title: "", isAdmin: false });
  assert("無身分 fallback nurse", JSON.stringify(v7) === '["nurse"]');
}

// ── 2. 鎖定流程 ──
{
  assert("未完成＋逾期 → locked", L.shouldLockTask("2026-10-10", "pending", "2026-11-04") === true);
  assert("完成＋逾期 → 不鎖", L.shouldLockTask("2026-10-10", "done", "2026-11-04") === false);
  assert("未逾期 → 不鎖", L.shouldLockTask("2026-11-10", "pending", "2026-11-04") === false);
  assert("已鎖定 → 不再觸發", L.shouldLockTask("2026-10-10", "locked", "2026-11-04") === false);
  assert("correctTaskStatus: 完成優先→done", L.correctTaskStatus(5, 5, "2026-10-10", "locked", "2026-11-04") === "done");
  assert("correctTaskStatus: 逾期→locked", L.correctTaskStatus(2, 5, "2026-10-10", "pending", "2026-11-04") === "locked");
  assert("correctTaskStatus: 未逾期維持 pending", L.correctTaskStatus(2, 5, "2026-11-10", "pending", "2026-11-04") === "pending");
  const uid1 = L.unlockRequestDocId("T1");
  const uid2 = L.unlockRequestDocId("T1");
  assert("解鎖申請 doc id 格式", /^T1__unlock_[a-z0-9]+$/.test(uid1));
  assert("解鎖申請 doc id 唯一", uid1 !== uid2);
}

// ── 3. 個人聚合 ──
{
  const records = [
    { id: "a", indicatorId: "I1", reviewedPersonEmpNo: "E1", reviewDate: "2026-09-01", answers: [{ itemText: "T1", score: 1 }, { itemText: "T2", score: 0 }], rate: 50 },
    { id: "b", indicatorId: "I1", reviewedPersonEmpNo: "E1", reviewDate: "2026-10-05", answers: [{ itemText: "T1", score: 0 }, { itemText: "T2", score: 0 }], rate: 0 },
    { id: "c", indicatorId: "I2", reviewedPersonEmpNo: "E2", reviewDate: "2026-10-05", answers: [{ itemText: "T1", score: 1 }], rate: 100 },
  ];
  const trend = L.personalTrend(records, "E1", 6);
  assert("個人走勢只取本人", trend.length === 2 && trend.every((r) => r.id !== "c"));
  const byId = new Map(trend.map((r) => [r.id, r]));
  assert("個人走勢正確率：a=50%", byId.get("a")?.rate === 50);
  assert("個人走勢正確率：b=0%", byId.get("b")?.rate === 0);
  assert("個人走勢按日期降序", trend[0].id === "b" && trend[1].id === "a");
  const weak = L.weakTop3(records, "E1");
  assert("常犯 Top3：T2 兩次未符合", weak[0].itemText === "T2" && weak[0].miss === 2);
  assert("常犯 Top3：T1 一次", weak[1].itemText === "T1" && weak[1].miss === 1);
}

// ── 4. 柏拉圖 ──
{
  const recs = [
    { id: "a", indicatorId: "I1", answers: [{ itemText: "A", score: 0 }, { itemText: "B", score: 0 }] },
    { id: "b", indicatorId: "I2", answers: [{ itemText: "A", score: 0 }] },
    { id: "c", indicatorId: "I9", answers: [{ itemText: "C", score: 0 }] },
  ];
  const p = L.paretoTop3(recs, new Set(["I1", "I2"]));
  assert("柏拉圖 Top1 是 A（2 次）", p[0].itemText === "A" && p[0].count === 2);
  assert("柏拉圖 Top2 是 B（1 次）", p[1].itemText === "B" && p[1].count === 1);
  assert("柏拉圖排除其他指標", p.length === 2);
  assert("柏拉圖累積百分比", p[0].cumPct === 66.7 && p[1].cumPct === 100);
}

// ── 5. 燈號 ──
{
  const today = "2026-11-04";
  const tasks = [
    { id: "t1", doneCount: 2, caseCount: 10, deadline: "2026-11-08", status: "pending" }, // 4 天後到期，20% → red
    { id: "t2", doneCount: 7, caseCount: 10, deadline: "2026-11-09", status: "pending" }, // 5 天後到期，70% → yellow
    { id: "t3", doneCount: 9, caseCount: 10, deadline: "2026-11-06", status: "pending" }, // 2 天後到期，90% → 無燈
    { id: "t4", doneCount: 1, caseCount: 10, deadline: "2026-12-10", status: "pending" }, // 36 天後 → 無燈
    { id: "t5", doneCount: 2, caseCount: 10, deadline: "2026-11-08", status: "done" },    // 已完成 → 無燈
    { id: "t6", doneCount: 2, caseCount: null, deadline: "2026-11-08", status: "pending" }, // 應審 1 件→完成 → 無燈
  ];
  const lags = L.lagLights(tasks, today);
  assert("紅燈 t1", lags.length === 2 && lags[0].task.id === "t1" && lags[0].level === "red");
  assert("黃燈 t2", lags[1].task.id === "t2" && lags[1].level === "yellow");
}

// ── 6. 全院／單位聚合 ──
{
  const rs = [
    { id: "a", unitId: "U1", rate: 100 },
    { id: "b", unitId: "U1", rate: 80 },
    { id: "c", unitId: "U2", rate: 60 },
  ];
  assert("人員平均符合率 = 80", L.staffAvgRate(rs) === 80);
  assert("空資料 → null", L.staffAvgRate([]) === null);
  const th = new Map([["I1", 90]]);
  const rs2 = [
    { id: "a", unitId: "U1", indicatorId: "I1", rate: 100 },
    { id: "b", unitId: "U2", indicatorId: "I1", rate: 60 },
  ];
  const pr = L.unitPassRate(rs2, th);
  assert("單位達標率 1/2", pr.pass === 1 && pr.total === 2 && pr.rate === 50);
}

// ── 7. 下滑警訊 ──
{
  const rows = [
    { unitId: "U1", ym: "2026-09", avg: 95 },
    { unitId: "U1", ym: "2026-10", avg: 90 },
    { unitId: "U1", ym: "2026-11", avg: 85 },
    { unitId: "U2", ym: "2026-09", avg: 80 },
    { unitId: "U2", ym: "2026-10", avg: 85 },
    { unitId: "U2", ym: "2026-11", avg: 90 },
    { unitId: "U3", ym: "2026-09", avg: 95 },
    { unitId: "U3", ym: "2026-10", avg: 88 },
    { unitId: "U3", ym: "2026-11", avg: 89 },
  ];
  const alerts = L.declineAlerts(rows, ["2026-09", "2026-10", "2026-11"], 90);
  assert("U1 連續下滑被抓", alerts.some((a) => a.unitId === "U1" && a.kind === "decline"));
  assert("U2 上升無下滑警訊", !alerts.some((a) => a.unitId === "U2" && a.kind === "decline"));
  assert("U1 下滑即警示（不另發未達標）", !alerts.some((a) => a.unitId === "U1" && a.kind === "below"));
  assert("U3 未下滑但未達標 → below", alerts.some((a) => a.unitId === "U3" && a.kind === "below"));
}

console.log(`\nv1.15.0 斷言：${passed} 通過，${failed} 失敗`);
process.exit(failed > 0 ? 1 : 0);
