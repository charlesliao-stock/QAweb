/**
 * v1.40.1 斷言測試：結果分析頁三組小改動（靜態守衛，無需 emulator）。
 * 覆蓋：
 * - 組別分析篩選器「錯誤分析單位」已更名為「單位」，全檔無殘留舊字串
 * - 審查結果管理（ReviewResultManager）篩選器順序：組別 → 單位 → 指標名稱
 * - 共用期間篩選器：起始標籤「西元年/月(起)」、結束標籤「西元年/月(訖)」；
 *   區間單位預設值為「月」（useState 初始值；ResultsPage 無 localStorage 覆寫 interval）
 * - 版號一致：src/version.ts 與 package.json 皆為 1.40.1
 */
import { readFileSync } from "fs";

const ROOT = "/home/hatch/workspace/repos/QAweb";
const src = readFileSync(`${ROOT}/src/features/ResultsPage.tsx`, "utf8");
const versionTs = readFileSync(`${ROOT}/src/version.ts`, "utf8");
const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));

let pass = 0;
function check(name, fn) {
  fn();
  pass++;
  console.log(`ok - ${name}`);
}

// --- 1. 組別分析「錯誤分析單位」→「單位」 ---
check("全檔無「錯誤分析單位」殘留", () => {
  if (src.includes("錯誤分析單位")) throw new Error("仍有舊字串");
});
check("組別分析篩選器 label 為「單位」（接 errorUnit）", () => {
  if (!src.includes('label="單位"\n                value={errorUnit}')) {
    throw new Error("找不到組別分析的單位篩選器");
  }
});

// --- 2. 審查結果管理：組別在前、單位在後 ---
check("審查結果管理篩選器順序：組別 → 單位 → 指標名稱", () => {
  const mgr = src.slice(src.indexOf("function ReviewResultManager"));
  const g = mgr.indexOf('label="組別"');
  const u = mgr.indexOf('label="單位"');
  const i = mgr.indexOf('label="指標名稱"');
  if (g < 0 || u < 0 || i < 0) throw new Error("缺少篩選器");
  if (!(g < u && u < i)) throw new Error(`順序錯誤：組別@${g} 單位@${u} 指標@${i}`);
});

// --- 3. 共用期間篩選器 ---
check("起始標籤為「西元年/月(起)」", () => {
  if (!src.includes('label="西元年/月(起)"')) throw new Error("找不到起標籤");
});
check("結束標籤為「西元年/月(訖)」", () => {
  if (!src.includes('label="西元年/月(訖)"')) throw new Error("找不到訖標籤");
});
check("分析頁共用篩選器無裸「西元年/月」標籤殘留", () => {
  if (src.includes('label="西元年/月"')) throw new Error("仍有未更名的標籤");
});
check("區間單位預設值為「月」", () => {
  if (!src.includes('useState<AnalysisGranularity>("month")')) {
    throw new Error("預設值不是 month");
  }
});
check("無 localStorage 覆寫 interval 預設值", () => {
  if (/localStorage.*interval|interval.*localStorage/.test(src)) {
    throw new Error("發現 localStorage 覆寫 interval");
  }
});

// --- 版號 ---
check("版號一致為 1.40.1", () => {
  if (!versionTs.includes('VERSION = "1.40.1"')) throw new Error("version.ts 不是 1.40.1");
  if (pkg.version !== "1.40.1") throw new Error(`package.json 是 ${pkg.version}`);
});

console.log(`\n${pass} passed`);
