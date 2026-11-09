/**
 * v1.40.0 斷言測試：任務交接頁改為被動查詢。
 * lib 行為用 esbuild 打包後在 node 執行（被測函式皆零依賴）；
 * 頁面結構用靜態守衛（無需 emulator）。
 * 覆蓋：
 * - 只交接勾選且未完成的項目（done 即使被勾也不交接）
 * - 可交接範圍：管理員全部、召集人／執行幹事只限所屬組別
 * - 群組／單位篩選、排序（群組→單位→指標→月份）
 * - 確認驗證：無勾選／無新審查員／新舊審查員相同皆擋下；原因不列入驗證（選填）
 * - 被動查詢：進頁載入不含 reviewTasks，任務只在按「查詢」時讀取；
 *   職編搜尋走伺服器 where reviewerId == 精確比對
 * - 新審查員：查無此人提示、點選確認；確認／取消鈕皆在；
 *   取消清除勾選、新審查員與原因；window.confirm 已移除（確認鈕本身即為確認步驟）
 */
import { build } from "esbuild";
import { writeFileSync, readFileSync } from "fs";
import { createRequire } from "module";

const ROOT = "/home/hatch/workspace/repos/QAweb";

const entry = `\nimport {\n  isHandoffEligible, filterHandoffTasks, sortHandoffTasks,\n  selectHandoffTasks, validateHandoff,\n} from "${ROOT}/src/lib/handoff";\nexport { isHandoffEligible, filterHandoffTasks, sortHandoffTasks, selectHandoffTasks, validateHandoff };\n`;
writeFileSync("/tmp/v140-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v140-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v140-test-bundle.cjs",
  logLevel: "silent",
  define: { "import.meta.env": "{}" },
});
const require2 = createRequire("/tmp/v140-test-bundle.cjs");
const L = require2("/tmp/v140-test-bundle.cjs");

