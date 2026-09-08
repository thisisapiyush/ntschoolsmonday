# NT Schools Rollout

A bidirectional sync between Jira Cloud and monday.com for a government schools infrastructure rollout, built against real NT Department of Education data. 162 school sites are ingested from the department's live directory API, Jira issues create linked monday work packages, monday status changes transition Jira issues, and echo suppression prevents the two systems from looping. The integration runs on monday code in the AU region.

## Why it exists

Jira is the delivery team's system of record. monday.com is the program's system of record, where the PMO and executive stakeholders track progress across sites. Neither audience uses the other's tool, and neither will move. The integration exists so that neither has to: a status change in either system appears in the other within seconds, without anyone copying values by hand.

## Architecture

```
  Jira Cloud                    monday code (AU)                  monday.com
 +-----------+                 +---------------------+          +----------------+
 |           |  webhook        |                     |  GraphQL |                |
 |  Issues   | --------------> |  Webhook handler    | -------> |  Work Packages |
 |           |  (issue created |  (verify JWT,       |          |  board         |
 |           |   or updated)   |   map status,       |          |                |
 |           |                 |   resolve site,     |          |                |
 |           |  REST API       |   create/update)    |  webhook |                |
 |           | <-------------- |                     | <------- |  Status column |
 |           |  (transition    |  Monday webhook     |  (column |  changes       |
 |           |   issue)        |  handler            |   value  |                |
 +-----------+                 +---------------------+  changed)+----------------+
                                       |
                                       | Echo suppression
                                       | (SecureStorage markers
                                       |  prevent re-triggering)
                                       |
                               +---------------------+
                               |  NT Schools API     |
                               |  directory.ntschools|
                               |  .net (JSON)        |
                               +---------------------+
                                  Ingest: 275 records
                                  -> 162 government
                                     non-preschool sites
```

Both sync directions share a single status mapping and echo suppression layer. The ingest is a separate offline step that populates the Sites board from the NT directory.

## What works

**Site ingest.** 275 school records are fetched from the NT Department of Education's live directory endpoint at directory.ntschools.net. After filtering non-government schools and co-located preschools, 162 sites are written to the monday Sites board. Each site carries its school ID, DECS region, a derived remoteness classification, and a readiness score computed in code. The ingest is idempotent: it matches on school ID and updates in place on subsequent runs, never creating duplicates.

**Jira to monday.** A Jira webhook fires on issue creation and status transitions. The handler verifies the webhook JWT, resolves which school site the issue relates to (by matching the issue summary against site names on the board), and creates or updates the corresponding Work Package item. The Jira key and a direct link are written back onto the monday item. Status is mapped from Jira's vocabulary (To Do, In Progress, Done) to monday's (Backlog, In progress, Done).

**Monday to Jira.** A native monday webhook fires when a status column changes on the Work Packages board. The handler reads the item's current columns from the monday API, maps the monday status to a Jira status, fetches the available transitions from the Jira issue's current state, and posts the matching transition. An origin comment is added to the Jira issue so the delivery team can see where the change came from. The status mapping is deliberately lossy in this direction: three monday statuses (Backlog, Scheduled, On hold) collapse to Jira's single "To Do", because Jira's default workflow has no equivalents for the other two.

**Echo suppression.** Without it, the sync loops: a monday status change transitions Jira, the Jira webhook writes the status back to monday, monday fires the webhook again, indefinitely. Each direction records a short-lived marker in SecureStorage after writing. Before writing, each direction checks for a matching marker. If found, the event is an echo of the integration's own prior write and is suppressed. The window is 60 seconds, tunable via configuration.

## Stack

TypeScript throughout. monday.com GraphQL API (version 2026-07) for board reads and writes. Jira Cloud REST API v3 with OAuth 2.0 (3LO) for issue queries, transitions, and webhook management. Express for the HTTP layer. Zod for runtime validation of every external response. jose for JWT verification on inbound webhooks. monday code hosting in the AU region for data residency. 102 tests via Vitest.

## The interesting engineering

**Field ownership.** Bidirectional sync does not mean every field flows both ways. Each field has a declared owner; only Status is genuinely shared between both systems. The ownership model and the reasoning behind it are in [sync-design.md](docs/sync-design.md).

