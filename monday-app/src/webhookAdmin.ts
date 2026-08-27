import { Router } from "express";
import { z } from "zod";
import { SecureStorage } from "@mondaycom/apps-sdk";
import type { JiraClient } from "./jiraClient.js";
import { JiraApiError } from "./jiraClient.js";
import type { IssueSync, WebhookIssue } from "./issueSync.js";
import type { SiteResolver } from "./siteResolver.js";
import { jiraStatusToMonday } from "./statusMap.js";

const WEBHOOK_ID_KEY = "jira_webhook_id";

const WebhookRegisterResponseSchema = z.object({
  webhookRegistrationResult: z.array(
    z.object({ createdWebhookId: z.number() })
  ),
});

const WebhookListResponseSchema = z.object({
  values: z.array(
    z.object({
      id: z.number(),
      expirationDate: z.string().optional(),
    })
  ),
});

const JiraSearchResponseSchema = z.object({
  issues: z.array(
    z.object({
      key: z.string(),
      fields: z.object({
        summary: z.string(),
        status: z.object({ name: z.string() }),
      }),
    })
  ),
  nextPageToken: z.string().optional(),
});

function isScopeError(err: unknown): boolean {
  if (!(err instanceof JiraApiError)) return false;
  if (err.status !== 403) return false;
  return (
    err.body.includes("scope") ||
    err.body.includes("permission") ||
    err.body.includes("OAuth")
  );
}

function scopeErrorResponse(res: import("express").Response): void {
  res.status(403).json({
    error:
      'Missing OAuth scope "manage:jira-webhook". ' +
      "Reauthorise at /oauth/start to grant the required scope.",
    reauthorizeUrl: "/oauth/start",
  });
}

