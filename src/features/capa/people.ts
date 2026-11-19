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
      memberships,
    };
  });
}

/**
 * 依單位找預設人員：負責人＝該單位內具 ownerRole（預設護理長）角色者；
 * 核准者＝督導（督導以 titleUnitCodes 管轄多單位，故以管轄單位查）。
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
  return {
    owner: inUnit ? pickByRole(toRows(inUnit), ownerRole) : undefined,
    approver: supervised
      ? pickByRole(toRows(supervised), approverRole) ?? (inUnit ? pickByRole(toRows(inUnit), approverRole) : undefined)
      : inUnit
        ? pickByRole(toRows(inUnit), approverRole)
        : undefined,
  };
}

/**
 * 全院具某角色的在職人員（新流程督導／召集人下拉用，範圍不限）。
 * 注意：users 集合的 list 規則只放行管理員／幹事／單位主管／管轄督導，
 * 加上掛「護理長」角色者可讀「督導／品管組召集人」角色者（2026-11-19
 * 定案：CAPA 由負責人護理長提交，只有在 CAPA 內護理長可選督導）。
 * 非護理長的負責人查全院清單仍會被 rules 擋下而回傳空陣列，呼叫端須
 * 以後備（目前指派人）呈現，不可視為「沒有這個人」。
 */
export async function listPeopleByRole(role: string): Promise<CapaPerson[]> {
  if (!role.trim()) return [];
  const snapshot = await getDocs(
    query(collection(getFirebaseDb(), "users"), where("roles", "array-contains", role.trim())),
  ).catch(() => null);
  if (!snapshot) return [];
  return toRows(snapshot)
    .filter((row) => row.status !== "停用" && row.status !== "離職")
    .map((row) => ({ id: row.id, name: row.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
}

/** 指標所屬品管組的品管組召集人（memberships 的 groupId 配對；無配對時退回全院第一位召集人） */
export async function findConvener(groupId: string): Promise<CapaPerson | undefined> {
  const snapshot = await getDocs(
    query(collection(getFirebaseDb(), "users"), where("roles", "array-contains", "品管組召集人")),
  ).catch(() => null);
  if (!snapshot) return undefined;
  const rows = toRows(snapshot).filter((row) => row.status !== "停用" && row.status !== "離職");
  if (!groupId) return rows[0] ? { id: rows[0].id, name: rows[0].name } : undefined;
  const hit =
    rows.find((row) => row.memberships.some((m) => m.groupId === groupId && m.roles.includes("品管組召集人"))) ??
    rows.find((row) => row.memberships.some((m) => m.groupId === groupId));
  const person = hit ?? rows[0];
  return person ? { id: person.id, name: person.name } : undefined;
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