**Loop prevention.** Two layers, deliberately stacked: identity mapping (so the integration knows which entities are linked) and echo suppression (so it knows which writes are its own). The marker is keyed on the Jira status rather than the monday status, because the monday-to-Jira mapping is many-to-one and a marker keyed on the monday side would fail to match the returning echo. The full trace through both directions is in [PHASE6.md](monday-app/PHASE6.md).

**Idempotency.** Webhooks are at-least-once on both platforms. Every handler is safe to run twice. Item creation checks the identity mapping first and updates rather than creating on a second delivery, which is covered by unit tests because it is the failure mode least likely to surface in manual testing and most likely to produce duplicate items in front of an audience. See [sync-design.md](docs/sync-design.md).

**The unreliable isPreSchool flag.** The source schema includes an `isPreSchool` boolean that caught zero preschools across 275 records on the first run. All 59 were caught by checking `schoolType === "Preschool"` instead. The ingest checks both conditions and logs each count separately so the discrepancy stays visible. Details in [board-design.md](docs/board-design.md).

**Runtime label resolution.** monday status columns store integer indexes, not label text. The ingest and sync layer both resolve labels from the board schema at startup, never hardcoding indexes. A region value with no matching board label is skipped and counted; a value the integration itself produces that has no label is treated as a bug and aborts before any writes. This distinction (skip for external data, abort for internal data) is documented in [board-design.md](docs/board-design.md).

## Operational constraints

These surfaced through repeated deployment on monday code and are the kind of thing that only appears when you deploy, break it, and deploy again. They are documented in detail in [hardening.md](docs/hardening.md) and [PHASE6.md](monday-app/PHASE6.md).

**SecureStorage does not survive a deployment.** monday code's SecureStorage is cleared when a new app version is pushed. The Jira OAuth grant established before a code push is gone after it. Every deployment requires the operator to re-establish the grant by visiting `/oauth/start` and completing the Atlassian consent flow. For a production integration this means either durable external storage or a deployment runbook step. This was confirmed by observing `hasToken: true` on the diagnostic endpoint before a deploy and `hasToken: false` immediately after, with nothing else changed.

**Deployment URLs change on version bump.** The monday code URL includes the app version number. When a new version is promoted, every external system holding a callback URL breaks: the Atlassian OAuth redirect URI and the registered Jira webhook both point at the old version's URL. The operator must update both. A stable custom domain in front of the deployment would remove this class of problem; monday code does not provide one natively.

**The workflow action block cannot register.** The custom action block is implemented, tested, and correctly configured, but does not appear in monday's workflow builder when paired with the built-in "When status changes" trigger. The Developer Center's field-type system does not support binding a trigger's output to an action's input for the primitive types the workflows infrastructure accepts. The monday-to-Jira direction uses a native monday webhook instead. The block code is retained as the correct long-term approach.

## Structure

```
ingest/          NT school data ingest (directory API to monday Sites board)
monday-app/      Jira and monday webhook receivers, sync logic, OAuth, admin
board-view/      React board view on the Vibe design system
docs/            Design decisions and hardening notes
```

## Running it

**Prerequisites.** Node.js 20+, a monday.com developer account, a Jira Cloud site with OAuth 2.0 (3LO) configured.

**Ingest.** Populates the Sites board from the NT directory API:

```
cd ingest
npm install
MONDAY_API_TOKEN=<token> SITES_BOARD_ID=<id> npx tsx src/sync.ts
```

**App (local).** Runs the webhook receiver locally. Requires a tunnel (ngrok or similar) for Jira webhook delivery:

```
cd monday-app
npm install
cp .env.example .env   # fill in credentials
npm run dev
```

**App (monday code).** Deploy to the monday code platform:

```
cd monday-app
mapps code:push
```

After deploying, set secrets via the CLI (`mapps code:secret`), visit `/oauth/start` to establish the Jira grant, and register the Jira webhook via `POST /admin/webhook/register`. See the setup steps in [PHASE6.md](monday-app/PHASE6.md) for the monday webhook registration.

## Docs

- [Board design](docs/board-design.md): column choices, label resolution, the isPreSchool problem, what breaks at scale
- [Sync design](docs/sync-design.md): field ownership, loop prevention, idempotency, reconciliation
- [Hardening notes](docs/hardening.md): what changes for production (residency, auth, access control, audit, storage durability)
- [Phase 6: monday to Jira sync](monday-app/PHASE6.md): transition lookup, echo suppression traces, operational constraints
