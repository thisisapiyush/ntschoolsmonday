# Phase 5: Jira to monday sync

Jira issues created or updated in the NTSR project create or update
corresponding Work Package items on the monday Work Packages board. The
trigger is a Jira webhook registered programmatically via the REST API.


## Webhook registration

Jira Cloud exposes a webhook REST API at `/rest/api/3/webhook` for OAuth
2.0 and Connect apps. Registration is a POST with a shared callback URL
and an array of webhook subscriptions, each carrying an event list and an
optional JQL filter.

```json
{
  "url": "https://<app-host>/webhook/jira",
  "webhooks": [
    {
      "events": ["jira:issue_created", "jira:issue_updated"],
      "jqlFilter": "project = NTSR"
    }
  ]
}
```

The response returns a `webhookRegistrationResult` array, each entry
containing a `createdWebhookId` (numeric). This ID is persisted so
the app can list, delete, and extend its registrations later.

The `url` field is a single URL shared by all webhooks in the request.
Jira delivers all matched events to this one endpoint. The
`jqlFilter` scopes delivery to the NTSR project so the app does not
receive events for unrelated projects.

### OAuth scope

The webhook REST API requires the `manage:jira-webhook` scope in
addition to the existing `read:jira-work` and `write:jira-work` scopes.
This scope must be added to the OAuth consent URL in `oauth.ts`. Existing
grants will need to be reauthorised after the scope change.

### Admin endpoints

Registration is a deliberate operator action, not something that fires at
startup. Three admin endpoints expose webhook lifecycle operations:

- **POST /admin/webhook/register** registers the webhook using the
  current OAuth token. It stores the returned webhook ID in
  SecureStorage so the app knows what it owns. If a webhook is already
  registered, it returns the existing registration rather than creating
  a duplicate.

- **GET /admin/webhook/status** returns the current registration state:
  whether a webhook ID is stored, and if so, queries Jira's
  `GET /rest/api/3/webhook` to confirm it is still active and report
  its expiry date.

- **POST /admin/webhook/refresh** calls `PUT /rest/api/3/webhook` with
  the stored webhook ID to extend the expiry by another 30 days.

### 30-day expiry

Webhooks registered via the REST API expire after 30 days. The extend
endpoint (PUT) resets the clock. The status endpoint reports the expiry
date so an operator can see when a refresh is needed.

