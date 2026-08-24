import express from "express";
import { loadConfig } from "./config.js";
import { FileTokenStore, FileStateStore } from "./tokenStore.js";
import { MondayTokenStore, MondayStateStore } from "./mondayStore.js";
import { buildAuthorizeUrl, exchangeCode, fetchCloudId } from "./oauth.js";
import { createJiraClient, NotAuthorisedError } from "./jiraClient.js";
import { JiraSearchResponseSchema } from "./types.js";
import type { TokenStore, StateStore } from "./types.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

  const app = express();

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

  app.get("/jira/issues", async (_req, res, next) => {
    try {
      const jql = encodeURIComponent(
        `project=${config.JIRA_PROJECT_KEY} ORDER BY created DESC`
      );
      const data = await jira.get(
        `search?jql=${jql}&maxResults=50&fields=summary,status`,
        JiraSearchResponseSchema
      );

      res.json({
        project: config.JIRA_PROJECT_KEY,
        issues: data.issues.map((issue) => ({
          key: issue.key,
          summary: issue.fields.summary,
          status: issue.fields.status.name,
        })),
      });
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

  app.listen(config.PORT, () => {
    console.log(`Listening on port ${config.PORT}`);
    console.log(`Token store: ${config.TOKEN_STORE}`);
  });
}

main().catch((err) => {
  console.error(
    "Fatal startup error:",
    err instanceof Error ? err.message : err
  );
  process.exitCode = 1;
});
