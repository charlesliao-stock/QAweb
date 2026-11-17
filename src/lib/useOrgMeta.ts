/**
 * 組織詮釋資料 Hook（v1.40.5）：載入 roles／titles 集合，建立名稱→詮釋資料
 * 對照表；同時保留主檔 ID，供儀表板管理設定以穩定 ID 儲存覆寫。
 * 走參考資料共用快取（getCachedRefCollection），同頁重複掛載只讀一次。
 */
import { loadRefCollection } from "./refLoad";
import { collection } from "./db";
import { getFirebaseDb } from "./firebase";
import { getCachedRef } from "./refCache";
import { getDocsCacheFirst } from "./cacheFirst";
import {
  DEFAULT_ROLE_LEVELS,
  DEFAULT_TITLE_LEVELS,
  type OrgLevel,
} from "./orgLevels";
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
  /** 所屬層級 id（空＝未分層級），供預覽下拉依層級排序 */
  levelId: string;
}

export interface OrgTitleTarget {
  id: string;
  name: string;
  flags: TitleFlags;
  levelId: string;
}

export interface OrgMeta {
  roleMeta: RoleMetaMap;
  titleMeta: TitleMetaMap;
  titleMetaById: Map<string, TitleFlags>;
  roleTargets: OrgRoleTarget[];
  titleTargets: OrgTitleTarget[];
  /** 職稱／角色層級（已依 order 排序；讀不到時退回預設層級） */
  titleLevels: OrgLevel[];
  roleLevels: OrgLevel[];
  loading: boolean;
}

const EMPTY: OrgMeta = {
  roleMeta: new Map(),
  titleMeta: new Map(),
  titleMetaById: new Map(),
  roleTargets: [],
  titleTargets: [],
  titleLevels: DEFAULT_TITLE_LEVELS,
  roleLevels: DEFAULT_ROLE_LEVELS,
  loading: true,
};

async function loadLevels(name: "titleLevels" | "roleLevels", fallback: OrgLevel[]): Promise<OrgLevel[]> {
  try {
    const snap = await getCachedRef(name, () =>
      getDocsCacheFirst(collection(getFirebaseDb(), name)),
    );
    const levels = snap.docs.map((d) => {
      const v = d.data() as Record<string, unknown>;
      return {
        id: d.id,
        name: typeof v.name === "string" ? v.name : "",
        order: typeof v.order === "number" ? v.order : 0,
      };
    });
    return levels.length > 0 ? levels : fallback;
  } catch {
    return fallback;
  }
}

export function useOrgMeta(): OrgMeta {
  const [meta, setMeta] = useState<OrgMeta>(EMPTY);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [rSnap, tSnap, titleLevels, roleLevels] = await Promise.all([
          loadRefCollection("roles"),
          loadRefCollection("titles"),
          loadLevels("titleLevels", DEFAULT_TITLE_LEVELS),
          loadLevels("roleLevels", DEFAULT_ROLE_LEVELS),
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
            levelId: typeof v.levelId === "string" ? v.levelId : "",
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
            levelId: typeof input.levelId === "string" ? input.levelId : "",
            ...resolveRoleMeta(input),
          })),
          titleTargets: titleInputs
            .filter((input) => input.name.trim())
            .map((input) => ({
              id: input.id,
              name: input.name,
              flags: resolveTitleFlags(input),
              levelId: typeof input.levelId === "string" ? input.levelId : "",
            })),
          titleLevels,
          roleLevels,
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
