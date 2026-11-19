import { useMemo, useCallback } from "react";
import { shouldAutoLinkReviewer } from "../../../lib/scheduling";
import { resolveDataScope, deriveCrossFlags, isUnitSchedulerRole } from "../../../lib/dataScope";
import { titleFlagsOf } from "../../../lib/orgMeta";
import { isReviewerRole } from "../../../lib/roleIdentity";
import type { useScheduleState } from "./useScheduleState";

export function useScheduleScope(prev: ReturnType<typeof useScheduleState>) {
  const { users, orgMeta, user, units, catalog, myUnitCode, indicators } = prev;

  const usersMap = useMemo(() => {
    const m = new Map<string, string>();
    users.forEach((u) => m.set(u.id, u.name));
    return m;
  }, [users]);
  // v1.83.0：尚未開通帳號的在職人員（排程指派審查員時提醒用）
  const inactiveIds = useMemo(
    () => new Set(users.filter((u) => !u.activated && u.status !== "停用").map((u) => u.id)),
    [users],
  );
  // v1.88.4：具審查員角色且效期有效的職編（分工表批次匯入驗證用；
  // reviewReviewers 名單內的職編另由 reviewersByGroup 判定，兩者任一成立即可）
  const reviewerRoleIds = useMemo(
    () =>
      new Set(
        users
          .filter(
            (u) =>
              u.reviewerAccessActive &&
              shouldAutoLinkReviewer(u.roles, orgMeta.roleMeta),
          )
          .map((u) => u.id),
      ),
    [users, orgMeta.roleMeta],
  );
  // v1.88.4：查閱頁任務追蹤的可見單位（與結果分析／CAPA 同一 dataScope 口徑；
  // kind all 時為 null＝全看；審查員本人的任務在彈窗內另行放行）
  const detailScopeUnits = useMemo(() => {
    if (!user) return null;
    const scope = resolveDataScope({
      isAdmin: (user.roles ?? []).includes("系統管理員"),
      roles: user.roles ?? [],
      title: user.title ?? "",
      titleFlags: titleFlagsOf(user.title ?? "", user.titleId, orgMeta.titleMeta, orgMeta.titleMetaById),
      memberships: user.memberships ?? [],
      unitCode: user.unitCode ?? "",
      titleUnitCodes: user.titleUnitCodes ?? [],
      units,
      unitGroups: catalog.unitGroups,
      cross: deriveCrossFlags(catalog.templates, user.roles ?? [], user.title ?? ""),
      isReviewer: isReviewerRole(user.roles ?? [], orgMeta.roleMeta),
    });
    return scope.kind === "all" ? null : scope.unitCodes;
  }, [user, units, catalog, orgMeta]);
  // v1.88.5：單位排程者（單位召集人／單位執行幹事，不論 cross）——
  // 只能幫自己單位排程、只看得到自己單位的排程內容；指標不設限（見 rows
  // 與各編輯器）。系統管理員不受限；其餘角色依上節 dataScope 不變。
  const isUnitScheduler = useMemo(
    () =>
      isUnitSchedulerRole(
        user?.roles ?? [],
        (user?.roles ?? []).includes("系統管理員"),
      ),
    [user],
  );
  const scheduleRestrictedUnits = useMemo(
    () =>
      isUnitScheduler && myUnitCode
        ? new Set<string>([myUnitCode])
        : isUnitScheduler
          ? new Set<string>()
          : null,
    [isUnitScheduler, myUnitCode],
  );
  // 查閱頁用：單位排程者不論 cross 皆只看自己單位；其餘沿用 dataScope。
  const scheduleScopeUnits = scheduleRestrictedUnits ?? detailScopeUnits;
  const unitNameOf = useCallback(
    (code: string) => units.find((u) => u.code === code)?.name ?? code,
    [units],
  );
  const indicatorOf = useCallback(
    (id: string) => indicators.find((i) => i.id === id),
    [indicators],
  );

  return {
    isUnitScheduler,
    unitNameOf,
    scheduleRestrictedUnits,
    usersMap,
    indicatorOf,
    reviewerRoleIds,
    inactiveIds,
    scheduleScopeUnits,
  };
}
