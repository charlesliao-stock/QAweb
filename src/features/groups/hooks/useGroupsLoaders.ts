import { useRef, useCallback, useMemo, useEffect } from "react";
import { loadRefCollection } from "../../../lib/refLoad";
import { buildRoleMetaMap, type RoleMetaMap, legacyTitleFlags } from "../../../lib/orgMeta";
import { seedOrderForRole, sortedLevels, seedOrderForTitle } from "../../../lib/orgLevels";
import { toErrorMessage } from "../../../lib/errors";
import type { UnitRow, UserRow } from "../model/types";
import { getFirebaseDb } from "../../../lib/firebase";
import { getDocsFromServer, collection } from "../../../lib/db";
import { parseMemberships } from "../../../lib/roleIdentity";
import { migrateOrgLevels, migrateTitleLevelsV187, migrateTitleLevelsV188, migrateTitleRoleOrderV188 } from "../../../lib/levelMigration";
import type { GroupsPageProps } from "../model/pageProps";
import type { useGroupsState } from "./useGroupsState";
import type { useGroupsDerived } from "./useGroupsDerived";

export function useGroupsLoaders(props: GroupsPageProps, prev: ReturnType<typeof useGroupsState> & ReturnType<typeof useGroupsDerived>) {
  const { onAction, onTabChange } = props;
  const { setRolesLoading, setRolesLoadError, setRoleOptions, roleOptions, setMasterLoading, setMasterLoadError, setGroups, setUnits, setLevelsLoading, setLevelsLoadError, setTitleLevels, setRoleLevels, setTitlesLoading, setTitlesLoadError, setTitles, setUsersLoading, setUsersLoadError, setUsers, isAdmin, user, migrationRanRef, tab, users } = prev;

  const usersLoadedRef = useRef(false);

  const loadRoles = useCallback(async () => {
    setRolesLoading(true);
    setRolesLoadError("");
    try {
      const snap = await loadRefCollection("roles");
      const meta = buildRoleMetaMap(
        snap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>;
          return {
            name: typeof data.name === "string" ? data.name : d.id,
            levelId: data.levelId,
          };
        }),
      );
      setRoleOptions(
        snap.docs
          .map((d) => {
            const data = d.data();
            const name = typeof data.name === "string" ? data.name : d.id;
            const m = meta.get(name);
            return {
              id: d.id,
              name,
              scope: m?.scope,
              levelId:
                typeof data.levelId === "string" ? data.levelId : "",
              // v1.88.8 補項：層級內順序（無欄位時以種子順序退回，再無則排最後）
              order:
                typeof data.order === "number"
                  ? data.order
                  : (seedOrderForRole(name) ?? Number.MAX_SAFE_INTEGER),
            };
          })
          .sort(
            (a, b) =>
              a.order - b.order || a.name.localeCompare(b.name, "zh-Hant"),
          ),
      );
    } catch (error) {
      setRoleOptions([]);
      setRolesLoadError(toErrorMessage(error));
    } finally {
      setRolesLoading(false);
    }
  }, []);

  /** 角色詮釋資料對照（名稱→類別／範圍），身分判斷不再比對名稱。 */
  const roleMeta: RoleMetaMap = useMemo(
    () => buildRoleMetaMap(roleOptions),
    [roleOptions],
  );

  /** 群組＋單位一起載入（單位需對應品管組名稱、人數） */
  const loadMaster = useCallback(async () => {
    setMasterLoading(true);
    setMasterLoadError("");
    try {
      const [gsnap, usnap] = await Promise.all([
        loadRefCollection("groups"),
        loadRefCollection("units"),
      ]);
      const groupList = gsnap.docs
        .map((d) => ({
          id: d.id,
          name: typeof d.data().name === "string" ? d.data().name : "",
        }))
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
      const groupIdToName = new Map(groupList.map((g) => [g.id, g.name]));

      // 各單位人數（非管理員無 users 查詢權限，顯示「—」）
      const counts = new Map<string, number>();
      try {
        const usersSnap = await loadRefCollection("users");
        usersSnap.docs.forEach((d) => {
          const uc = d.data().unitCode;
          if (typeof uc === "string" && uc) {
            counts.set(uc, (counts.get(uc) ?? 0) + 1);
          }
        });
      } catch {
        // 維持空 map
      }

      const unitList: UnitRow[] = usnap.docs
        .map((d) => {
          const data = d.data();
          const groupId =
            typeof data.groupId === "string" ? data.groupId : "";
          return {
            code: d.id,
            name: typeof data.name === "string" ? data.name : "",
            groupId,
            mergedFromUnitCodes: Array.isArray(data.mergedFromUnitCodes)
              ? data.mergedFromUnitCodes.map(String).filter(Boolean)
              : [],
            groupName: groupIdToName.get(groupId) ?? "未分類",
            memberCount: counts.has(d.id) ? (counts.get(d.id) ?? 0) : null,
          };
        })
        .sort((a, b) => a.code.localeCompare(b.code, "zh-Hant"));

      const unitCountByGroup = new Map<string, number>();
      unitList.forEach((u) => {
        if (u.groupId) {
          unitCountByGroup.set(u.groupId, (unitCountByGroup.get(u.groupId) ?? 0) + 1);
        }
      });

      setGroups(
        groupList.map((g) => ({
          ...g,
          unitCount: unitCountByGroup.get(g.id) ?? 0,
        })),
      );
      setUnits(unitList);
    } catch (error) {
      const message = toErrorMessage(error);
      setMasterLoadError(message);
      onAction(`讀取品管組／單位清單失敗：${message}`);
    } finally {
      setMasterLoading(false);
    }
  }, [onAction]);

  /** 層級清單（v1.55.0）：titleLevels／roleLevels 各讀一次 */
  const loadLevels = useCallback(async () => {
    setLevelsLoading(true);
    setLevelsLoadError("");
    try {
      const db = getFirebaseDb();
      const [tSnap, rSnap] = await Promise.all([
        getDocsFromServer(collection(db, "titleLevels")),
        getDocsFromServer(collection(db, "roleLevels")),
      ]);
      const read = (snap: { docs: Array<{ id: string; data: () => Record<string, unknown> }> }) =>
        snap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            name: typeof data.name === "string" ? data.name : "",
            order: typeof data.order === "number" ? data.order : 0,
          };
        });
      setTitleLevels(sortedLevels(read(tSnap)));
      setRoleLevels(sortedLevels(read(rSnap)));
    } catch (error) {
      const message = toErrorMessage(error);
      setLevelsLoadError(message);
      onAction(`讀取層級清單失敗：${message}`);
    } finally {
      setLevelsLoading(false);
    }
  }, [onAction]);

  const loadTitles = useCallback(async () => {
    setTitlesLoading(true);
    setTitlesLoadError("");
    try {
      const snap = await loadRefCollection("titles");
      const list = snap.docs
        .map((d) => {
          const data = d.data();
          return {
            id: d.id,
            name: typeof data.name === "string" ? data.name : "",
            levelId:
              typeof data.levelId === "string" ? data.levelId : "",
            // v1.88.8 補項：層級內順序（無欄位時以種子順序退回，再無則排最後）
            order:
              typeof data.order === "number"
                ? data.order
                : (seedOrderForTitle(
                    typeof data.name === "string" ? data.name : "",
                  ) ?? Number.MAX_SAFE_INTEGER),
            ...legacyTitleFlags(
              typeof data.name === "string" ? data.name : "",
            ),
            ...(typeof data.isUnitHead === "boolean"
              ? { isUnitHead: data.isUnitHead }
              : {}),
            ...(typeof data.isDistrictHead === "boolean"
              ? { isDistrictHead: data.isDistrictHead }
              : {}),
            ...(typeof data.isHospitalHead === "boolean"
              ? { isHospitalHead: data.isHospitalHead }
              : {}),
            ...(typeof data.isOfficer === "boolean"
              ? { isOfficer: data.isOfficer }
              : {}),
            ...(typeof data.isConvener === "boolean"
              ? { isConvener: data.isConvener }
              : {}),
          };
        })
        // v1.88.8 補項：層級內按 order 排（小在上），同 order 再按名稱
        .sort(
          (a, b) =>
            a.order - b.order || a.name.localeCompare(b.name, "zh-Hant"),
        );
      // 各職稱使用人數（僅管理員可查 users；舊人員無 titleId 者以職稱名稱比對）
      const titleCounts = new Map<string, number>();
      const legacyTitleCounts = new Map<string, number>();
      let usersReadable = false;
      try {
        const usnap = await loadRefCollection("users");
        usersReadable = true;
        usnap.docs.forEach((d) => {
          const data = d.data();
          const titleId = typeof data.titleId === "string" ? data.titleId : "";
          const titleName = typeof data.title === "string" ? data.title : "";
          if (titleId) {
            titleCounts.set(titleId, (titleCounts.get(titleId) ?? 0) + 1);
          } else if (titleName) {
            legacyTitleCounts.set(titleName, (legacyTitleCounts.get(titleName) ?? 0) + 1);
          }
        });
      } catch {
        titleCounts.clear();
        legacyTitleCounts.clear();
      }
      setTitles(
        list.map((t) => ({
          ...t,
          userCount: usersReadable
            ? (titleCounts.get(t.id) ?? 0) + (legacyTitleCounts.get(t.name) ?? 0)
            : null,
        })),
      );
    } catch (error) {
      const message = toErrorMessage(error);
      setTitlesLoadError(message);
      onAction(`讀取職稱清單失敗：${message}`);
    } finally {
      setTitlesLoading(false);
    }
  }, [onAction]);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    setUsersLoadError("");
    try {
      const snap = await loadRefCollection("users");
      usersLoadedRef.current = true;
      const list: UserRow[] = snap.docs
        .map((d) => {
          const data = d.data();
          const roles = Array.isArray(data.roles)
            ? data.roles.map(String)
            : [];
          return {
            staffId: d.id,
            name: typeof data.name === "string" ? data.name : "",
            unitCode: typeof data.unitCode === "string" ? data.unitCode : "",
            title: typeof data.title === "string" ? data.title : "",
            titleId: typeof data.titleId === "string" ? data.titleId : "",
            roles,
            // v1.21：讀取以 memberships 為主，無則 fallback 舊 groupIds＋roles
            memberships: parseMemberships(data.memberships, {
              roles,
              groupIds: Array.isArray(data.groupIds)
                ? data.groupIds.map(String)
                : [],
            }),
            status: typeof data.status === "string" ? data.status : "在職",
            reviewerAccessExpiresAt: typeof data.reviewerAccessExpiresAt === "string"
              ? data.reviewerAccessExpiresAt
              : "",
            // v1.87.0：督導負責單位（職稱成員管理頁的督導頁讀取用）
            titleUnitCodes: Array.isArray(data.titleUnitCodes)
              ? data.titleUnitCodes.map(String)
              : [],
          };
        })
        .sort((a, b) => a.staffId.localeCompare(b.staffId, "zh-Hant"));
      setUsers(list);
    } catch (error) {
      const message = toErrorMessage(error);
      setUsersLoadError(message);
      onAction(`讀取人員清單失敗：${message}`);
    } finally {
      setUsersLoading(false);
    }
  }, [onAction]);

  // v1.40.5：開頁不再自動補種固定名稱群組。群組／單位／角色／職稱
  // 皆由系統管理員在本頁自行建立；各醫院名稱不同，不得寫死。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      loadMaster();
      loadRoles();
      loadTitles();
      loadLevels();
      // v1.55.0：一次性層級遷移（管理員開頁執行；旗標防重跑）
      if (isAdmin && user?.staffId && !migrationRanRef.current) {
        migrationRanRef.current = true;
        (async () => {
          try {
            const res = await migrateOrgLevels(
              getFirebaseDb(),
              user.staffId,
              user.name,
            );
            const parts: string[] = [];
            if (res.levelsCreated.length > 0)
              parts.push(`建立層級 ${res.levelsCreated.length} 個`);
            if (res.titlesBackfilled > 0)
              parts.push(`職稱回填 ${res.titlesBackfilled} 筆`);
            if (res.rolesBackfilled > 0)
              parts.push(`角色回填 ${res.rolesBackfilled} 筆`);
            if (res.rolesCreated.length > 0)
              parts.push(`新增角色 ${res.rolesCreated.length} 個`);
            if (res.oldRole === "migrated")
              parts.push(
                `舊角色「品管執行幹事」已遷移 ${res.oldRoleHolders} 人後刪除`,
              );
            else if (res.oldRole === "deleted-empty")
              parts.push("舊角色「品管執行幹事」已刪除");
            if (parts.length > 0)
              onAction(`層級遷移完成：${parts.join("、")}`);
            // v1.87.0：職稱層級拆分（部級→主任／副主任／督導／單位；旗標防重跑）
            try {
              const res187 = await migrateTitleLevelsV187(
                getFirebaseDb(),
                user.staffId,
              );
              const parts187: string[] = [];
              if (res187.levelsCreated.length > 0)
                parts187.push(
                  `建立職稱層級 ${res187.levelsCreated.join("、")}`,
                );
              if (res187.titlesRemapped > 0)
                parts187.push(`職稱層級重對照 ${res187.titlesRemapped} 筆`);
              if (res187.deptLevelRemoved)
                parts187.push("舊部級層級已刪除");
              if (parts187.length > 0)
                onAction(`職稱層級拆分完成：${parts187.join("、")}`);
            } catch (error) {
              onAction(`職稱層級拆分失敗：${toErrorMessage(error)}`);
            }
            // v1.88.8：職稱層級併回（主任／副主任／督導／單位→部級／單位；旗標防重跑）
            try {
              const res188 = await migrateTitleLevelsV188(
                getFirebaseDb(),
                user.staffId,
              );
              const parts188: string[] = [];
              if (res188.levelsCreated.length > 0)
                parts188.push(
                  `建立職稱層級 ${res188.levelsCreated.join("、")}`,
                );
              if (res188.titlesRemapped > 0)
                parts188.push(`職稱層級重對照 ${res188.titlesRemapped} 筆`);
              if (res188.headNurseMerged)
                parts188.push(
                  `護理長／副護理長已合併，轉任 ${res188.headNurseUsersRetargeted} 人`,
                );
              if (res188.nurseTitleCreated)
                parts188.push("已新增「護士」職稱");
              if (res188.legacyLevelsRemoved.length > 0)
                parts188.push(
                  `舊層級已刪除 ${res188.legacyLevelsRemoved.join("、")}`,
                );
              if (parts188.length > 0)
                onAction(`職稱層級併回完成：${parts188.join("、")}`);
            } catch (error) {
              onAction(`職稱層級併回失敗：${toErrorMessage(error)}`);
            }
            // v1.88.8 補項：職稱／角色順序回填（order 欄位初值；旗標防重跑）
            try {
              const resOrder = await migrateTitleRoleOrderV188(
                getFirebaseDb(),
                user.staffId,
              );
              const partsOrder: string[] = [];
              if (resOrder.titlesBackfilled > 0)
                partsOrder.push(`職稱順序回填 ${resOrder.titlesBackfilled} 筆`);
              if (resOrder.rolesBackfilled > 0)
                partsOrder.push(`角色順序回填 ${resOrder.rolesBackfilled} 筆`);
              if (partsOrder.length > 0)
                onAction(`職稱／角色順序回填完成：${partsOrder.join("、")}`);
            } catch (error) {
              onAction(`職稱／角色順序回填失敗：${toErrorMessage(error)}`);
            }
            await loadLevels();
            await loadTitles();
            await loadRoles();
          } catch (error) {
            onAction(`層級遷移失敗：${toErrorMessage(error)}`);
          }
        })();
      }
      // v1.12.0：掛載時即預載人員（修頁籤 badge 初始顯示 0 的問題）
      if (isAdmin) loadUsers();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadMaster, loadRoles, loadTitles, loadLevels, isAdmin, user]);

  useEffect(() => {
    // v1.27.2：掛載時已預載人員，切回頁籤不重拉（存檔後各 handler 會自行 loadUsers）
    if (tab === "users" && isAdmin && !usersLoadedRef.current) {
      loadUsers();
    }
  }, [tab, isAdmin, loadUsers]);

  useEffect(() => {
    if (tab === "roles" && isAdmin && users.length === 0) {
      loadUsers();
    }
  }, [tab, isAdmin, users.length, loadUsers]);

  // v1.86.0：頁籤切換時回報 App，獨立頁返回時回到原本頁籤（掛載時亦回報 initialTab）
  useEffect(() => {
    onTabChange?.(tab);
  }, [tab, onTabChange]);

  return {
    loadMaster,
    loadUsers,
    loadTitles,
    loadLevels,
    loadRoles,
    roleMeta,
  };
}
