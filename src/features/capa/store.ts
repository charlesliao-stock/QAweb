import { collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, where } from "../../lib/db";
import { getFirebaseDb } from "../../lib/firebase";
import { isDemoMode } from "../../lib/demoMode";
import { logAudit } from "../../lib/audit";
import type { CapaCase, CapaSettings, CapaTemplate } from "./model";
import { DEFAULT_CAPA_SETTINGS, DEMO_CAPA_CASES, DEMO_CAPA_TEMPLATES } from "./model";

const db = () => getFirebaseDb();
const CASES = "capa";
let demoInitialized = false;

async function seedDemoIfNeeded(): Promise<void> {
  if (!isDemoMode() || demoInitialized) return;
  demoInitialized = true;
  const [cases, settings] = await Promise.all([
    getDocs(collection(db(), CASES)),
    getDoc(doc(db(), "systemParams", "capaSettings")),
  ]);
  if (cases.empty) {
    await Promise.all(DEMO_CAPA_CASES.map((item) => setDoc(doc(db(), CASES, item.id), item)));
  }
  if (!settings.exists()) {
    await setDoc(doc(db(), "systemParams", "capaSettings"), { ...DEFAULT_CAPA_SETTINGS, templates: DEMO_CAPA_TEMPLATES });
  } else if (!Array.isArray((settings.data() as { templates?: unknown }).templates)) {
    await setDoc(doc(db(), "systemParams", "capaSettings"), { templates: DEMO_CAPA_TEMPLATES }, { merge: true });
  }
}

function dataRows<T extends { id: string }>(snapshot: { docs: Array<{ id: string; data: () => unknown }> }): T[] {
  return snapshot.docs.map((item) => ({ ...(item.data() as Omit<T, "id">), id: item.id }) as T);
}

export async function loadCapaCases(): Promise<CapaCase[]> {
  await seedDemoIfNeeded();
  const snapshot = await getDocs(collection(db(), CASES));
  return dataRows<CapaCase>(snapshot).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 結果分析下探清單／單位分析「C」標記專用：只讀單一指標的案件（單欄位等號，免複合索引） */
export async function loadCapaCasesByIndicator(indicatorId: string): Promise<CapaCase[]> {
  await seedDemoIfNeeded();
  const snapshot = await getDocs(query(collection(db(), CASES), where("indicatorId", "==", indicatorId)));
  return dataRows<CapaCase>(snapshot);
}

/** 單位分析「C」標記專用：只讀單一單位的案件（單欄位等號，免複合索引） */
export async function loadCapaCasesByUnit(unitCode: string): Promise<CapaCase[]> {
  await seedDemoIfNeeded();
  const snapshot = await getDocs(query(collection(db(), CASES), where("unitCode", "==", unitCode)));
  return dataRows<CapaCase>(snapshot);
}

/**
 * 儀表板「待審核」專用：只讀 stage＝督導審核／結案核准 的案件
 * （兩個單欄位等號查詢合併，免複合索引），不再整個 capa 集合全讀，
 * 降低 Spark 讀取量。
 */
export async function loadCapaPendingApprovalCases(): Promise<CapaCase[]> {
  await seedDemoIfNeeded();
  const snapshots = await Promise.all([
    getDocs(query(collection(db(), CASES), where("stage", "==", "督導審核"))),
    getDocs(query(collection(db(), CASES), where("stage", "==", "結案核准"))),
  ]);
  const seen = new Set<string>();
  return snapshots
    .flatMap((snapshot) => dataRows<CapaCase>(snapshot))
    .filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

export async function loadCapaSettings(): Promise<CapaSettings> {
  await seedDemoIfNeeded();
  const snapshot = await getDoc(doc(db(), "systemParams", "capaSettings"));
  if (!snapshot.exists()) return DEFAULT_CAPA_SETTINGS;
  const documentData = snapshot.data() as Record<string, unknown>;
  const raw = Object.fromEntries(Object.entries(documentData).filter(([key]) => key !== "templates")) as Partial<CapaSettings>;
  // 舊設定只有一層「督導」時，視為新流程前的舊值，正規化為兩層
  // （直屬督導→品管組召集人）；下次儲存設定時即寫回新值。
  const approvalRoles = raw.approvalRoles?.length
    ? raw.approvalRoles
    : DEFAULT_CAPA_SETTINGS.approvalRoles;
  return {
    ...DEFAULT_CAPA_SETTINGS,
    ...raw,
    indicatorOverrides: raw.indicatorOverrides ?? {},
    approvalRoles:
      approvalRoles.length < 2 ? DEFAULT_CAPA_SETTINGS.approvalRoles : approvalRoles,
  };
}

export async function loadCapaTemplates(): Promise<CapaTemplate[]> {
  await seedDemoIfNeeded();
  const snapshot = await getDoc(doc(db(), "systemParams", "capaSettings"));
  if (!snapshot.exists()) return [];
  const templates = (snapshot.data() as { templates?: CapaTemplate[] }).templates ?? [];
  return templates.slice().sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

export async function saveCapaCase(item: CapaCase, actor: { id: string; name: string }, action: string, detail = ""): Promise<void> {
  const { id, ...value } = item;
  await setDoc(doc(db(), CASES, id), { ...value, updatedAt: new Date().toISOString() }, { merge: true });
  logAudit(db(), { actor: actor.id, actorName: actor.name, action, targetType: "capa", targetId: id, detail: detail || `${item.caseNumber}｜${item.stage}` });
}

export async function saveCapaSettings(value: CapaSettings, actor: { id: string; name: string }): Promise<void> {
  await setDoc(doc(db(), "systemParams", "capaSettings"), {
    ...value,
    updatedAt: new Date().toISOString(),
    updatedAtServer: serverTimestamp(),
  }, { merge: true });
  logAudit(db(), { actor: actor.id, actorName: actor.name, action: "更新 CAPA 系統設定", targetType: "capaSettings", targetId: "capaSettings", detail: `預設觸發期數 ${value.defaultTriggerPeriods}；${value.multiLevelApproval ? "多層級" : "單層級"}核准` });
}

export async function saveCapaTemplate(item: CapaTemplate, actor: { id: string; name: string }): Promise<void> {
  const ref = doc(db(), "systemParams", "capaSettings");
  const current = await getDoc(ref);
  const templates = current.exists() ? ((current.data() as { templates?: CapaTemplate[] }).templates ?? []) : [];
  const next = [item, ...templates.filter((row) => row.id !== item.id)];
  await setDoc(ref, { templates: next, updatedAt: new Date().toISOString() }, { merge: true });
  logAudit(db(), { actor: actor.id, actorName: actor.name, action: "維護 CAPA 範本", targetType: "capaTemplate", targetId: item.id, detail: `${item.type}｜${item.name}｜${item.active ? "啟用" : "停用"}` });
}
