import { writeFileSync } from "fs";
import { createRequire } from "module";
import { resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..");
const localRequire = createRequire(import.meta.url);
const { build } = createRequire(localRequire.resolve("vite", { paths: [ROOT] }))("esbuild");
writeFileSync(
  "/tmp/t169-dashboard-visibility.ts",
  [
    `export { DASHBOARD_SECTION_KEYS_BY_VARIANT, dashboardVariantForRole, dashboardVariantForTitle, parseDashboardSectionOverrides, resolveDashboardSectionsForTarget, setDashboardSectionOverride, countCapaPendingReview } from "${ROOT}/src/lib/dashboardVisibility";`,
    `export { buildRoleMetaMap } from "${ROOT}/src/lib/orgMeta";`,
  ].join("\n"),
);
await build({
  entryPoints: ["/tmp/t169-dashboard-visibility.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/t169-dashboard-visibility.cjs",
  logLevel: "silent",
});
const L = createRequire("/tmp/t169-dashboard-visibility.cjs")("/tmp/t169-dashboard-visibility.cjs");
let failures = 0;
const assert = (name, condition) => {
  if (!condition) {
    failures += 1;
    console.error(`FAIL: ${name}`);
  }
};

const parsed = L.parseDashboardSectionOverrides({
  roles: {
    roleA: { alert48h: false, unknownSection: true, overview: "yes" },
    empty: { unknownSection: false },
  },
  titles: { titleA: { alert48h: true, unknownSection: true } },
  unexpected: { roleB: { radar: true } },
});
assert("只解析已知 dashboard key 與 boolean", parsed.roles.roleA.alert48h === false && !("unknownSection" in parsed.roles.roleA) && !parsed.roles.roleA.overview);
assert("無有效 key 的目標不保留", !parsed.roles.empty);
assert("只接受 roles／titles 兩個範圍", !parsed.roles.roleB);

const withOverride = L.setDashboardSectionOverride({}, "role", "roleA", "alert48h", false);
assert("新增覆寫", withOverride.roles.roleA.alert48h === false);
const inherited = L.setDashboardSectionOverride(withOverride, "role", "roleA", "alert48h", undefined);
assert("設為繼承會移除空目標", Object.keys(inherited.roles).length === 0);

const resolved = L.resolveDashboardSectionsForTarget({
  base: { alert48h: true, nextMonthPreview: false },
  overrides: {
    roles: {
      roleA: { alert48h: true, nextMonthPreview: true },
      roleB: { alert48h: false },
    },
    titles: { titleA: { alert48h: true } },
  },
  roleIds: ["roleA", "roleB"],
  titleId: "titleA",
});
assert("相同視角角色衝突時隱藏優先", resolved.nextMonthPreview === true && resolved.alert48h === true);
assert("職稱覆寫最後生效", resolved.alert48h === true);
const noTitleOverride = L.resolveDashboardSectionsForTarget({
  base: { alert48h: true },
  overrides: { roles: { roleA: { alert48h: true }, roleB: { alert48h: false } } },
  roleIds: ["roleA", "roleB"],
});
assert("無職稱覆寫時沿用保守的角色結果", noTitleOverride.alert48h === false);

const roleMeta = L.buildRoleMetaMap(["品質審查員", "品管執行幹事", "召集人", "一般人員"]);
assert("角色對應到既有單一儀表板類別", L.dashboardVariantForRole("品質審查員", roleMeta) === "reviewer" && L.dashboardVariantForRole("品管執行幹事", roleMeta) === "officer" && L.dashboardVariantForRole("召集人", roleMeta) === "convener" && L.dashboardVariantForRole("一般人員", roleMeta) === "nurse");
assert("職稱按管理層級對應變體", L.dashboardVariantForTitle({ isUnitHead: true, isDistrictHead: true, isHospitalHead: false, isOfficer: false, isConvener: false }) === "supervisor");
assert("CAPA 摘要只列在護理長以上", L.DASHBOARD_SECTION_KEYS_BY_VARIANT.headNurse.includes("capaPendingReview") && L.DASHBOARD_SECTION_KEYS_BY_VARIANT.supervisor.includes("capaPendingReview") && L.DASHBOARD_SECTION_KEYS_BY_VARIANT.director.includes("capaPendingReview") && !L.DASHBOARD_SECTION_KEYS_BY_VARIANT.nurse.includes("capaPendingReview"));

const pendingCount = L.countCapaPendingReview([
  { stage: "結案核准", approvalSteps: [{ decision: "核准" }, { decision: "待審核" }] },
  { stage: "正式結案", approvalSteps: [{ decision: "待審核" }] },
  { stage: "結案核准", approvalSteps: [{ decision: "核准" }] },
  { stage: "結案核准", approvalSteps: undefined },
]);
assert("CAPA 待審摘要只計結案核准且仍有待審步驟", pendingCount === 1);

console.log(failures ? `failed ${failures}` : "v1.69-dashboard-visibility：所有 assertions 通過");
process.exit(failures ? 1 : 0);
