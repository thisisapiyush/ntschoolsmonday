import type { MondayClient } from "./mondayClient.js";
import type { LabelMap } from "./types.js";

interface ColumnDef {
  id: string;
  title: string;
  settings_str: string;
}

interface BoardColumnsResponse {
  boards: Array<{ columns: ColumnDef[] }>;
}

const STATUS_COLUMNS = [
  "color_mm63v03v",
  "color_mm63hg85",
  "color_mm64cjvv",
  "color_mm643hp0",
  "color_mm64ty9d",
] as const;

export type StatusColumnId = (typeof STATUS_COLUMNS)[number];

export async function loadBoardSchema(
  client: MondayClient,
  boardId: string
): Promise<Map<StatusColumnId, LabelMap>> {
  const data = await client.query<BoardColumnsResponse>(
    `query ($boardId: [ID!]!) {
      boards(ids: $boardId) {
        columns { id title settings_str }
      }
    }`,
    { boardId: [boardId] }
  );

  const board = data.boards[0];
  if (!board) {
    throw new Error(`Board ${boardId} not found`);
  }

  const result = new Map<StatusColumnId, LabelMap>();

  for (const colId of STATUS_COLUMNS) {
    const col = board.columns.find((c) => c.id === colId);
    if (!col) {
      throw new Error(
        `Column ${colId} not found on board ${boardId}`
      );
    }

    const settings = JSON.parse(col.settings_str) as {
      labels?: Record<string, string>;
    };
    const labels = settings.labels;
    if (!labels) {
      throw new Error(
        `Column ${colId} (${col.title}) has no labels in settings_str`
      );
    }

    const labelMap: LabelMap = new Map();
    for (const [indexStr, text] of Object.entries(labels)) {
      const index = parseInt(indexStr, 10);
      if (!Number.isNaN(index)) {
        labelMap.set(text, index);
      }
    }

    result.set(colId, labelMap);
  }

  return result;
}

export function resolveLabel(
  schema: Map<StatusColumnId, LabelMap>,
  columnId: StatusColumnId,
  labelText: string
): number {
  const labelMap = schema.get(columnId);
  if (!labelMap) {
    throw new Error(`No label map loaded for column ${columnId}`);
  }
  const index = labelMap.get(labelText);
  if (index === undefined) {
    throw new Error(
      `Label "${labelText}" not found in column ${columnId}. ` +
        `Available labels: ${[...labelMap.keys()].join(", ")}`
    );
  }
  return index;
}

const CODE_CONTROLLED_COLUMNS: StatusColumnId[] = [
  "color_mm63hg85",
  "color_mm64cjvv",
  "color_mm643hp0",
  "color_mm64ty9d",
];

export function validateCodeControlledLabels(
  schema: Map<StatusColumnId, LabelMap>,
  requiredLabels: Map<StatusColumnId, string[]>
): void {
  const errors: string[] = [];

  for (const colId of CODE_CONTROLLED_COLUMNS) {
    const required = requiredLabels.get(colId);
    if (!required) continue;

    for (const label of required) {
      const labelMap = schema.get(colId);
      if (!labelMap?.has(label)) {
        errors.push(`Column ${colId}: missing label "${label}"`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Board schema validation failed (code-controlled columns):\n  ${errors.join("\n  ")}`
    );
  }
}

export function resolveRegionLabels(
  schema: Map<StatusColumnId, LabelMap>,
  regionValues: string[]
): { resolved: Map<string, number>; unmapped: string[] } {
  const regionMap = schema.get("color_mm63v03v");
  if (!regionMap) {
    throw new Error("No label map loaded for Region column color_mm63v03v");
  }

  const resolved = new Map<string, number>();
  const unmapped: string[] = [];

  const unique = [...new Set(regionValues)];
  for (const region of unique) {
    const index = regionMap.get(region);
    if (index !== undefined) {
      resolved.set(region, index);
    } else {
      unmapped.push(region);
    }
  }

  return { resolved, unmapped };
}
