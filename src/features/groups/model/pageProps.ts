import type { Tab, OrgMemberTarget } from "./types";

export interface GroupsPageProps {
  onAction: (message: string) => void;
  /** 返回人員管理時要回到原本的頁籤（App 記住上次頁籤；預設人員） */
  initialTab?: Tab;
  /** v1.86.0：指定時只渲染該成員／單位管理獨立頁（不顯示頁籤與清單） */
  memberPage?: OrgMemberTarget | null;
  /** 頁籤切換時回報 App（供獨立頁返回時回到原本頁籤） */
  onTabChange?: (tab: Tab) => void;
  /** v1.86.0：成員／單位管理改跳獨立頁（App 切換 PageId） */
  onOpenMemberPage?: (target: OrgMemberTarget) => void;
  /** v1.86.0：獨立頁返回人員管理 */
  onBackToGroups?: () => void;
}
