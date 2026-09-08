# Phase 6: monday to Jira status sync

When a Work Package's Status column changes on the monday board, the
integration transitions the corresponding Jira issue and records where
the change came from. This is the reverse of Phase 5 (Jira to monday)
and completes the bidirectional sync. The central challenge is loop
prevention: without it, a monday write triggers a Jira transition,
which fires a webhook, which writes to monday, which triggers another
transition, indefinitely.


## Trigger paths

Two trigger paths are implemented. The native monday webhook is the
active path. The workflow action block is the long-term path, retained
in code but not currently registrable in the monday workflow builder due
to a Developer Center limitation (see below).

Both paths share a single sync function (`statusSync.ts`) that reads
the item's columns, maps the monday status to a Jira status, checks
echo suppression, transitions the Jira issue, records the echo marker,
and posts an origin comment. Neither path duplicates this logic.


## Native monday webhook (active trigger)

### How it works

monday's GraphQL API supports native webhooks via the `create_webhook`
mutation. The webhook fires a POST to a configured URL whenever a column
value changes on a board. The integration registers a webhook for the
`change_specific_column_value` event, filtered to the Status column on
the Work Packages board.

### Authentication

monday native webhooks do not carry a signed authorization header
unless created with an integration app token (which requires a
marketplace-published integration feature). The webhook URL includes a
shared secret token as a path segment. The handler rejects requests
where the token does not match the configured `MONDAY_WEBHOOK_TOKEN`.

This is a URL-based secret, not a cryptographic signature. It prevents
unauthenticated callers but does not prove the request originated from
monday. The limitation is acceptable for an internal integration where
the URL is not publicly discoverable, but it is weaker than the JWT
verification used by the workflow action block. If monday adds signed
headers to API-created webhooks in future, the handler should be
upgraded to verify them.

### Challenge handshake

When the webhook is first created, monday sends a POST with a
`challenge` field to verify that the endpoint exists and is under the
caller's control. The handler echoes the challenge value back in the
response body:

Request: `{ "challenge": "<random-token>" }`
Response: `{ "challenge": "<random-token>" }`

### Endpoint

`POST /webhook/monday/<MONDAY_WEBHOOK_TOKEN>`

### Webhook payload

```json
{
  "event": {
    "userId": 123,
    "boardId": 5030564582,
    "pulseId": 1234567890,
    "pulseName": "Work Package Name",
    "columnId": "status_col",
    "columnType": "color",
    "columnTitle": "Status",
    "value": { "label": { "index": 1, "text": "In progress" } },
    "previousValue": null,
    "changedAt": 1693920000,
    "type": "update_column_value",
    "triggerUuid": "...",
    "subscriptionId": 456
  }
}
```

The handler uses only `event.pulseId` (the item ID) and
`event.columnId` (to confirm the change is on the status column). It
does not parse `event.value` or `event.previousValue`. As with the
action block, the handler reads the item's current column values from
the monday API, which is more reliable than parsing the trigger's value
serialisation.

### Column filter

The handler checks `event.columnId` against the board schema's
`statusColumnId`. Changes to other columns are ignored with a 200
response. This is defense-in-depth: the webhook is created with
`change_specific_column_value` and a columnId config, so monday should
only send status changes. The check protects against misconfiguration.

### Error handling and retries

If the Jira API fails with a transient error, the handler returns HTTP
500. monday retries webhook deliveries that return non-200 for up to 30
minutes, which provides automatic retry for temporary Jira outages.

Permanent failures (no Jira key, unmapped status, no matching
transition) return HTTP 200 because retrying would not help.

### Setup

1. Set a random secret as the `MONDAY_WEBHOOK_TOKEN` environment
   variable (or monday code secret):

   ```
   mapps code:secret -a 11859824 -s MONDAY_WEBHOOK_TOKEN <random-string>
   ```

2. Deploy the app so the endpoint is live.

3. Create the webhook via the monday API (use the API playground at
   `https://<account>.monday.com/apps/manage/tokens` or curl):

   ```graphql
   mutation {
     create_webhook(
       board_id: 5030564582,
       url: "https://<app-host>/webhook/monday/<MONDAY_WEBHOOK_TOKEN>",
       event: change_specific_column_value,
       config: "{\"columnId\":\"<status-column-id>\"}"
     ) {
       id
       board_id
     }
   }
   ```

   Replace `<app-host>` with the deployed app's hostname,
   `<MONDAY_WEBHOOK_TOKEN>` with the secret value, and
   `<status-column-id>` with the Work Packages board's status column
   ID (visible in the board schema load logs at startup, or via the
   monday API).

