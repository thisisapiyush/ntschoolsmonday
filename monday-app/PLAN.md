# monday-app Jira OAuth — implementation plan

## Overview

Replace the throwaway health-check Express server with a TypeScript app
implementing Jira Cloud OAuth 2.0 (3LO). The app runs locally via tsx and
deploys to monday code. It keeps the existing GET /health endpoint and adds
the OAuth flow plus a proof-of-life Jira issues endpoint.


## TypeScript conversion

Match the ingest/ setup: strict mode, no `any`, `noUncheckedIndexedAccess`,
tsx for execution, vitest for tests, zod for external response validation.
The existing `index.js` is deleted and replaced by `src/server.ts`.

monday code runs `node index.js`, so the package.json `main` stays as
`index.js` — a one-line loader that imports the compiled/tsx entrypoint.
During local dev, `tsx src/server.ts` runs directly.


## Module structure

```
monday-app/
  src/
    server.ts          Express app, routes, startup validation
    env.ts             Load and validate required env vars at startup
    oauth.ts           State generation, token exchange, refresh logic
    tokenStore.ts      Storage interface + file-backed implementation
    mondayStore.ts     monday code storage implementation
    jiraClient.ts      Authenticated Jira API calls, backoff
    types.ts           Shared types and Zod schemas
  tests/
    oauth.test.ts      State, expiry, refresh rotation, revocation
    tokenStore.test.ts File store read/write/clear
    jiraClient.test.ts Not-yet-authorised path
  .tokens.json         Local file store (gitignored)
```


## Environment variables

Required at startup (fail loudly if missing):

| Variable | Purpose |
|----------|---------|
| JIRA_CLIENT_ID | OAuth app client ID |
| JIRA_CLIENT_SECRET | OAuth app secret |
| JIRA_SITE_URL | For display only — API calls use cloudId |
| JIRA_PROJECT_KEY | Project to query in /jira/issues |
| JIRA_REDIRECT_URI | Callback URL registered in the Atlassian app |

Optional:

| Variable | Purpose |
|----------|---------|
| PORT | Listen port, defaults to 8080 |
| TOKEN_STORE | `"file"` (default) or `"monday"` — selects storage backend |


## Token storage abstraction

```typescript
interface TokenStore {
  load(): Promise<StoredTokens | null>;
  save(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;       // Unix ms
  cloudId: string;
  siteUrl: string;         // display only
}
```

Two implementations:

**FileTokenStore** — reads/writes `.tokens.json` in the app root.
Gitignored. Used for local development. Simple JSON file, no encryption
(local dev only, same machine).

**MondayTokenStore** — uses monday code's `Storage` API
(`monday.storage.instance`). Used when `TOKEN_STORE=monday`. Tokens are
stored as a single JSON blob under a known key. monday code's storage is
scoped to the app instance and not accessible to other apps.

Neither implementation logs token values.


## OAuth flow

### GET /oauth/start

1. Generate a 32-byte cryptographically random state value (`crypto.randomBytes`).
2. Store it in an in-memory Map with a 10-minute TTL (short-lived, CSRF only).
3. Redirect to `https://auth.atlassian.com/authorize` with:
   - `audience=api.atlassian.com`
   - `client_id` from env
   - `redirect_uri` from env
   - `scope=read:jira-work write:jira-work read:jira-user offline_access`
   - `state=<generated>`
   - `response_type=code`
   - `prompt=consent`

`offline_access` is required — without it Atlassian returns no refresh token.

### GET /oauth/callback

1. Verify `state` matches a stored value. Consume it (one-use). Reject
   mismatches with 400.
2. Exchange `code` at `https://auth.atlassian.com/oauth/token` (POST) for
   access token, refresh token, and expires_in.
3. Call `https://api.atlassian.com/oauth/token/accessible-resources` with
   the access token to get the cloudId. The first resource matching
   JIRA_SITE_URL is used. If no match, fail with a clear message.
4. Compute `expiresAt = Date.now() + (expires_in * 1000)`.
5. Persist via TokenStore.
6. Return a simple HTML confirmation page naming the connected site.


## Token refresh strategy

