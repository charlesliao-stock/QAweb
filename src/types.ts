export const ROLES = [
  "一般人員",
  "審查員",
  "護理長",
  "督導",
  "品管執行幹事",
  "系統管理員",
  "指標負責人",
] as const;

export type Role = (typeof ROLES)[number];

export type PageId =
  | "dashboard"
  | "indicators"
  | "schedule"
  | "audit"
  | "results"
  | "groups"
  | "capa"
  | "admin";

export type Rag = "green" | "amber" | "red";

export interface Indicator {
  id: string;
  code: string;
  name: string;
  group: string;
  threshold: number;
  attainment: number;
  audited: number;
  planned: number;
  version: string;
  status: "啟用" | "審核中" | "草稿";
  owner: string;
  resultLabel: string;
}

export interface ScheduleTask {
  id: string;
  indicator: string;
  unit: string;
  month: string;
  reviewer: string;
  done: number;
  total: number;
  due: string;
  status: "進行中" | "待開始" | "逾期補審";
}

export interface CapaCase {
  id: string;
  title: string;
  unit: string;
  owner: string;
  due: string;
  progress: number;
  stage: string;
  status: "改善中" | "待驗證" | "逾期";
}
