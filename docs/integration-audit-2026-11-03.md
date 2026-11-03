# Integration review — November 3, 2026

This review checks repository implementations and mocked provider responses. It does not certify live installations: production credentials, provider approvals, account permissions, token renewal and imported totals must be checked after deployment. No live messages were sent or integrations disconnected during this review.

## Changes

- Zoho CRM: support V8 page tokens beyond 2,000 records; reject malformed and nonadvancing pages instead of accepting an incomplete import. HTTP 204 remains a valid empty result.
- QuickBooks: detect provider Fault responses even with HTTP 200; reject empty/malformed JSON instead of importing a zero financial report.
- GA4: discover all account/property summary pages; detect pagination loops. Optional Google profile lookup no longer blocks a valid Analytics grant.
- LinkedIn Ads: follow cursor pagination for accounts and campaigns, renew expired tokens when refresh credentials are available, retain the saved advertising account across list reorder/reconnection, and fail if access to that account disappears. Apps without programmatic refresh access still require reconnection on expiration.
- Meta Ads: fail explicitly if access to the saved ad account disappears rather than switching to a different account.
- Slack: retain OAuth token-rotation fields and renew an expired bot token before an explicit disconnect/revoke. Incoming webhook notifications remain separate from bot-token expiration. Token revocation is not a claim of uninstalling the entire Slack app.
- Pipedrive: normalize an optional /api suffix and use /api/v1/users/me consistently for company-domain OAuth profile requests; existing CRM imports remain on API v2.
- Google: reject an incomplete token renewal response before overwriting stored credentials.

## Coverage and version decisions

| Integration | Reviewed implementation | Decision / remaining check |
| --- | --- | --- |
| HubSpot | OAuth renewal, CRM cursor imports, 2026-03 API paths | Retain supported date version; validate live scopes and CRM totals after deploy. |
| Salesforce | OAuth/session retry, nextRecordsUrl, v65.0 | Retain supported version; verify selected Salesforce org and live sync. |
| Zoho | Regional API domain, token renewal, CRM V8 imports | Pagination corrected; verify large live imports and regional authorization. |
| Pipedrive | OAuth company domain, refresh/retry, v2 cursor imports | Profile URL corrected; verify new installation and renewal. |
| Bitrix24 | Company/deal imports and next-page handling | No version change; verify tenant credentials and imported totals. |
| Stripe | SDK 20.4.x pinned API behavior, customer/charge pagination and successful paid cash | Retain current SDK major; changing major/API versions needs a separate billing compatibility review. |
| Shopify | OAuth renewal, 2026-07 Admin API, Link pagination, paid-order filtering | Retain supported stable version. REST importer remains legacy; plan GraphQL migration before new public-app distribution. |
| QuickBooks | Rotated OAuth credentials, reports, fault handling, cash evidence status | Fault handling corrected; verify realm, authorization and report totals. |
| GA4 | OAuth, Admin account discovery, v1beta reporting | Account pagination corrected; verify property selection and live daily metrics. |
| LinkedIn Ads | 202608 API version, OAuth renewal, account/campaign discovery and reporting | Keep supported version; pagination and account continuity corrected. Initial connection retains existing first-account default. |
| Meta Ads | v26.0 discovery/reporting and account continuity | Account continuity corrected. Official changelog retrieval was rate-limited; version support/app approval still needs provider-console verification. Initial connection retains existing first-account default. |
| Slack | OAuth v2, webhook delivery, token rotation, explicit revoke | Rotation metadata corrected; verify channel access and delivery after deploy. |
| GraphIQ | Dynamic MCP tool/schema discovery, company/news adapter, monitoring and notification deduplication tests | No forced protocol/schema replacement; verify live provider access and a scheduled monitoring check. |

## Validation

- Full backend suite: 365 tests pass, including 17 new maintenance regressions.
- New regressions cover Zoho and LinkedIn pagination, saved LinkedIn account identity, renewal validation, QuickBooks HTTP-200 faults, GA4 discovery, Slack rotation/callback persistence, Pipedrive URLs and malformed Google renewal responses.
- External calls in these regressions are mocked. Existing ingestion tests cover provider metrics, account/workspace isolation and notification behavior; they do not prove production account health.
- Supported API versions were retained where no migration was required. This review does not claim every SDK is the newest published major.

## Provider references

- [HubSpot API versions](https://developers.hubspot.com/docs/api/how-to-use-hubspot-api)
- [Salesforce API versions](https://developer.salesforce.com/docs/platform/api-rest/guide/resources-versions.html)
- [Zoho V8 Get Records](https://www.zoho.com/crm/developer/docs/api/v8/get-records.html)
- [Pipedrive OAuth authorization](https://pipedrive.readme.io/docs/marketplace-oauth-authorization) and [Users API](https://developers.pipedrive.com/docs/api/v1/Users)
- [Bitrix24 deal list](https://apidocs.bitrix24.com/api-reference/crm/deals/crm-deal-list.html)
- [Stripe API versioning](https://docs.stripe.com/api/versioning)
- [Shopify API versioning](https://shopify.dev/docs/api/usage/versioning) and [REST Admin API](https://shopify.dev/docs/api/admin-rest)
- [QuickBooks errors](https://static.developer.intuit.com/output_html/qbo/docs/develop/troubleshooting/error-codes.html)
- [GA4 Admin account summaries](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/accountSummaries/list) and [runReport](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport)
- [LinkedIn versions](https://learn.microsoft.com/en-us/linkedin/marketing/versioning), [pagination](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/cursor-based-pagination), and [refresh tokens](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens)
- [Slack OAuth](https://docs.slack.dev/authentication/installing-with-oauth/) and [token rotation](https://docs.slack.dev/authentication/using-token-rotation/)
