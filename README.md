# NT Schools Rollout

Bidirectional sync between Jira Cloud and monday.com, using real NT Government
school data from data.nt.gov.au.

Jira is the delivery team's system of record. monday.com is the program's system
of record. This integration keeps them consistent without anyone copying status
between the two by hand.

Built on the monday apps framework: workflow automation blocks, a React board
view, and monday code hosting in the AU region for data residency.

**Status:** in progress.

## Structure

| Directory | Purpose |
|---|---|
| `ingest/` | Pulls NT school data and loads it into monday |
| `monday-app/` | Automation blocks, Jira webhook receiver, sync logic |
| `board-view/` | React board view built on the Vibe design system |
| `docs/` | Design decisions |

## Stack

- TypeScript throughout
- monday.com GraphQL API, version 2026-07
- Jira Cloud REST API v3 with OAuth 2.0 (3LO)
- monday code hosting, AU region

## Docs

- [Board design](docs/board-design.md)
- [Sync design](docs/sync-design.md)
- [Hardening notes](docs/hardening.md)