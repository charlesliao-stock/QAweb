export type CapaStage =
  | "待確認"
  | "原因分析"
  | "措施規劃"
  | "措施執行"
  | "成效驗證"
  | "結案核准"
  | "正式結案"
  | "已退回";
export type CapaSource = "人工立案" | "結果分析" | "系統觸發";
export type CapaTemplateType = "原因分析" | "改善措施" | "成效驗證";
export type CapaActionStatus = "待開始" | "進行中" | "已完成";
export interface CapaAction {
  id: string;
  title: string;
  causeId: string;
  ownerId: string;
  ownerName: string;
  dueDate: string;
  status: CapaActionStatus;
  evidence: string;
}
export interface CapaApprovalStep {
  role: string;
  approverId?: string;
  approverName?: string;
  decision: "待審核" | "核准" | "退回";
  note?: string;
  decidedBy?: string;
  decidedAt?: string;
}
export interface CapaHistoryEntry {
  id: string;
  action: string;
  actorId: string;
  actorName: string;
  at: string;
  note?: string;
}
export interface CapaCase {
  id: string;
  caseNumber: string;
  title: string;
  source: CapaSource;
  stage: CapaStage;
  statusLabel?: string;
  indicatorId: string;
  indicatorCode: string;
  indicatorName: string;
  unitCode: string;
  unitName: string;
  ownerId: string;
  ownerName: string;
  threshold: number;
  triggerPeriodCount: number;
  periodKeys: string[];
  resultSnapshots: Array<{ period: string; rate: number; extraAudit?: boolean }>;
  findingSummary: string;
  immediateAction: string;
  rootCause: string;
  contributingFactors: string;
  actions: CapaAction[];
  verification: {
    baseline: string;
    target: string;
    observationPeriods: number;
    dataSource: string;
    sampleSize: string;
    verifierRole: string;
    result: "未驗證" | "通過" | "未通過";
    resultNote: string;
  };
  approvalSteps: CapaApprovalStep[];
  history: CapaHistoryEntry[];
  createdAt: string;
  updatedAt: string;
  dueDate: string;
  closedAt?: string;
  returnedFrom?: CapaStage;
}
export interface CapaSettings {
  triggerEnabled: boolean;
  defaultTriggerPeriods: number;
  indicatorOverrides: Record<string, number>;
  multiLevelApproval: boolean;
  approvalRoles: string[];
  verifierRole: string;
}
export interface CapaTemplate {
  id: string;
  type: CapaTemplateType;
  name: string;
  category: string;
  content: string;
  active: boolean;
}
export const DEFAULT_CAPA_SETTINGS: CapaSettings = {
  triggerEnabled: true,
  defaultTriggerPeriods: 2,
  indicatorOverrides: {},
  multiLevelApproval: true,
  approvalRoles: ["督導", "品管執行幹事"],
  verifierRole: "督導／品管",
};
export const CAPA_STAGES: CapaStage[] = [
  "待確認", "原因分析", "措施規劃", "措施執行", "成效驗證", "結案核准", "正式結案",
];
export const DEMO_CAPA_CASES: CapaCase[] = [
  {
    id: "demo-capa-014", caseNumber: "CA-2026-014", title: "紀錄完整率連續未達閾值", source: "系統觸發", stage: "措施執行",
    indicatorId: "demo-ind-3-0010", indicatorCode: "3-0010", indicatorName: "紀錄完整率", unitCode: "NUR-A", unitName: "一般病房 A",
    ownerId: "demo", ownerName: "林護理長", threshold: 90, triggerPeriodCount: 2, periodKeys: ["2026-09", "2026-10"],
    resultSnapshots: [{ period: "2026/09", rate: 84 }, { period: "2026/10", rate: 86 }], findingSummary: "交班欄位紀錄不完整，兩個有效審查期低於指標閾值。",
    immediateAction: "已提醒當班同仁補齊必要紀錄，並由護理長確認高風險個案交班資訊。",
    rootCause: "交班流程沒有紀錄完成檢核點；新進同仁對欄位填寫標準不一致。", contributingFactors: "流程／交接；工作輔助資訊不足。",
    actions: [
      { id: "act-1", title: "交班表新增紀錄完整性檢核欄", causeId: "交班流程缺少檢核點", ownerId: "demo", ownerName: "林護理長", dueDate: "2026-11-25", status: "進行中", evidence: "" },
      { id: "act-2", title: "同仁欄位填寫短訓練與隨班觀察", causeId: "填寫標準不一致", ownerId: "demo-2", ownerName: "陳副護理長", dueDate: "2026-11-28", status: "待開始", evidence: "" },
    ],
    verification: { baseline: "86%", target: "連續 2 個有效審查期達到 ≥90%", observationPeriods: 2, dataSource: "結果分析／審查紀錄", sampleSize: "依當期排程收案", verifierRole: "督導／品管", result: "未驗證", resultNote: "" },
    approvalSteps: [{ role: "督導", decision: "待審核" }, { role: "品管執行幹事", decision: "待審核" }],
    history: [{ id: "h-1", action: "案件建立並進入措施執行", actorId: "demo", actorName: "系統", at: "2026-11-10T09:30:00+08:00" }],
    createdAt: "2026-11-10T09:30:00+08:00", updatedAt: "2026-11-14T10:42:00+08:00", dueDate: "2026-12-05",
  },
  {
    id: "demo-capa-013", caseNumber: "CA-2026-013", title: "紀錄正確率改善追蹤", source: "人工立案", stage: "已退回",
    indicatorId: "demo-ind-2-0007", indicatorCode: "2-0007", indicatorName: "紀錄正確率", unitCode: "ICU-B", unitName: "加護病房 B",
    ownerId: "demo-2", ownerName: "陳護理長", threshold: 90, triggerPeriodCount: 2, periodKeys: ["2026-08", "2026-09"],
    resultSnapshots: [{ period: "2026/08", rate: 82 }, { period: "2026/09", rate: 85 }], findingSummary: "關鍵紀錄欄位漏填率偏高。", immediateAction: "已安排當日補正並確認交班。",
    rootCause: "紙本表單欄位容易略過，填寫指引不明確。", contributingFactors: "流程工具；欄位視覺提示不足。",
    actions: [{ id: "act-3", title: "修訂表單並增加欄位提示", causeId: "表單設計不易辨識", ownerId: "demo-2", ownerName: "陳護理長", dueDate: "2026-11-30", status: "進行中", evidence: "待補修訂版次與公告紀錄" }],
    verification: { baseline: "85%", target: "連續 2 期達標（≥90%）", observationPeriods: 2, dataSource: "結果分析", sampleSize: "依排程", verifierRole: "督導／品管", result: "未驗證", resultNote: "" },
    approvalSteps: [{ role: "督導", decision: "待審核" }], history: [{ id: "h-2", action: "退回補充流程根因及可驗證證據", actorId: "supervisor", actorName: "督導", at: "2026-11-12T15:20:00+08:00", note: "請補充表單變更的實施範圍及追蹤資料。" }],
    createdAt: "2026-11-08T08:00:00+08:00", updatedAt: "2026-11-12T15:20:00+08:00", dueDate: "2026-11-30", returnedFrom: "措施規劃",
  },
  {
    id: "demo-capa-009", caseNumber: "CA-2026-009", title: "交班完整率改善成效確認", source: "結果分析", stage: "正式結案",
    indicatorId: "demo-ind-3-0010", indicatorCode: "3-0010", indicatorName: "紀錄完整率", unitCode: "NUR-C", unitName: "一般病房 C",
    ownerId: "demo-3", ownerName: "王護理長", threshold: 90, triggerPeriodCount: 2, periodKeys: ["2026-07", "2026-08"],
    resultSnapshots: [{ period: "2026/07", rate: 87 }, { period: "2026/08", rate: 88 }], findingSummary: "交班紀錄完整率連續低於閾值。", immediateAction: "已補齊交班資訊。",
    rootCause: "資訊欄位分散在不同表單，交接時缺少提示。", contributingFactors: "表單流程不一致。",
    actions: [{ id: "act-9", title: "統一交班欄位與檢核步驟", causeId: "資訊分散", ownerId: "demo-3", ownerName: "王護理長", dueDate: "2026-09-01", status: "已完成", evidence: "已完成新表單公告及現場抽查。" }],
    verification: { baseline: "88%", target: "連續 2 期達標（≥90%）", observationPeriods: 2, dataSource: "結果分析", sampleSize: "20 人次／期", verifierRole: "督導／品管", result: "通過", resultNote: "2026/09 94%；2026/10 96%，均達標。" },
    approvalSteps: [{ role: "督導", decision: "核准", decidedBy: "supervisor", decidedAt: "2026-10-27T11:30:00+08:00" }, { role: "品管執行幹事", decision: "核准", decidedBy: "quality", decidedAt: "2026-10-28T09:00:00+08:00" }],
    history: [{ id: "h-9", action: "成效驗證通過並完成結案核准", actorId: "quality", actorName: "品管執行幹事", at: "2026-10-28T09:00:00+08:00" }],
    createdAt: "2026-08-01T09:00:00+08:00", updatedAt: "2026-10-28T09:00:00+08:00", dueDate: "2026-10-28", closedAt: "2026-10-28T09:00:00+08:00",
  },
];
export const DEMO_CAPA_TEMPLATES: CapaTemplate[] = [
  { id: "t-cause-1", type: "原因分析", name: "5 Why 系統因素提示", category: "分析工具", content: "從流程、環境、工具、資訊、訓練與工作條件檢視原因，避免先假設為個人疏失。", active: true },
  { id: "t-action-1", type: "改善措施", name: "晨會／交班宣導", category: "教育溝通", content: "於班前會說明問題、標準與紀錄方式；記錄實施日期、涵蓋對象與宣導證據。", active: true },
  { id: "t-action-2", type: "改善措施", name: "修正表單／檢核表", category: "流程工具", content: "確認修訂版號、實施日、使用範圍與舊版回收證據。", active: true },
  { id: "t-action-3", type: "改善措施", name: "同儕抽查／隨班觀察", category: "監測查核", content: "設定抽樣範圍、抽查人、頻率、資料位置及回饋方式。", active: true },
  { id: "t-verify-1", type: "成效驗證", name: "連續期別達標", category: "指標驗證", content: "觀察期內連續達到指標閾值，並記錄有效期別、來源及樣本量。", active: true },
];
export const CAPA_STATUS_LABEL: Record<CapaStage, string> = {
  待確認: "待確認", 原因分析: "原因分析", 措施規劃: "措施規劃", 措施執行: "措施執行",
  成效驗證: "成效驗證", 結案核准: "結案核准", 正式結案: "已核准結案", 已退回: "退回補充",
};
export function allowedTriggerPeriods(settings: CapaSettings, indicatorId: string): number {
  return settings.indicatorOverrides[indicatorId] ?? settings.defaultTriggerPeriods;
}
export function newId(prefix = "capa"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
export function makeHistory(action: string, actorId: string, actorName: string, note = ""): CapaHistoryEntry {
  return { id: newId("history"), action, actorId, actorName, at: new Date().toISOString(), ...(note ? { note } : {}) };
}
