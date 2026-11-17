/**
 * v1.40.6 斷言測試：登入帳號與密碼統一先設定為職編（靜態守衛，無需 emulator）。
 *
 * 背景：帳號 email 早已統一為「職編@nurseboard.internal」（auth.tsx staffEmail），
 * 但初始密碼在程式內沒有任何約定：全程式碼沒有 createUserWithEmailAndPassword，
 * 帳號開通完全由管理員在 Firebase Console 手動建立，初始密碼是當時自行設定；
 * 管理員看得到的兩處開通提示（新增人員成功訊息、人員匯入備註）只提 email 格式，
 * 沒提密碼；登入頁也沒告訴新帳號首次該用什麼密碼。
 *
 * 本版修正（MVP 無 Cloud Functions，不新增後端開通流程）：
 * - auth.tsx 新增單一約定 defaultInitialPassword(staffId)＝職編（trim 後原值）：
 *   帳號＝職編、初始密碼＝職編；日後站內若新增開通／重設流程一律用本函式。
 * - GroupsPage：新增人員成功訊息、人員匯入備註、新增人員表單「首次登入強制
 *   改密碼」下方，皆寫明初始密碼請設為職編。
 * - App.tsx 登入頁：新增「新帳號首次登入：密碼預設為職編，登入後須立即更改」提示。
 * - 不動：首次登入強制改密碼機制（mustChangePassword）、demo／demo 展示帳號、
 *   任何既有帳號的密碼（本版不重設、不更動任何現有帳號）。
 * 覆蓋：
 * 1. defaultInitialPassword 存在且回傳 trim 後職編
 * 2. staffEmail 不變（職編@nurseboard.internal）
 * 3. 程式內仍無建立帳號／重設他人密碼的程式碼（開通仍在 Console 手動）
 * 4. 首次登入強制改密碼機制仍在
 * 5. demo／demo 展示帳號不變
 * 6. 三處管理員提示皆寫明初始密碼＝職編
 * 7. 登入頁有新帳號首次登入提示
 * 8. 版號一致：src/version.ts 與 package.json 皆為 1.40.6
 */
import { readFileSync } from "node:fs";

const ROOT = "/home/hatch/workspace/repos/QAweb";
const read = (p) => readFileSync(`${ROOT}/${p}`, "utf8");
const authSrc = read("src/lib/auth.tsx");
const groupsSrc = read("src/features/GroupsPage.tsx");
const appSrc = read("src/app/App.tsx");
const versionTs = read("src/version.ts");
const pkg = JSON.parse(read("package.json"));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`ok - ${name}`);
  } catch (err) {
    fail++;
    console.log(`FAIL - ${name}: ${err.message}`);
  }
}

// --- 1. 單一約定：初始密碼＝職編 ---
check("defaultInitialPassword 存在且回傳 trim 後職編", () => {
  if (!authSrc.includes("export function defaultInitialPassword(staffId: string): string {")) {
    throw new Error("未找到 defaultInitialPassword");
  }
  if (!authSrc.includes("return staffId.trim();")) throw new Error("未回傳 trim 後職編");
  if (!authSrc.includes("帳號＝職編、初始密碼＝職編")) throw new Error("未寫明統一約定");
});

// --- 2. 帳號合成規則不變 ---
check("staffEmail 不變：職編@nurseboard.internal", () => {
  if (!authSrc.includes("return `${staffId.trim()}@nurseboard.internal`;")) {
    throw new Error("staffEmail 被改動");
  }
});

// --- 3. 仍無站內建立帳號／重設他人密碼的程式碼 ---
check("程式內無 createUser（開通仍在 Console 手動，不新增後端）", () => {
  if (authSrc.includes("createUserWithEmailAndPassword")) throw new Error("auth.tsx 出現 createUser");
  if (groupsSrc.includes("createUserWithEmailAndPassword")) throw new Error("GroupsPage 出現 createUser");
  if (appSrc.includes("createUserWithEmailAndPassword")) throw new Error("App.tsx 出現 createUser");
});

// --- 4. 首次登入強制改密碼機制仍在 ---
check("首次登入強制改密碼機制仍在", () => {
  if (!authSrc.includes("mustChangePassword")) throw new Error("auth.tsx 無 mustChangePassword");
  if (!authSrc.includes("setNeedsPasswordChange(profile.mustChangePassword)")) {
    throw new Error("登入後未依 mustChangePassword 設定強制改密");
  }
  if (!authSrc.includes("mustChangePassword: false,")) throw new Error("改密後未清 mustChangePassword");
  if (!appSrc.includes("首次登入")) throw new Error("登入頁無首次登入流程");
  if (!groupsSrc.includes("首次登入強制改密碼")) throw new Error("人員表單無強制改密勾選");
});

// --- 5. demo／demo 展示帳號不變 ---
check("demo／demo 展示帳號不變", () => {
  if (!authSrc.includes('trimmed === "demo" && password === "demo"')) throw new Error("demo 登入判斷被改動");
  if (!appSrc.includes("展示帳號：demo／demo")) throw new Error("登入頁 demo 提示被改動");
});

// --- 6. 三處管理員提示皆寫明初始密碼＝職編 ---
check("新增人員成功訊息寫明初始密碼請設為職編", () => {
  if (!groupsSrc.includes("初始密碼請設為職編 ${staffId}（首次登入須更改）")) {
    throw new Error("新增人員訊息未寫明初始密碼");
  }
});
check("人員匯入備註寫明初始密碼請設為該員職編", () => {
  if (!groupsSrc.includes("初始密碼請設為該員職編，首次登入須更改")) {
    throw new Error("匯入備註未寫明初始密碼");
  }
});
check("新增人員表單寫明帳號與初始密碼統一為職編", () => {
  if (!groupsSrc.includes("帳號與初始密碼統一為職編")) throw new Error("表單未寫明統一約定");
  if (!groupsSrc.includes("在 Firebase Console 建立使用者時初始密碼請設為該員職編")) {
    throw new Error("表單未寫明 Console 建立步驟");
  }
});

// --- 7. 登入頁新帳號提示 ---
check("登入頁有新帳號首次登入提示", () => {
  if (!appSrc.includes("新帳號首次登入：密碼預設為職編，登入後須立即更改")) {
    throw new Error("登入頁無新帳號提示");
  }
});

// --- 8. 版號一致 ---
check("版號一致：version.ts 與 package.json 皆為 1.40.6", () => {
  if (!versionTs.includes('VERSION = "1.40.6"')) throw new Error("version.ts 不是 1.40.6");
  if (pkg.version !== "1.40.6") throw new Error(`package.json 是 ${pkg.version}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
