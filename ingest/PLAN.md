# Ingest script: implementation plan

## Overview

TypeScript CLI that loads NT government schools from the NT Department of
Education directory API into the monday.com "Sites" board. Runs on Node 20+
with `npx tsx ingest/src/index.ts [--dry-run]`.


## Module responsibilities

### `fetchSchools.ts`: source API client

Fetches `GET https://directory.ntschools.net/api/School/GetAllSchoolsForDirectory`.
Validates the response with Zod. Returns the raw array.

The Zod schema accepts `schoolType: string | null` and any string for
`electorate` (including `"n/a"`). Validation covers shape, not business
rules. Filtering is a separate step.

### `transform.ts`: pure mapping and derivation

1. **Filter**: Exclude when `isGovernment === false` OR `isPreSchool === true`
   OR `schoolType === "Preschool"`. The `isPreSchool` flag is unreliable
   (some preschools have `isPreSchool: false`), so both conditions are
   checked. Logs the count caught by each condition separately so the
   discrepancy is visible.
2. **Derive remoteness** (a proxy, since the source has no remoteness field):
   - schoolType `"Remote School"` or `"Small School"` → `"Very Remote"`
   - schoolType `"Distance School"` → `"Remote"`
   - otherwise, decsRegion `"Darwin"` → `"Urban"`
   - otherwise → `"Regional"`
3. **Map** each filtered record to a `SiteItem` containing:
   - `name` ← schoolName
   - `schoolCode` ← itSchoolCode
   - `region` ← decsRegion
   - `remoteness` ← derived above
   - `siteStatus` ← `"Not started"`
   - `powerReady` ← `"Unknown"`
   - `commsReady` ← `"Unknown"`
   - `readinessScore` ← computed by `readiness.ts` (0 on first ingest)

No I/O. Exported types used by the orchestrator and tests.

### `readiness.ts`: pure scoring function

```
readinessScore(powerReady, commsReady, siteStatus) → number
```

| Input          | Value        | Points |
|----------------|-------------|--------|
| Power ready    | Yes          | 40     |
| Comms ready    | Yes          | 40     |
| Site status    | Complete     | 20     |
| anything else  | (any)        | 0      |

On first ingest every score is 0. The function handles the populated case
so it is ready for future update runs.

### `schema.ts`: label index resolution

At startup, queries the board schema via:

```graphql
query {
  boards(ids: [$boardId]) {
    columns { id title settings_str }
  }
}
```

For each status column, parses `settings_str` (JSON with `{ labels: { "0": "Label A", "1": "Label B", ... } }`),
and builds a `Map<string, number>` from label text to index.

Exports a `resolveLabel(columnId, labelText)` function that returns the
index or throws with a message naming the column and the unrecognised
value. This ensures that reordering or adding labels in the monday UI
doesn't silently corrupt writes.

Columns resolved:
- `color_mm63v03v` (Region), expects: Alice Springs, Barkly, Big Rivers, Central, Darwin, East Arnhem, Top End
- `color_mm63hg85` (Remoteness), expects: Urban, Regional, Remote, Very Remote
- `color_mm64cjvv` (Site status), expects: Not started (at minimum)
- `color_mm643hp0` (Power ready), expects: Unknown (at minimum)
- `color_mm64ty9d` (Comms ready), expects: Unknown (at minimum)

### `mondayClient.ts`: GraphQL client with backoff

- Single `query(gql, variables)` function wrapping `fetch` to
  `https://api.monday.com/v2`.
- Sets headers: `Authorization: <token>`, `Content-Type: application/json`,
  `API-Version: 2026-07`.
- Detects `COMPLEXITY_BUDGET_EXHAUSTED` errors and retries with exponential
  backoff + jitter (base 1s, max 60s, jitter ±50%).
- Request-only-needed-fields discipline is the caller's job; this module
  handles transport and rate limiting.

### `index.ts`: orchestration

Two-pass approach:

```
1. Fetch & transform
   fetchSchools() → validate → filter & map → SiteItem[]

2. Sync to monday
   a. Resolve label indexes (schema.ts)
   b. Fetch existing items (paginated cursor loop on items_page)
      → build Map<itSchoolCode, itemId>
   c. For each SiteItem:
      - if code exists in map → update (change_multiple_column_values)
      - if code is new → create (create_item)
      - accumulate counters: created, updated, skipped, failed, unmapped
   d. Print summary (orphans listed by name, not just counted)
```

CLI flag: `--dry-run` prints what would be created/updated without writing
to monday.


## Idempotency: two-pass detail

**Pass 1: read existing items.** Paginate using `items_page(limit: 100,
cursor: $cursor)`, requesting only `id` and `column_values` for
`text_mm649dbn` (School ID). Build a `Map<string, string>` from
itSchoolCode → monday item ID.

