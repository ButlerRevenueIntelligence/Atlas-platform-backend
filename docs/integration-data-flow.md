# Integration data flow repair

Active code lives in `routes/`, `services/`, and `jobs/`. The similarly named files at the repository root are not the server's route imports.

## Behavior

- Dashboard, Operator, executive boards, metrics, attribution activity, and Slack executive briefings use `getUnifiedWorkspaceData`.
- Sync jobs reuse registered manual import handlers. Stripe, HubSpot, Zoho, Pipedrive, Salesforce, Shopify, QuickBooks, Bitrix24, Google Ads, GA4, Meta Ads, and LinkedIn Ads are scheduled every 15 minutes.
- A connection or account selection does not claim that data has been imported. Provider errors fail the sync instead of populating fabricated zero records.
- Account and Client collections remain compatible with existing pages. Imported Shopify/Salesforce deals reference canonical Clients. Legacy Account references are resolved for unified reads until repaired.
- Payment revenue, CRM closed-won bookings, advertising conversions, GA4 leads, and QuickBooks accounting totals remain distinct measures. Payment revenue prefers Stripe, then Shopify, then imported daily metrics; it does not add the same sale from several systems.
- Advertising imports are stored by workspace, provider, selected account, and date. Changing the selected account does not add the previous account's performance into current totals. GA4 leads use the `generate_lead` event. Advertising conversions are separately recorded.
- Daily reports use UTC calendar days. Provider-local reporting dates are retained as supplied; no unverified timezone shift or FX rate is applied.
- Executive monetary totals currently report USD. Known non-USD records are excluded with a visible notice. Multi-currency reporting and full FX conversion are not implemented in this change.
- Stripe revenue uses successful paid charges net of refunds, grouped by date and currency in `stripe_revenue_daily_v2`. The legacy collection is retained; it is read until the first successful new sync. The new collection avoids changing a production unique index in place.
- QuickBooks financial cards show the accounting snapshot's own period and currency. YTD accounting income is not added to trailing 30-day payment revenue.
- Global Revenue Map labels regional values as closed-won bookings. It does not claim geographic allocation of Stripe payment revenue.
- GraphIQ searches are cached per workspace for 24 hours, shared by Account Intelligence and Market Signals, and referenced by snapshot ID in Operator requests. The server loads only the snapshot belonging to the authenticated workspace.
- Live Growth Engine attribution splits and report scores no longer use invented percentages. Deal-to-channel revenue attribution stays unavailable until transaction/deal associations are recorded.

## Validation

`npm test` runs regression cases for duplicate revenue, refunds, unsuccessful charges, currencies, calendar windows, old deals closing in the current period, pipeline filtering, source selection, account links, provider response mapping, pagination, token renewal, failed provider requests, and tenant authorization.

The frontend builds with the existing compatibility dependency resolution: `npm ci --legacy-peer-deps`, then `npm run build`. Its pre-existing React 18 / React Three peer dependency mismatch and bundle size warning are not redesigned here.

## Deployment and live verification

1. Review and deploy the backend branch, then the matching frontend branch. Do not merge one and leave the other indefinitely: Operator external intelligence now expects server-issued GraphIQ snapshot IDs.
2. Use the existing provider credentials and scopes. Google Ads requires the developer token and a selected client account; GA4 requires Data API access and a selected property. LinkedIn requires reporting access. Missing permissions must surface as failed syncs rather than successful data ingestion.
3. Run `npm run integration:repair-links` against the deployment environment to preview existing imported links, then `npm run integration:repair-links -- --apply` to repair them. This does not delete source accounts or deals. It creates missing Clients and replaces matching imported deal links within the same workspace.
4. Run a manual sync for each connected provider. Existing Stripe data is corrected by a full new successful sync; until then legacy totals may still contain the historical aggregation errors.
5. Compare the provider's report against Atlas for the same reporting period, account, and currency. Check Command Center/Overview, Deal Room, Deal War Room, Growth Engine, Accounts, Account Intelligence, Market Signals, Reports, Board Mode, Global Revenue Map, and Operator. Confirm that member/invite actions remain scoped to the chosen workspace.
6. Repeat in another workspace and confirm that neither records nor GraphIQ results appear across tenants. Confirm provider errors and recovery states in Integrations.

No production database or live provider credentials were used during the local tests. They validate the code and response mapping, not current provider permission grants or deployed production data. Real account validation remains required before calling all integrations verified end to end.
