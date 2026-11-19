import { collection, getDocs, query, where } from "../../lib/db";
import { getFirebaseDb } from "../../lib/firebase";

export interface CapaPerson {
  id: string;
  name: string;
}

interface UserRow {
  id: string;
  name: string;
  roles: string[];
  status: string;
  unitCode: string;
  /** 職稱名（督導身分判斷用；users.roles 只由 memberships 衍生，純職稱督導未必含「督導」角色） */
  title: string;
  /** 督導設定的管理單位（僅督導職稱時設定，見 useGroupsUserActions／職稱成員管理） */
  titleUnitCodes: string[];
  memberships: Array<{ groupId: string; roles: string[] }>;
}

/** 角色名稱比對：完全相同優先；其次包含（排除「副」開頭，避免副護理長被當成護理長） */
function pickByRole(rows: UserRow[], role: string): CapaPerson | undefined {
  const wanted = role.trim();
  if (!wanted) return undefined;
  const active = rows.filter((row) => row.status !== "停用" && row.status !== "離職");
  const exact = active.find((row) => row.roles.includes(wanted));
  const hit =
    exact ??
    active.find((row) => row.roles.some((r) => r.includes(wanted) && !r.startsWith("副")));
  return hit ? { id: hit.id, name: hit.name } : undefined;
}

function toRows(snapshot: { docs: Array<{ id: string; data: () => unknown }> }): UserRow[] {
  return snapshot.docs.map((d) => {
    const v = d.data() as Record<string, unknown>;
    const memberships = Array.isArray(v.memberships)
      ? (v.memberships as Array<Record<string, unknown>>)
          .map((m) => ({ groupId: typeof m.groupId === "string" ? m.groupId : "", roles: Array.isArray(m.roles) ? m.roles.map(String) : [] }))
          .filter((m) => m.groupId)
      : [];
    return {
      id: d.id,
      name: typeof v.name === "string" ? v.name : d.id,
      roles: Array.isArray(v.roles) ? v.roles.map(String) : [],
      status: typeof v.status === "string" ? v.status : "",
      unitCode: typeof v.unitCode === "string" ? v.unitCode : "",
      title: typeof v.title === "string" ? v.title : "",
      titleUnitCodes: Array.isArray(v.titleUnitCodes) ? v.titleUnitCodes.map(String) : [],
      memberships,
    };
  });
}

/**
 * 身分比對（督導用）：職稱或角色任一為該角色即認。全站督導身分走職稱
 * （isDistrictHead，職稱含「督導」）；但 users.roles 只由 memberships 衍生
 * （deriveStoredRoles，v1.58.0），純職稱督導的 roles 未必含「督導」，故
 * 不能只比 roles——否則有設管理單位的督導會被漏掉。
 */
function isRolePerson(row: UserRow, role: string): boolean {
  const wanted = role.trim();
  if (!wanted) return false;
  if (row.title.includes(wanted)) return true;
  if (row.roles.includes(wanted)) return true;
  return row.roles.some((r) => r.includes(wanted) && !r.startsWith("副"));
}

/** 確定性排序：多位符合時不依 Firestore 回傳順序，依姓名、職編排序取第一位。 */
function sortRows(rows: UserRow[]): UserRow[] {
  return [...rows].sort(
    (a, b) => a.name.localeCompare(b.name, "zh-Hant") || a.id.localeCompare(b.id),
  );
}

function isActive(row: UserRow): boolean {
  return row.status !== "停用" && row.status !== "離職";
}

/**
 * 依單位找預設人員：負責人＝該單位內具 ownerRole（預設護理長）角色者；
 * 直屬督導＝「督導設定的管理單位（titleUnitCodes）含案件單位」者：
 * 查詢本身已以 titleUnitCodes array-contains 限定，再以職稱或角色確認
 * 督導身分。找不到時留空（由負責人下拉自選），不再退回單位內其他督導
 * （其 titleUnitCodes 未必含該單位），查詢失敗時亦留空、不猜人。
 * 使用者清單僅管理員／幹事可讀；讀取失敗時回傳空物件，由呼叫端退回預設。
 */