4. monday will send a challenge POST to the URL. The handler echoes it
   back. If the mutation succeeds, the webhook is active.


## Workflow action block (retained, not currently registrable)

The workflow action block is implemented and tested but cannot be
registered in the monday workflow builder. The Developer Center requires
an input field type to bind to a built-in trigger's output, but the
available types (`string`, `number`, `boolean`, `date`, `object`,
`credentials`) do not include the item-definition type that the
builder's trigger-output picker expects for the "When status changes"
trigger. The "Item Definition" type visible in the Developer Center
dropdown is a deprecated sentence-builder concept that is not recognised
by the workflows infrastructure.

The block code is retained because it is the correct long-term approach:
workflow blocks carry JWT authentication, integrate with monday's
automation history, and support the visual builder's error reporting. If
monday updates the Developer Center to support trigger-output binding
for primitive field types, the block can be activated by configuring the
input field as type `number`, key `itemId`, source "Trigger Output".

### Why a workflow block, not a legacy integration

monday.com has two automation systems. The older "Integrations" system
uses sentence-builder recipes and an `authorization_url` flow. The
newer "Workflows" system uses composable trigger and action blocks that
users assemble in a visual builder. This phase uses the workflows
infrastructure because it is the current platform, the older system is
deprecated, and the block model gives users more flexibility in how
they wire triggers to actions.

### Block architecture

The integration provides a custom action block. The trigger is a
built-in monday trigger ("When column changes", scoped to the Status
column on the Work Packages board). The user assembles these in the
monday workflow builder:

    Trigger: "When Status changes"  -->  Action: "Sync status to Jira"

The action block is configured in the monday Developer Center under the
app's Features tab as a new Workflow Block of kind "action". The block
defines a single input field:

| Setting | Value |
|---------|-------|
| Field type | `number` |
| Field key | `itemId` |
| Field source | Trigger Output |

