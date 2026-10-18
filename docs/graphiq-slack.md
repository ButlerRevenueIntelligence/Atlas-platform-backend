# GraphIQ Slack notifications

New GraphIQ news and company results retrieved from Market Signals or Account Intelligence can notify the workspace's existing Slack incoming webhook. Both MCP searches and legacy company searches participate. Operator searches, cached history reads, demo fixtures and empty/unstructured responses do not send notifications. Opt-in [continuous monitoring](graphiq-monitoring.md) also retrieves saved searches on a schedule. Cached history is not backfilled.

## Controls and payload

Notifications default on when Slack is connected in live mode. Workspace owners, admins and managers can turn them off in either GraphIQ research panel; other members can see the destination and delivery status. The backend uses the authenticated workspace and its stored webhook, never a destination supplied by the search request. Settings and delivery status are scoped to GraphIQ without replacing other integration metadata or global sync status.

Each digest includes workspace, search, retrieval time, up to five source details, a count for additional results (up to 20 results per search), and links to both Atlas pages. Provider content uses plain-text blocks; webhook credentials never reach the browser or payload. Source reporting is not presented as buying intent or a verified CRM account match.

## Delivery semantics

The `graphiq_slack_deliveries` collection requires its unique index on `orgId`, `destination`, `fingerprint` and its TTL index on `expiresAt`. Ensure production MongoDB index creation is enabled or create these indexes through the deployment's normal index-management process. Claims are tenant- and destination-specific, suppressing repeated and concurrent retrievals across both pages for 30 days. TTL cleanup is asynchronous. Changing the webhook creates a separate destination scope.

News deduplicates by canonical source URL (tracking parameters removed), falling back to title, publisher and publication time. Company profiles deduplicate by name, website and description; a description change can notify again. Claims and payloads cap at 20 normalized results.

Slack must return HTTP success with body `ok` to count as accepted. The UI does not claim channel readership or downstream delivery. Definite HTTP rejections become retryable after a bounded delay, only when a later matching retrieval occurs; there is no separate Slack retry worker; a later saved-search check can retry a definite rejection. Network timeouts, server failures, unexpected success bodies, and failures persisting an attempted delivery are treated as uncertain and are not automatically resent. A process crash during sending also leaves the claim held until expiry. This favors avoiding duplicate notifications and is not an exactly-once guarantee.

Research remains available if Slack is absent, disabled or fails. The UI shows acceptance, rejection, uncertain delivery or a skipped duplicate. Production GraphIQ access and an actual end-to-end Slack delivery must be checked after deployment; automated delivery tests mock Slack and do not send channel messages.

## Deployment order

Deploy the backend before the frontend. No new environment variables are required: use the existing GraphIQ key, integration-token encryption key and connected Slack webhook. Verify the database indexes, check the GraphIQ connection from Atlas, retrieve a new result from each page, and confirm the message in the configured Slack channel. Repeat a result to check deduplication and turn notifications off to check the workspace control.
