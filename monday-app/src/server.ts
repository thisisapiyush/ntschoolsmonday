import express from "express";
import { loadConfig } from "./config.js";
import { FileTokenStore, FileStateStore } from "./tokenStore.js";
import { MondayTokenStore, MondayStateStore } from "./mondayStore.js";
import { buildAuthorizeUrl, exchangeCode, fetchCloudId } from "./oauth.js";
import {
  createJiraClient,
  NotAuthorisedError,
  JiraApiError,
} from "./jiraClient.js";
import { JiraSearchResponseSchema } from "./types.js";
import type { TokenStore, StateStore } from "./types.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createMondayClient } from "./mondayClient.js";
import { loadWorkPackagesSchema } from "./boardSchema.js";
import { createSiteResolver } from "./siteResolver.js";
import { createMondayWriter } from "./mondayWriter.js";
import { createIssueSync } from "./issueSync.js";
import { createWebhookRouter } from "./webhookHandler.js";
import { createWebhookAdminRouter } from "./webhookAdmin.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname, "..");

async function main() {
  const config = await loadConfig();

  const tokenStore: TokenStore =
    config.TOKEN_STORE === "monday"
      ? new MondayTokenStore()
      : new FileTokenStore(join(appRoot, ".tokens.json"));

  const stateStore: StateStore =
    config.TOKEN_STORE === "monday"
      ? new MondayStateStore()
      : new FileStateStore(join(appRoot, ".oauth-states.json"));

  const jira = createJiraClient({
    clientId: config.JIRA_CLIENT_ID,
    clientSecret: config.JIRA_CLIENT_SECRET,
    tokenStore,
  });

  const monday = createMondayClient(config.MONDAY_API_TOKEN);

  console.log("Loading Work Packages board schema...");
  const wpSchema = await loadWorkPackagesSchema(
    monday,
    config.WORK_PACKAGES_BOARD_ID
  );
  console.log("Board schema loaded. Columns resolved by title.");

  const siteResolver = createSiteResolver(monday, config.SITES_BOARD_ID);
  const writer = createMondayWriter(
    monday,
    wpSchema,
    config.WORK_PACKAGES_BOARD_ID
  );

  const useSecureStorage = config.TOKEN_STORE === "monday";

  const issueSync = createIssueSync({
    siteResolver,
    writer,
    siteUrl: config.JIRA_SITE_URL,
    useSecureStorage,
  });

  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/oauth/start", async (_req, res, next) => {
    try {
      const { url, state, expiresAt } = buildAuthorizeUrl({
        clientId: config.JIRA_CLIENT_ID,
        redirectUri: config.JIRA_REDIRECT_URI,
      });
      await stateStore.save(state, expiresAt);
      res.redirect(url);
    } catch (err) {
      next(err);
    }
  });

  app.get("/oauth/callback", async (req, res, next) => {
    try {
      const { code, state } = req.query;

      if (typeof state !== "string" || typeof code !== "string") {
        res.status(400).json({ error: "Missing code or state parameter" });
        return;
      }

      const valid = await stateStore.consume(state);
      if (!valid) {
        res.status(400).json({
          error:
            "Invalid or expired state. Start the OAuth flow again at /oauth/start.",
        });
        return;
      }

      const tokenResult = await exchangeCode({
        clientId: config.JIRA_CLIENT_ID,
        clientSecret: config.JIRA_CLIENT_SECRET,
        redirectUri: config.JIRA_REDIRECT_URI,
        code,
      });

      const { cloudId, siteUrl } = await fetchCloudId(
        tokenResult.accessToken,
        config.JIRA_SITE_URL
      );

      await tokenStore.save({
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.refreshToken,
        expiresAt: tokenResult.expiresAt,
        cloudId,
        siteUrl,
      });

      res.type("html").send(
        `<!doctype html>
<h1>Connected</h1>
<p>Successfully connected to Jira site: <strong>${siteUrl}</strong></p>
<p>Cloud ID: ${cloudId}</p>
<p><a href="/jira/issues">View issues</a></p>`
      );
    } catch (err) {
      next(err);
    }
  });

  app.get("/jira/issues", async (req, res, next) => {
    try {
      const body: Record<string, unknown> = {
        jql: `project=${config.JIRA_PROJECT_KEY} ORDER BY created DESC`,
        maxResults: 50,
        fields: ["summary", "status"],
      };

      const { nextPageToken } = req.query;
      if (typeof nextPageToken === "string") {
        body["nextPageToken"] = nextPageToken;
      }

      const data = await jira.post(
        "search/jql",
        body,
        JiraSearchResponseSchema
      );

      const response: Record<string, unknown> = {
        project: config.JIRA_PROJECT_KEY,
        issues: data.issues.map((issue) => ({
          key: issue.key,
          summary: issue.fields.summary,
          status: issue.fields.status.name,
        })),
      };
      if (data.nextPageToken) {
        response["nextPageToken"] = data.nextPageToken;
      }

      res.json(response);
    } catch (err) {
      if (err instanceof NotAuthorisedError) {
        res
          .status(401)
          .json({ error: err.message, authorizeUrl: "/oauth/start" });
        return;
      }
      next(err);
    }
  });

  const webhookUrl = config.WEBHOOK_BASE_URL
    ? `${config.WEBHOOK_BASE_URL.replace(/\/+$/, "")}/webhook/jira`
    : "";

  app.use(
    createWebhookRouter({
      clientSecret: config.JIRA_CLIENT_SECRET,
      issueSync,
    })
  );

  app.use(
    createWebhookAdminRouter({
      jira,
      issueSync,
      siteResolver,
      webhookUrl,
      projectKey: config.JIRA_PROJECT_KEY,
      siteUrl: config.JIRA_SITE_URL,
      useSecureStorage,
    })
  );

  app.use(
    (
      err: Error,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      console.error(`[ERROR] ${req.method} ${req.path}: ${err.message}`);
      if (err.stack) {
        console.error(err.stack);
      }
      if (err instanceof JiraApiError) {
        console.error(
          `Upstream Jira response (${err.status}): ${err.body}`
        );
      }

      const response: Record<string, unknown> = {
        error: err.message,
        path: req.path,
      };
      if (err instanceof JiraApiError) {
        response.upstream = {
          status: err.status,
          statusText: err.statusText,
          body: err.body,
        };
      }

      const status = err instanceof JiraApiError ? 502 : 500;
      res.status(status).json(response);
    }
  );

  app.listen(config.PORT, () => {
    console.log(`Listening on port ${config.PORT}`);
    console.log(`Token store: ${config.TOKEN_STORE}`);
    console.log(`Sites board: ${config.SITES_BOARD_ID}`);
    console.log(`Work Packages board: ${config.WORK_PACKAGES_BOARD_ID}`);
  });
}

main().catch((err) => {
  console.error(
    "Fatal startup error:",
    err instanceof Error ? err.message : err
  );
  process.exitCode = 1;
});
