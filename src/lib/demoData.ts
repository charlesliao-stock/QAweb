/**
 * 展示模式預載資料（新資料模型）。
 * collectionPath → { docId: data }；子集合 path 如 "indicators/QI-001/versions"
 */
import {
  DEFAULT_SYSTEM_PARAMS,
  SEED_ROLES,
  SEED_TITLES,
} from "./seed";
import { PERM_KEYS } from "./permissions";

const QI001_TEN_STEPS = {
  step1: "所有護理單位",
  step2:
    "護理人員在執行口服、靜脈注射給藥作業（除TPN、化療外）時，能：正確辨識病人、確實三讀五對、確實執行用藥指導、給藥後完成紀錄。",
  step3: "非常重要之照護面，屬於高危險、高頻次、具問題傾向之護理活動。",
  step4: {
    basis:
      "醫院評鑑基準2.5.8、2.5.11落實正確給藥及確實執行病人用藥教育之相關規定；護理-技術-3-0901-口服給藥法；病房-共用-2-0506_護理人員給藥管理程序書",
    subIndicators: [
      {
        name: "護理人員給藥作業正確率",
        numerator: "護理人員給藥作業正確之人次數",
        denominator: "審核總人次數",
      },
      {
        name: "各細項指標之正確率",
        numerator: "細項指標正確之人次數",
        denominator: "審核總人次數－不適用人次數",
      },
    ],
  },
  step5: {
    thresholds: [
      { name: "護理人員給藥作業正確率", value: 100 },
      { name: "各細項指標正確率", value: 100 },
    ],
  },
  step6: {
    caseCount: "每季隨機審核各單位3位執行給藥作業的護理師，每單位每年至少審核4次。",
    auditors: "由護理長或各單位品管小組成員或中央審核組種子負責監測。",
    auditDate: "中央稽核單位每年至少審核4次。",
    auditMethod:
      "採隨機監測，依據「護理人員給藥作業正確率審核表」實際查核護理人員執行給藥作業的過程。",
  },
  step7: "各單位自行依據監測結果與閾值之差異，進行系統性或特殊性原因之分析。",
  step8: "確定要因後，於一個月內由單位研擬改善對策並執行。",
  step9:
    "再進行監測、統計、分析與評值。連續二次審查未達閾值，請單位填寫「品質管理改善追蹤單」，並於兩個月內交由召集人審閱。",
  step10: "步驟六至九於各單位品管組、病房（加護病房）品管組與護理部品管組會議中呈報。",
};

const QI001_QUESTIONS = [
  {
    text: "1.病人辨識正確",
    optionSet: "yes-no",
    guidance:
      "1.護理人員將護理工作車推至病人單位，有開啟給藥執行作業畫面\n2.護理人員以兩種辨識資料（姓名、出生年月日）核對病人",
    group: "確認病人",
  },
  {
    text: "2.執行三讀步驟正確",
    optionSet: "yes-no",
    guidance:
      "1.第一讀：從藥盒取出藥袋／藥包或針劑，核對電腦給藥執行畫面\n2.第二讀：取出藥物放入治療盤／藥杯內再次核對",
    group: "給藥前",
  },
  {
    text: "3.執行五對步驟正確",
    optionSet: "yes-no",
    guidance:
      "1.時間對：於醫囑給藥時間前後30分鐘內執行\n2.藥物對：逐一核對藥物圖片，確認藥物與醫囑一致",
    group: "給藥前",
  },
  {
    text: "4.執行給藥正確",
    optionSet: "yes-no",
    guidance:
      "1.於給藥執行作業畫面點選「確認」鍵\n2.病人不在病室時，未將藥物留置於病人單位",
    group: "執行給藥",
  },
  {
    text: "5.清楚雙人核對的情境與流程",
    optionSet: "yes-no",
    guidance:
      "實際查核或口述：管制藥品或靜脈輸液幫浦給藥需雙人核對，涵蓋病人辨識與三讀五對完整流程。",
    group: "了解特殊用藥雙人覆核流程",
  },
  {
    text: "6.執行藥物指導",
    optionSet: "yes-no-na",
    guidance:
      "1.詢問病人、家屬可說出藥物之作用、副作用及注意事項（加護病房、門診無法監測則填不適用）\n2.「衛教指導紀錄單」有用藥指導紀錄並有簽名",
    group: "落實藥物指導",
  },
  {
    text: "7.熟悉用藥不良反應通報",
    optionSet: "yes-no",
    guidance:
      "通報途徑：IPD護理人員給藥執行畫面及院內資訊整合版→病人安全專區→過敏／ADR註記與通報。",
    group: "用藥不良反應處理",
  },
];

