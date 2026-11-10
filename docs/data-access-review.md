# Customer data access review

## Delivery status

This branch implements the connection review and backend controls. It does not publish an approved DPA, change production settings, establish provider contract terms, or implement a new deletion service. `DATA_ACCESS_MODE` defaults to `off`. The checked-in policy is explicitly unapproved and cannot be accepted, even if a caller directly invokes the acceptance endpoint.

The matching frontend branch is `feat/data-access-review` in Atlas-platform-frontend. It includes a Data & Privacy page, full document text, source review, required unchecked acknowledgments, and acceptance receipt download.

## Code findings from main at implementation time

| Area | Verified in source | Still requires production evidence |
|---|---|---|
| AI | `routes/ai.js` calls OpenAI Chat Completions with `gpt-4o-mini`. `askAtlasMessages` sends the question, server-loaded evidence, up to 100 deals, up to 50 accounts, and selected external company/news context. Some specific questions use internal deterministic answers instead. | Whether this branch is deployed, API organization/project settings, executed provider agreement, training rules, abuse-monitoring retention, locations and human access. No zero-retention promise is made. |
| CRM permissions | HubSpot requests contact/company/deal/schema read scopes; Zoho requests account/deal/org read scopes; Salesforce requests `api refresh_token offline_access`; Pipedrive grant depends on application configuration. | Actual approved grants, authorized fields, application scope settings, account-level permissions and imported historical coverage. |
| Advertising | Google Ads requests adwords and sign-in scopes; Meta requests ads_read, ads_management and business_management; LinkedIn requests reporting/read access. | Actual granted scopes and provider app settings. Google/Meta scopes must not be called universally read-only. |
| Accounting/payments | QuickBooks requests the accounting scope; Stripe OAuth requests read_write. | Whether permissions can be narrowed without breaking operations; actual scope grants. |
| Shopify | Default scopes are read_products, read_customers and read_orders; SHOPIFY_SCOPES may override them. | Actual deployed SHOPIFY_SCOPES and granted access. |
| Slack | Slack requests chat:write/incoming-webhook. Alerts, deal risks, research notifications and executive briefings can send workspace information to a configured channel. | Destination access, customer-selected channel membership, retention and provider contract. |
| External research | GraphIQ organization search sends the organization search object. MCP searches and monitoring transmit research criteria. Company snapshots have expiry fields. | Complete production data flow, cache deletion mechanism, vendor retention and transfer terms. An expiry field alone is not proof that all copies are deleted. |
| Storage | MongoDB models store imported business records. Integration token setters implement AES-256-GCM using INTEGRATION_TOKEN_ENCRYPTION_KEY. Token decryption still supports legacy plaintext values. | Whether all live records have been migrated, key management, encryption of other stored data/backups, database/host region and support access. Do not claim all customer data is encrypted based only on token setters. |
| Deletion | Disconnect logic clears connection credentials/state; imported clients, deals, metrics and snapshots are distinct records. | Verified export/deletion process, deadlines, backup lifetime, logs, lawful retention and vendor deletion. Disconnect must not be represented as complete deletion. |

The draft screen contains conservative summaries, not a completed field-by-field contractual schedule. A source can only become accept-ready with explicitly approved imports/access/version and an approved, completed common policy and document set. The automated checks detect empty values and obvious placeholders; they cannot determine legal accuracy or operational truth.

## Backend controls

