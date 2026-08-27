\# Sync design



How Jira Cloud and monday.com are kept consistent.



\*\*Status:\*\* design only. Implementation begins at Phase 5.



\## Systems of record



Jira is the delivery team's system of record. Engineers work there and will

not move. monday is the program's system of record, where the PMO and

executive stakeholders track the rollout across sites.



Neither audience uses the other's tool. The integration exists so that

neither has to.



\## Field ownership



Bidirectional sync does not mean every field flows both ways. Where two

systems can both write the same field, concurrent edits produce silent data

loss under last-write-wins. Each field therefore has a declared owner.



| Field | Owner | Direction |

|---|---|---|

| Summary / package name | Jira | Jira to monday |

| Description | Jira | Jira to monday |

| Assignee | Jira | Jira to monday |

| Status | Shared | Both directions |

| Site link | monday | monday to Jira, as a comment |

| Program milestone | monday | monday to Jira, as a comment |

| Priority | monday | monday to Jira |



Status is the only genuinely shared field, which is where conflict handling

and reconciliation are concentrated.



Program context flows to Jira as issue comments rather than custom fields.

Custom fields require Jira admin configuration that a delivery team may not

grant, and comments degrade gracefully when they are not read.



\## Flows



\*\*Jira to monday.\*\* An issue is created or transitioned in Jira. Jira fires a

webhook. The app verifies the signature, resolves which site the issue relates

to, and creates or updates the corresponding Work Package item, writing the

Jira key and URL back onto the item.



\*\*monday to Jira.\*\* A program manager changes a work package status. The

monday automation the user configured, built on this app's custom action

block, fires. The app transitions the corresponding Jira issue and adds a

comment recording the origin of the change.



\*\*Reconciliation.\*\* A scheduled job compares both systems nightly, identifies

items that have drifted, and reports them.



\## Loop prevention



The naive implementation loops indefinitely: a write to monday triggers the

monday automation, which writes to Jira, which fires the Jira webhook, which

writes to monday.



Two mechanisms, deliberately layered:



1\. \*\*Identity mapping.\*\* The Jira key to monday item ID mapping is persisted

&#x20;  in the monday code managed database. Every inbound event is resolved

&#x20;  against it before any write.

2\. \*\*Echo suppression.\*\* Writes originated by the integration are recorded

&#x20;  with a short-lived marker keyed on the mapping. An inbound event matching

&#x20;  a recent outbound write of the same field to the same value is dropped.



The marker is time-bounded rather than permanent, so a genuine user change

made shortly after an integration write is not swallowed. The window is a

tuning parameter and its value is a trade-off between loop safety and

responsiveness.



\## Idempotency



Webhooks are at-least-once. Both platforms will redeliver on timeout or

non-2xx response, and Jira in particular will redeliver an event the app has

already processed successfully but responded to slowly.



Every handler is keyed on a stable event identifier and is safe to run twice.

Item creation checks the mapping first and updates rather than creating on a

second delivery. This is covered by unit tests, since it is the failure mode

least likely to surface in manual testing and most likely to produce

duplicate items in front of an audience.



\## Rate limiting



monday charges query complexity rather than counting requests, so a single

badly shaped GraphQL query can exhaust the budget where many small ones would

not. Queries request only the columns they need, and paginate with cursors.



Both platforms are handled with exponential backoff and jitter.

COMPLEXITY\_BUDGET\_EXHAUSTED on monday and 429 on Jira are treated as retryable

rather than fatal. Retry state is not held in memory, so a redeployment mid

backoff does not lose the work.



\## Reconciliation



Webhooks are lossy. Endpoints go down, deliveries are dropped, and users edit

records during outages. An integration that only reacts to events accumulates

drift that nobody notices until it matters.



The nightly job walks both systems, compares the fields under shared

ownership, and reports every discrepancy to a dedicated group on the Work

Packages board.



It reports rather than auto-corrects. Silently overwriting a human's change

at 3am is worse than surfacing the disagreement, and in a government context

an auditable record of what disagreed is more valuable than an unlogged fix.



\## Deletion



Deleting a Site item in monday leaves its connected Work Packages orphaned

and their mirror columns empty. Deleting an issue in Jira leaves a mapping

pointing at nothing.



Neither deletion cascades. Orphans are detected by the reconciliation job and

reported for human resolution. Automatic cascade deletion across a system

boundary, triggered by a webhook that might itself be a mistake, is not a

behaviour worth building.



\## Failure surfacing



Sync failures are written to the affected work package item, not only to

logs. A program manager who cannot see that an item stopped syncing will

assume it is current, and a stale item presented as live is worse than a

visibly broken one.



\## Ingest idempotency



The school ingest applies the same identity-mapping principle described above

for the Jira sync, but against a simpler surface: a read-only source where

only one side can change.



Each school record carries an `itSchoolCode` that is unique and stable across

runs. The ingest writes this code into the School ID text column on the Sites

board, and uses it as the join key for all subsequent runs.



The sync is two-pass. First, the ingest reads every existing item from the

board, paginating with cursors, and builds a map from school code to monday

item ID. Second, it walks the transformed source list: if the code already

exists in the map, the item is updated in place; if not, a new item is

created. Entries consumed from the map are removed as they are matched, so

anything remaining at the end is an orphan — a school that exists on the

board but no longer appears in the source.



Orphans are logged by name in the run summary and never deleted. A school

disappearing from the directory might mean a closure, a reclassification,

or a data error upstream, and in each case the correct response is a human

decision rather than an automated deletion. The ingest surfaces the

information; an operator acts on it.



This is a degenerate case of the bidirectional mapping the Jira sync will

maintain. The identity principle is the same — stable external key, resolve

before write, never create a duplicate — but without the echo suppression

and conflict handling that bidirectional sync requires, because the NT

directory is not listening for changes in the other direction.



\## Jira search pagination



Jira's /rest/api/3/search/jql endpoint uses token-based pagination and

returns no result total, so the reconciliation job cannot ask how many issues

exist up front. It must walk pages until nextPageToken is absent. This is

the same pattern as monday's cursor-based items\_page — iterate until the

cursor is empty, accumulate results.



Offset pagination would also be unsafe here, since records can change

between page fetches. A result that moved from page 2 to page 1 during

iteration could be skipped or counted twice. Token-based pagination avoids

this at the cost of not knowing the total until the walk is complete.

