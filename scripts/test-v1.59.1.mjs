/**
 * v1.59.1 斷言測試：品管審查頁審查員聯集可見範圍＋檢視彈窗限縮。
 * 混合測試：lib/auditVisibility.ts 以 esbuild 打包後真的跑純函式；
 * 其餘為靜態守衛（原始碼文字比對），無需 emulator。
 * 線上逐項點按由主代理另行驗證（admin 視角看不到差異，需非 admin 帳號）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildSync } from "esbuild";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf-8");

function bundle(entry, out) {
  const bundled = join(tmpdir(), out);
  buildSync({
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: bundled,
    logLevel: "silent",
  });
  return bundled;
}

const {
  taskUnitsBySchedule,
  unionUnits,
  modalUnitScope,
  unitVisibleInModal,
} = await import(bundle("src/lib/auditVisibility.ts", "qi-fix-158-auditVisibility-1591.mjs"));

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}`);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const setEq = (set, arr) => eq([...(set ?? [])].sort(), [...arr].sort());

const versionTs = read("src/version.ts");
const pkg = JSON.parse(read("package.json"));
const audit = read("src/features/AuditPage.tsx");
const visibility = read("src/lib/auditVisibility.ts");

// ---- 0. 版號 ----
check(
  "版號 1.59.1 一致",
  versionTs.includes('VERSION = "1.59.1"') && pkg.version === "1.59.1",
);

// ---- 1. 任務→排程對應（taskUnitsBySchedule） ----
const scheds = [
  { key: "IND1__year__2026", indicatorId: "IND1", intervalMonthKeys: new Set(["2026-3", "2026-6", "2026-9"]) },
  { key: "IND1__temp__111", indicatorId: "IND1", intervalMonthKeys: new Set(["2026-3", "2026-5"]) },
  { key: "IND1__academic__115", indicatorId: "IND1", intervalMonthKeys: new Set(["2026-8", "2026-9", "2026-10"]) },
  { key: "IND2__temp__222", indicatorId: "IND2", intervalMonthKeys: new Set(["2026-3"]) },
];
const t = (o) => ({ indicatorId: "", year: 2026, month: 3, unitId: "U1", ...o });

let m = taskUnitsBySchedule(
  [
    t({ indicatorId: "IND1", scheduleCategory: "temp", schedulePeriod: "111", unitId: "U1" }),
    t({ indicatorId: "IND1", scheduleCategory: "temp", schedulePeriod: "111", unitId: "U2" }),
    t({ indicatorId: "IND1", scheduleCategory: "year", schedulePeriod: "2026", month: 6, unitId: "U3" }),
    t({ indicatorId: "IND1", scheduleCategory: "academic", schedulePeriod: "115", month: 9, unitId: "U4" }),
    t({ indicatorId: "IND2", scheduleCategory: "temp", schedulePeriod: "222", unitId: "U5" }),
  ],
  scheds,
);
check("1a 加審 temp 任務對到排程（兩單位聯集）", setEq(m.get("IND1__temp__111"), ["U1", "U2"]));
check("1b 年度任務對到排程", setEq(m.get("IND1__year__2026"), ["U3"]));
check("1c 學年度任務對到排程", setEq(m.get("IND1__academic__115"), ["U4"]));
check("1d 不同指標任務分開對應", setEq(m.get("IND2__temp__222"), ["U5"]));

m = taskUnitsBySchedule(
  [t({ indicatorId: "IND1", scheduleCategory: "temp", schedulePeriod: "999", unitId: "U1" })],
  scheds,
);
check("1e 鍵指到不存在的排程（已刪）不歸屬、不誤放", m.size === 0);

m = taskUnitsBySchedule(
  [t({ indicatorId: "IND1", month: 5, unitId: "U1" })], // 舊任務缺鍵；5 月只在 temp 111 區間
  scheds,
);
check("1f 舊任務 fallback：年月只落一個排程區間 → 歸屬", setEq(m.get("IND1__temp__111"), ["U1"]));

m = taskUnitsBySchedule(
  [t({ indicatorId: "IND1", month: 3, unitId: "U1" })], // 3 月同時在 year 2026 與 temp 111
  scheds,
);
check("1g 舊任務 fallback：年月落多個排程區間 → 不歸屬（不誤放）", m.size === 0);

m = taskUnitsBySchedule(
  [t({ indicatorId: "IND1", month: 12, unitId: "U1" })], // 12 月不在任何區間
  scheds,
);
check("1h 舊任務 fallback：年月不在任何區間 → 不歸屬", m.size === 0);

m = taskUnitsBySchedule(
  [t({ indicatorId: "IND1", scheduleCategory: "temp", month: 5, unitId: "U1" })], // 有 category 缺 period → 走 fallback
  scheds,
);
check("1i 半缺鍵任務走 fallback（5 月唯一）→ 歸屬", setEq(m.get("IND1__temp__111"), ["U1"]));

m = taskUnitsBySchedule(
  [t({ indicatorId: "IND1", scheduleCategory: "temp", schedulePeriod: "111", unitId: "" })],
  scheds,
);
check("1j 不限單位 NA 任務 unitId '' 原樣保留", setEq(m.get("IND1__temp__111"), [""]));

m = taskUnitsBySchedule([], scheds);
check("1k 無本人任務 → 空對應（兩者皆無不列）", m.size === 0);

// ---- 2. unionUnits ----
check("2a 聯集去重", eq(unionUnits(["U1", "U2"], ["U2", "U3"]), ["U1", "U2", "U3"]));
check("2b 聯集保留 ''（NA）", eq(unionUnits([""], ["U1"]), ["", "U1"]));
check("2c 兩者皆空 → 空", eq(unionUnits([], undefined), []));

// ---- 3. 檢視彈窗限縮（modalUnitScope） ----
const base = {
  isAdmin: false,
  isSenior: false,
  isConvenerInGroup: false,
  isHeadNurseApplies: false,
  ownUnitCode: "",
  assignedUnits: [],
};
check("3a 管理員 → null（全部可見）", modalUnitScope({ ...base, isAdmin: true }) === null);
check("3b 高階主管 → null（全部可見）", modalUnitScope({ ...base, isSenior: true }) === null);
check(
  "3c 召集人／執行幹事在所屬群組 → null（整列可見，不縮成單一單位）",
  modalUnitScope({ ...base, isConvenerInGroup: true, assignedUnits: ["U1"] }) === null,
);
check(
  "3d 召集人不在該群組＋審查員身分 → 只看被指派單位",
  eq(modalUnitScope({ ...base, assignedUnits: ["U1", "U2"] }), ["U1", "U2"]),
);
check(
  "3e 護理長自審 → 只看本人單位",
  eq(
    modalUnitScope({ ...base, isHeadNurseApplies: true, ownUnitCode: "U9" }),
    ["U9"],
  ),
);
check(
  "3f 護理長自審＋審查員 → 本人單位與被指派單位聯集",
  eq(
    modalUnitScope({
      ...base,
      isHeadNurseApplies: true,
      ownUnitCode: "U9",
      assignedUnits: ["U1", "U9"],
    }),
    ["U9", "U1"],
  ),
);
check(
  "3g 審查員含 NA 指派 '' → 保留 ''",
  eq(modalUnitScope({ ...base, assignedUnits: [""] }), [""]),
);
check("3h 無任何分支貢獻 → []（fail closed）", eq(modalUnitScope(base), []));
check(
  "3i 護理長分支不成立（非自審）→ 不貢獻本人單位",
  eq(modalUnitScope({ ...base, ownUnitCode: "U9", assignedUnits: ["U1"] }), ["U1"]),
);

// ---- 4. unitVisibleInModal ----
check("4a scope null → 全部可見", unitVisibleInModal(null, "U1") === true);
check("4b scope 含該單位 → 可見", unitVisibleInModal(["U1", "U2"], "U2") === true);
check("4c scope 不含該單位 → 不可見", unitVisibleInModal(["U1"], "U2") === false);
check("4d scope 含 '' → NA 可見", unitVisibleInModal([""], "") === true);
check("4e scope 不含 '' → NA 不可見", unitVisibleInModal(["U1"], "") === false);

// ---- 5. AuditPage 靜態守衛 ----
check(
  "5a 本人任務查詢：reviewTasks where reviewerId == staffId",
  audit.includes('collection(db, "reviewTasks")') &&
    audit.includes('where("reviewerId", "==", staffId)'),
);
check(
  "5b 任務查詢用 fetchAllPaged＋同欄位 orderBy（不需複合索引）",
  audit.includes("fetchAllPaged(") &&
    audit.includes('{ orderByField: "reviewerId" }'),
);
check(
  "5c 任務→排程用 scheduleDocId＋taskUnitsBySchedule",
  audit.includes("scheduleDocId(") &&
    audit.includes("taskUnitsBySchedule(") &&
    audit.includes('import {') &&
    audit.includes("from \"../lib/auditVisibility\""),
);
check(
  "5d 任務指派聯集進 assigned（分工表＋任務）",
  audit.includes("taskUnitsBySched.get(") &&
    audit.includes("assigned.push(...taskUnits)") &&
    audit.includes("unionUnits(assigned)"),
);
check(
  "5e 任務未拉完有可見提示（不無聲少列）",
  audit.includes("myTasksTruncated") &&
    audit.includes("本人任務未完整載入"),
);
check(
  "5f ActiveRow 帶 modalUnitIds，out.push 有設定",
  audit.includes("modalUnitIds: ModalUnitScope;") &&
    audit.includes("modalUnitIds,"),
);
check(
  "5g 單位摘要按 modalUnitIds 過濾",
  audit.includes("unitVisibleInModal(scope, record.unitId)") &&
    audit.includes(".filter(([unitId]) => unitVisibleInModal(scope, unitId))"),
);
check(
  "5h 明細紀錄按 modalUnitIds 過濾",
  audit.includes("unitVisibleInModal(viewRow.modalUnitIds, record.unitId)"),
);
check(
  "5i 召集人彈窗為群組範圍（isConvenerInGroup → modalUnitScope 內回 null）",
  audit.includes("isConvenerInGroup:") &&
    visibility.includes("if (input.isConvenerInGroup) return null;"),
);
check(
  "5j 執行頁 assignedUnitIds 限縮不動（下拉仍以被指派單位為先）",
  audit.includes("row.assignedUnitIds.length > 0") &&
    audit.includes("? row.assignedUnitIds") &&
    audit.includes(": row.sched.unitIds"),
);

// ---- 6. 舊行為不回歸（v1.59.0） ----
check(
  "6a 管理員／高階主管全見分支仍在",
  audit.includes("if (isAdmin || isSenior) visible = true;"),
);
check(
  "6b 審查員分工表路徑仍在（reviewerOf）",
  audit.includes("reviewerOf.get(s.indicatorId)?.get(staffId)"),
);
check(
  "6c 護理長僅自審且本人單位在內仍在",
  audit.includes("isHeadNurse &&") &&
    audit.includes("s.selfReview &&") &&
    audit.includes("s.unitIds.includes(user.unitCode)"),
);
check(
  "6d 召集人／執行幹事僅所屬群組仍在",
  audit.includes("myConvenerGroupIds.includes(ind.groupId)"),
);
check(
  "6e 加審／自審 badge 分流仍在",
  audit.includes('selfReview ? "自審" : "加審"'),
);
check(
  "6f can() 僅用於修改已提交（未擴大權限改動）",
  audit.includes('can("editSubmitted"') && !audit.includes('can("auditView"'),
);
check(
  "6g 無新 collection：AuditPage 未引用新集合名",
  !audit.includes("collection(db, \"audit") &&
    !audit.includes("collection(db, \"reviewerScopes"),
);

// ---- 總結 ----
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