export async function findUnitPeople(
  unitCode: string,
  ownerRole: string,
  approverRole: string,
): Promise<{ owner?: CapaPerson; approver?: CapaPerson }> {
  if (!unitCode) return {};
  const db = getFirebaseDb();
  const [inUnit, supervised] = await Promise.all([
    getDocs(query(collection(db, "users"), where("unitCode", "==", unitCode))).catch(() => null),
    getDocs(query(collection(db, "users"), where("titleUnitCodes", "array-contains", unitCode))).catch(() => null),
  ]);
  const approver = supervised
    ? sortRows(toRows(supervised).filter((row) => isActive(row) && isRolePerson(row, approverRole)))[0]
    : undefined;
  return {
    owner: inUnit ? pickByRole(toRows(inUnit), ownerRole) : undefined,
    approver: approver ? { id: approver.id, name: approver.name } : undefined,
  };
}

/**
 * 全院具某角色的在職人員（新流程督導／召集人下拉用，範圍不限）。
 * 注意：users 集合的 list 規則只放行管理員／幹事／單位主管／管轄督導，
 * 加上掛「護理長」角色者可讀「督導／品管組召集人」角色者，或
 * titleUnitCodes 非空者（有設管理單位的督導，2026-11-19 補充定案）。
 * 非護理長的負責人查全院清單仍會被 rules 擋下而回傳空陣列，呼叫端須
 * 以後備（目前指派人）呈現，不可視為「沒有這個人」。
 */
export async function listPeopleByRole(role: string): Promise<CapaPerson[]> {
  if (!role.trim()) return [];
  const db = getFirebaseDb();
  const wanted = role.trim();
  const queries = [
    query(collection(db, "users"), where("roles", "array-contains", wanted)),
  ];
  // 「督導」是職稱：純職稱督導的 roles 未必含「督導」，另以職稱補查標準職稱名，
  // 否則有設管理單位的督導不會出現在下拉。殘留缺口：自訂職稱變體（不在下列
  // 兩名內、且 roles 亦無「督導」者）仍查不到；預設指派（findUnitPeople）不受此限。
  if (wanted === "督導") {
    queries.push(
      query(collection(db, "users"), where("title", "in", ["督導", "護理部督導"])),
    );
  }
  const snapshots = await Promise.all(queries.map((q) => getDocs(q).catch(() => null)));
  const seen = new Map<string, CapaPerson>();
  for (const snapshot of snapshots) {
    if (!snapshot) continue;
    for (const row of toRows(snapshot)) {
      if (!isActive(row) || seen.has(row.id)) continue;
      seen.set(row.id, { id: row.id, name: row.name });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
}

/**
 * 指標所屬品管組的品管組召集人：以 memberships 的 groupId＋「品管組召集人」
 * 角色嚴格配對；無配對時留空（由負責人下拉自選），不再退回全院第一位召集人
 * （該召集人屬於別的品管組）。多位符合時依姓名、職編排序取第一位。
 */
export async function findConvener(groupId: string): Promise<CapaPerson | undefined> {
  const snapshot = await getDocs(
    query(collection(getFirebaseDb(), "users"), where("roles", "array-contains", "品管組召集人")),
  ).catch(() => null);
  if (!snapshot || !groupId) return undefined;
  const rows = sortRows(toRows(snapshot).filter((row) => isActive(row)));
  const hit = rows.find((row) =>
    row.memberships.some((m) => m.groupId === groupId && m.roles.includes("品管組召集人")),
  );
  return hit ? { id: hit.id, name: hit.name } : undefined;
}

/** 單位內可被指定為撰寫人的在職人員（負責人／管理員用；規則允許護理長讀本單位人員） */
export async function listUnitPeople(unitCode: string): Promise<CapaPerson[]> {
  if (!unitCode) return [];
  const snapshot = await getDocs(query(collection(getFirebaseDb(), "users"), where("unitCode", "==", unitCode)));
  return toRows(snapshot)
    .filter((row) => row.status !== "停用" && row.status !== "離職")
    .map((row) => ({ id: row.id, name: row.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
}
