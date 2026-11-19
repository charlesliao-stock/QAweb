import type { TitleFlags, RoleScope } from "../../../lib/orgMeta";
import type { Membership } from "../../../lib/roleIdentity";

/** v1.21：組織與設定重整為五區（人員／單位／角色／職稱／群組） */
export type Tab = "users" | "units" | "roles" | "titles" | "groups";

export type GroupsTab = Tab;

/** v1.86.0：成員／單位管理獨立頁的目標（角色／職稱／群組各一頁）；v1.86.1：單位也改跳獨立頁；v1.87.0：職稱下層（parent 為上層頁）與督導負責單位（title-units） */
export interface OrgMemberTarget {
  kind: "role" | "title" | "group" | "unit" | "title-units";
  id: string;
  /** 下層頁返回的上層頁（無＝回人員管理） */
  parent?: OrgMemberTarget;
}

export interface GroupRow {
  id: string;
  name: string;
  unitCount: number;
}

export interface UnitRow {
  code: string;
  name: string;
  groupId: string;
  mergedFromUnitCodes: string[];
  groupName: string;
  memberCount: number | null;
}

export interface TitleRow extends TitleFlags {
  id: string;
  name: string;
  /** v1.55.0：所屬層級 id（空＝未分層級） */
  levelId: string;
  /** v1.88.8 補項：層級內順序（小在上；上下順序即階層，下屬鏈讀此欄位） */
  order: number;
  userCount: number | null;
}

export interface UserRow {
  staffId: string;
  name: string;
  unitCode: string;
  title: string;
  titleId: string;
  roles: string[];
  /** 群組＋角色配對（v1.21；無則由舊 groupIds＋roles 推導） */
  memberships: Membership[];
  status: string;
  reviewerAccessExpiresAt: string;
  /** v1.58.0：督導負責的單位代碼（v1.87.0 起由職稱成員管理頁的督導頁設定） */
  titleUnitCodes: string[];
}

export interface RoleRow {
  id: string;
  name: string;
  /** v1.55.0：所屬層級 id（空＝未分層級） */
  levelId: string;
  /** v1.88.8 補項：層級內順序（小在上；上下順序即階層，下屬鏈讀此欄位） */
  order: number;
  /** 適用範圍（由層級推導：group＝群組角色；unit＝單位角色，v1.57.0 A3） */
  scope: RoleScope;
  memberCount: number | null;
}

export interface OptionItem {
  id: string;
  name: string;
  scope?: RoleScope;
  /** v1.55.0：所屬層級 id（空＝未分層級） */
  levelId?: string;
  /** v1.88.8 補項：層級內順序（小在上） */
  order?: number;
}

export interface GroupForm {
  name: string;
}

export interface UnitForm {
  code: string;
  name: string;
  groupId: string;
  mergedFromUnitCodes: string[];
}

/** 職稱：名稱之外，勾選主管層級旗標供身分判斷（儀表板／結果範圍）使用。 */
export interface TitleForm extends TitleFlags {
  name: string;
  /** v1.55.0：所屬層級 id（空＝未分層級） */
  levelId: string;
}

export interface UserForm {
  staffId: string;
  name: string;
  unitCode: string;
  title: string;
  titleId: string;
  hireDate: string;
  email: string;
  phone: string;
  /** 群組＋角色配對列（v1.21：可多個、各群組角色可不同） */
  memberships: Membership[];
  mustChangePassword: boolean;
  /** v1.58.0：督導負責的單位代碼（僅督導職稱時設定；承接舊督導轄區群組）；v1.87.0：改由職稱成員管理頁的督導頁設定 */
  titleUnitCodes: string[];
  reviewerAccessExpiresAt: string;
}

export interface PreviewRow {
  index: number;
  values: string[];
  ok: boolean;
  error: string;
}
