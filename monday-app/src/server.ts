import express from "express";
import { loadEnv } from "./env.js";
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

const env = loadEnv();

const tokenStore: TokenStore =
  env.TOKEN_STORE === "monday"
    ? new MondayTokenStore()
    : new FileTokenStore(join(appRoot, ".tokens.json"));

const stateStore: StateStore =
  env.TOKEN_STORE === "monday"
    ? new MondayStateStore()
    : new FileStateStore(join(appRoot, ".oauth-states.json"));

const jira = createJiraClient({
  clientId: env.JIRA_CLIENT_ID,
  clientSecret: env.JIRA_CLIENT_SECRET,
  tokenStore,
});

const app = express();

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/oauth/start", async (_req, res, next) => {
  try {
    const { url, state, expiresAt } = buildAuthorizeUrl({
      clientId: env.JIRA_CLIENT_ID,
      redirectUri: env.JIRA_REDIRECT_URI,
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
      clientId: env.JIRA_CLIENT_ID,
      clientSecret: env.JIRA_CLIENT_SECRET,
      redirectUri: env.JIRA_REDIRECT_URI,
      code,
    });

    const { cloudId, siteUrl } = await fetchCloudId(
      tokenResult.accessToken,
      env.JIRA_SITE_URL
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
      `project=${env.JIRA_PROJECT_KEY} ORDER BY created DESC`
    );
    const data = await jira.get(
      `search?jql=${jql}&maxResults=50&fields=summary,status`,
      JiraSearchResponseSchema
    );

    res.json({
      project: env.JIRA_PROJECT_KEY,
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

app.listen(env.PORT, () => {
  console.log(`Listening on port ${env.PORT}`);
  console.log(`Token store: ${env.TOKEN_STORE}`);
});

export { app };