const QI002_TEN_STEPS = {
  step1: "所有護理單位",
  step2: "護理人員於照護病人前後、執行無菌技術前後，依手部衛生五時機正確執行手部衛生。",
  step3: "高頻次、高影響力之感染管制基礎措施。",
  step4: {
    basis: "醫院評鑑基準感染管制章節；WHO 手部衛生指引",
    subIndicators: [
      {
        name: "手部衛生遵從率",
        numerator: "正確執行手部衛生之人次數",
        denominator: "觀察總人次數",
      },
    ],
  },
  step5: {
    thresholds: [{ name: "手部衛生遵從率", value: 90 }],
  },
  step6: {
    caseCount: "每月每單位隨機觀察20人次。",
    auditors: "單位品管小組成員。",
    auditDate: "每月。",
    auditMethod: "直接觀察法，依手部衛生查核表記錄。",
  },
  step7: "依監測結果與閾值差異分析原因。",
  step8: "針對低遵從時機加強教育訓練。",
  step9: "次月再監測確認改善成效。",
  step10: "於單位品管會議呈報。",
};

const QI002_QUESTIONS = [
  {
    text: "1.接觸病人前執行手部衛生",
    optionSet: "yes-no",
    guidance: "觀察是否於接觸病人前依步驟完成手部衛生。",
    group: "手部衛生時機",
  },
  {
    text: "2.執行無菌技術前執行手部衛生",
    optionSet: "yes-no",
    guidance: "觀察無菌技術前是否完成手部衛生。",
    group: "手部衛生時機",
  },
  {
    text: "3.手部衛生步驟正確",
    optionSet: "yes-no",
    guidance: "查核搓揉步驟與時間是否符合規範（至少20秒）。",
    group: "手部衛生技巧",
  },
];

function buildDocs<T extends { id: string }>(
  items: T[],
): Record<string, Omit<T, "id">> {
  const out: Record<string, Omit<T, "id">> = {};
  for (const { id, ...rest } of items) out[id] = rest;
  return out;
}

/**
 * 延遲建構（函式呼叫時才組裝）：避免 demoData → seed → db → demoStore → demoData
 * 的循環依賴在模組載入期崩潰。
 */
export function getDemoData(): Record<string, Record<string, unknown>> {
  return {
    groups: {
      "g-ward": { name: "病房組" },
      "g-icu": { name: "加護組" },
    },
    units: {
      "9A": { name: "9A病房", groupId: "g-ward" },
      "9B": { name: "9B病房", groupId: "g-ward" },
      ICU: { name: "加護病房", groupId: "g-icu" },
    },
    titles: buildDocs(
      SEED_TITLES.map((t) => ({
        id: `${t.level}-${t.name}`,
        name: t.name,
        level: t.level,
        // 展示帳號職稱為「督導」：給滿權限，交集判斷才不會把展示模式鎖死
        ...(t.name === "督導"
          ? {
              permissions: Object.fromEntries(
                PERM_KEYS.map((k) => [k, true]),
              ),
            }
          : {}),
      })),
    ),
    roles: buildDocs(
      SEED_ROLES.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
      })),
    ),
    systemParams: {
      config: { ...DEFAULT_SYSTEM_PARAMS },
    },
    users: {
      demo: {
        name: "展示管理員",
        unitCode: "",
        title: "",
        roles: ["系統管理員"],
        mustChangePassword: false,
        status: "在職",
      },
      A12345: {
        name: "王小明",
        unitCode: "9A",
        title: "護理師",
        roles: ["審查員"],
        mustChangePassword: false,
        status: "在職",
      },
      B67890: {
        name: "陳大華",
        unitCode: "9A",
        title: "護理長",
        roles: ["護理長"],
        mustChangePassword: false,
        status: "在職",
      },
      C11111: {
        name: "林小美",
        unitCode: "9B",
        title: "護理師",
        roles: ["審查員", "一般人員"],
        mustChangePassword: false,
        status: "在職",
      },
    },
    indicators: {
      "QI-001": {
        name: "護理人員給藥作業正確率",
        groupId: "g-ward",
        owners: ["B67890"],
        threshold: 100,
        status: "啟用",
        version: "v1.0",
        tenSteps: QI001_TEN_STEPS,
        questions: QI001_QUESTIONS,
      },
      "QI-002": {
        name: "手部衛生遵從率",
        groupId: "g-ward",
        owners: ["B67890"],
        threshold: 90,
        status: "啟用",
        version: "v1.0",
        tenSteps: QI002_TEN_STEPS,
        questions: QI002_QUESTIONS,
      },
    },
    "indicators/QI-001/versions": {
      "v1.0": {
        version: "v1.0",
        status: "啟用",
        threshold: 100,
        tenSteps: QI001_TEN_STEPS,
        questions: QI001_QUESTIONS,
        effectiveDate: "2026-11-01",
        note: "初版",
      },
    },
    "indicators/QI-002/versions": {
      "v1.0": {
        version: "v1.0",
        status: "啟用",
        threshold: 90,
        tenSteps: QI002_TEN_STEPS,
        questions: QI002_QUESTIONS,
        effectiveDate: "2026-11-01",
        note: "初版",
      },
    },
  };
}
