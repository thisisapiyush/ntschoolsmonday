\# Board design



Design decisions for the monday.com workspace, and the reasoning behind them.



\## Scope



Two boards: \*\*Sites\*\* and \*\*Work Packages\*\*.



An earlier draft included Risks and Vendors boards. Both represent real

requirements in a live infrastructure program, but neither adds any

integration surface, and every additional board is more seed data to keep

consistent for no gain in what the demo actually demonstrates. Cut them.



Reconciliation drift reports, which were originally destined for a Risks

board, will instead be written to a dedicated group on Work Packages.



\## Sites



One item per NT government school, ingested from the School List dataset

published by the NT Department of Education on data.nt.gov.au.



Sites is a separate board rather than a group on Work Packages because the

two have different lifecycles. Sites are long-lived reference data, updated

rarely and sourced from an external system of record. Work packages are

transactional, created and closed continuously throughout the rollout. A

single board would force one retention and permission model onto both.



\### Columns



| Column | Type | Notes |

|---|---|---|

| Site | Item name | School name |

| School ID | Text | Identifier from the NT dataset, used as the join key |

| Region | Status | Darwin, Katherine, Barkly, Alice Springs, Big Rivers |

| Remoteness | Status | Urban, Regional, Remote, Very Remote |

| Site status | Status | Not started, Survey booked, In progress, Complete, Blocked |

| Enrolments | Numbers | From the NT dataset |

| Power ready | Status | Yes, No, Unknown |

| Comms ready | Status | Yes, No, Unknown |

| Access window | Timeline | Dry season access window for remote sites |

| Latitude | Numbers | Required by the board view |

| Longitude | Numbers | Required by the board view |

| Readiness | Numbers | Computed, see below |

| Work packages | Connect boards | Link to Work Packages |



Default monday status labels were replaced throughout. Labels carry domain

meaning here, not generic progress states.



\## Work Packages



The unit of delivery, and the only board that syncs with Jira.



| Column | Type | Notes |

|---|---|---|

| Package name | Item name | |

| Site | Connect boards | Link to Sites |

| Region | Mirror | Pulled through the Site connection |

| Status | Status | Backlog, Scheduled, In progress, On hold, Done |

| Owner | People | |

| Timeline | Timeline | |

| Jira key | Text | Populated by the integration |

| Jira link | Link | Populated by the integration |

| Last synced | Date | Populated by the integration |



\## Region is mirrored, not duplicated



Region lives on Sites and is mirrored into Work Packages, so there is one

source of truth and no possibility of the two drifting apart.



The trade-off is real: mirror columns cannot be written to via the API, and

filtering and grouping on them is more limited than on native columns. For a

demo at this scale that is the right call. At several thousand work packages

it would be worth measuring whether mirror resolution affects board load

times, and denormalising region onto Work Packages at write time if it does.



\## Readiness is computed in code, not as a formula column



Readiness was initially a monday formula column. The formula builder

repeatedly failed to bind column references, and rather than spend further

time on it the score moved into the integration layer as a plain Numbers

column populated at ingest.



This turned out to be the better design regardless:



\- The scoring rule lives in version-controlled TypeScript and can be unit

&#x20; tested. A formula string has no history and no test coverage.

\- The rule can evolve without touching board configuration, which in a client

&#x20; environment means no change request against a production board.

\- It can express logic monday formulas handle poorly, such as weighting by

&#x20; remoteness or decaying stale survey data.

\- The board view consumes a number either way and is indifferent to its origin.



\## Status labels have indexes, and the order is a data contract



monday status columns store an integer index, not the label text. The ingest

script and the sync layer both write indexes, resolved from the board schema

at startup rather than hardcoded.



Consequence: reordering or deleting status labels after go-live silently

breaks writes, and deleting a label does not clear it from items already

using it. Label sets should be treated as a schema change, not a

configuration tweak.



\## Dashboard scope



Dashboards are limited to one connected board on the current plan tier, so

the rollout dashboard reports on Sites only: site count by region, site count

by status, and a count of blocked sites.



A client deployment on Pro or above would use a cross-board dashboard

combining site readiness with work package delivery status. This is a

