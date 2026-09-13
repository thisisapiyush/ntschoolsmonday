import { SecureStorage } from "@mondaycom/apps-sdk";
import type { MondayClient } from "./mondayClient.js";
import type { SiteResolver } from "./siteResolver.js";
import type { MondayWriter } from "./mondayWriter.js";
import { jiraStatusToMonday } from "./statusMap.js";
import type { EchoStore } from "./echoSuppression.js";

const MAPPING_KEY = "jira_issue_mapping";
const DEDUP_KEY = "webhook_dedup";
const DEDUP_TTL_MS = 60 * 60 * 1000;

interface IssueMapping {
  [jiraKey: string]: string;
}

interface DedupEntries {
  [webhookId: string]: number;
}

interface LogContext {
  correlationId: string;
  jiraKey?: string;
  event?: string;
  mondayItemId?: string;
}

function log(level: string, ctx: LogContext, message: string): void {
  const fields = Object.entries(ctx)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`[${level}] ${fields} ${message}`);
}

export interface WebhookIssue {
  key: string;
  fields: {
    summary: string;
    status: { name: string };
  };
}

export interface WebhookPayload {
  webhookEvent: string;
  issue: WebhookIssue;
  changelog?: {
    items?: Array<{
      field: string;
      fromString: string | null;
      toString: string | null;
    }>;
  };
}