let pass = 0;
function check(name, fn) {
  fn();
  pass++;
  console.log(`ok - ${name}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const t1 = { id: "a", status: "pending", groupId: "g1", unitId: "u1", reviewerId: "r1", groupName: "甲組", unitName: "9A", indicatorName: "指標甲", month: 8 };
const t2 = { id: "b", status: "done", groupId: "g1", unitId: "u1", reviewerId: "r1", groupName: "甲組", unitName: "9A", indicatorName: "指標乙", month: 9 };
const t3 = { id: "c", status: "locked", groupId: "g2", unitId: "u2", reviewerId: "r2", groupName: "乙組", unitName: "9B", indicatorName: "指標甲", month: 8 };

// --- 可交接範圍 ---
check("done 任務不可交接（即使是管理員）", () => {
  if (L.isHandoffEligible(t2, { isAdmin: true, allowedGroupIds: [] })) throw new Error("done 應排除");
});
check("管理員可交接未完成任務", () => {
  if (!L.isHandoffEligible(t1, { isAdmin: true, allowedGroupIds: [] })) throw new Error("管理員應可交接");
});
check("非管理員只可交接所屬組別", () => {
  if (!L.isHandoffEligible(t1, { isAdmin: false, allowedGroupIds: ["g1"] })) throw new Error("所屬組應可交接");
  if (L.isHandoffEligible(t3, { isAdmin: false, allowedGroupIds: ["g1"] })) throw new Error("非所屬組不應交接");
});

// --- 篩選與排序 ---
check("群組／單位篩選（空字串＝不篩）", () => {
  if (!eq(L.filterHandoffTasks([t1, t3], { groupId: "", unitId: "" }).map((t) => t.id), ["a", "c"])) throw new Error("不篩應全留");
  if (!eq(L.filterHandoffTasks([t1, t3], { groupId: "g2", unitId: "" }).map((t) => t.id), ["c"])) throw new Error("群組篩選錯誤");
  if (!eq(L.filterHandoffTasks([t1, t3], { groupId: "", unitId: "u1" }).map((t) => t.id), ["a"])) throw new Error("單位篩選錯誤");
});
check("排序：群組→單位→指標→月份（zh-Hant 筆畫序：乙在甲前）", () => {
  const out = L.sortHandoffTasks([t3, t2, t1]).map((t) => t.id);
  if (!eq(out, ["c", "b", "a"])) throw new Error(`排序錯誤：${out}`);
});

// --- 勾選與確認驗證 ---
check("只交接勾選且未完成的項目（done 被勾也不交接）", () => {
  const out = L.selectHandoffTasks([t1, t2, t3], ["a", "b"]).map((t) => t.id);
  if (!eq(out, ["a"])) throw new Error(`應只剩 a，實為 ${out}`);
});
check("確認驗證：無勾選擋下", () => {
  if (L.validateHandoff([], "r9") === null) throw new Error("無勾選應擋下");
});
check("確認驗證：無新審查員擋下", () => {
  if (L.validateHandoff([t1], "") === null) throw new Error("無新審查員應擋下");
  if (L.validateHandoff([t1], "   ") === null) throw new Error("空白新審查員應擋下");
});
check("確認驗證：新舊審查員相同擋下", () => {
  if (L.validateHandoff([t1], "r1") === null) throw new Error("相同審查員應擋下");
});
check("確認驗證：勾選＋新審查員不同人即通過（原因不列入驗證）", () => {
  if (L.validateHandoff([t1, t3], "r9") !== null) throw new Error("應通過");
});

// --- 頁面靜態守衛：被動查詢 ---
const page = readFileSync(`${ROOT}/src/features/TaskHandoffPage.tsx`, "utf8");
check("進頁載入（loadReference）不含 reviewTasks", () => {
  const start = page.indexOf("const loadReference = useCallback");
  const end = page.indexOf("useEffect(() => { void loadReference(); }", start);
  if (start < 0 || end < 0) throw new Error("找不到 loadReference 區段");
  if (page.slice(start, end).includes("reviewTasks")) throw new Error("進頁不應讀取 reviewTasks");
});
check("進頁載入不含 indicators（查詢時才讀）", () => {
  const start = page.indexOf("const loadReference = useCallback");
  const end = page.indexOf("useEffect(() => { void loadReference(); }", start);
  if (page.slice(start, end).includes("indicators")) throw new Error("進頁不應讀取 indicators");
});
check("任務讀取只在 runSearch（2 次全量／職編查詢）；寫入只有交接時的 doc 更新", () => {
  const reads = page.match(/getDocs\(query\(collection\(db, "reviewTasks"\)/g) ?? [];
  if (reads.length !== 2) throw new Error(`任務讀取應出現 2 次，實為 ${reads.length} 次`);
  const rs = page.indexOf("const runSearch = useCallback");
  const re = page.indexOf("function toggleTask", rs);
  const readIdx = [...page.matchAll(/getDocs\(query\(collection\(db, "reviewTasks"\)/g)].map((m) => m.index);
  if (readIdx.some((i) => i < rs || i > re)) throw new Error("任務讀取應只在 runSearch 內");
  const writes = page.match(/doc\(db, "reviewTasks", task\.id\)/g) ?? [];
  if (writes.length !== 1) throw new Error(`交接寫入應出現 1 次，實為 ${writes.length} 次`);
});
check("職編搜尋走伺服器 where reviewerId == 精確比對", () => {
  if (!page.includes('where("reviewerId", "==", staffId)')) throw new Error("應有 reviewerId == 查詢");
});
check("未查詢前顯示空白提示", () => {
  if (!page.includes("尚未查詢")) throw new Error("應有「尚未查詢」空白態");
});
check("有「查詢」鈕", () => {
  if (!page.includes("查詢")) throw new Error("應有查詢鈕");
});

// --- 頁面靜態守衛：新審查員／確認／取消 ---
check("新審查員：查無此人提示", () => {
  if (!page.includes("查無此人")) throw new Error("應有查無此人提示");
});
check("新審查員：點選確認（選取鈕＋已選顯示）", () => {
  if (!page.includes("選取</button>")) throw new Error("應有選取鈕");
  if (!page.includes("已選新審查員")) throw new Error("應有已選顯示");
});
check("確認／取消鈕皆在", () => {
  if (!page.includes("確認交接")) throw new Error("應有確認鈕");
  if (!page.includes(">取消</button>")) throw new Error("應有取消鈕");
});
check("取消清除勾選、新審查員與原因", () => {
  const start = page.indexOf("function handleCancel()");
  const end = page.indexOf("async function handleHandoff()", start);
  const body = page.slice(start, end);
  for (const s of ["setSelectedTasks([])", "setNewReviewer(null)", "setReason(\"\")"]) {
    if (!body.includes(s)) throw new Error(`handleCancel 缺少 ${s}`);
  }
});
check("window.confirm 已移除（確認鈕本身即為確認步驟）", () => {
  if (page.includes("window.confirm")) throw new Error("不應再有 window.confirm");
});
check("firestore.rules 未被動到（本版不應出現 handoff 相關規則變更）", () => {
  const rules = readFileSync(`${ROOT}/firestore.rules`, "utf8");
  if (rules.includes("reviewTasks") && rules.includes("reassign")) throw new Error("不應新增交接規則");
});

console.log(`\n${pass} passed`);
