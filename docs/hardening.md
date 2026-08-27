\# Hardening notes



What would change to take this from a portfolio demo to something running

against a live NT Government program.



\*\*Status:\*\* notes. Not implemented.



\## Data residency



The monday code deployment targets the AU region, so application data stays

in monday's Australian data region rather than defaulting to the US.



monday's data region is set automatically based on the location of the first

user who opens the account, and cannot be moved once data exists. For a

government client this is a decision to make deliberately at account creation,

not something to discover afterwards. Moving regions means creating a new

account.



Enterprise accounts hosted in the EU are the only configuration with strict

region-bound residency including sub-processors. Other regions, AU included,

host customer account data in the assigned region but may involve

sub-processors elsewhere for some components. That distinction belongs in a

client conversation before contract, not after.



Jira Cloud residency is configured separately, on the Atlassian side.



\## Authentication and secrets



The demo uses OAuth 2.0 (3LO) against Jira with secrets held in the monday

code secret store, and no credentials in the repository.



For production:



\- Rotate credentials on a schedule, with rotation tested rather than assumed.

\- Scope the Jira OAuth grant to the minimum required, and review it when the

&#x20; integration changes.

\- Use a dedicated service identity in both systems rather than an individual's

&#x20; account, so that a person leaving does not break the integration.

\- Handle token revocation as an expected event with a clear operator path to

&#x20; reauthorise, not as an unhandled failure.



\## Access control



Board permissions in monday are the real access boundary, and the integration

inherits whatever the service identity can see. Work packages carry site

context that may be sensitive at a school level even when no personal

information is involved.



Board-level permissions, column-level restrictions on anything sensitive, and

a documented answer to who can see which regions.



\## Audit



Government work requires an answer to who changed what, when, and via which

system.



\- Every integration write is attributable to the integration rather than

&#x20; appearing as an anonymous change.

\- Origin is recorded on the target record, which is why monday to Jira status

&#x20; changes carry a comment.

\- Correlation IDs propagate across the sync path so a single business event

&#x20; can be traced end to end through both systems.

\- Log retention long enough to be useful in an incident review.



\## Privacy



The demo uses only published aggregate data from the NT Open Data Portal. No

student or staff information is involved, and the design does not require any.



A production deployment should keep it that way. If personal information ever

enters scope the assessment is a different exercise, and the integration

should be designed to hold identifiers rather than attributes wherever

possible.



\## Scale



Sites is bounded by the size of the NT school system, roughly 150 items. Work

Packages is not bounded, and at several thousand items:



\- Mirror column resolution needs measuring against board load times.

\- Ingest and reconciliation need batching against the API complexity budget

&#x20; rather than serial writes.

\- The reconciliation job's full walk of both systems becomes expensive and

&#x20; should move to a changed-since query where the APIs support it.



\## Availability



The integration is not the system of record for anything, which is a

deliberate property. If it stops, both platforms continue working

independently and drift accumulates until it is restored.



Consequences to plan for:



\- Reconciliation must be able to catch up after an extended outage, not only

&#x20; detect single-event drift.

\- Users need to know when sync is degraded, surfaced in monday rather than

&#x20; only in logs.

\- Startup after a redeployment must not replay stale queued events blindly.



\## Supply chain



Dependency vulnerability scanning runs as part of deployment via the monday

CLI, and the report is retrievable per deployment. In a government context

this is a control worth evidencing rather than merely performing.



\## Alternative hosting



monday code was chosen for managed hosting, AU residency, an integrated

secret store, a managed database and a built-in scheduler, with no

infrastructure to operate.



Where a client requires the integration inside their own network boundary,

monday supports pointing app features at an externally hosted render URL

instead. That path trades the managed platform for full control of the

runtime environment, and is the right answer for some agencies. It is worth

knowing both options exist before assuming either.



\## Source endpoint stability



The ingest depends on an undocumented, unversioned JSON endpoint behind the

NT Department of Education's school directory SPA at

directory.ntschools.net. The endpoint requires no authentication and returns

the current school list, but it carries no stability guarantee: no API

version header, no published schema, no deprecation policy.



Zod validation on the response means a shape change — a renamed field, a

changed type, a restructured payload — fails loudly at parse time rather

than silently writing corrupt data into the board. This is the right

first-order defence, but it only converts a silent failure into a noisy one.



A production deployment would need two things on top of this. First,

monitoring on ingest success: an alert when a scheduled run fails, with

enough context in the error to distinguish a transient network failure from

a breaking schema change. Second, a documented fallback: what the operator

does when the endpoint changes or disappears. Options include falling back

to a manually curated CSV upload, contacting the department for a supported

data feed, or sourcing the school list from ACARA's national dataset

instead. The fallback does not need to be built, but it needs to be written

down so that the first person to encounter the failure has a path forward

rather than a mystery.



\## OAuth and credential isolation



The OAuth grant is resource-level, scoped to the single Jira site authorised

during the consent flow rather than account-wide. The integration cannot

reach Atlassian instances outside the one it was authorised for, which limits

blast radius if a token is compromised.



Secrets are held in monday code's secret store, set via the CLI and read at

runtime through the SDK's SecretsManager. They never appear in the

repository, in environment variables on the deployed container, or in

application logs.



OAuth tokens and CSRF state live in monday code's SecureStorage, which is

Vault-backed and authenticated via the platform's own GCP service identity.

No manually managed credential is needed to access it — the platform

provides the auth context at runtime.



\## Compute residency



monday.com account data residency is Australia, confirmed in account

settings, but the monday code app runtime deployed to a US host. Data

residency and compute residency are configured separately on the monday

platform and can diverge on the same account.



For a government client this is worth establishing explicitly before contract

rather than assuming one implies the other. Where compute must also reside

in-region, the alternative hosting model described above applies.

