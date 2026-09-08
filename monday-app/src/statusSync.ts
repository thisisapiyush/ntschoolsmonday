import type { MondayClient } from "./mondayClient.js";
import type { JiraClient } from "./jiraClient.js";
import type { EchoStore } from "./echoSuppression.js";
import type { WorkPackagesSchema } from "./boardSchema.js";
import { mondayStatusToJira } from "./statusMap.js";
import { transitionIssue, addOriginComment } from "./jiraTransition.js";

export interface LogContext {
  correlationId: string;
  jiraKey?: string;
  mondayItemId?: string;
}

export function log(level: string, ctx: LogContext, message: string): void {
  const fields = Object.entries(ctx)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`[${level}] ${fields} ${message}`);
}

interface ItemColumns {
  jiraKey: string | null;
  statusLabel: string | null;
}

async function readItemColumns(
  mondayClient: MondayClient,
  schema: WorkPackagesSchema,
  itemId: string
): Promise<ItemColumns> {
  const data = await mondayClient.query<{
    items: Array<{
      column_values: Array<{
        id: string;
        text: string | null;
      }>;
    }>;
  }>(
    `query ($itemId: [ID!]!) {
      items(ids: $itemId) {
        column_values { id text }
      }
    }`,
    { itemId: [itemId] }
  );

  const item = data.items[0];
  if (!item) return { jiraKey: null, statusLabel: null };

  let jiraKey: string | null = null;
  let statusLabel: string | null = null;

  for (const col of item.column_values) {
    if (col.id === schema.jiraKeyColumnId) {
      jiraKey = col.text || null;
    }
    if (col.id === schema.statusColumnId) {
      statusLabel = col.text || null;
    }
  }

  return { jiraKey, statusLabel };
}

export interface SyncDeps {
  mondayClient: MondayClient;
  jira: JiraClient;
  echoStore: EchoStore;
  schema: WorkPackagesSchema;
}

export interface SyncResult {
  message: string;
  transient?: boolean;
  errorTitle?: string;
  errorDetail?: string;
}

export async function syncStatusToJira(
  deps: SyncDeps,
  itemId: string,
  correlationId: string,
  previousMondayStatus?: string
): Promise<SyncResult> {
  const ctx: LogContext = { correlationId, mondayItemId: itemId };

  let columns: ItemColumns;
  try {
    columns = await readItemColumns(deps.mondayClient, deps.schema, itemId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("ERROR", ctx, `Failed to read item columns: ${message}`);
    return {
      message: "Could not read monday item",
      transient: true,
      errorTitle: "Could not read monday item",
      errorDetail: message,
    };
  }

  if (!columns.jiraKey) {
    log(
      "INFO",
      ctx,
      "Item has no Jira key, skipping (monday-originated work package)"
    );
    return { message: "No Jira counterpart" };
  }

  ctx.jiraKey = columns.jiraKey;

  if (!columns.statusLabel) {
    log("WARN", ctx, "Item has no status label");
    return { message: "No status to sync" };
  }

  const jiraStatus = mondayStatusToJira(columns.statusLabel);
  if (!jiraStatus) {
    log(
      "WARN",
      ctx,
      `Unmapped monday status "${columns.statusLabel}", skipping`
    );
    return { message: "Unmapped status" };
  }

  try {
    const suppressed = await deps.echoStore.check(
      columns.jiraKey,
      "status",
      jiraStatus
    );
    if (suppressed) {
      log(
        "INFO",
        ctx,
        `Echo suppressed: marker ${columns.jiraKey}:status:${jiraStatus} found within window`
      );
      return { message: "Echo suppressed" };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("WARN", ctx, `Echo store check failed, proceeding: ${message}`);
  }

  try {
    const result = await transitionIssue(
      deps.jira,
      columns.jiraKey,
      jiraStatus
    );

    if (result.kind === "no_matching_transition") {
      const available = result.availableTargets.join(", ") || "none";
      log(
        "WARN",
        ctx,
        `No transition to "${jiraStatus}" available. Available targets: ${available}`
      );

      try {
        await deps.mondayClient.query<{
          create_update: { id: string };
        }>(
          `mutation ($itemId: ID!, $body: String!) {
              create_update(item_id: $itemId, body: $body) { id }
            }`,
          {
            itemId,
            body:
              `Cannot transition Jira issue ${columns.jiraKey} to "${jiraStatus}". ` +
              `The issue's current workflow does not allow this transition. ` +
              `Available target statuses: ${available}.`,
          }
        );
      } catch {
        log("ERROR", ctx, "Failed to post constraint update to monday item");
      }

      return { message: "No matching transition" };
    }

    log(
      "INFO",
      ctx,
      `Transitioned ${columns.jiraKey} via "${result.transitionName}" (id=${result.transitionId}) to "${jiraStatus}"`
    );

    try {
      await deps.echoStore.record(columns.jiraKey, "status", jiraStatus);
      log(
        "INFO",
        ctx,
        `Echo marker recorded: ${columns.jiraKey}:status:${jiraStatus}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("WARN", ctx, `Failed to record echo marker: ${message}`);
    }

    try {
      await addOriginComment(
        deps.jira,
        columns.jiraKey,
        previousMondayStatus,
        columns.statusLabel
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("WARN", ctx, `Failed to add Jira comment: ${message}`);
    }

    return { message: "Transition complete" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("ERROR", ctx, `Jira transition failed: ${message}`);
    return {
      message: `Could not transition ${columns.jiraKey}: ${message}`,
      transient: true,
      errorTitle: "Jira transition failed",
      errorDetail: message,
    };
  }
}