The built-in "When column changes" trigger (and its "When status changes
to anything" variant) outputs `itemId`, `userId`, and `groupId`. The
action only needs `itemId`. The field type must be a workflows primitive
(`string`, `number`, `boolean`, `date`) or `object`. "Item Definition"
is a deprecated sentence-builder concept and is not recognised by the
workflows infrastructure, which is why a block configured with that type
does not appear in the workflow builder when the source is Trigger
Output.

The handler does not use `boardId` from the payload (it is passed at
startup), and it reads the item's columns from the monday API rather
than depending on trigger-supplied column values.

### Run URL

The action block's run URL is `POST /workflow/action/sync-status`. This
is a new route on the existing Express server, kept separate from the
Jira webhook routes for clarity.

### Payload shape

When the workflow fires, monday sends a POST to the run URL with this
shape:

```json
{
  "payload": {
    "inputFields": {
      "itemId": 1234567890
    },
    "inboundFieldValues": {
      "itemId": 1234567890
    }
  },
  "runtimeMetadata": {
    "actionUuid": "...",
    "triggerUuid": "..."
  }
}
```

The `inputFields` and `inboundFieldValues` carry the same data. The
field key `itemId` matches the built-in trigger's output field. The
handler reads the item's current column values from the monday API to
get both the Jira key and the current Status label, rather than
depending on trigger-supplied column values (which the built-in triggers
do not provide in the new workflows format).

### JWT verification

Monday signs inbound requests to app endpoints with a JWT in the
`Authorization` header. For workflow blocks, the JWT is signed with the
app's **Signing Secret** (not the Client Secret, and not the API token).
The Signing Secret is a separate credential found in the monday
Developer Center under the app's Basic Information section.

The JWT claims include:

| Claim | Purpose |
|-------|---------|
| `accountId` | monday account ID |
| `userId` | ID of the user whose workflow fired |
| `aud` | The app endpoint URL |
| `exp` | Expiration timestamp |
| `shortLivedToken` | A 5-minute token for monday API calls |
| `iat` | Issued-at timestamp |

Verification uses `jose` (already a dependency from Phase 5) to check
the signature with the Signing Secret. The algorithm is not explicitly
documented but community consensus and monday's own examples use HS256.
The handler accepts HS256, HS384, and HS512, consistent with the Jira
JWT verification in Phase 5.

The `shortLivedToken` in the claims could be used for monday API calls
scoped to the triggering user's permissions. For simplicity and
consistency, the handler uses the existing `MONDAY_API_TOKEN` instead,
since the monday client is already initialised with it at startup.

A new secret, `MONDAY_SIGNING_SECRET`, must be added to the config and
set via `mapps code:secret`.

### Response contract

The action block returns HTTP 200 with a JSON body on success:

```json
{ "message": "Transition complete" }
```

On transient failure, the handler returns a monday error response with
severity code 4000, which logs the failure in the workflow's activity
history and notifies the automation creator:

```json
{
  "severityCode": 4000,
  "notificationErrorTitle": "Jira transition failed",
  "notificationErrorDescription": "Could not transition NTSR-42: ...",
  "runtimeErrorDescription": "Jira API returned 500"
}
```

On permanent failure (no Jira key on the item, unmapped status), the
handler returns 200 because retrying would not help. It logs the
reason and, where possible, surfaces it on the monday item as an update.

If no transition to the target status is available from the issue's
current Jira state, that is a workflow constraint, not an error. The
handler returns 200, logs the constraint, and posts an update on the
monday item explaining which transition was attempted and what
transitions are available. This makes the constraint visible to program
managers without failing the workflow.


## Transition lookup

Jira does not accept a status name on issue update. The workflow for
changing an issue's status is:

1. **GET** `/rest/api/3/issue/{issueKey}/transitions` to list the
   transitions available from the issue's current state.
2. Find the transition whose `to.name` matches the target Jira status.
3. **POST** `/rest/api/3/issue/{issueKey}/transitions` with the
   matching transition's `id`.

The GET response shape:

```json
{
  "transitions": [
    {
      "id": "21",
      "name": "Start Progress",
      "to": {
        "name": "In Progress",
        "id": "3"
      }
    }
  ]
}
```

The match is on `to.name` (the target status name), not `name` (the
transition name, which is often different). The comparison is
case-sensitive because Jira status names are controlled values, not
free text.

The POST body:

```json
{
  "transition": { "id": "21" }
}
```

The POST returns 204 No Content on success. The existing `jiraClient.ts`
assumes every response has a JSON body, so a new method or a
void-response path is needed. The cleanest approach is to add a
`postNoContent` method to the Jira client that returns `void` instead of
parsing the response body.

### Jira comment

After a successful transition, the handler posts a comment on the Jira
issue recording that the change originated in monday. The comment uses
Atlassian Document Format (ADF), which the v3 REST API requires:

```json
{
  "body": {
    "type": "doc",
    "version": 1,
    "content": [
      {
        "type": "paragraph",
        "content": [
          {
            "type": "text",
            "text": "Status changed from Backlog to In progress in monday.com"
          }
        ]
      }
    ]
  }
}
```

The comment names the previous monday status (from the trigger or from
the echo marker context) and the new monday status, so the Jira history
shows the monday-side labels, not just the Jira transition name. The
comment is informational. If the comment POST fails, the handler logs
the failure but does not fail the action, because the transition itself
already succeeded.

The `write:jira-work` scope (already granted) covers both transition
POSTs and comment creation.


## Status mapping

The monday-to-Jira mapping extends `statusMap.ts`. It is deliberately
not symmetric with the Jira-to-monday mapping:

| monday status | Jira status |
|---------------|-------------|
| Backlog | To Do |
| Scheduled | To Do |
| In progress | In Progress |
| On hold | To Do |
| Done | Done |

Three monday statuses (Backlog, Scheduled, On hold) collapse to a
single Jira status (To Do). This mapping is lossy in the monday-to-Jira
direction. A round trip starting from monday preserves the Jira status
but not necessarily the monday status: if a user sets "Scheduled" in
monday, Jira transitions to "To Do", and the return webhook maps "To Do"
back to "Backlog", not "Scheduled". The echo suppression (see below)
prevents this overwrite by suppressing the return echo entirely, so the
monday item stays at "Scheduled" and Jira shows "To Do".

### Making it lossless

The mapping is lossy because Jira's default workflow has no equivalents
for "Scheduled" and "On hold". A client who needs lossless round-trip
sync would need to:

1. Add "Scheduled" and "On hold" statuses to their Jira workflow scheme.
2. Create transitions to and from these statuses.
3. Extend `JIRA_TO_MONDAY` to map "Scheduled" to "Scheduled" and
   "On hold" to "On hold".
4. Extend `MONDAY_TO_JIRA` to map "Scheduled" to "Scheduled" and
   "On hold" to "On hold".

Without these Jira workflow changes, the three-to-one collapse is
unavoidable. The current design handles it safely through echo
suppression rather than trying to prevent the mismatch.

### Unmapped statuses

If a monday status has no Jira mapping (for example, a custom status
added to the board after deployment), the handler logs a warning and
returns 200 without transitioning. It does not surface an error on the
monday item because a missing mapping is a configuration gap, not a user
mistake.


## Echo suppression

### The loop

Without suppression, a bidirectional sync creates an infinite loop:

1. User changes Status in monday.
2. Action block transitions Jira issue.
3. Jira fires a webhook (Phase 5 handler).
4. Phase 5 writes the mapped status back to monday.
5. Monday fires the workflow trigger again.
6. Go to step 2.

The loop must be broken without losing genuine changes made by users
on either side.

### Two-layer defence

**Layer 1: identity mapping.** The existing Jira key to monday item ID
mapping in SecureStorage (from Phase 5) establishes which entities are
linked. This is not a suppression mechanism on its own, but it is the
foundation that both directions use to look up the counterpart entity.

**Layer 2: echo markers.** When either direction writes a status change,
it records a short-lived marker in SecureStorage. Before writing, each
direction checks for a recent marker matching the same entity and value.
If found, the write is an echo of the integration's own prior write and
is suppressed.

### Marker key format

Markers are keyed on the Jira issue key and the Jira status name:

    echo:{jiraKey}:status:{jiraStatusName}

The Jira status is the canonical value because the mapping is
many-to-one in the monday-to-Jira direction. Using the monday status as
the key would fail to match when different monday statuses map to the
same Jira status (e.g. "Scheduled" and "Backlog" both map to "To Do",
so a marker keyed on "Scheduled" would not match the returning echo
keyed on "Backlog"). Using the Jira status sidesteps this: both sides
resolve to the same Jira status before checking or recording.

### Storage

Markers are stored in SecureStorage under the key `echo_markers` as a
JSON object mapping marker keys to Unix timestamps:

```json
{
  "NTSR-42:status:In Progress": 1693920000000,
  "NTSR-14:status:To Do": 1693920060000
}
```

Entries older than the suppression window are pruned on each read, the
same pattern used by the Phase 5 dedup store. SecureStorage is the
mechanism because monday code auto-scales across containers that would
not share in-memory state.

### Suppression window

The default window is **60 seconds**, configurable via the
`ECHO_WINDOW_MS` environment variable (or monday code secret).

The trade-off:

**Too short (under 30 seconds).** The round trip from monday write to
Jira transition to webhook delivery to Phase 5 processing typically
takes 5 to 15 seconds, but Jira webhook delivery can be delayed by up
to 30 seconds under load. A window shorter than the worst-case round
trip allows the echo to arrive after the marker has expired, restarting
the loop.

**Too long (over 120 seconds).** A genuine user change made within the
window is indistinguishable from an echo and is suppressed. The user
would have to wait over two minutes after an integration-originated
change before their manual change is processed. This is disruptive for
a user actively managing work packages.

**60 seconds** is a pragmatic middle ground. It covers the typical round
trip with margin, and the suppression gap (the period where a genuine
change would be dropped) is short enough that it is unlikely to
conflict with normal usage patterns. If a deployment experiences slower
Jira webhook delivery, the window can be increased without code changes.

### Trace through the loop

**Monday-originated change (happy path):**

1. User sets monday status to "In progress".
2. Action block maps to Jira "In Progress".
3. Checks echo marker `NTSR-42:status:In Progress`: not found.
4. Transitions Jira to "In Progress".
5. Records marker `NTSR-42:status:In Progress` with current timestamp.
6. Jira webhook fires: status "In Progress".
7. Phase 5 maps to monday "In progress".
8. Checks echo marker `NTSR-42:status:In Progress`: found, within window.
9. Skips monday write. Loop stopped.

**Jira-originated change (happy path):**

1. User transitions Jira to "Done".
2. Webhook fires, Phase 5 maps to monday "Done".
3. Checks echo marker `NTSR-42:status:Done`: not found.
4. Writes monday status "Done".
5. Records marker `NTSR-42:status:Done`.
6. Monday workflow fires: status changed to "Done".
7. Action block maps to Jira "Done".
8. Checks echo marker `NTSR-42:status:Done`: found, within window.
9. Skips Jira transition. Loop stopped.

**Lossy mapping (On hold to To Do):**

1. User sets monday status to "On hold".
2. Action block maps to Jira "To Do".
3. Checks echo marker `NTSR-42:status:To Do`: not found.
4. Transitions Jira to "To Do".
5. Records marker `NTSR-42:status:To Do`.
6. Webhook fires: status "To Do".
7. Phase 5 maps "To Do" to monday "Backlog".
8. Checks echo marker `NTSR-42:status:To Do`: found, within window.
9. Skips monday write. Monday stays at "On hold", Jira shows "To Do".

The user's intent ("On hold") is preserved on the monday side. Jira
shows the closest available equivalent.

**Genuine change after window expiry:**

1. Integration sets status (marker recorded).
2. 90 seconds later, user changes status again.
3. Echo marker has expired (> 60 seconds).
4. Change is processed normally. Not suppressed.


## Integration into existing modules

### issueSync.ts (Phase 5 modification)

The Phase 5 `processEvent` function gains an echo check before writing
to monday. Before calling `writer.updateItem` or `writer.createItem`
with a `mondayStatus`, the handler resolves the Jira status from the
webhook payload, checks the echo store, and skips the status write if a
matching marker is found within the window.

After writing a status to monday, `processEvent` records a marker for
the Jira status that the monday status was mapped from. This lets the
action block suppress the resulting workflow trigger.

### statusMap.ts (extended)

The `MONDAY_TO_JIRA` map gains two new entries:

```typescript
["Scheduled", "To Do"],
["On hold", "To Do"],
```

### jiraClient.ts (extended)

A `postNoContent` method is added for endpoints that return 204 with no
body, specifically the transition POST. The existing `post` method
tries to parse JSON from every response, which throws on 204.

### config.ts (extended)

A new required key `MONDAY_SIGNING_SECRET` is added for JWT
verification of inbound workflow block requests. An optional key
`MONDAY_WEBHOOK_TOKEN` is added for the native webhook endpoint (the
endpoint is disabled if this is not set). An optional key
`ECHO_WINDOW_MS` is added with a default of `60000`.


## New modules

| Module | Responsibility |
|--------|---------------|
| `statusSync.ts` | Shared sync logic: read item columns, map status, check echo, transition Jira, record echo, post comment. Used by both `workflowAction.ts` and `mondayWebhook.ts`. |
| `mondayWebhook.ts` | Express router for `POST /webhook/monday/:token`. Challenge handshake, token verification, column filter, delegates to `statusSync.ts`. |
| `workflowAction.ts` | Express router for `POST /workflow/action/sync-status`. JWT verification, payload parsing, delegates to `statusSync.ts`. |
| `echoSuppression.ts` | Echo marker store (SecureStorage). Read, write, prune. Shared by both sync directions. |
| `jiraTransition.ts` | Fetch available transitions, match by target status name, POST the transition. Add origin comment. |


## Correlation IDs

The monday workflow payload includes `runtimeMetadata.actionUuid` which
serves as a correlation ID for the monday-originated leg of the sync.
This ID is logged alongside the Jira key on every log line during
processing, the same structured logging pattern used in Phase 5.

When the action block writes to Jira (transition + comment), it does
not have a way to inject a correlation ID into the Jira webhook that
fires in response. The Jira webhook will arrive at the Phase 5 handler
with its own `X-Atlassian-Webhook-Identifier`. The two legs are linked
through the echo marker: the action block logs its correlation ID when
writing the marker, and Phase 5 logs its own correlation ID when
reading the marker and suppressing the echo. Searching logs for the
Jira key joins the two legs.


## Error surfacing

Failures are surfaced on the monday item as an update (comment), not
only in logs. This follows the Phase 5 pattern where program managers
see sync failures without log access.

| Failure | Handling |
|---------|----------|
| JWT verification fails | 401, no processing. |
| Item has no Jira key | 200, logged. No update posted (not a failure). |
| Unmapped monday status | 200, logged at warn. |
| Jira transition not available | 200, update posted on monday item naming the constraint. |
| Jira API error (transient) | Error response with severity 4000 for monday retry. |
| Echo marker store failure | Logged, processing continues without suppression (fail open on the marker, not on the sync). |


## Tests

| Test | What it covers |
|------|----------------|
| Status mapping (extended) | New entries: Scheduled to To Do, On hold to To Do. |
| JWT verification | Signing Secret verification, same pattern as Phase 5 Jira JWT tests. |
| Transition matching | Matches `to.name`, returns null when no matching transition available. |
| No Jira key | Item without a Jira key column value logs and no-ops. |
| Echo suppression: monday to Jira to monday | Simulate: action writes marker, Phase 5 receives echo, checks marker, skips. Prove the second pass is suppressed. |
| Echo suppression: Jira to monday to Jira | Simulate: Phase 5 writes marker, action fires, checks marker, skips. Prove the second pass is suppressed. |
| Echo suppression: window expiry | Set marker, advance clock past window, verify event is NOT suppressed. |
| Echo suppression: different status not suppressed | Marker for "In Progress", event for "Done", verify not suppressed. |
| Workflow constraint surfacing | Transition not available, verify update posted to monday item. |


## Decisions (resolved)

1. **Built-in trigger.** Use the built-in "When column changes" trigger
   rather than a custom trigger block. Fewer moving parts, and it is
   what a user would reach for in the workflow builder. The trigger
   outputs `itemId`, `userId`, and `groupId`. The action block declares
   a single input field of type `number`, key `itemId`, source "Trigger
   Output". The handler reads `inputFields.itemId` and converts to
   string for the GraphQL query.

2. **Previous column value.** The handler does not depend on the
   previous value from the trigger payload. It reads the current item
   state from the monday API. If `previousColumnValue` happens to be
   in the payload, the handler uses it for the Jira comment text only
   ("Status changed from X to Y"). If absent, the comment omits the
   "from" status. Nothing functional depends on it.

3. **App feature registration.** The action block is registered in the
   monday Developer Center as a new Workflow Block feature on app
   11859824. Steps:
   - Developer Center, select the app, Features tab.
   - Add Feature, select "Workflow Block", kind "Action".
   - Name: "Sync status to Jira".
   - Run URL: `https://<app-host>/workflow/action/sync-status`.
   - Add one input field: type `number`, key `itemId`, source
     "Trigger Output".
   - Save and create a new app version.
   - In the workflow builder, pair with the built-in "When status
     changes to anything" trigger.

4. **Signing Secret.** The monday Signing Secret is in the Developer
   Center under the app's Basic Information section. It is stored as a
   monday code secret with the key `MONDAY_SIGNING_SECRET`:
   `mapps code:secret -a 11859824 -s MONDAY_SIGNING_SECRET <value>`.

5. **Jira 204 handling.** A `postNoContent` method was added to the
   Jira client. The existing `request` function was refactored to an
   `executeRequest` helper that returns the raw `Response`. The
   `postNoContent` method calls `executeRequest` and discards the
   response body, treating any 2xx as success. The existing `get` and
   `post` methods continue to parse JSON via `executeRequest` followed
   by `response.json()`.

6. **Echo suppression logging.** Every suppression is logged at info
   level with the correlation ID, the full marker key
   (`{jiraKey}:status:{value}`), and a note that the event was within
   the window. Both the monday-to-Jira and Jira-to-monday directions
   log identically, so searching for a Jira key in the logs shows the
   complete chain: which direction wrote the marker and which direction
   suppressed the echo.


## Token persistence diagnostics

monday code auto-scales across container instances. Tokens stored via
the SDK's `SecureStorage` are persisted in a Vault-backed store keyed by
the app's GCP project ID (not by app version or container instance). The
SDK selects the remote `SecureStorage` implementation when `K_SERVICE`
is set, which it always is on monday code. Locally, the SDK falls back
to a SQLite-backed `LocalSecureStorage`.

If `TOKEN_STORE` is set to `"file"` (or defaults to it because the
`K_SERVICE` variable is missing), tokens are written to the local
filesystem, which does not survive container restarts or cross-container
requests. This is the most common cause of "Not authorised" after a
successful OAuth callback.

### Diagnostic endpoint

`GET /debug/token-status` returns a JSON object reporting the token
store state without exposing credentials:

```json
{
  "storeConfig": "monday",
  "storeImpl": "MondayTokenStore",
  "isMondayCode": true,
  "kService": "your-service-name",
  "hasToken": true,
  "cloudId": "abc123",
  "siteUrl": "https://your-site.atlassian.net",
  "expiresAt": "2026-09-09T08:00:00.000Z",
  "isExpired": false,
  "expiresInMinutes": 42
}
```

If `hasToken` is `false` immediately after a successful OAuth callback,
the vault write did not persist. Check the startup logs for the
`[MondayTokenStore] VERIFY FAILED` message, which indicates that the
immediate read-back after `set()` returned null.

### Startup logging

The server logs these values at startup:

- `K_SERVICE` environment variable (present on monday code, absent locally)
- `isMondayCode` flag derived from `K_SERVICE`
- `TOKEN_STORE` config value (`"monday"` or `"file"`)
- Token store constructor name (`MondayTokenStore` or `FileTokenStore`)

If `TOKEN_STORE` says `"monday"` but the constructor is `FileTokenStore`,
there is a code path mismatch. If `K_SERVICE` is unset but you expected
monday code, the container environment is misconfigured.

### Verify-after-save

The OAuth callback and `MondayTokenStore.save()` both verify the save
by immediately reading the token back from the store. If the read-back
returns null, the Connected page shows "Token persisted: NO, see server
logs" and the server logs the `VERIFY FAILED` message. This makes a
vault persistence failure visible at the moment it happens, rather than
on the next unrelated request.


## Operational constraints (observed)

These constraints surfaced through repeated deployment and testing on
the monday code platform. They are not documented in monday's developer
guides and are only discoverable by deploying repeatedly and watching
what breaks.

### SecureStorage does not survive a deployment

monday code's SecureStorage is cleared when a new version of the app is
deployed. An OAuth grant established before a code push is gone after
it, and every route then reports `no_token`. This was confirmed by
observing `hasToken: true` on the `/debug/token-status` endpoint before
a deploy and `hasToken: false` immediately after, with nothing else
changed.

For this integration, the consequence is that the Jira OAuth grant must
be re-established after every release. The operator visits `/oauth/start`,
completes the Atlassian consent flow, and confirms `hasToken: true` on
the diagnostic endpoint before the integration is operational.

For a production integration this means either a persistence layer
outside the platform's ephemeral storage (an external database, or the
alternative hosting model described in `docs/hardening.md`), or an
operator runbook step to re-establish the grant after every release.