Access tokens are short-lived (typically 1 hour). The refresh logic:

1. Before any Jira API call, check if the token expires within 5 minutes.
2. If so, POST to `https://auth.atlassian.com/oauth/token` with
   `grant_type=refresh_token`.
3. Atlassian rotates refresh tokens — the response contains a new refresh
   token. **Persist the new refresh token immediately.** Failing to do this
   is the classic bug that breaks the integration hours after initial auth.
4. Update `expiresAt` and `accessToken` in the store.

Refresh failure handling:
- If the refresh returns 400/401 (revoked or expired grant), clear stored
  tokens and return a clear error that re-authorisation is needed via
  /oauth/start. This is an expected operational state, not a crash.
- Do not retry a failed refresh — a revoked grant will not un-revoke.
- Do not attempt a second refresh if one just succeeded but the API still
  returns 401 — treat the grant as revoked to avoid a retry loop.


## Jira API client

`jiraClient.ts` exposes a function that takes a path and returns JSON:

```typescript
async function jiraGet<T>(path: string, schema: ZodSchema<T>): Promise<T>
```

- Constructs the URL: `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/${path}`
- Attaches `Authorization: Bearer <accessToken>`
- Validates the response with the provided Zod schema
- On 429: reads `Retry-After` header, waits that long (or exponential
  backoff with jitter if the header is absent), up to 3 retries
- On 401 after a fresh token: treat as revoked, clear tokens, do not loop


## Endpoints

### GET /health
Unchanged: `{ status: "ok", timestamp: <ISO> }`

### GET /oauth/start
Redirects to Atlassian authorize URL.

### GET /oauth/callback
Exchanges code for tokens, persists, returns confirmation HTML.

### GET /jira/issues
If no stored tokens: return `{ error: "Not authorised", authorizeUrl: "/oauth/start" }` with 401.
Otherwise: fetch issues from JIRA_PROJECT_KEY, return:
```json
{
  "project": "PROJ",
  "issues": [
    { "key": "PROJ-1", "summary": "...", "status": "..." }
  ]
}
```


## Error handling

| Failure | Handling |
|---------|----------|
| Missing env var | Throw at startup with the variable name |
| State mismatch on callback | 400 with message, no token exchange |
| Token exchange fails | 500 with message (no secrets logged) |
| No accessible resource matches JIRA_SITE_URL | 500 with clear message |
| Refresh token revoked | Clear stored tokens, 401 with re-auth message |
| Jira 429 | Backoff with Retry-After, up to 3 retries |
| Jira 401 after fresh refresh | Grant revoked, clear tokens |
| Token store I/O failure | Throw — this is infrastructure, not a user error |


## Tests (vitest, no network)

| Test | Coverage |
|------|----------|
| State generation | Produces a hex string of expected length |
| State verification | Valid state accepted, consumed (not reusable), expired state rejected, wrong state rejected |
| Token expiry check | Token expiring in 6min → not expired; 4min → expired; past → expired |
| Refresh rotation | After mock refresh, new refresh token and new access token are persisted; old refresh token is gone |
| Refresh failure | On 400 from refresh endpoint, tokens are cleared |
| Not-yet-authorised | /jira/issues with no stored tokens returns 401 with authorizeUrl |
| FileTokenStore | save/load/clear round-trip |


## Decisions (resolved)

1. **State storage.** Not in-memory. monday code runs on auto-scaling
   containers, so /oauth/start and /oauth/callback can land on different
   instances. State goes behind the same storage abstraction as tokens:
   file-backed locally, monday code storage when deployed. Short TTL
   retained.

2. **Accessible resources matching.** Match on `url` with normalisation
   (strip trailing slash, lowercase, compare hostname). The `name` field
   is user-editable in Atlassian admin and would silently break the match
   if renamed. On mismatch, fail with a message naming the configured
   JIRA_SITE_URL and the sites actually returned.

3. **monday code Storage API.** Implement MondayTokenStore properly now.
   The point of Phase 3 was to hit platform friction early; a stub defers
   the same problem to deployment day. Keep it behind the env flag so
   local development doesn't require it.
