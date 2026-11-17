// v1.54.0 靜態守衛：全站 data-panel 邊界統一（內嵌區 16px／20px）。
// 不跑瀏覽器，只核對原始碼：新容器存在、滿版表格維持貼邊、展開區與
// 底部說明皆已包進邊界。線上逐項點按由主代理另行驗證。
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf-8");
const css = read("../src/styles.css");
const groups = read("../src/features/GroupsPage.tsx");
const perm = read("../src/features/PermissionManagementPage.tsx");
const admin = read("../src/features/AdminPage.tsx");
const schedule = read("../src/features/SchedulePage.tsx");
const indicators = read("../src/features/IndicatorsPage.tsx");
const versionTs = read("../src/version.ts");
const pkg = JSON.parse(read("../package.json"));

// 版號
check("version.ts = 1.54.0", versionTs.includes('VERSION = "1.54.0"'));
check("package.json = 1.54.0", pkg.version === "1.54.0");

// CSS：新容器與滿版表格不動
check("panel-inset padding 16px 20px", /\.panel-inset \{\s*padding: 16px 20px;\s*\}/.test(css));
check("panel-inset.divided 有上分隔線", /\.panel-inset\.divided \{\s*border-top: 1px solid #edf0f1;\s*\}/.test(css));
check("panel.data-panel 仍 padding 0（滿版表格不動）", /\.panel\.data-panel \{\s*padding: 0;\s*\}/.test(css));

// GroupsPage：三處成員管理展開區改用 divided 容器，不再是 marginTop:12 裸 div
check("群組／單位／職稱展開區共 3 個 panel-inset divided", (groups.match(/panel-inset divided/g) || []).length === 3);
check("無殘留 marginTop:12 展開區", !groups.includes('<div style={{ marginTop: 12 }}>'));
// 匯入預覽：標題與按鈕包進邊界，表格維持直接子元素
check("匯入預覽標題包 panel-inset", groups.includes('<section className="panel data-panel import-preview">\n          <div className="panel-inset">'));
check("匯入預覽表格仍為 section 直接子元素（滿版不動）", /import-preview">[\s\S]*?<div className="panel-inset">[\s\S]*?<\/div>\s*<div className="table-scroll">/.test(groups));
// 底部說明：群組／單位／職稱＋角色共 4 處包進邊界
check("群組底部說明包邊界", groups.includes("群組維護限品管執行幹事或系統管理員") && /<div className="panel-inset">\s*<p className="settings-note">\s*群組維護限/.test(groups));
check("單位底部說明包邊界", /<div className="panel-inset">\s*<p className="settings-note">\s*單位維護限/.test(groups));
check("職稱底部說明包邊界", /<div className="panel-inset">\s*<p className="settings-note">\s*職稱維護限/.test(groups));
check("角色底部說明包邊界", /<div className="panel-inset">\s*<p className="settings-note">\s*角色以名稱唯一/.test(groups));
// 角色成員管理整頁包進邊界
check("角色成員管理整頁包 panel-inset", /<section className="panel data-panel">\s*<div className="panel-inset">\s*<MemberChecklist/.test(groups));
// 三張主列表格仍為 data-panel 直接子元素（滿版不動）
check("群組列表格維持貼邊", /<section className="panel data-panel">\s*<div className="table-scroll">\s*<table className="permission-table">\s*<thead>\s*<tr>\s*<SortHeader label="群組名稱"/.test(groups));
check("職稱列表格維持貼邊", /<section className="panel data-panel">\s*<div className="table-scroll">\s*<table className="permission-table">\s*<thead>\s*<tr>\s*<SortHeader label="職稱名稱"/.test(groups));

// 權限管理：4 個面板皆有邊界；權限矩陣表維持直接子元素
check("權限管理 4 個 panel-inset", (perm.match(/panel-inset/g) || []).length === 4);
check("權限矩陣表維持貼邊", /<\/div>\s*\{rowsForTarget\.length !== 0 && \(\s*permissionMatrix/.test(perm));

// 稽核紀錄：標題、3 則說明、搜尋列、篩選結果共 6 個 panel-inset；紀錄表維持貼邊
check("稽核紀錄 6 個 panel-inset", (admin.match(/panel-inset/g) || []).length === 6);
check("稽核紀錄表維持貼邊", /<div className="table-scroll">\s*<table className="permission-table">\s*<thead>\s*<tr>\s*<th>時間<\/th>/.test(admin));

// 其他 data-panel 純表格頁不動：排程表、指標表仍為直接子元素
check("排程表維持貼邊", /<section className="panel data-panel">\s*<div className="table-scroll">\s*<table className="data-table">/.test(schedule));
check("指標表維持貼邊", /<section className="panel data-panel">\s*<div className="table-scroll">\s*<table className="permission-table">/.test(indicators));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
