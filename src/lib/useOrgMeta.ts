/**
 * 組織詮釋資料 Hook（v1.40.5）：載入 roles／titles 集合，建立名稱→詮釋資料
 * 對照表，供各頁的身分辨識使用（角色身分由層級＋名稱關鍵字推導，v1.57.0 A3）。
 * 走參考資料共用快取（getCachedRefCollection），同頁重複掛載只讀一次。
 */
import { useEffect, useState } from "react";
import { collection } from "./db";
import { getFirebaseDb } from "./firebase";
import {
  buildRoleMetaMap,
  buildTitleMetaById,
  buildTitleMetaMap,
  type RoleMetaInput,
  type RoleMetaMap,
  type TitleFlags,
  type TitleMetaInput,
  type TitleMetaMap,
} from "./orgMeta";
import { getCachedRefCollection } from "./refCache";
import { getDocsCacheFirst } from "./cacheFirst";

export interface OrgMeta {
  roleMeta: RoleMetaMap;
  titleMeta: TitleMetaMap;
  titleMetaById: Map<string, TitleFlags>;
  loading: boolean;
}

const EMPTY: OrgMeta = {
  roleMeta: new Map(),
  titleMeta: new Map(),
  titleMetaById: new Map(),
  loading: true,
};

export function useOrgMeta(): OrgMeta {
  const [meta, setMeta] = useState<OrgMeta>(EMPTY);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = getFirebaseDb();
        const [rSnap, tSnap] = await Promise.all([
          getCachedRefCollection("roles", () =>
            getDocsCacheFirst(collection(db, "roles")),
          ),
          getCachedRefCollection("titles", () =>
            getDocsCacheFirst(collection(db, "titles")),
          ),
        ]);
        if (cancelled) return;
        const roles: RoleMetaInput[] = rSnap.docs.map((d) => {
          const v = d.data() as Record<string, unknown>;
          return {
            name: typeof v.name === "string" ? v.name : d.id,
            levelId: v.levelId,
          };
        });
        const titles: TitleMetaInput[] = tSnap.docs.map((d) => {
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
        setMeta({
          roleMeta: buildRoleMetaMap(roles),
          titleMeta: buildTitleMetaMap(titles),
          titleMetaById: buildTitleMetaById(titles),
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
