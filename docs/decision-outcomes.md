# Leadership decisions and meeting continuity

Command Center now connects a preserved decision and its reasoning to an expected result, real accountable workspace member, review date, existing recovery actions, and later observed opportunity changes. The same actions remain available in account plans; no task store or CRM writes are added.

## Access and integrity

The leadership router requires authentication, CORE, command_center.view, and explicit active membership. Managers (owner/admin/manager) start tracking. Managers and the assigned decision owner can link actions and add outcome reviews; viewers are read-only. Account-decision sources additionally require clients.view, a current canonical account key, a retained decision entry, and an explicitly linked opportunity. Live account names never resolve identity.

Original decision text, reasoning, expected result, owner, review date, creator, and server opportunity snapshot cannot be replaced by update requests. Source account text/date are copied from the retained entry, not the request. Duplicate promotion of an account entry is protected by a partial unique workspace/source-entry index. An account history entry can later age out without deleting the tracked decision.

Only existing actions from the same workspace and opportunity can be linked (maximum 20 distinct IDs). Links reference the same action records, not copied tasks. Unavailable/out-of-view actions are labeled and can be unlinked. Assigning a new action uses the existing recovery workflow; return to the decision to link it. Creating a decision does not send messages.

Outcome assessments are explicitly human assessments: improved, unchanged, worsened, or insufficient evidence. Each review captures the current server opportunity record, author, and time. Missing opportunities require insufficient evidence. Cross-mode outcome reviews are rejected. Atomic version checks return 409 on conflicting edits. The latest 100 outcome reviews and a lifetime review count are retained. The briefing loads five reviews per decision, with retained history loaded on demand; this is a working history, not a compliance archive. Reviews before the due review date do not clear a later due review.

## Meeting comparisons

New saved meeting checkpoints include deal records plus up to 100 recent actions, decisions in the current data mode, and recently updated account plans where clients.view is present. Reads fetch 101 to detect partial coverage; both current and baseline limits are disclosed. These are independent collection reads, not a transactional database-wide snapshot or exhaustive provider audit.

Shows action status/outcome/deadline changes, currently overdue commitments (including ones already overdue), completed actions, decisions added/reviewed/due, objective/owner/review-date changes, new/reopened blockers, and explicit blocker resolutions. New opportunity review flags compare record-based rules at the two read times: overdue expected close, 7+ days without recorded activity, overdue CRM next action, missing CRM next action or owner. Newly visible records are labeled; missing records are not inferred as wins, completions, or resolutions. Removed/renamed blockers are not counted as resolved. Duplicate blocker wording is compared conservatively by counts.

Account-plan snapshots are not returned through the checkpoint response or list. Plan comparisons require account access at both baseline and current reads. Old checkpoints still support their original opportunity comparisons but need a new save for execution comparisons. A data-mode switch likewise requires a new execution baseline.

Demo opportunities are fictional with dates rolling daily. Decisions, checkpoints, and reviews saved by the team are real workspace records. No sample decisions or reviews are inserted by reads. Demo field/date movement is not observed commercial progress. All monetary comparisons use the existing USD opportunity dataset. Closed Won means a CRM stage; no action or decision is credited with recovered revenue, recognized revenue, collected cash, or causal impact.

## Deployment and validation

Deploy backend before frontend. New collection leadership_decisions and additive LeadershipCheckpoint fields use normal Mongoose model/index initialization. No environment variables, dependencies, credentials, or manual data migration. Existing account-history decisions are not automatically promoted or backfilled.

Run npm test in backend and npm run build in frontend. Route tests mock database boundaries; perform real-database and browser verification after deployment.

Suggested verification:
1. As manager, record an account decision and open Track this decision’s outcome. Select a linked opportunity, real owner, expected result, review date and existing action. Confirm the saved text matches the account entry.
2. Save a meeting checkpoint. Complete a linked action with an outcome, resolve one blocker, and change a CRM opportunity through its normal workflow.
3. Refresh against the saved checkpoint: review commitments, flags, blocker changes, and decision evidence. Add a human outcome review and inspect its preserved evidence.
4. Test viewer read-only access, decision-owner versus unrelated-member updates, permission loss for account snapshots, tenant isolation, a stale version, and a missing opportunity.
5. Check the mobile tabs, forms, long decision text, and expanded evidence without horizontal overflow.