export function createWebhookAdminRouter(opts: {
  jira: JiraClient;
  issueSync: IssueSync;
  siteResolver: SiteResolver;
  webhookUrl: string;
  projectKey: string;
  siteUrl: string;
  useSecureStorage: boolean;
}): Router {
  const router = Router();

  let storage: InstanceType<typeof SecureStorage> | null = null;

  function getStorage(): InstanceType<typeof SecureStorage> {
    if (!storage) storage = new SecureStorage();
    return storage;
  }

  async function loadWebhookId(): Promise<number | null> {
    if (!opts.useSecureStorage) return null;
    const raw = await getStorage().get<string>(WEBHOOK_ID_KEY);
    if (raw == null) return null;
    const parsed = parseInt(raw, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  async function saveWebhookId(id: number): Promise<void> {
    if (!opts.useSecureStorage) return;
    await getStorage().set(WEBHOOK_ID_KEY, String(id));
  }

  router.post("/admin/webhook/register", async (req, res, next) => {
    try {
      const existing = await loadWebhookId();
      if (existing !== null) {
        res.json({
          message: "Webhook already registered",
          webhookId: existing,
        });
        return;
      }

      const data = await opts.jira.post(
        "webhook",
        {
          url: opts.webhookUrl,
          webhooks: [
            {
              events: ["jira:issue_created", "jira:issue_updated"],
              jqlFilter: `project = ${opts.projectKey}`,
            },
          ],
        },
        WebhookRegisterResponseSchema
      );

      const result = data.webhookRegistrationResult[0];
      if (!result) {
        res.status(500).json({ error: "No webhook ID returned from Jira" });
        return;
      }

      await saveWebhookId(result.createdWebhookId);

      res.json({
        message: "Webhook registered",
        webhookId: result.createdWebhookId,
      });
    } catch (err) {
      if (isScopeError(err)) {
        scopeErrorResponse(res);
        return;
      }
      next(err);
    }
  });

  router.get("/admin/webhook/status", async (req, res, next) => {
    try {
      const webhookId = await loadWebhookId();
      if (webhookId === null) {
        res.json({ registered: false });
        return;
      }

      try {
        const data = await opts.jira.get("webhook", WebhookListResponseSchema);
        const match = data.values.find((w) => w.id === webhookId);

        if (!match) {
          res.json({
            registered: true,
            webhookId,
            active: false,
            note: "Webhook ID stored but not found in Jira. It may have expired or been deleted.",
          });
          return;
        }

        let daysUntilExpiry: number | null = null;
        if (match.expirationDate) {
          const expiry = new Date(match.expirationDate).getTime();
          daysUntilExpiry = Math.ceil((expiry - Date.now()) / 86_400_000);
        }

        res.json({
          registered: true,
          webhookId,
          active: true,
          expirationDate: match.expirationDate,
          daysUntilExpiry,
        });
      } catch (err) {
        if (isScopeError(err)) {
          scopeErrorResponse(res);
          return;
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/webhook/refresh", async (req, res, next) => {
    try {
      const webhookId = await loadWebhookId();
      if (webhookId === null) {
        res.status(404).json({
          error: "No webhook registered. Call POST /admin/webhook/register first.",
        });
        return;
      }

      await opts.jira.post(
        "webhook/refresh",
        { webhookIds: [webhookId] },
        z.object({})
      );

      res.json({ message: "Webhook expiry extended", webhookId });
    } catch (err) {
      if (isScopeError(err)) {
        scopeErrorResponse(res);
        return;
      }
      next(err);
    }
  });

  router.post("/admin/backfill", async (req, res, next) => {
    try {
      const dryRun = req.query["dryRun"] === "true";
      const allIssues: WebhookIssue[] = [];
      let nextPageToken: string | undefined;

      do {
        const body: Record<string, unknown> = {
          jql: `project = ${opts.projectKey} ORDER BY created ASC`,
          maxResults: 50,
          fields: ["summary", "status"],
        };
        if (nextPageToken) {
          body["nextPageToken"] = nextPageToken;
        }

        const data = await opts.jira.post(
          "search/jql",
          body,
          JiraSearchResponseSchema
        );
        allIssues.push(...data.issues);
        nextPageToken = data.nextPageToken;
      } while (nextPageToken);

      const mapping = await opts.issueSync.loadMapping();
      const toCreate: WebhookIssue[] = [];
      const toUpdate: WebhookIssue[] = [];

      for (const issue of allIssues) {
        if (mapping[issue.key]) {
          toUpdate.push(issue);
        } else {
          toCreate.push(issue);
        }
      }

      const unresolvedSites: string[] = [];
      for (const issue of toCreate) {
        const resolution = await opts.siteResolver.resolve(
          issue.fields.summary
        );
        if (resolution.kind === "unresolved") {
          unresolvedSites.push(
            `${issue.key}: ${resolution.reason}`
          );
        }
      }

      if (dryRun) {
        res.json({
          dryRun: true,
          issuesFound: allIssues.length,
          wouldCreate: toCreate.length,
          wouldUpdate: toUpdate.length,
          unresolvedSites,
          issues: allIssues.map((i) => ({
            key: i.key,
            summary: i.fields.summary,
            status: i.fields.status.name,
            mondayStatus: jiraStatusToMonday(i.fields.status.name) ?? "(unmapped)",
            action: mapping[i.key] ? "update" : "create",
          })),
        });
        return;
      }

      let created = 0;
      let updated = 0;
      let failed = 0;

      for (const issue of allIssues) {
        try {
          await opts.issueSync.processEvent(
            {
              webhookEvent: mapping[issue.key]
                ? "jira:issue_updated"
                : "jira:issue_created",
              issue,
            },
            `backfill-${issue.key}`
          );
          if (mapping[issue.key]) {
            updated++;
          } else {
            created++;
          }
        } catch {
          failed++;
        }
      }

      res.json({
        dryRun: false,
        issuesFound: allIssues.length,
        created,
        updated,
        failed,
      });
    } catch (err) {
      if (isScopeError(err)) {
        scopeErrorResponse(res);
        return;
      }
      next(err);
    }
  });

  return router;
}
