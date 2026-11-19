import { useState, useMemo } from "react";
import type { UnitPanel } from "../model/types";
import { useOrgMeta } from "../../../lib/useOrgMeta";
import { titleFlagsOf, hasRoleCategory } from "../../../lib/orgMeta";
import { isReviewerRole } from "../../../lib/roleIdentity";
import { resolveDataScope, deriveCrossFlags } from "../../../lib/dataScope";
import type { ResultsCacheScope } from "../../../lib/resultsCache";
import type { useResultsState } from "./useResultsState";

export function useResultsScope(prev: ReturnType<typeof useResultsState>) {
  const { user, units, catalog } = prev;

  // 單位分析矩陣下方展開面板（曲線圖／選項明細）
  const [unitPanel, setUnitPanel] = useState<UnitPanel | null>(null);

  // 資料範圍（v1.88.4：改走共用 dataScope——縱向從屬＋橫向 cross 取聯集，
  // 取代原先寫死的推導；護理長仍優先 staff 分支，沿用舊順序，保留摘要模式）
  const orgMeta = useOrgMeta();
  const isNurseLeader = !!user && (
    titleFlagsOf(user.title ?? "", user.titleId, orgMeta.titleMeta, orgMeta.titleMetaById).isUnitHead ||
    hasRoleCategory(user.roles ?? [], "unitHead", orgMeta.roleMeta)
  );
  const isReviewer = !!user && isReviewerRole(user?.roles ?? [], orgMeta.roleMeta);
  const dataScope = useMemo(() => {
    if (!user) return null;
    return resolveDataScope({
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
      isReviewer,
    });
  }, [user, units, catalog, orgMeta.titleMeta, orgMeta.titleMetaById, isReviewer]);

  const scope = useMemo(() => {
    const roles = user?.roles ?? [];
    if (roles.includes("系統管理員")) return { kind: "admin" as const };
    if (!user) return { kind: "admin" as const };
    if (dataScope?.kind === "all") return { kind: "admin" as const };
    if (isNurseLeader)
      return { kind: "staff" as const, unitCode: user.unitCode };
    if (isReviewer)
      return { kind: "reviewer" as const, staffId: user.staffId };
    return { kind: "staff" as const, unitCode: user.unitCode };
  }, [user, isNurseLeader, isReviewer, dataScope]);

  /**
   * 靜態可見單位集合（dataScope 口徑；管理員沿用舊行為回空集合，
   * 各過濾處對 admin 另有全量分支，不受影響）。
   */
  const visibleUnitCodes = useMemo(() => {
    if (scope.kind === "admin") return new Set<string>();
    if (!dataScope || dataScope.kind === "all") return new Set<string>();
    return dataScope.unitCodes;
  }, [scope.kind, dataScope]);

  /** 按年份快取的權限範圍鍵（與 scope 同義，格式見 resultsCache） */
  const cacheScope: ResultsCacheScope = useMemo(() => {
    if (scope.kind === "reviewer")
      return { kind: "reviewer", staffId: scope.staffId };
    if (scope.kind === "staff")
      return {
        kind: "staff",
        unitCode: scope.unitCode,
        unitCodes: [...visibleUnitCodes].sort(),
      };
    return { kind: "admin" };
  }, [scope, visibleUnitCodes]);

  return {
    scope,
    visibleUnitCodes,
    cacheScope,
    isNurseLeader,
    setUnitPanel,
    unitPanel,
  };
}
