export type PageId =
  | "dashboard"
  | "indicators"
  | "schedule"
  | "audit"
  | "results"
  | "groups"
  | "handoff"
  | "capa"
  | "admin"
  | "permissions"
  | "reviewers";

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
