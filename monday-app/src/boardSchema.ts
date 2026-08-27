import type { MondayClient } from "./mondayClient.js";

type LabelMap = Map<string, number>;

interface ColumnDef {
  id: string;
  title: string;
  type: string;
  settings_str: string;
}

interface BoardColumnsResponse {
  boards: Array<{ columns: ColumnDef[] }>;
}

export interface WorkPackagesSchema {
  statusColumnId: string;
  statusLabels: LabelMap;
  jiraKeyColumnId: string;
  jiraLinkColumnId: string;
  lastSyncedColumnId: string;
  siteColumnId: string;
}

const EXPECTED_COLUMNS: ReadonlyArray<{
  title: string;
  type: string;
  key: keyof WorkPackagesSchema;
}> = [
  { title: "Status", type: "color", key: "statusColumnId" },
  { title: "Jira key", type: "text", key: "jiraKeyColumnId" },
  { title: "Jira link", type: "link", key: "jiraLinkColumnId" },
  { title: "Last synced", type: "date", key: "lastSyncedColumnId" },
  { title: "Site", type: "board_relation", key: "siteColumnId" },
];

function buildLabelMap(settingsStr: string, title: string): LabelMap {
  const settings = JSON.parse(settingsStr) as {
    labels?: Record<string, string>;
  };
  const labels = settings.labels;
  if (!labels) {
    throw new Error(
      `Column "${title}" has no labels in settings_str`
    );
  }

  const labelMap: LabelMap = new Map();
  for (const [indexStr, text] of Object.entries(labels)) {
    const index = parseInt(indexStr, 10);
    if (!Number.isNaN(index)) {
      labelMap.set(text, index);
    }
  }
  return labelMap;
}

export async function loadWorkPackagesSchema(
  client: MondayClient,
  boardId: string
): Promise<WorkPackagesSchema> {
  const data = await client.query<BoardColumnsResponse>(
    `query ($boardId: [ID!]!) {
      boards(ids: $boardId) {
        columns { id title type settings_str }
      }
    }`,
    { boardId: [boardId] }
  );

  const board = data.boards[0];
  if (!board) {
    throw new Error(`Board ${boardId} not found`);
  }

  const missing: string[] = [];
  const result: Record<string, string | LabelMap> = {};

  for (const expected of EXPECTED_COLUMNS) {
    const col = board.columns.find((c) => c.title === expected.title);
    if (!col) {
      missing.push(`"${expected.title}" (${expected.type})`);
      continue;
    }

    result[expected.key] = col.id;

    if (expected.type === "color") {
      const labelsKey = expected.key.replace("ColumnId", "Labels");
      result[labelsKey] = buildLabelMap(col.settings_str, expected.title);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Work Packages board ${boardId} is missing columns: ${missing.join(", ")}`
    );
  }

  return result as unknown as WorkPackagesSchema;
}

export function resolveStatusIndex(
  schema: WorkPackagesSchema,
  label: string
): number {
  const index = schema.statusLabels.get(label);
  if (index === undefined) {
    throw new Error(
      `Status label "${label}" not found. Available: ${[...schema.statusLabels.keys()].join(", ")}`
    );
  }
  return index;
}