- `/api/data-access/:provider` returns the exact current disclosure, document text, content digest, readiness, membership eligibility, and current receipt.
- `POST /api/data-access/:provider/accept` accepts only a live active owner/admin membership plus explicit authority and processing acknowledgments. Agreement acceptance is required if no receipt for the same common agreement content exists in the workspace. Global/super-admin role bypasses are not used here.
- Receipts preserve server-owned text, checkbox wording, digest, authenticated workspace/user/email and server time. Application endpoints are create/read only; these are not a WORM archive and a database administrator can still modify the collection. Add appropriate DB access/audit policies and retention before launch.
- `/api/data-access/receipts/:id` scopes retrieval to the authenticated workspace.
- In enforce mode, shared integration authorization routes require the initiating administrator's current source acceptance. OAuth state additionally binds a one-time attempt to the workspace/user/provider/receipt/digest, preserves provider-specific PKCE fields, and expires in ten minutes. Callback processing revalidates active administrator membership and atomically consumes the attempt before provider token exchange. In-flight pre-release states must be restarted when enforcement is enabled.
- Manual sync, registered scheduled sync, spreadsheet imports, AI analysis and GraphIQ API routes are gated on the current accepted disclosure. Scheduled imports missing acceptance are skipped before connection status mutation, rather than falsely reporting an OAuth disconnection.
- Slack alert/briefing send paths require current Slack-source acceptance; GraphIQ monitoring requires a current workspace data-use acceptance. GoHighLevel's legacy unsigned authorization flow is explicitly unavailable under enforce mode pending its own repair.
- Inventory, disconnect, existing stored-data views, billing, and local demo connector operations remain accessible. Demo exploration must not be confused with authorization for real imports. The AI endpoint still requires acceptance under enforcement because user prompts themselves can contain confidential information.

## Complete the policy

Edit `config/dataAccessPolicy.json`, or set `DATA_ACCESS_POLICY_FILE` to a secured JSON file using the same schema. The path is controlled by the deployment, never by a customer request. Do not place secrets in the policy: its content is shown to workspace members.

1. Fill legalEntity, reviewedAt (ISO date), and a version identifier.
2. Replace each common statement with a verified description: purpose, AI inputs/recipients/training/human review/retention, all other recipients, sale/advertising/unrelated use, storage/access, retention/deletion/export, and contact.
3. Supply finalized plain-text agreement, Terms, Privacy Policy and provider list in `documents`. Coordinate those versions with the public website and customer handout. Include applicable customer identity/order-form context and transfer schedules in the legal documents.
4. For each source, add `connectors.<provider>` with approved, version, imports, and access. Make the imported fields/history and scopes explicit. A connector lacking approval remains unavailable under enforce mode.
5. After factual verification and legal review, set the common `approved` and approved sources' `approved` values to true. Record the actual reviewer evidence outside the customer-facing policy.

Receipts hash the full server-owned source disclosure. Editing text invalidates old source acceptance even without changing the version. Version and agreement/common-content changes affect reuse of organization agreement acceptance. Plan the notification/reacceptance process before changing policy content in enforce mode.

## Staging and release

1. Deploy backend code before frontend code. Keep production `DATA_ACCESS_MODE=off` during preparation; current connections continue normally. Do not describe the gate as active.
2. In a staging environment with test workspaces only, set `DATA_ACCESS_MODE=preview`. Connections follow the review screen with a clear preview continuation; no draft agreement can be accepted. The Data & Privacy page can be inspected in off mode too. Do not treat preview continuation as contractual acceptance.
3. Populate an approved test policy and use `DATA_ACCESS_MODE=enforce` in staging. Test an actual owner, admin, non-admin, removed member and another workspace. Exercise provider denial, cancellation, stale policy, replay, QuickBooks and a PKCE provider, Bitrix webhook, spreadsheet upload, AI, GraphIQ and scheduled imports. Confirm receipt JSON preserves the version that was accepted. Reconcile the UI against actual provider consent screens.
4. Notify existing customer admins and arrange the acceptance window before enabling production enforcement. Enforce mode pauses imports, external AI/research and Slack delivery for workspaces/sources without current acceptance; it does not delete or revoke saved provider connections. No grandfathered consent is manufactured.
5. Publish the verified/legal-reviewed documents and customer overview; activate enforcement only once the business has completed the review and customer rollout. Monitor both acceptance failures and provider callbacks. A pending review is not a provider authorization failure.

No real customer data, vendor account settings or production database was accessed during development. Code tests cannot verify vendor contracts, deployed environment settings, deletion execution or live account access.

## Validation

`npm test`: includes data-access tests covering draft rejection, changed text, missing acceptance, role checks, direct imports, immutable content capture, tenant-scoped receipt lookup, signed state, PKCE preservation, callback replay, removed membership and AI reacceptance.

Frontend: `npm ci --legacy-peer-deps`, `npm run build`. Browser layout/interaction testing must be completed in staging if the development environment prevents Chromium from launching.
