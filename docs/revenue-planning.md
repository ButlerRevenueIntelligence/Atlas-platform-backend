# Revenue targets and forecast-versus-actual

Deploy the backend first, then the frontend. No new credentials or environment variables are required. The new `revenue_targets` and `forecast_snapshots` collections are created by Mongoose; target identities have a unique compound index for workspace, period, and measure. No existing metrics, deals, targets, or credentials are seeded, deleted, or rewritten.

## Workflow

Open **Revenue Planning** from Core navigation, Overview's **Targets & Forecasts** card, or Command Center. Choose a calendar month/quarter and a measure. Owner/admin/manager members can set the shared target and save forecasts. Other active members can read the plan and history.

Measures remain distinct:

- **CRM won value:** USD Closed Won amounts dated by `closedAt`, falling back to expected close only when an outcome timestamp is unavailable. This is opportunity won value, not recognized revenue or cash collection. Undated wins are excluded and counted.
- **Recorded revenue:** explicitly selected Stripe, Shopify, or imported daily metrics. Sources are never summed together, preventing payment/commerce duplicates. The selection is stored with each target and forecast rather than silently switching to a new preferred source. QuickBooks period accounting totals are not added.
- **Sample recorded revenue:** demo-only, rejected for real workspaces. Shares Overview's last-30-day sample formula; extra sample history is display-only.

Actual attainment, the remaining target gap, and potential pipeline coverage are labeled separately. The Overview card reads persisted current-month/current-quarter targets, using the most recently updated measure for each period, and links back to that exact plan. It no longer compares a rolling 30-day actual with an assumed monthly target or a rolling 90-day forecast with a calendar-quarter result.

## Forecast rules

CRM model = observed won value in the selected period + amount × probability for open deals expected to close from today through the exclusive period end. Overdue open close dates are excluded until reviewed; missing dates and overdue counts are disclosed. Closed, lost, archived, foreign-currency, and out-of-period records do not contribute to potential coverage.

Recorded-revenue model = selected-source revenue through the last completed UTC day + trailing-30-day average × remaining calendar days. All 30 original daily source observations are required; display zero-fill rows do not establish completeness. Original zero-value observations remain valid. If history is insufficient, the model is unavailable rather than inventing a forecast. Managers can still save an explicitly labeled leadership estimate with required rationale. Current-day partial revenue is excluded; it is not added again to the projection.

Calendar boundaries use **UTC**, not the viewer's device timezone. Future periods project only their own days. Imports and transaction dates may be incomplete; observed results are not certified accounting results. Provider freshness and missing evidence are shown.

## History and access

Forecasts preserve the server's save time, original target, actual at save, model total, chosen estimate, assumptions, source, calculation version, original revenue observations, and relevant opportunity records. There is no endpoint to edit/delete/backdate snapshots. Later target edits or corrections never rewrite the saved forecast. Target updates use version checks; concurrent edits return 409 and history is retained for the latest 50 revisions.

Forecast history shows the latest 50 snapshots for the selected measure across periods. The forecast remains fixed; observed results are recalculated from current records using the original measure and exact period. Variance = observed actual minus saved full-period forecast and is only calculated after period end. A missing revenue dataset remains unavailable, not a zero-revenue miss. Percent variance is unavailable for a zero forecast. No synthetic accuracy score or overlapping-window aggregate is generated. Opportunity changes include expected close, stage, value, probability, action deadlines, and recorded outcome-date corrections. Changes are observations, not proof of causation.

All endpoints under `/api/revenue-planning` require authentication, CORE access, `dashboard.view`, and an explicitly active workspace membership. All reads and writes use the canonical workspace ID; body-supplied tenant/actor/evidence/totals/save-time values are ignored. Writes require owner/admin/manager. Completed-period target edits and retrospective forecasts are rejected.

- `GET /plan?period=YYYY-MM|YYYY-QN&metric=...`
- `GET /summary`
- `PUT /target` with period, metric, amount, and version (`null` for first save)
- `POST /snapshots` with period, metric, label, optional rationale; optional numeric forecastOverride requires rationale

Interactive periods range from 18 months before to 15 months after the current month. Revenue observation reads cover 730 days. Older saved snapshots remain readable, but absent historical revenue data is marked unavailable. Demo dates roll forward, so sample history is rehearsal data, not a production forecast-accuracy claim. Reads do not create demo forecasts or targets; fallback targets are explicitly labeled sample targets.

## Verification and demo

`npm test` covers calendar/quarter/leap-year boundaries, source isolation, exclusion of partial today, genuine-zero versus missing days, forecast evidence, period-end scoring, outcome-date corrections, permissions, tenant isolation, version conflicts, and tamper-resistant server capture. Database boundaries are mocked. The frontend production build and populated render checks are separate; real browser/database verification is required after deployment.

For a reproducible sample as of October 15, 2026: the Q4 CRM plan has $161,000 won, $963,950 weighted open, and a $1,124,950 model. A $1.5M target has $375,050 remaining after potential coverage. Monthly and quarterly windows intentionally differ. Save a named forecast, inspect its original evidence, and revisit after subsequent source updates; in-progress periods never display a premature forecast miss.
