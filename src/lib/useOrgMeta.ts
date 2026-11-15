/**
 * 組織詮釋資料 Hook（v1.40.5）：載入 roles／titles 集合，建立名稱→詮釋資料
 * 對照表；同時保留主檔 ID，供儀表板管理設定以穩定 ID 儲存覆寫。
 * 走參考資料共用快取（getCachedRefCollection），同頁重複掛載只讀一次。
 */
import { loadRefCollection } from "./refLoad";
import { useEffect, useState } from "react";
import {
  buildRoleMetaMap,
  buildTitleMetaById,
  buildTitleMetaMap,
  resolveRoleMeta,
  resolveTitleFlags,
  type RoleMeta,
  type RoleMetaInput,
  type RoleMetaMap,
  type TitleFlags,
  type TitleMetaInput,
  type TitleMetaMap,
} from "./orgMeta";

export interface OrgRoleTarget extends RoleMeta {
  id: string;
}

export interface OrgTitleTarget {
  id: string;
  name: string;
  flags: TitleFlags;
}

export interface OrgMeta {
  roleMeta: RoleMetaMap;
  titleMeta: TitleMetaMap;
  titleMetaById: Map<string, TitleFlags>;
  roleTargets: OrgRoleTarget[];
  titleTargets: OrgTitleTarget[];
  loading: boolean;
}

const EMPTY: OrgMeta = {
  roleMeta: new Map(),
  titleMeta: new Map(),
  titleMetaById: new Map(),
  roleTargets: [],
  titleTargets: [],
  loading: true,
};

export function useOrgMeta(): OrgMeta {
  const [meta, setMeta] = useState<OrgMeta>(EMPTY);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [rSnap, tSnap] = await Promise.all([
          loadRefCollection("roles"),
          loadRefCollection("titles"),
        ]);
        if (cancelled) return;
        const roleInputs: Array<RoleMetaInput & { id: string }> = rSnap.docs.map((d) => {
          const v = d.data() as Record<string, unknown>;
          return {
            id: d.id,
            name: typeof v.name === "string" && v.name.trim() ? v.name : d.id,
            levelId: v.levelId,
            levelName: v.levelName,
          };
        });
        const titleInputs: Array<TitleMetaInput & { id: string }> = tSnap.docs.map((d) => {
          const v = d.data() as Record<string, unknown>;
          return {
            id: d.id,
            name: typeof v.name === "string" ? v.name : "",
            isUnitHead: v.isUnitHead,
            isDistrictHead: v.isDistrictHead,
            isHospitalHead: v.isHospitalHead,
            isOfficer: v.isOfficer,
            isConvener: v.isConvener,
          };
        });
        const roles = roleInputs.map(({ id: _id, ...input }) => input);
        const titles = titleInputs;
        setMeta({
          roleMeta: buildRoleMetaMap(roles),
          titleMeta: buildTitleMetaMap(titles),
          titleMetaById: buildTitleMetaById(titles),
          roleTargets: roleInputs.map(({ id, ...input }) => ({
            id,
            ...resolveRoleMeta(input),
          })),
          titleTargets: titleInputs
            .filter((input) => input.name.trim())
            .map((input) => ({
              id: input.id,
              name: input.name,
              flags: resolveTitleFlags(input),
            })),
          loading: false,
        });
      } catch {
        if (!cancelled) {
          setMeta({ ...EMPTY, loading: false });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return meta;
}
