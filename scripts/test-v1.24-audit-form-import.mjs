import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";

const ROOT = process.cwd();
const entry = `
import { defaultOptionSet } from "${ROOT}/src/lib/indicators";
import { mergeImportedAuditForm, resolveAuditImportGroup } from "${ROOT}/src/lib/auditFormImport";
export { defaultOptionSet, mergeImportedAuditForm, resolveAuditImportGroup };
`;
writeFileSync("/tmp/v124-audit-form-import-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v124-audit-form-import-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v124-audit-form-import-bundle.cjs",
  logLevel: "silent",
  define: { "import.meta.env": "{}" },
});
const require2 = createRequire("/tmp/v124-audit-form-import-bundle.cjs");
const L = require2("/tmp/v124-audit-form-import-bundle.cjs");

let passed = 0;
let failed = 0;
function assert(name, condition) {
  if (condition) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.error(`FAIL ${name}`);
  }
}

const groups = [
  { id: "g-ward", name: "病房組" },
  { id: "g-icu", name: "加護組" },
];
assert(
  "組別欄可用唯一組別名稱解析",
  L.resolveAuditImportGroup("病房組", groups).groupId === "g-ward",
);
assert(
  "組別欄可用組別 ID 解析",
  L.resolveAuditImportGroup("g-icu", groups).groupName === "加護組",
);
assert(
  "組別缺漏會回報 missing",
  L.resolveAuditImportGroup("  ", groups).reason === "missing",
);
assert(
  "不存在的組別不會任意匹配",
  L.resolveAuditImportGroup("不存在組", groups).reason === "unknown",
);
assert(
  "同名組別有歧義時不會錯配",
  L.resolveAuditImportGroup("病房組", [
    ...groups,
    { id: "g-ward-2", name: "病房組" },
  ]).reason === "ambiguous",
);

const existing = {
  questions: [
    {
      id: "q-existing",
      itemText: "既有題目",
      optionSet: L.defaultOptionSet(),
      guidance: "既有指引",
      commonErrors: [],
      groupId: "old-vitals",
      groupName: "生命徵象",
      order: 0,
    },
  ],
  questionGroups: [{ id: "old-vitals", name: "生命徵象", order: 0 }],
  useQuestionGroups: true,
};
const imported = {
  questions: [
    {
      id: "q-existing",
      itemText: "匯入題目一",
      optionSet: L.defaultOptionSet(),
      guidance: "匯入指引一",
      commonErrors: [],
      groupId: "import-vitals",
      groupName: "生命徵象",
      order: 0,
    },
    {
      id: "q-import-2",
      itemText: "匯入題目二",
      optionSet: L.defaultOptionSet(),
      guidance: "匯入指引二",
      commonErrors: [],
      groupId: "import-safety",
      groupName: "安全事項",
      order: 1,
    },
    {
      id: "q-import-3",
      itemText: "未分組題目",
      optionSet: L.defaultOptionSet(),
      guidance: "",
      commonErrors: [],
      groupId: null,
      groupName: "",
      order: 2,
    },
  ],
  questionGroups: [
    { id: "import-vitals", name: "生命徵象", order: 0 },
    { id: "import-safety", name: "安全事項", order: 1 },
  ],
  useQuestionGroups: true,
};

const replaced = L.mergeImportedAuditForm(existing, imported, "replace");
assert("取代模式不保留原題目", replaced.questions.length === 3);
assert("取代模式重設題目順序", replaced.questions.every((q, i) => q.order === i));
assert(
  "取代模式只保留匯入分組",
  replaced.questionGroups.map((g) => g.name).join(",") === "生命徵象,安全事項",
);

const appended = L.mergeImportedAuditForm(existing, imported, "append");
assert("追加模式保留原題並接續匯入題目", appended.questions.length === 4);
assert(
  "追加模式題目順序接續原題",
  appended.questions.map((q) => q.order).join(",") === "0,1,2,3",
);
assert(
  "同名分組沿用既有分組 ID",
  appended.questions[1].groupId === "old-vitals",
);
assert(
  "新分組題目映射至新分組",
  appended.questions[2].groupId ===
    appended.questionGroups.find((g) => g.name === "安全事項")?.id,
);
assert(
  "追加後題目 ID 不重複",
  new Set(appended.questions.map((q) => q.id)).size === appended.questions.length,
);
assert(
  "追加後未分組題目仍未分組",
  appended.questions[3].groupId === null && appended.questions[3].groupName === "",
);
assert(
  "追加模式保留已有的分組使用設定",
  appended.useQuestionGroups === true,
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