routine scoping consideration in monday implementations, where plan tier

determines which features are available rather than whether the design is

sound.



\## Seed data



Five schools entered by hand before the ingest script, deliberately spread

across urban, regional and very remote, with readiness ranging from 0 to 100.

A uniformly green board hides exactly the problems the demo is meant to show.



One site carries two work packages, so the connect column is exercised with a

one-to-many relationship rather than the one-to-one case that happens to work

by accident.



\## What breaks at scale



\- Mirror column resolution across thousands of items, as above.

\- Board item limits. Sites is bounded at roughly 150 by the size of the NT

&#x20; school system, but Work Packages grows without bound and would need

&#x20; archiving or a per-year board strategy.

\- The ingest script writes items serially. At 150 sites this is fine. Beyond

&#x20; that it needs batching against the API complexity budget.



\## First ingest: data source findings



The original design referenced the School List dataset published by the NT

Department of Education on data.nt.gov.au. That dataset turned out to be a

metadata stub linking to an external directory, and its CSV resource dates

from 2019. The live directory at directory.ntschools.net exposes an

unauthenticated JSON endpoint returning the current school list, and this is

the actual ingest source. The endpoint requires no authentication and returns

a flat array of school records with classification flags, school type,

electorate and DECS region.



\## The isPreSchool flag is unreliable



The source schema includes an `isPreSchool` boolean, but on the first run of

275 records it caught zero preschools. All 59 were caught by checking

`schoolType === "Preschool"` instead. Filtering on the documented flag alone

would have loaded every preschool as a separate site, duplicating the

co-located primary school already in the list — exactly the outcome the

filter exists to prevent.



The ingest therefore checks both conditions: exclude when `isPreSchool` is

true OR `schoolType` is `"Preschool"`. It logs each count separately so the

discrepancy stays visible. If the upstream system ever corrects the flag,

the type-based check becomes redundant but harmless, and the log output will

show the shift.



\## Source record count is live and will drift



The committed test fixture contains 276 records. The first live run returned

275\. This is expected for a live source that reflects school openings,

closures and reclassifications over time. Tests run against the committed

fixture and will diverge from live counts; the fixture is a shape and logic

test, not a census.



\## Fields the source does not provide



The directory endpoint carries no coordinates, enrolment numbers or street

addresses. Latitude, Longitude and Enrolments columns are left empty in this

phase.



Coordinates are deferred to an enrichment pass against ACARA's Australian

Schools List, matched on school name and reporting a match rate. ACARA

publishes coordinates for all Australian schools, so coverage should be high,

but name mismatches between the NT directory and the national list will need

manual resolution for the remainder.



\## Remoteness is a proxy



The source has no remoteness field. The ingest derives it from `schoolType`

as follows: Remote School and Small School map to Very Remote, Distance

School to Remote, otherwise Urban for Darwin region and Regional everywhere

else.



This is a reasonable proxy for the NT school system, where the correlation

between school classification and remoteness is strong. It will misclassify

a small number of schools — a specialist school in Darwin is not urban in the

ARIA sense, and a small school on the Stuart Highway is arguably regional

rather than very remote. For a rollout planning board the approximation is

sufficient, and it can be corrected per-site without changing the ingest

logic.



\## Region labels corrected to DECS vocabulary



The initial board design guessed at NT administrative regions. The source

uses the Department of Education's own DECS region vocabulary: Central, Top

End, Darwin, Barkly, Alice Springs, East Arnhem, Big Rivers and West Arnhem.

The board labels were corrected to match.



Label indexes are resolved from the board schema at runtime, never hardcoded.

If a source record carries a region value that has no matching label on the

board, the ingest leaves the Region column empty for that item, counts it as

unmapped, and continues. This avoids aborting an entire run because one

record has an unexpected value in a field the ingest does not control. For

columns whose values the ingest itself produces — Remoteness, Site status,

Power ready, Comms ready — a missing label is treated as a bug and aborts at

startup before any writes.



\## Final scope



162 government non-preschool sites from 275 source records. The remainder

are non-government schools (private, Catholic, independent) and preschools

co-located with primary schools already in the list.

