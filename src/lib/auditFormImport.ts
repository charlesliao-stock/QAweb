import {
  newQid,
  type AuditQuestion,
  type QuestionGroup,
} from "./indicators";

export interface AuditImportGroup {
  id: string;
  name: string;
}

export interface ImportedAuditForm {
  questions: AuditQuestion[];
  questionGroups: QuestionGroup[];
  useQuestionGroups: boolean;
}

export type AuditGroupResolution =
  | { ok: true; groupId: string; groupName: string }
  | { ok: false; reason: "missing" | "unknown" | "ambiguous" };

/** 組別欄接受既有組別 ID 或唯一組別名稱；重名時要求以 ID 消歧。 */
export function resolveAuditImportGroup(
  input: string,
  groups: AuditImportGroup[],
): AuditGroupResolution {
  const value = input.trim();
  if (!value) return { ok: false, reason: "missing" };

  const byId = groups.filter((group) => group.id.trim() === value);
  if (byId.length === 1)
    return {
      ok: true,
      groupId: byId[0].id,
      groupName: byId[0].name.trim(),
    };
  if (byId.length > 1) return { ok: false, reason: "ambiguous" };

  const byName = groups.filter((group) => group.name.trim() === value);
  if (byName.length === 1)
    return {
      ok: true,
      groupId: byName[0].id,
      groupName: byName[0].name.trim(),
    };
  if (byName.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: false, reason: "unknown" };
}

function groupNameKey(name: string): string {
  return name.trim().toLocaleLowerCase("zh-Hant");
}

/**
 * 將匯入題目取代或追加至既有審核表。
 * 追加時同名題目分組沿用原 ID；新分組和題目 ID 重新產生，避免碰撞。
 */
export function mergeImportedAuditForm(
  existing: ImportedAuditForm,
  imported: ImportedAuditForm,
  mode: "replace" | "append",
): ImportedAuditForm {
  const importedGroups = [...imported.questionGroups]
    .sort((a, b) => a.order - b.order)
    .map((group, order) => ({ ...group, order }));
  const importedQuestions = [...imported.questions]
    .sort((a, b) => a.order - b.order)
    .map((question, order) => ({ ...question, order }));

  if (mode === "replace") {
    return {
      questions: importedQuestions,
      questionGroups: importedGroups,
      useQuestionGroups: imported.useQuestionGroups || importedGroups.length > 0,
    };
  }

  const groups = [...existing.questionGroups]
    .sort((a, b) => a.order - b.order)
    .map((group, order) => ({ ...group, order }));
  const groupIdByName = new Map<string, string>();
  const usedGroupIds = new Set<string>();
  for (const group of groups) {
    usedGroupIds.add(group.id);
    const key = groupNameKey(group.name);
    if (key && !groupIdByName.has(key)) groupIdByName.set(key, group.id);
  }

  const importedGroupIdMap = new Map<string, string>();
  for (const group of importedGroups) {
    const key = groupNameKey(group.name);
    const sameNameId = key ? groupIdByName.get(key) : undefined;
    if (sameNameId) {
      importedGroupIdMap.set(group.id, sameNameId);
      continue;
    }

    let id = newQid();
    while (usedGroupIds.has(id)) id = newQid();
    usedGroupIds.add(id);
    const next = { ...group, id, order: groups.length };
    groups.push(next);
    importedGroupIdMap.set(group.id, id);
    if (key) groupIdByName.set(key, id);
  }

  const questions = [...existing.questions]
    .sort((a, b) => a.order - b.order)
    .map((question, order) => ({ ...question, order }));
  const usedQuestionIds = new Set(questions.map((question) => question.id));
  for (const question of importedQuestions) {
    let id = question.id || newQid();
    while (usedQuestionIds.has(id)) id = newQid();
    usedQuestionIds.add(id);

    const mappedGroupId = question.groupId
      ? importedGroupIdMap.get(question.groupId)
      : undefined;
    const byName = question.groupName
      ? groupIdByName.get(groupNameKey(question.groupName))
      : undefined;
    const groupId = mappedGroupId ?? byName ?? null;
    const targetGroup = groupId
      ? groups.find((group) => group.id === groupId)
      : undefined;
    questions.push({
      ...question,
      id,
      groupId,
      groupName: targetGroup?.name ?? "",
      order: questions.length,
    });
  }

  return {
    questions,
    questionGroups: groups,
    useQuestionGroups:
      existing.useQuestionGroups ||
      imported.useQuestionGroups ||
      groups.length > 0,
  };
}
