import type { MondayClient } from "./mondayClient.js";
import type { WorkPackagesSchema } from "./boardSchema.js";
import { resolveStatusIndex } from "./boardSchema.js";

interface CreateItemResponse {
  create_item: { id: string };
}

interface ChangeColumnValuesResponse {
  change_multiple_column_values: { id: string };
}

interface CreateUpdateResponse {
  create_update: { id: string };
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createMondayWriter(
  client: MondayClient,
  schema: WorkPackagesSchema,
  boardId: string
) {
  function buildColumnValues(opts: {
    mondayStatus?: string;
    jiraKey: string;
    jiraLink: string;
    siteItemId?: string;
  }): string {
    const values: Record<string, unknown> = {
      [schema.jiraKeyColumnId]: jiraKey(opts.jiraKey),
      [schema.jiraLinkColumnId]: {
        url: opts.jiraLink,
        text: opts.jiraKey,
      },
      [schema.lastSyncedColumnId]: { date: todayDate() },
    };

    if (opts.mondayStatus) {
      const index = resolveStatusIndex(schema, opts.mondayStatus);
      values[schema.statusColumnId] = { index };
    }

    if (opts.siteItemId) {
      values[schema.siteColumnId] = {
        item_ids: [parseInt(opts.siteItemId, 10)],
      };
    }

    return JSON.stringify(values);
  }

  function jiraKey(key: string): string {
    return key;
  }

  async function createItem(opts: {
    name: string;
    mondayStatus?: string;
    jiraKey: string;
    jiraLink: string;
    siteItemId?: string;
  }): Promise<string> {
    const columnValues = buildColumnValues(opts);

    const data = await client.query<CreateItemResponse>(
      `mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
        create_item(
          board_id: $boardId
          item_name: $itemName
          column_values: $columnValues
        ) { id }
      }`,
      {
        boardId,
        itemName: opts.name,
        columnValues,
      }
    );

    return data.create_item.id;
  }

  async function updateItem(
    itemId: string,
    opts: {
      name?: string;
      mondayStatus?: string;
      jiraKey: string;
      jiraLink: string;
      siteItemId?: string;
    }
  ): Promise<void> {
    const values: Record<string, unknown> = {
      [schema.jiraKeyColumnId]: opts.jiraKey,
      [schema.jiraLinkColumnId]: {
        url: opts.jiraLink,
        text: opts.jiraKey,
      },
      [schema.lastSyncedColumnId]: { date: todayDate() },
    };

    if (opts.mondayStatus) {
      const index = resolveStatusIndex(schema, opts.mondayStatus);
      values[schema.statusColumnId] = { index };
    }

    if (opts.siteItemId) {
      values[schema.siteColumnId] = {
        item_ids: [parseInt(opts.siteItemId, 10)],
      };
    }

    const columnValues = JSON.stringify(values);

    if (opts.name) {
      await client.query<ChangeColumnValuesResponse>(
        `mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!, $itemName: String!) {
          change_multiple_column_values(
            board_id: $boardId
            item_id: $itemId
            column_values: $columnValues
          ) { id }
          change_simple_column_value(
            board_id: $boardId
            item_id: $itemId
            column_id: "name"
            value: $itemName
          ) { id }
        }`,
        { boardId, itemId, columnValues, itemName: JSON.stringify(opts.name) }
      );
    } else {
      await client.query<ChangeColumnValuesResponse>(
        `mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
          change_multiple_column_values(
            board_id: $boardId
            item_id: $itemId
            column_values: $columnValues
          ) { id }
        }`,
        { boardId, itemId, columnValues }
      );
    }
  }

  async function addUpdate(itemId: string, body: string): Promise<void> {
    await client.query<CreateUpdateResponse>(
      `mutation ($itemId: ID!, $body: String!) {
        create_update(item_id: $itemId, body: $body) { id }
      }`,
      { itemId, body }
    );
  }

  return { createItem, updateItem, addUpdate };
}

export type MondayWriter = ReturnType<typeof createMondayWriter>;
