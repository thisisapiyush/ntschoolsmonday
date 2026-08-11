\# NT Schools Rollout — monday.com ↔ Jira integration



Bidirectional sync between Jira Cloud (delivery system of record) and

monday.com (program system of record), using real NT Government school

data from data.nt.gov.au.



Built on the monday apps framework: workflow automation blocks, a React

board view, and monday code hosting in the AU region.



Status: in progress.



\## Structure

\- `ingest/` — pulls NT school data and loads it into monday

\- `monday-app/` — automation blocks, Jira webhook receiver, sync logic

\- `board-view/` — React board view (Vibe design system)

\- `docs/` — design decisions