export function createIssueSync(opts: {
  siteResolver: SiteResolver;
  writer: MondayWriter;
  mondayClient: MondayClient;
  boardId: string;
  jiraKeyColumnId: string;
  siteUrl: string;
  useSecureStorage: boolean;
  echoStore?: EchoStore;
}) {
  const { siteResolver, writer, siteUrl } = opts;

  const inFlight = new Map<string, Promise<void>>();
  const localMapping = new Map<string, string>();

  let storage: InstanceType<typeof SecureStorage> | null = null;

  function getStorage(): InstanceType<typeof SecureStorage> {
    if (!storage) {
      storage = new SecureStorage();
    }
    return storage;
  }

  async function loadMapping(): Promise<IssueMapping> {
    let persisted: IssueMapping = {};
    if (opts.useSecureStorage) {
      const raw = await getStorage().get<string>(MAPPING_KEY);
      if (raw != null) {
        try {
          persisted = JSON.parse(raw) as IssueMapping;
        } catch {
          persisted = {};
        }
      }
    }
    for (const [k, v] of localMapping) {
      persisted[k] = v;
    }
    return persisted;
  }

  async function saveMapping(mapping: IssueMapping): Promise<void> {
    for (const [k, v] of Object.entries(mapping)) {
      localMapping.set(k, v);
    }
    if (!opts.useSecureStorage) return;
    await getStorage().set(MAPPING_KEY, JSON.stringify(mapping));
  }

  async function isDuplicate(webhookId: string): Promise<boolean> {
    if (!opts.useSecureStorage) return false;
    const raw = await getStorage().get<string>(DEDUP_KEY);
    let entries: DedupEntries = {};
    if (raw != null) {
      try {
        entries = JSON.parse(raw) as DedupEntries;
      } catch {
        entries = {};
      }
    }

    if (webhookId in entries) return true;

    const now = Date.now();
    const pruned: DedupEntries = {};
    for (const [id, ts] of Object.entries(entries)) {
      if (now - ts < DEDUP_TTL_MS) {
        pruned[id] = ts;
      }
    }
    pruned[webhookId] = now;

    await getStorage().set(DEDUP_KEY, JSON.stringify(pruned));
    return false;
  }

  function summaryChanged(payload: WebhookPayload): boolean {
    return (
      payload.changelog?.items?.some((item) => item.field === "summary") ??
      false
    );
  }

  async function findItemByJiraKey(jiraKey: string): Promise<string | null> {
    const data = await opts.mondayClient.query<{
      items_page_by_column_values: { items: Array<{ id: string }> };
    }>(
      `query ($boardId: ID!, $columnId: String!, $value: String!) {
        items_page_by_column_values(
          board_id: $boardId
          limit: 1
          columns: [{ column_id: $columnId, column_values: [$value] }]
        ) {
          items { id }
        }
      }`,
      {
        boardId: opts.boardId,
        columnId: opts.jiraKeyColumnId,
        value: jiraKey,
      }
    );
    return data.items_page_by_column_values.items[0]?.id ?? null;
  }

  function buildJiraLink(issueKey: string): string {
    const base = siteUrl.replace(/\/+$/, "");
    return `${base}/browse/${issueKey}`;
  }

  async function processEvent(
    payload: WebhookPayload,
    correlationId: string
  ): Promise<void> {
    const key = payload.issue.key;
    const prev = inFlight.get(key) ?? Promise.resolve();
    const current = prev.then(() =>
      processEventInner(payload, correlationId).catch(() => {})
    );
    inFlight.set(key, current);
    await current;
    if (inFlight.get(key) === current) {
      inFlight.delete(key);
    }
  }

  async function processEventInner(
    payload: WebhookPayload,
    correlationId: string
  ): Promise<void> {
    const { issue } = payload;
    const ctx: LogContext = {
      correlationId,
      jiraKey: issue.key,
      event: payload.webhookEvent,
    };

    const duplicate = await isDuplicate(correlationId);
    if (duplicate) {
      log("INFO", ctx, "Duplicate webhook, skipping");
      return;
    }

    const mapping = await loadMapping();
    const existingItemId = mapping[issue.key];

    let mondayStatus = jiraStatusToMonday(issue.fields.status.name);
    if (!mondayStatus) {
      log(
        "WARN",
        ctx,
        `Unmapped Jira status "${issue.fields.status.name}", leaving monday Status unchanged`
      );
    }

    const jiraStatusName = issue.fields.status.name;

    if (mondayStatus && opts.echoStore && existingItemId) {
      try {
        const suppressed = await opts.echoStore.check(
          issue.key,
          "status",
          jiraStatusName
        );
        if (suppressed) {
          log(
            "INFO",
            ctx,
            `Echo suppressed: marker ${issue.key}:status:${jiraStatusName} found within window, skipping status write`
          );
          mondayStatus = undefined;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(
          "WARN",
          ctx,
          `Echo store check failed, proceeding: ${message}`
        );
      }
    }

    const jiraLink = buildJiraLink(issue.key);

    if (existingItemId) {
      ctx.mondayItemId = existingItemId;
      log("INFO", ctx, "Updating existing Work Package");

      const needsReResolve = summaryChanged(payload);
      let siteItemId: string | undefined;

      if (needsReResolve) {
        const resolution = await siteResolver.resolve(issue.fields.summary);
        if (resolution.kind === "matched") {
          siteItemId = resolution.itemId;
          log("INFO", ctx, `Re-resolved site to "${resolution.name}"`);
        } else {
          log("WARN", ctx, `Site re-resolution failed: ${resolution.reason}`);
        }
      }

      try {
        await writer.updateItem(existingItemId, {
          name: summaryChanged(payload) ? issue.fields.summary : undefined,
          mondayStatus,
          jiraKey: issue.key,
          jiraLink,
          siteItemId,
        });
        log("INFO", ctx, "Work Package updated");

        if (mondayStatus && opts.echoStore) {
          try {
            await opts.echoStore.record(issue.key, "status", jiraStatusName);
            log(
              "INFO",
              ctx,
              `Echo marker recorded: ${issue.key}:status:${jiraStatusName}`
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log(
              "WARN",
              ctx,
              `Failed to record echo marker: ${message}`
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log("ERROR", ctx, `Failed to update Work Package: ${message}`);
        try {
          await writer.addUpdate(
            existingItemId,
            `Sync error: failed to update from Jira issue ${issue.key}. ${message}`
          );
        } catch {
          log("ERROR", ctx, "Failed to write error update to monday item");
        }
      }
    } else {
      if (payload.webhookEvent !== "jira:issue_created") {
        log(
          "INFO",
          ctx,
          "No existing mapping and event is not issue_created, skipping"
        );
        return;
      }

      const existingOnBoard = await findItemByJiraKey(issue.key);
      if (existingOnBoard) {
        log(
          "INFO",
          ctx,
          `Item ${existingOnBoard} already exists on board for ${issue.key}, repairing mapping`
        );
        mapping[issue.key] = existingOnBoard;
        await saveMapping(mapping);
        await writer.updateItem(existingOnBoard, {
          mondayStatus,
          jiraKey: issue.key,
          jiraLink: buildJiraLink(issue.key),
        });
        return;
      }

      log("INFO", ctx, "Creating new Work Package");

      const resolution = await siteResolver.resolve(issue.fields.summary);

      try {
        const itemId = await writer.createItem({
          name: issue.fields.summary,
          mondayStatus,
          jiraKey: issue.key,
          jiraLink,
          siteItemId:
            resolution.kind === "matched" ? resolution.itemId : undefined,
        });

        ctx.mondayItemId = itemId;
        log("INFO", ctx, "Work Package created");

        mapping[issue.key] = itemId;
        await saveMapping(mapping);

        if (mondayStatus && opts.echoStore) {
          try {
            await opts.echoStore.record(issue.key, "status", jiraStatusName);
            log(
              "INFO",
              ctx,
              `Echo marker recorded: ${issue.key}:status:${jiraStatusName}`
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log(
              "WARN",
              ctx,
              `Failed to record echo marker: ${message}`
            );
          }
        }

        if (resolution.kind === "unresolved") {
          log("WARN", ctx, `Site unresolved: ${resolution.reason}`);
          try {
            await writer.addUpdate(
              itemId,
              `Site could not be linked automatically. ${resolution.reason}`
            );
          } catch {
            log("ERROR", ctx, "Failed to write unresolved-site update");
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log("ERROR", ctx, `Failed to create Work Package: ${message}`);
      }
    }
  }

  return { processEvent, loadMapping, saveMapping, isDuplicate };
}

export type IssueSync = ReturnType<typeof createIssueSync>;
