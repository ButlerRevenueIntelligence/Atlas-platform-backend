# Populated leadership demo

Only the strict Atlas Demo Company identity (`isDemoWorkspace`) receives these read-only scenario records. Live workspaces retain their existing saved-record behavior. No GET request seeds collections, invents active members or changes integration status.

## Connected views

- Command Center recovery plan: six current actions and a completed sponsor action, including blocked/overdue work, owner names, dates, outcomes and history. Decisions & results: three decisions with expected results, original evidence, linked actions, improved/worsened reviews and a due review. Account context: four local account-research profiles linked to the same opportunities and shared plans. These are not labeled as live GraphIQ retrievals or external events.
- Shared account plans: all six canonical demo accounts have objectives, stakeholders, blockers, review dates and decisions/notes. Both Deal War Room's deal-ID entry point and Account Intelligence's deal-ID entry point resolve through the same catalog to the same plan. Account-specific actions are filtered by canonical opportunity IDs.
- Revenue Planning: month and quarter forecast history for bookings and recorded revenue includes the selected period and two prior periods, with original forecast evidence, actuals and calculated variances. Completed booking periods use separate historical scenario cohort IDs; current open deals are never redated or added to those periods. Revenue history uses the existing daily demo series. Live forecasts are never synthesized or backdated.

Scenario IDs stay stable and dates roll with the current date. Saved plans override the corresponding template; saved forecasts override example forecasts for the same measure/period. Real team actions and decisions remain first in bounded views. Templates carry `isDemoRecord` in API responses so they cannot be mistaken for mutable persisted records by the UI. Template actions and decisions are read-only; managers can create new tracked records through the existing forms. Template plans can be used as a starting point: select a real active workspace owner and save before posting team notes. Real assignee membership and concurrency checks remain enforced.

Repeated fictional/sample-data banners and labels are removed from the application pages and deterministic Operator responses. The Atlas Demo Company workspace identity and internal demo mode remain intact. Live source limits, financial definitions, missing-evidence notices, and provider connection states remain intact.

## Verification

Backend tests cover canonical account links, complete plans, action/decision evidence, date rollover, calculated period variances, saved-record precedence, tenant queries and no-write reads. Populated server-render smoke checks cover leadership tabs, all six plan pages, account execution/updates, and monthly/quarterly forecast history. The production frontend build is required. Deployed browser/mobile checks remain necessary; server renders do not verify interactive browser behavior.