**Pass 2: write.** For each transformed school:

- Look up its `itSchoolCode` in the map.
- If found: call `change_multiple_column_values` with the item's ID.
  Remove the entry from the map so we can detect orphans.
- If not found: call `create_item`.

Items remaining in the map after pass 2 are orphans (schools that exist
in monday but not in the source). They are logged by name in the summary
and never deleted. Deletion is a destructive action that should be an
explicit operator decision.


## Writes: column values JSON

monday's `column_values` argument is a JSON string. For our columns:

```json
{
  "text_mm649dbn": "acacisch",
  "color_mm63v03v": { "index": 3 },
  "color_mm63hg85": { "index": 0 },
  "color_mm64cjvv": { "index": 0 },
  "color_mm643hp0": { "index": 2 },
  "color_mm64ty9d": { "index": 2 },
  "numeric_mm643e9f": "0"
}
```

Index values are resolved at runtime from `schema.ts`, never hardcoded.


## Error handling

| Failure | Handling |
|---------|----------|
| Source API unreachable / non-200 | Throw with status code and URL. Abort. |
| Source API returns unexpected shape | Zod throws. Log the parse error with the first failing record. Abort. |
| Remoteness / Site status / Power ready / Comms ready label not found | Abort at startup. These values are produced by our own code, so a mismatch is a bug. |
| Region (decsRegion) label not found | **Do not abort.** At startup, resolve the distinct set of source decsRegion values against the label map and report any that don't resolve. At write time, leave the Region column empty for those records, count them as "unmapped", and continue. |
| `COMPLEXITY_BUDGET_EXHAUSTED` | Exponential backoff + jitter, up to 5 retries. |
| Single item create/update fails | Log the error with the school name and code, increment `failed` counter, continue to next item. |
| `MONDAY_API_TOKEN` missing | Throw at startup with a clear message. |

Abort-on-startup for missing token and code-controlled labels (Remoteness,
Site status, Power ready, Comms ready). Region labels are source-dependent
and handled gracefully per-item. Per-item errors during the write loop are
non-fatal so that one bad record doesn't block the rest.


## Rate limit strategy

- **Read phase**: `items_page` with `limit: 100` and cursor pagination.
  Request only `id` and the school-code column value. Keeps complexity low.
- **Write phase**: Individual mutations per item (create or update).
  monday's `change_multiple_column_values` writes all columns in one call,
  so each item is a single mutation. Batching multiple items into one
  request via `mutation { a: create_item(...) b: create_item(...) }` is
  possible but complicates per-item error handling, so it is deferred unless
  rate limits are hit in practice.
- **Backoff**: On `COMPLEXITY_BUDGET_EXHAUSTED`, wait
  `min(baseMs * 2^attempt + jitter, 60000)` then retry, up to 5 times.


## Test plan (vitest)

All tests run against the committed fixture `data/schools-raw.json`, no
network calls.

| Module | Tests |
|--------|-------|
| `transform.ts` | Filters correctly (222 gov non-preschool from 276). Handles null schoolType without crashing. Handles "n/a" electorate without crashing. |
| `transform.ts` | Remoteness derivation: "Remote School" → Very Remote, "Small School" → Very Remote, "Distance School" → Remote, Darwin primary → Urban, non-Darwin primary → Regional, null schoolType in Darwin → Urban. |
| `readiness.ts` | All unknown → 0. Power Yes only → 40. Comms Yes only → 40. Both Yes, not complete → 80. All Yes/Complete → 100. |
| Idempotency | Given a mock existing-items map and a list of SiteItems, correctly partitions into creates vs updates. |


## Dependencies

```
typescript, tsx, zod, dotenv, vitest
```

No other runtime dependencies. `fetch` is native in Node 20+.


## Decisions (resolved)

1. **Batched writes.** Sequential, one mutation per item. Don't batch until
   the complexity budget actually bites.

2. **Orphan handling.** Log and skip, never delete. Report orphans by name
   in the summary, not just a count.

3. **Preschool filter.** The `isPreSchool` flag is unreliable. Filter on
   both: exclude when `isPreSchool === true` OR `schoolType === "Preschool"`.
   Log the count caught by each condition separately so the discrepancy is
   visible.

4. **West Arnhem region.** Label added to the board manually. Fail-loud
   design handles any future unrecognised values.

5. **Region label resolution.** Do not abort on unresolvable decsRegion.
   At startup, report unresolvable values. At write time, leave Region
   empty for those records, count as "unmapped". Abort-on-startup only
   applies to code-controlled columns (Remoteness, Site status, Power
   ready, Comms ready).
