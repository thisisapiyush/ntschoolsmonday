import "dotenv/config";
import { fetchSchools } from "./fetchSchools.js";
import { filterAndTransform } from "./transform.js";
import { createMondayClient, type MondayClient } from "./mondayClient.js";
import {
  loadBoardSchema,
  resolveLabel,
  validateCodeControlledLabels,
  resolveRegionLabels,
  type StatusColumnId,
} from "./schema.js";
import type { SiteItem, IngestSummary, LabelMap } from "./types.js";

const BOARD_ID = "5030539700";
const SCHOOL_CODE_COLUMN = "text_mm649dbn";
const PAGE_LIMIT = 100;

function getToken(): string {
  const token = process.env["MONDAY_API_TOKEN"];
  if (!token) {
    throw new Error(
      "MONDAY_API_TOKEN is not set. Add it to .env or set it as an environment variable."
    );
  }
  return token;
}

interface ExistingItem {
  id: string;
  name: string;
  schoolCode: string;
}

async function fetchExistingItems(
  client: MondayClient
): Promise<Map<string, ExistingItem>> {
  const map = new Map<string, ExistingItem>();
  let cursor: string | null = null;
  let isFirstPage = true;

  while (true) {
    let data: Record<string, unknown>;

    if (isFirstPage) {
      data = await client.query(
        `query ($boardId: [ID!]!, $limit: Int!) {
          boards(ids: $boardId) {
            items_page(limit: $limit) {
              cursor
              items {
                id
                name
                column_values(ids: ["${SCHOOL_CODE_COLUMN}"]) {
                  id
                  text
                }
              }
            }
          }
        }`,
        { boardId: [BOARD_ID], limit: PAGE_LIMIT }
      );
      isFirstPage = false;

      const boards = data["boards"] as Array<{
        items_page: {
          cursor: string | null;
          items: Array<{
            id: string;
            name: string;
            column_values: Array<{ id: string; text: string | null }>;
          }>;
        };
      }>;
      const board = boards[0];
      if (!board) break;

      const page = board.items_page;
      for (const item of page.items) {
        const codeCol = item.column_values.find(
          (cv) => cv.id === SCHOOL_CODE_COLUMN
        );
        const code = codeCol?.text;
        if (code) {
          map.set(code, { id: item.id, name: item.name, schoolCode: code });
        }
      }
      cursor = page.cursor;
    } else {
      data = await client.query(
        `query ($limit: Int!, $cursor: String!) {
          next_items_page(limit: $limit, cursor: $cursor) {
            cursor
            items {
              id
              name
              column_values(ids: ["${SCHOOL_CODE_COLUMN}"]) {
                id
                text
              }
            }
          }
        }`,
        { limit: PAGE_LIMIT, cursor }
      );

      const page = data["next_items_page"] as {
        cursor: string | null;
        items: Array<{
          id: string;
          name: string;
          column_values: Array<{ id: string; text: string | null }>;
        }>;
      };

      for (const item of page.items) {
        const codeCol = item.column_values.find(
          (cv) => cv.id === SCHOOL_CODE_COLUMN
        );
        const code = codeCol?.text;
        if (code) {
          map.set(code, { id: item.id, name: item.name, schoolCode: code });
        }
      }
      cursor = page.cursor;
    }

    if (!cursor) break;
  }

  return map;
}

function buildColumnValues(
  item: SiteItem,
  schema: Map<StatusColumnId, LabelMap>,
  regionIndexMap: Map<string, number>
): string {
  const values: Record<string, unknown> = {
    [SCHOOL_CODE_COLUMN]: item.schoolCode,
    color_mm63hg85: {
      index: resolveLabel(schema, "color_mm63hg85", item.remoteness),
    },
    color_mm64cjvv: {
      index: resolveLabel(schema, "color_mm64cjvv", item.siteStatus),
    },
    color_mm643hp0: {
      index: resolveLabel(schema, "color_mm643hp0", item.powerReady),
    },
    color_mm64ty9d: {
      index: resolveLabel(schema, "color_mm64ty9d", item.commsReady),
    },
    numeric_mm643e9f: item.readinessScore.toString(),
  };

  const regionIndex = regionIndexMap.get(item.region);
  if (regionIndex !== undefined) {
    values["color_mm63v03v"] = { index: regionIndex };
  }

  return JSON.stringify(values);
}

async function createItem(
  client: MondayClient,
  item: SiteItem,
  columnValues: string
): Promise<void> {
  await client.query(
    `mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) {
        id
      }
    }`,
    {
      boardId: BOARD_ID,
      itemName: item.name,
      columnValues,
    }
  );
}

async function updateItem(
  client: MondayClient,
  itemId: string,
  item: SiteItem,
  columnValues: string
): Promise<void> {
  await client.query(
    `mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) {
        id
      }
    }`,
    {
      boardId: BOARD_ID,
      itemId,
      columnValues,
    }
  );
}

