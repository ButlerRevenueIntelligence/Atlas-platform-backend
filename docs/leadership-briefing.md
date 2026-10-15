# Leadership briefing

Command Center now connects meeting changes, evidence, recovery actions, and a deal-slip simulator. Deploy the backend before the frontend. No new environment variables, credential changes, backfill, or manual migration are required. Mongoose creates `leadership_checkpoints` and `recovery_actions` on first use.

## Demo walkthrough

1. Open Command Center in Atlas Demo Company. The initial comparison is labeled **Illustrative comparison**. It is generated from the shared demo dataset, never stored or claimed as observed history. Northstar moves from Proposal to Negotiation with a later close date; Elevate has a higher deal value and newer activity.
2. Expand “Why is Atlas showing this?” for source values, dates, and weighted calculations.
3. Assign a recovery action to an actual active workspace member and choose a deadline. Fictional CRM owners remain context, not assignable users.
4. Mark it in progress, blocked, or completed. Completion requires an outcome. “Deal progress since assignment” compares current deal fields with evidence captured at assignment. This does not establish causation or recovered revenue.
5. Run Northstar with a 30-day delay, next 30 days, and an $800,000 planning target. Baseline weighted pipeline is $762,650; the scenario is $417,050, a $345,600 reduction and $382,950 gap. The same delay has zero impact in the 90-day window. CRM records never change.
6. Save a named meeting checkpoint. Future comparisons use that persisted snapshot instead of the rehearsal. Demo dates roll forward daily and remain labeled as sample behavior.
7. Account context matches open opportunities to unexpired GraphIQ profile search results. The current provider supplies profiles, not a verified event feed; this release does not invent funding, leadership changes, expansion events, or purchase intent.

## API and access

All `/api/leadership` endpoints require authentication, CORE access, `command_center.view`, and an explicitly active membership in the selected workspace. Every database read/write is tenant scoped. Body-supplied org IDs are ignored.

- `GET /briefing?checkpointId=...`: current deals, priorities, comparison, latest 12 meeting choices, latest 100 actions, active member choices, sync freshness, account context.
- `POST /checkpoints`: owner/admin/manager saves server-captured meeting data and label.
- `POST /actions`: owner/admin/manager assigns a server-captured opportunity action to an active non-viewer member in this workspace.
- `PATCH /actions/:id`: assignee or owner/admin/manager changes status/outcome. Viewers cannot write. Version conflicts return 409. Each update records its actor and timestamp; latest 100 history entries retained.
- `POST /scenario`: recomputes from current workspace deals. Inputs: one deal ID, integer delay 1–365 days, horizon 30/60/90 days, optional nonnegative numeric target. No writes.

## Calculation boundaries

Uses the existing unified USD-only deal dataset; archived records excluded. Open pipeline excludes Closed Won/Lost. Dated weighted totals are amount × normalized probability for open deals closing on/before the cutoff, including overdue opportunities. Missing close dates are excluded and counted separately. Priority rules put near-term deals first, then sort by amount; this is not a predictive risk score.

Both snapshots use the current outlook cutoff for weighted comparisons. Missing records are not inferred to be won/lost. Recorded activity does not establish buyer intent. The user-entered target is compared with weighted pipeline, not recognized revenue or a committed forecast. Alternatives are other deals outside the window; no acceleration or recovery is assumed.

GraphIQ matching ignores punctuation/case but requires the whole account name. It uses only tenant-owned, unexpired stored results. Profiles require human validation and do not imply events. Briefing reads make no provider or AI calls.

## Validation

`npm test` covers totals, comparisons, missing evidence, scenario boundaries/non-mutation, tenant isolation, roles, assignee validation, server-owned snapshots, concurrent edits, history, and demo isolation. Database boundaries are mocked; deployment verification still needs a real database and browser. Frontend production build checked separately.
