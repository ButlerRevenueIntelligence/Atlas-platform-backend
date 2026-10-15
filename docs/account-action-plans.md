# Shared account action plans

Deploy the backend before the companion frontend. No new environment variables, provider credentials, package dependencies, or manual migration are required. Mongoose initializes `account_action_plans` with a unique workspace/account-key index. Reads do not seed plan records or modify CRM data.

## Workflow

Open **Shared account plans** from Accounts, an Account Intelligence card, a Deal War Room opportunity, or a recovery action in Command Center. The directory includes current linked customer records and legacy accounts. Plans have three focused views:

- **Account plan:** objective, accountable workspace member, review date, team-entered stakeholder roles/engagement, and blockers with responsible members and resolution status.
- **Opportunities & actions:** current source opportunity next steps alongside the existing persistent recovery actions. Assign/update uses the existing leadership endpoints and the shared ActionCard renderer. An action is not copied into a second task list; the same ID/version/status is visible in Command Center and the account plan.
- **Decisions & updates:** team notes, account decisions, and plan-save events with server-generated actor/timestamp. Latest 100 entries are retained and displayed. This is bounded working history, not an indefinite compliance audit archive.

Owner/admin/manager members create plans and reassign plan ownership. An active non-viewer plan owner can edit the objective, stakeholders, blockers, and review date. Other non-viewer members can add notes. Account decisions require the plan owner or a manager. Viewers are read-only. Recovery assignment remains manager-only under the existing policy; assignees can update their own actions. Ownership is checked atomically for decisions posted by non-manager owners.

Plan edits use optimistic version checks. Notes append atomically without changing the strategy version, so an unchanged open strategy draft can still be saved. Notes cannot overwrite strategy fields. Concurrent strategy edits return 409. Pending UI drafts are preserved after a conflict, and posting notes or updating actions does not replace an open editor draft. Save/cancel the editor before refreshing the page's data. Managers must choose active non-viewer members for plan/blocker ownership; inactive owners need reassignment.

## Identity and data boundaries

Live account identity never uses names, domains, or inferred buying signals:

1. Exact provider + external company ID yields a stable provider key. Base64url components keep reserved characters and Unicode safe in routes. Current Client and legacy Account aliases for that exact provider identity lead to one plan.
2. Records without a provider identity use their typed local record ID (`client:...` or `account:...`). Same-name companies remain separate.
3. Opportunities attach by their explicit `clientId` record link. A conflicting identical Mongo ID in different identity groups is ambiguous and remains unlinked. A matching company name never establishes a link.
4. Archived account records are not surfaced. Their plan documents are not deleted. Current pipeline excludes archived/closed deals and uses the existing unified USD-only data; currency exclusions remain disclosed.

Demo accounts derive stable `demo:...` keys from canonical shared sample opportunities. Only the demo fixture uses its explicit fictional company names to group sample wins/open deals. Demo dates roll forward. Fictional CRM owner names are context, not assignable workspace members. Saved plans/notes are real workspace records; sample plans, stakeholders, and past decisions are not manufactured on reads.

Company/contact context is whitelisted before responses. Provider raw payloads and integration secrets are not returned. Stakeholder engagement and blockers are manually entered team assessments, not independently verified intent. Action completion never establishes recovered revenue.

## API

All `/api/account-plans` endpoints require authentication, CORE access, `clients.view`, and an explicitly active membership in the canonical selected workspace. Plan and recovery queries are tenant scoped. Body-supplied org/account identity, owner names, history, timestamps, and authors are ignored.

- `GET /`: directory and current plan summaries. Optional `dealId` or typed `accountRef` resolves an exact current account; unknown/unlinked references return 404.
- `GET /:accountKey`: plan, safe account data, linked opportunities, latest 100 existing recovery actions, active member choices, and capabilities.
- `PUT /:accountKey`: full strategy edit with current `version` (`null` for first creation), objective, ownerId, optional reviewAt, up to 30 stakeholders, and up to 50 blockers. Owner names are resolved server-side. Notes/history are not accepted through this endpoint.
- `POST /:accountKey/updates`: append `note` or `decision` (1–4000 characters) after the plan exists. Actor and timestamp are server-owned. System plan events cannot be forged through this endpoint.

## Verification

Backend tests cover provider/legacy identity, duplicate-name separation, ambiguous IDs, archived records, canonical demo totals, field validation, authentication, active membership, tenant-scoped related actions, role restrictions, real member ownership, version conflicts, concurrent owner reassignment, and history forgery prevention. Database boundaries are mocked. Frontend production build and populated render smoke checks run separately; real browser and database workflow verification remain required after deployment.

Deal War Room's display mapper now retains numeric amount and original opportunity ID so its account-plan links resolve to source records. Account Intelligence groups live opportunities by explicit client ID when available rather than collapsing distinct customer records with the same name. Existing grouping fallback remains a display label only; the plan API never links by that fallback name.

## Demo path

1. Open Northstar from Shared account plans; its open pipeline matches the shared $480,000 sample opportunity.
2. Start a plan, assign an actual workspace member, add an objective/review date, and record a stakeholder/blocker using team-entered evidence.
3. From Opportunities & actions, assign a legal-review action to a real member. Open Command Center and confirm the same action is present.
4. Update its status/outcome in either view; refresh the other to see the same record change.
5. Record an account decision and a team note; confirm author/timestamp in the shared feed.
6. Verify a viewer can read but cannot edit, and a second editor's stale save returns a conflict without overwriting newer work.
