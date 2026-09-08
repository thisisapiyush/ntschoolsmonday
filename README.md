# NT Schools Rollout

Bidirectional sync between Jira Cloud and monday.com, using real NT Government
school data from data.nt.gov.au.

Jira is the delivery team's system of record. monday.com is the program's system
of record. This integration keeps them consistent without anyone copying status
between the two by hand.

Built on the monday apps framework and monday code hosting in the AU region for
data residency.

## How the sync works

The integration syncs in both directions, with echo suppression preventing
the two sides from looping.

**Jira to monday.** A registered Jira webhook fires on issue creation and
status changes. The webhook handler maps the Jira status to a monday status,
resolves the school site from the issue summary, and creates or updates the
corresponding monday Work Package item.

**Monday to Jira.** A native monday webhook fires when the Status column changes
on the Work Packages board. The handler maps the monday status to a Jira status,
looks up the available transitions on the Jira issue, and posts the transition.
An origin comment is added to the Jira issue recording that the change came from
monday.

**Echo suppression.** Each direction records a short-lived marker in SecureStorage
after writing a status change. Before writing, each direction checks for a
matching marker. If found, the write is an echo of the integration's own prior
action and is suppressed. The default suppression window is 60 seconds.

## Operational constraints

These are platform constraints discovered through deployment. They are documented
in detail in `monday-app/PHASE6.md` and `docs/hardening.md`.

**SecureStorage is cleared on deploy.** monday code's SecureStorage does not
survive a code push. The Jira OAuth grant must be re-established after every
deployment by visiting `/oauth/start` and completing the Atlassian consent flow.
A production integration would need durable external storage or a deployment
runbook step.

**Deployment URL changes on version bump.** The monday code URL includes the app
version. When a new version is promoted, the Atlassian OAuth redirect URI and
the registered Jira webhook URL both break and must be updated. A stable custom
domain in front of the deployment would remove this problem.

**Workflow action block not registrable.** The custom action block is implemented
and tested but cannot be registered in monday's workflow builder due to a
Developer Center limitation in how trigger outputs bind to action inputs. The
monday-to-Jira direction uses a native monday webhook as the active trigger path.
The block code is retained as the correct long-term approach.

## Structure

| Directory | Purpose |
|---|---|
| `ingest/` | Pulls NT school data and loads it into monday |
| `monday-app/` | Jira webhook receiver, monday webhook receiver, sync logic |
| `board-view/` | React board view built on the Vibe design system |
| `docs/` | Design decisions and hardening notes |

## Stack

- TypeScript throughout
- monday.com GraphQL API, version 2026-07
- Jira Cloud REST API v3 with OAuth 2.0 (3LO)
- monday code hosting, AU region

## Docs

- [Board design](docs/board-design.md)
- [Sync design](docs/sync-design.md)
- [Hardening notes](docs/hardening.md)
- [Phase 6: monday to Jira sync](monday-app/PHASE6.md)