### Deployment URL changes on version bump

The monday code deployment URL includes the app version. When a new
version is created and promoted, the URL changes. Every external system
holding a callback or webhook URL must be updated on a version bump.

In this integration, two external URLs are affected:

1. The Atlassian OAuth callback URL (`JIRA_REDIRECT_URI`). After a
   version bump, the redirect URI configured in the Atlassian developer
   console no longer matches the deployed endpoint. The operator must
   update it in both places: the Atlassian app's OAuth settings and the
   monday code secret `JIRA_REDIRECT_URI`.

2. The registered Jira webhook URL. The webhook was created pointing at
   the previous deployment URL. After a version bump, Jira delivers
   events to the old URL, which no longer exists. The operator must
   delete the old webhook and register a new one via
   `POST /admin/webhook/register`.

A stable custom domain (CNAME) in front of the deployment would remove
this class of problem entirely. monday code does not provide this
natively, but a reverse proxy or API gateway in front of the app would
serve the same purpose.

### Workflow action block not registrable

The custom workflow action block (`workflowAction.ts`) is implemented,
tested, and correctly configured with input field type `number`, key
`itemId`, source "Trigger Output". It does not appear in monday's
workflow builder when paired with the built-in "When status changes"
trigger, due to a Developer Center limitation in how trigger outputs
bind to action inputs.

The monday-to-Jira direction is triggered by a native monday webhook
calling the same shared handler instead. The block code is retained
because it is the correct long-term approach: workflow blocks carry JWT
authentication, integrate with monday's automation history, and support
the visual builder's error reporting. If monday resolves the binding
limitation, the block can be activated without code changes.
