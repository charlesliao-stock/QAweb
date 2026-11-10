import {
  LEGACY_REVIEWER_ROLE_NAMES,
  reviewerRoleNames,
  type RoleMetaMap,
} from "./orgMeta";

function taipeiDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** 未設定到期日（null／空字串）代表永久有效；到期日當天仍有效。 */
export function isReviewerAccessActive(expiresAt: unknown, now = new Date()): boolean {
  if (expiresAt == null || expiresAt === "") return true;
  if (typeof expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) return false;
  return expiresAt >= taipeiDate(now);
}

/**
 * 只移除逾期的審查員角色，不影響同一人其他有效角色。
 * 審查員類別改以角色詮釋資料判斷（傳入 roleMeta；未傳時以舊名稱推導，
 * 行為與舊版一致）。
 */
export function activeRolesForReviewerExpiry(
  roles: string[],
  expiresAt: unknown,
  now = new Date(),
  roleMeta?: RoleMetaMap,
): string[] {
  if (isReviewerAccessActive(expiresAt, now)) return roles;
  // 有詮釋資料時以類別為準；無詮釋資料時以舊名稱清單推導。
  const reviewerNames = roleMeta
    ? new Set(reviewerRoleNames(roleMeta))
    : null;
  return roles.filter((role) =>
    reviewerNames
      ? !reviewerNames.has(role)
      : !LEGACY_REVIEWER_ROLE_NAMES.includes(role),
  );
}