For the demo this is a manual operation. A production deployment would
run the refresh on a schedule (monday code's built-in cron). The status
endpoint returns days until expiry so monitoring can alert before it
lapses.

### Registration limits

OAuth 2.0 apps are limited to 5 webhooks per app per user per tenant.
This integration needs one webhook (two events in a single subscription),
well within the limit.


## Webhook verification

Jira secures webhooks for OAuth 2.0 apps with bearer authentication. Each
delivery includes an `Authorization: Bearer <token>` header where the
token is a JWT signed with the app's client secret.

Verification on the inbound handler:

1. Extract the bearer token from the `Authorization` header.
2. Verify the JWT signature using `JIRA_CLIENT_SECRET` as the key. Use a
   standard JWT library (jose) rather than hand-rolling verification.
3. Reject requests where the token is missing, malformed, or fails
   signature verification. Return 401 with no further processing.
4. Check standard JWT claims: reject expired tokens (`exp`), validate
   the issuer (`iss`) if Atlassian populates it.

Verification is not optional. Without it, any party who discovers the
webhook URL can inject fabricated events that create or modify Work
Packages on the monday board. The client secret is already available in
the app's config.

The Atlassian documentation does not specify the signing algorithm
explicitly, so the implementation should accept the algorithm declared in
the JWT header and verify against the client secret. If verification
fails in practice, the status endpoint and logs will surface the
mismatch.


## Inbound webhook processing

### Respond fast, process asynchronously

Jira redelivers webhooks when the handler responds slowly or times out.
The handler must return 200 immediately and process the event
asynchronously. In practice this means the Express route acknowledges the
request, then hands the payload to an async processing function that runs
outside the request lifecycle.

If the async processing fails, the failure is logged and surfaced on the
monday item (see error handling below). The 200 has already been sent, so
Jira does not redeliver, which is correct: the event was received, and
retrying the same payload would hit the same failure.

### Correlation ID

Every Jira webhook delivery includes the `X-Atlassian-Webhook-Identifier`
header, which is unique per tenant and stable across retries of the same
event. This value is used as the correlation ID for all logging within
that event's processing. Every log line emitted during processing
includes it, so a single event can be traced from receipt through site
resolution, mapping lookup, and monday write.

### Idempotency

Jira delivers at least once and will redeliver on timeout. The
`X-Atlassian-Webhook-Identifier` is the deduplication key. Before
processing, the handler checks whether this identifier has already been
processed by looking it up in a short-lived set (stored in SecureStorage
with a TTL, or an in-memory LRU cache with a size bound).

If the identifier is already present, the handler returns 200 and skips
processing. If not, the identifier is recorded before processing begins.

The handlers are also safe to run twice even without the deduplication
check. Creating a Work Package is keyed on the Jira issue key in the
mapping store: if the key already maps to an item, the handler updates
rather than creates. This is the same idempotency principle the ingest
uses for school codes.


## Site resolution

### Summary parsing

Issue summaries follow the pattern `<work description> - <school name>`,
for example "Install satellite link - Maningrida College". The school
name is extracted by splitting on ` - ` (space-hyphen-space) and taking
the last segment. The last segment is used rather than the first because
work descriptions are more likely to contain hyphens than school names.

This is a deliberate compromise. The robust approach is a Jira custom
field carrying the itSchoolCode, which provides a stable, unambiguous
join key. That approach requires Jira admin configuration to create the
custom field and project-level configuration to make it visible on issue
screens. A delivery team may not grant either, and requiring it before
the integration works at all would block adoption. Summary parsing works
with no Jira configuration changes.

The trade-off is fragility: if an issue summary does not follow the
convention, or if a school name is misspelled, the match fails. The
design handles this gracefully (see below) rather than preventing it.

### Sites board cache

At startup, the handler loads all items from the Sites board
(ID 5030539700) and builds a `Map<string, string>` from normalised
school name to monday item ID. Normalisation lowercases and trims
whitespace so that "Maningrida College" and "maningrida college" both
match.

The cache is refreshed on miss: if a parsed school name is not found in
the map, the handler reloads the Sites board and tries again before
giving up. This handles the case where a school was added to the board
after the app started. The refresh is rate-limited to at most once per
minute to avoid hammering the monday API on a burst of unresolvable
events.

### Failure handling

When the school name cannot be resolved (no match after a cache refresh,
or the summary does not contain ` - `), the Work Package is created
without a Site link. The item is still created because the Jira data
(key, status, summary) is valuable on the board even without a site
association.

The reason for the failed link is recorded in two places:

1. A log line at warn level with the correlation ID, the full summary,
   and the parsed (or unparsed) school name.
2. On the monday item itself, so it is visible to program managers
   without log access. The mechanism for this is an update (comment) on
   the item noting the unresolved site and the original summary.

If the summary contains ` - ` but the school name matches more than one
Sites item (ambiguous match), the same unlinked-with-reason behaviour
applies. Ambiguous matches are unlikely given that school names in the NT
system are unique, but the handler does not assume uniqueness.


## Jira key to monday item mapping

The mapping from Jira issue key (e.g. "NTSR-42") to monday Work Package
item ID is persisted in SecureStorage under a known key prefix. This is
the same store used for OAuth tokens and CSRF state, chosen for
consistency and because it is Vault-backed on monday code.

The mapping is stored as a single JSON object keyed by Jira issue key.
On each webhook, the handler looks up the issue key:

- **Key not found:** this is a new issue. Create a Work Package item,
  then persist the mapping.
- **Key found:** this is an update. Retrieve the monday item ID and
  update the existing item.

The mapping is authoritative. If a mapping exists, the handler updates
rather than creates, even if the webhook event type is
`jira:issue_created`. This handles the redelivery case where a create
event is delivered twice.


## Create or update flow

### Column value resolution

The Work Packages board (ID 5030564582) has status columns whose label
indexes must be resolved at runtime, following the same pattern as the
ingest's `schema.ts`. At startup, the handler queries the board schema
and builds label-to-index maps for the Status column.

Column IDs are read from the board schema by column title, not
hardcoded. The relevant columns:

| Column | Type | Written by this handler |
|--------|------|------------------------|
| (item name) | name | Yes, from issue summary |
| Site | board_relation | Yes, from site resolution |
| Status | status | Yes, mapped from Jira status |
| Jira key | text | Yes |
| Jira link | link | Yes |
| Last synced | date | Yes |
| Timeline | timeline | No (set by program managers) |

### On issue created

1. Parse the school name from the summary.
2. Resolve the site: look up the normalised name in the cache.
3. Create a monday item on Work Packages with:
   - Name: the full issue summary
   - Site: connected to the resolved Sites item (omitted if unresolved)
   - Status: mapped from the Jira issue status
   - Jira key: the issue key (e.g. "NTSR-42")
   - Jira link: `https://<siteUrl>/browse/<issueKey>`
   - Last synced: current date
4. Persist the Jira key to monday item ID mapping.
5. If site resolution failed, add an update to the item explaining why.

### On issue updated

1. Look up the monday item ID from the mapping store.
2. If not mapped (edge case: update arrived before create, or create
   was missed), treat it as a create.
3. Update the item:
   - Name: updated if the summary changed
   - Status: remapped from the current Jira status
   - Last synced: current date
4. Site link is not re-resolved on update. If the original create was
   unlinked, the link stays unlinked until an operator corrects it
   manually or the school name is fixed in the Jira summary and a
   future update triggers re-resolution.

Re-resolution on update is deferred. It adds complexity (diff the old
and new summary, re-resolve only if the school-name segment changed)
for a case that should be rare and is better handled by fixing the
summary in Jira.


## Status mapping

The Jira to monday status mapping is defined in a single module so it
can be referenced in both directions (Phase 6 uses the reverse).

| Jira status | monday status |
|-------------|---------------|
| To Do | Backlog |
| In Progress | In progress |
| In Review | In progress |
| Done | Done |

The mapping is not symmetric. "In Progress" and "In Review" both map to
"In progress" on the monday side. In the reverse direction (Phase 6),
"In progress" in monday maps back to "In Progress" in Jira, not "In
Review". Information is lost in the round trip. This is acceptable
because "In Review" is a Jira workflow distinction that the PMO view in
monday does not need, and inventing a monday status for it would add
board complexity for no audience.

Unmapped Jira statuses (any value not in the table) are logged at warn
level and the monday Status column is left unchanged. This prevents a
new Jira workflow state from silently blanking the status on the board.


## Error handling

| Failure | Handling |
|---------|----------|
| JWT verification fails | 401, no processing. Logged with the source IP. |
| Webhook payload fails Zod validation | 200 (already acknowledged), logged with the correlation ID and the validation error. Item not created or updated. |
| Site resolution fails | Item created without Site link. Reason recorded on the item and in logs. |
| monday API write fails | Logged with the correlation ID, Jira key, and the monday error. The mapping is not persisted, so the next event for this issue will retry the create. |
| monday API complexity budget exhausted | Exponential backoff and retry, same strategy as the ingest. |
| Mapping store read/write fails | Logged and surfaced as an error response. This is infrastructure failure. |

Sync failures are surfaced on the monday item as an update (comment)
so program managers see them without log access. A Work Package whose
last sync failed is more useful than one that silently stopped updating.


## Structured logging

Every log line within webhook processing includes:

- `correlationId`: the `X-Atlassian-Webhook-Identifier` value
- `jiraKey`: the issue key, when available
- `event`: the webhook event type
- `mondayItemId`: the target item ID, when available

Log levels: info for successful create/update, warn for unresolved site
or unmapped status, error for write failures and verification failures.


## New modules

| Module | Responsibility |
|--------|---------------|
| `webhookHandler.ts` | Express route for POST /webhook/jira. Verification, acknowledgement, async dispatch. |
| `webhookAdmin.ts` | Express routes for /admin/webhook/*. Registration, status, refresh. |
| `siteResolver.ts` | Sites board cache, name normalisation, lookup with refresh-on-miss. |
| `statusMap.ts` | Jira to monday status mapping. Exported for Phase 6 reverse use. |
| `issueSync.ts` | Core create-or-update logic. Mapping store, column value construction, monday writes. |
| `mondayWriter.ts` | GraphQL mutations for creating and updating Work Package items. Column value JSON construction. |


## New dependencies

`jose` for JWT verification. No other new runtime dependencies. The
monday GraphQL client reuses the existing `fetch`-based approach.


## Tests

| Test | What it covers |
|------|----------------|
| Summary parsing | Extracts school name from "Work - School". Handles no separator, multiple separators, leading/trailing whitespace. |
| Site resolution | Exact match, case-insensitive match, miss triggers cache refresh, ambiguous match returns unresolved. |
| Status mapping | Each Jira status maps correctly. Unmapped status returns undefined. |
| Create vs update | Unmapped key creates. Mapped key updates. Duplicate create event (same X-Atlassian-Webhook-Identifier) is skipped. |
| Idempotency | Second delivery of the same event ID does not create a duplicate item. |
| JWT verification | Valid token accepted. Expired token rejected. Wrong signature rejected. Missing header rejected. |
| Webhook payload validation | Valid payload passes Zod. Missing fields rejected. |


## Open questions

1. **Column ID discovery.** The ingest hardcodes column IDs as constants
   and resolves labels from `settings_str` at runtime. Should the
   monday-app do the same (hardcode Work Packages column IDs), or
   discover them by title from the board schema? Hardcoding is simpler
   and avoids ambiguity if two columns share a title. The trade-off is
   that renaming or recreating a column silently breaks the integration.
   The ingest chose hardcoding. Consistency argues for the same choice
   here.

2. **Deduplication store.** The `X-Atlassian-Webhook-Identifier` set
   needs a TTL or size bound. SecureStorage is persistent but has no
   native TTL. Options: store timestamps alongside identifiers and prune
   on read, or use an in-memory LRU that resets on redeployment (safe
   because the handlers are idempotent regardless). The in-memory
   approach is simpler and sufficient given that the handlers are
   create-or-update, not create-only.

3. **Site re-resolution on update.** The current design skips
   re-resolution when an issue is updated. If the school name segment
   of the summary changes, the Site link stays stale until manual
   correction. Is this acceptable, or should updates diff the summary
   and re-resolve when the school name changes?

4. **Existing issues.** When the webhook is first registered, issues
   already in the NTSR project will not trigger create events. Should
   the register endpoint also run a backfill pass using the existing
   `POST /search/jql` endpoint to create Work Packages for all current
   issues? Or is backfill a separate operation?

5. **OAuth scope reauthorisation.** Adding `manage:jira-webhook` to the
   consent URL means the existing grant must be reauthorised. This is a
   one-time manual step. Should the app detect the missing scope and
   surface it clearly, or is documenting it in the deployment notes
   sufficient?
