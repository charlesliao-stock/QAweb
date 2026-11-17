import { collection, getDocsFromServer, query, where } from "../../lib/db";
import type { DashTask } from "../../lib/dashboardStats";

interface QuotaTask {
  indicatorId: string;
  unitId: string;
  quotaGroupId: string;
  quotaIntervalStartYear: number;
  quotaIntervalStartMonth: number;
  quotaIntervalEndYear: number;
  quotaIntervalEndMonth: number;
}

interface QuotaRecord {
  id: string;
  data: Record<string, unknown>;
}

export interface PeriodicQuotaCounts {
  counts: Map<string, number>;
  failedGroups: Set<string>;
}

export function quotaRecordMatchesGroup(
  data: Record<string, unknown>,
  group: Pick<
    QuotaTask,
    | "indicatorId"
    | "unitId"
    | "quotaIntervalStartYear"
    | "quotaIntervalStartMonth"
    | "quotaIntervalEndYear"
    | "quotaIntervalEndMonth"
  >,
): boolean {
  const indicatorId = String(data.indicatorId ?? "");
  const unitId = String(data.unitId ?? "");
  const year = Number(data.year ?? 0);
  const month = Number(data.month ?? 0);
  const afterStart =
    year > group.quotaIntervalStartYear ||
    (year === group.quotaIntervalStartYear &&
      month >= group.quotaIntervalStartMonth);
  const beforeEnd =
    year < group.quotaIntervalEndYear ||
    (year === group.quotaIntervalEndYear &&
      month <= group.quotaIntervalEndMonth);
  return (
    indicatorId === group.indicatorId &&
    unitId === group.unitId &&
    afterStart &&
    beforeEnd
  );
}

/** Query each distinct indicator/year once, then aggregate records by interval quota. */
export async function loadPeriodicQuotaCounts(
  db: unknown,
  tasks: DashTask[],
): Promise<PeriodicQuotaCounts> {
  const groups = [
    ...new Map(
      tasks
        .filter((task) => task.quotaVersion === 1 && task.quotaGroupId)
        .map((task) => [task.quotaGroupId!, task]),
    ).values(),
  ];
  const groupData = new Map<string, QuotaTask>();
  const querySpecs = new Map<string, { indicatorId: string; year: number }>();
  const failedGroups = new Set<string>();

  for (const task of groups) {
    const groupId = task.quotaGroupId!;
    const startYear = task.quotaIntervalStartYear;
    const startMonth = task.quotaIntervalStartMonth;
    const endYear = task.quotaIntervalEndYear;
    const endMonth = task.quotaIntervalEndMonth;
    if (
      startYear == null ||
      startMonth == null ||
      endYear == null ||
      endMonth == null
    ) {
      failedGroups.add(groupId);
      continue;
    }

    groupData.set(groupId, {
      indicatorId: task.indicatorId,
      unitId: task.unitId,
      quotaGroupId: groupId,
      quotaIntervalStartYear: startYear,
      quotaIntervalStartMonth: startMonth,
      quotaIntervalEndYear: endYear,
      quotaIntervalEndMonth: endMonth,
    });
    for (let year = startYear; year <= endYear; year += 1) {
      const key = JSON.stringify([task.indicatorId, year]);
      querySpecs.set(key, { indicatorId: task.indicatorId, year });
    }
  }

  const snapshots = new Map<string, QuotaRecord[]>();
  const failedQueries = new Set<string>();
  await Promise.all(
    [...querySpecs.entries()].map(async ([key, spec]) => {
      try {
        const snapshot = await getDocsFromServer(
          query(
            collection(db, "reviewRecords"),
            where("indicatorId", "==", spec.indicatorId),
            where("year", "==", spec.year),
          ),
        );
        snapshots.set(
          key,
          snapshot.docs.map((document) => ({
            id: document.id,
            data: document.data() as Record<string, unknown>,
          })),
        );
      } catch {
        failedQueries.add(key);
      }
    }),
  );

  for (const [groupId, group] of groupData) {
    for (
      let year = group.quotaIntervalStartYear;
      year <= group.quotaIntervalEndYear;
      year += 1
    ) {
      if (failedQueries.has(JSON.stringify([group.indicatorId, year]))) {
        failedGroups.add(groupId);
        break;
      }
    }
  }

  const counts = new Map<string, number>();
  const seenRecordIds = new Set<string>();
  for (const records of snapshots.values()) {
    for (const record of records) {
      if (seenRecordIds.has(record.id)) continue;
      seenRecordIds.add(record.id);
      const data = record.data;
      const groupId =
        typeof data.quotaGroupId === "string" ? data.quotaGroupId : "";
      const taggedGroup = groupData.get(groupId);
      if (taggedGroup && quotaRecordMatchesGroup(data, taggedGroup)) {
        counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
        continue;
      }
      if (data.source !== "import" || groupId) continue;
      for (const [quotaId, group] of groupData) {
        if (quotaRecordMatchesGroup(data, group))
          counts.set(quotaId, (counts.get(quotaId) ?? 0) + 1);
      }
    }
  }

  return { counts, failedGroups };
}