function printSummary(summary: IngestSummary): void {
  console.log("\n=== Ingest Summary ===");
  console.log(`  Fetched from source:     ${summary.fetched}`);
  console.log(`  Non-government excluded: ${summary.nonGovernmentExcluded}`);
  console.log(`  Preschool (flag):        ${summary.preSchoolFlagExcluded}`);
  console.log(`  Preschool (type):        ${summary.preSchoolTypeExcluded}`);
  console.log(`  After filtering:         ${summary.filtered}`);
  console.log(`  Created:                 ${summary.created}`);
  console.log(`  Updated:                 ${summary.updated}`);
  console.log(`  Skipped (orphans):       ${summary.skipped}`);
  console.log(`  Failed:                  ${summary.failed}`);
  console.log(`  Unmapped region:         ${summary.unmapped}`);

  if (summary.orphans.length > 0) {
    console.log(`\n  Orphaned items (in monday but not in source):`);
    for (const name of summary.orphans) {
      console.log(`    - ${name}`);
    }
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  if (dryRun) {
    console.log("DRY RUN — no changes will be written to monday.com\n");
  }

  // 1. Fetch and transform
  console.log("Fetching schools from NT Directory API...");
  const rawSchools = await fetchSchools();
  console.log(`Fetched ${rawSchools.length} schools`);

  const filterResult = filterAndTransform(rawSchools);
  console.log(
    `Filtered to ${filterResult.filteredCount} government non-preschools`
  );
  console.log(
    `  Excluded: ${filterResult.nonGovernmentCount} non-government, ` +
      `${filterResult.preSchoolFlagCount} preschool (flag), ` +
      `${filterResult.preSchoolTypeCount} preschool (type)`
  );

  const summary: IngestSummary = {
    fetched: rawSchools.length,
    filtered: filterResult.filteredCount,
    nonGovernmentExcluded: filterResult.nonGovernmentCount,
    preSchoolFlagExcluded: filterResult.preSchoolFlagCount,
    preSchoolTypeExcluded: filterResult.preSchoolTypeCount,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    unmapped: 0,
    orphans: [],
  };

  // 2. Connect to monday and resolve schema
  const token = getToken();
  const client = createMondayClient(token);

  console.log("Loading board schema...");
  const schema = await loadBoardSchema(client, BOARD_ID);

  // Validate code-controlled labels (abort on failure)
  validateCodeControlledLabels(
    schema,
    new Map<StatusColumnId, string[]>([
      ["color_mm63hg85", ["Urban", "Regional", "Remote", "Very Remote"]],
      ["color_mm64cjvv", ["Not started"]],
      ["color_mm643hp0", ["Unknown"]],
      ["color_mm64ty9d", ["Unknown"]],
    ])
  );
  console.log("Code-controlled labels validated");

  // Resolve region labels (soft failure)
  const regionValues = filterResult.items.map((i) => i.region);
  const { resolved: regionIndexMap, unmapped: unmappedRegions } =
    resolveRegionLabels(schema, regionValues);

  if (unmappedRegions.length > 0) {
    console.warn(
      `WARNING: Unmapped decsRegion values (will write without Region): ${unmappedRegions.join(", ")}`
    );
  }
  console.log(
    `Region labels resolved: ${regionIndexMap.size} mapped, ${unmappedRegions.length} unmapped`
  );

  // 3. Fetch existing items
  console.log("Fetching existing items from monday board...");
  const existingItems = await fetchExistingItems(client);
  console.log(`Found ${existingItems.size} existing items`);

  // 4. Write items
  const unmappedRegionSet = new Set(unmappedRegions);

  for (const item of filterResult.items) {
    const isUnmapped = unmappedRegionSet.has(item.region);
    if (isUnmapped) {
      summary.unmapped++;
    }

    const columnValues = buildColumnValues(item, schema, regionIndexMap);
    const existing = existingItems.get(item.schoolCode);

    if (existing) {
      existingItems.delete(item.schoolCode);
      if (dryRun) {
        console.log(`  UPDATE: ${item.name} (${item.schoolCode}) -> item ${existing.id}`);
        summary.updated++;
        continue;
      }
      try {
        await updateItem(client, existing.id, item, columnValues);
        summary.updated++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `  FAILED to update "${item.name}" (${item.schoolCode}): ${msg}`
        );
        summary.failed++;
      }
    } else {
      if (dryRun) {
        console.log(`  CREATE: ${item.name} (${item.schoolCode})`);
        summary.created++;
        continue;
      }
      try {
        await createItem(client, item, columnValues);
        summary.created++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `  FAILED to create "${item.name}" (${item.schoolCode}): ${msg}`
        );
        summary.failed++;
      }
    }
  }

  // 5. Report orphans
  for (const [, orphan] of existingItems) {
    summary.skipped++;
    summary.orphans.push(orphan.name);
  }

  printSummary(summary);

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
