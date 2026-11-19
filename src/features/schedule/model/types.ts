import type { CycleCategory } from "../../../lib/cycle";
import type { IndicatorSchedule } from "../../../lib/scheduling";

export interface IndicatorLite {
  id: string;
  /** 顯示用編號（由複合文件 ID 解析；v1.21） */
  code: string;
  name: string;
  groupId: string;
  /** 指標狀態（v1.17：排程選擇器只列「啟用」） */
  status: string;
}

export interface UnitLite {
  code: string;
  name: string;
  groupId: string;
  mergedFromUnitCodes?: string[];
}

export interface UserLite {
  id: string;
  name: string;
  unitCode: string;
  status: string;
  reviewerAccessActive: boolean;
  /** 已開通帳號（曾成功登入，users.activatedAt 有值）；false＝尚未開通，無法自行登入 */
  activated: boolean;
  /** 角色名清單（分工表匯入驗證「具審查員角色」用） */
  roles: string[];
}

export interface ReviewerLite {
  personId: string;
  name: string;
}

export interface RowItem {
  key: string;
  indicatorId: string;
  /** 顯示用編號（v1.21：不顯示複合 ID） */
  code: string;
  name: string;
  groupId: string;
  groupName: string;
  /** 指標狀態（v1.17.0 補強：非「啟用」不得產生排程／加審） */
  status: string;
  category: CycleCategory;
  /** 年度／學年度的週期鍵；臨時列為該排程的 period（尚無排程則 ""） */
  period: string;
  schedule: IndicatorSchedule | null;
}

export type View =
  | { kind: "list" }
  | {
      kind: "schedule";
      indicatorId: string;
      category: "year" | "academic";
      year: number;
    }
  | { kind: "assignment"; indicatorId: string; category: "year" | "academic"; period: string }
  /** v1.88.6：查閱改整頁式（ScheduleDetailPage），不再用彈窗 */
  | {
      kind: "detail";
      indicatorId: string;
      category: CycleCategory;
      period: string;
    };
