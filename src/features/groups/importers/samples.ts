import { unitTemplateRows, UNIT_TEMPLATE_HEADERS, userTemplateRows, USER_TEMPLATE_HEADERS } from "../../../lib/orgImport";

// ================= 範例檔 =================

export const GROUP_SAMPLE: string[][] = [["品管組名稱"], ["病房組"], ["加護組"]];

export const GROUP_HEADER = ["品管組名稱"];

// v1.21：單位／人員範本改用 lib/orgImport（匯入欄位與範本單一來源）
export const UNIT_SAMPLE: string[][] = unitTemplateRows();

export const UNIT_HEADER = UNIT_TEMPLATE_HEADERS;

export const TITLE_SAMPLE: string[][] = [
  ["職稱名稱", "層級"],
  ["主任", "部級"],
  ["督導", "部級"],
  ["護理長/副護理長", "單位"],
  ["護理師", "單位"],
  ["護士", "單位"],
];

export const TITLE_HEADER = ["職稱名稱", "層級"];

export const ROLE_SAMPLE: string[][] = [
  ["角色名稱", "層級"],
  ["召集人", ""],
  ["執行幹事", ""],
];

export const ROLE_HEADER = ["角色名稱", "層級"];

export const USER_SAMPLE: string[][] = userTemplateRows();

export const USER_HEADER = USER_TEMPLATE_HEADERS;
