# Guided workspace setup

A four-step setup replaces the browser-only welcome flow: shared leadership priorities, expected systems, current data coverage, and a saved first leadership briefing. New signups reach it through /welcome and newly created workspaces go to /setup. Existing users receive an optional compact setup prompt; completed/deferred/read-only workspaces have a small review link. No forced login redirect or blocking modal is added.

## Persistence and access

workspace_setups has one document per orgId. Reads never create progress. GET /api/workspace-setup/status is a lightweight status read for navigation; GET /api/workspace-setup returns current readiness plus the saved setup. Both require authentication, CORE, command_center.view and explicit active membership, including globally privileged accounts.

Owner/admin/manager roles save shared priorities and expected systems, acknowledge coverage, build a briefing, complete the setup flow, or defer it. Other active members can inspect progress. PUT preferences accepts one to three known priority IDs and zero or more known system IDs. Only whitelisted fields are saved; caller tenant IDs, completion timestamps, snapshots, billing fields, authors and readiness claims are ignored. Every write uses a null-on-create or nonnegative revision; unique workspace indexing and atomic __v filters protect concurrent creation/edits. Changing priorities/systems invalidates previous coverage/briefing/completion milestones. The frontend keeps the preference editor revision separate from refreshed server facts.

Completion means the team reviewed the flow, not that integrations, commercial performance, or financial statements are certified. Deferred and completed states stay editable/reviewable. Progress is workspace-specific across devices; legacy global atlas_onboarded/atlas_primary_goal flags do not determine progress in this flow.

## Connection and coverage rules

Links reuse existing Data Connectors/OAuth/import/sync flows. Setup never starts OAuth, writes credentials, schedules syncs, reconnects providers, or sends messages. Changed expected-system choices are saved before leaving for a connector. Connector anchors and a return link support the round trip, including a resume link if an OAuth callback loses the original query. Existing integration authorization and plan rules remain responsible for connector operations.

Readiness separates disconnected, sample/demo connections, selection required, syncing, error/failed, connected-but-not-successfully-synced, successful within 24 hours, and stale syncs. Future/invalid timestamps cannot make a connector look fresh. Slack is a notification connection, not a revenue source. Relevant existing live connections with sync issues remain gaps even when not explicitly selected. DTOs exclude tokens, external account IDs/names, provider errors, raw payloads and arbitrary connection metadata.

Coverage uses the existing unified USD workspace dataset and exact account catalog:
- Open opportunities: valid close date, recorded owner, valid amount/probability, and overdue close dates. Genuine zeros are known values; missing values do not become coverage.
- Accounts: only explicit unambiguous record/provider links; names alone do not link an opportunity.
- Recorded revenue: original Stripe/Shopify/imported observation days in the last 30 UTC days. Zero records count, generated chart gap-fill rows do not. This does not establish a full 30-day run-rate forecast baseline.
- Accounting: usable USD QuickBooks snapshot plus recorded sync freshness, distinct from a revenue-to-cash reconciliation.

Protected account and financial coverage requires the corresponding clients.view/dashboard.view permission. Historical saved coverage snapshots are redacted after permission loss. Provider status alone never substitutes for field coverage. Currency-exclusion warnings remain visible. Live workspaces do not count explicitly demo-sourced opportunities as live readiness. Demo workspace coverage stays labeled sample and requires acknowledging sample limitations for selected priorities.

A readiness fingerprint covers mode, saved priorities/expected systems, and current relevant gaps. Review and completion require the fingerprint last shown to the user; changed gaps return 409 and require refresh/review. Completion re-reads current facts and retains unresolved items in its saved review rather than marking them fixed.

## First briefing and handoff

After reviewing coverage, a manager can build a server-derived first briefing. It saves read time/mode, original coverage highlights for the selected priorities, open pipeline/90-day probability-weighted context and up to three existing record-based priorities, then links to Command Center for evidence/actions/decision tracking. No opportunity data, goals, meeting checkpoints, actions, outcomes or financial facts are automatically created. An empty workspace gets a clearly labeled starting point with no fabricated opportunities or recommendations. A finance-focused workspace with revenue/accounting coverage can inspect those views without being told to connect a CRM first. Demo output is labeled sample; saved setup choices/progress are real records. Weighted pipeline is potential USD deal value, not recognized revenue, collected cash or a committed forecast. Setup priorities recommend setup sources; opportunity ranking rules remain the existing ones.

Mode changes require a new coverage review before building/finishing. Existing billing, access approval, subscription and trial enforcement remain in place. No new environment variables, credentials, dependencies, or manual migration. Deploy backend before frontend; the new collection uses normal Mongoose index initialization.

## Verification

Run npm test (backend) and npm run build (frontend). Route tests mock database boundaries; browser/OAuth and live-database verification remain necessary after deployment.

1. Sign up or create a workspace; choose priorities, select an expected system, leave for its connector and return. Confirm saved choices survive refresh/new device and actual sync/selection state is shown.
2. Inspect all four coverage cards and source limits. Confirm zero observations, empty workspace, failed sync, stale timestamp, missing opportunity fields and sample data retain distinct states.
3. Change data between reading coverage and confirming it; expect 409 rather than silent acknowledgment of unseen limits. Refresh, acknowledge gaps, build a starter/real/sample briefing and finish the flow.
4. Confirm completed setup does not claim unresolved gaps were fixed; reopen it, edit priorities, and verify previous milestones are invalidated. Continue later and resume.
5. Verify manager writes versus viewer/member reads, two simultaneous preference edits, duplicate creation, tenant switching during an outstanding read/write, and restricted historical coverage after permission loss.
6. Check 390px/mobile and desktop steps, connector scrolling/return, checkbox labels, keyboard focus and bounded recommended source cards. Existing pages should remain accessible throughout optional setup.
