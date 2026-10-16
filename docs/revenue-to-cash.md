# Revenue to cash

Adds `/api/revenue-to-cash` and `/revenue-to-cash`, reachable from Command Center and Revenue Planning. The screen traces supported invoices to opportunity references and actual payment application evidence. It is an operational evidence view, not revenue recognition, a bank reconciliation, a collections forecast, or a general ledger.

## Rollout

Deploy backend before frontend, then run the existing QuickBooks or Stripe sync. No new credentials, scopes or environment variables are introduced. Existing aggregate-only snapshots cannot populate this view. Verify a real provider detail import and browser behavior after deployment; unit tests use fixtures and mocked persistence/provider boundaries.

Two new collections require their Mongoose unique indexes to be present: `cash_evidence_snapshots` (workspace/provider/account/environment) and `cash_opportunity_links` (same scope plus invoice ID). Review authors and bounded history are server generated. Reads never seed evidence or reviews.

## Source and amount boundaries

- Select QuickBooks or Stripe; never add both sources together. One transaction can exist in both systems. Different source totals are not a reconciliation.
- USD only. No exchange-rate conversion. Foreign/unknown currency records are excluded and counted. Foreign Stripe minor-unit values are deliberately unavailable rather than incorrectly scaled.
- Totals cover the imported detail snapshot, not the current month or quarter. Distinct linked Closed Won opportunity value has a different population from all supported source invoices/payments. The UI never subtracts these measures as a waterfall.
- QuickBooks imports all available Invoice, Payment and RefundReceipt records. Payment Line LinkedTxn must identify exactly one Invoice. Ambiguous/credit/mixed applications do not establish an invoice cash link. Unapplied receipts remain separate. Provider balance reductions can include credits and adjustments. Home currency is read from Preferences.CurrencyPrefs.HomeCurrency when a transaction lacks CurrencyRef; absent currency stays unknown. RefundReceipt does not cover all refund mechanisms, journal entries or SalesReceipts. Payments can be undeposited; no bank-cleared assertion.
- Stripe imports live invoices and successful paid live charges, using paid Invoice Payments to trace a charge or payment intent to an invoice. A payment intent must resolve to exactly one successful charge. Payment-record/out-of-band or otherwise unresolved invoice payments are not inferred as cash. Invoice `amount_paid` is settlement evidence, not charge evidence. Gross charges remain separate from refunds, fees, payouts and disputes. A refund can be assigned to an invoice only when the entire charge has one verified invoice application; multi-invoice refunds are not allocated proportionally.
- A fully refunded charge remains a gross receipt with a separate refund. Provider invoice balance remains authoritative for this display; refunds do not automatically reopen it. Draft/void/unknown invoices and missing amounts are excluded from invoice totals. QuickBooks may retain voided invoices with zero totals even without a void status.
- QuickBooks sandbox details are explicitly labeled and cannot link to live CRM opportunities. Stripe test and unknown-mode objects are excluded. The strict Atlas demo workspace uses a fictional, internally reconciled scenario and never reads live financial evidence. Saved demo reviews remain scoped to the sample ledger.

## Opportunity association

Automatic links require explicit, exact, case-sensitive identifiers. No name, email, domain, customer-name or amount similarity is used.

| Source | Explicit reference |
| --- | --- |
| Stripe invoice metadata | `atlas_deal_id`, `salesforce_opportunity_id`, `hubspot_deal_id`, `pipedrive_deal_id`, `zoho_deal_id` |
| QuickBooks invoice CustomField | exact Name `Atlas Deal ID`, StringValue is local Atlas deal ID |

Every explicit reference must resolve uniquely to the same currently visible workspace opportunity. Conflicting, unknown and duplicate targets remain unlinked. External references also require the correct CRM provider. Current nonarchived USD opportunities are used; invoices can link to open opportunities, with a visible exception.

Owners/admins/managers may confirm an association or explicitly keep an invoice unlinked with a required reason. Explicit unlink overrides automatic metadata. One invoice has one association, many invoices may link to the same opportunity. Review fingerprints cover invoice ID/customer/currency/total; changes invalidate the association. Balance/date changes preserve it. Removed opportunities become unresolved. Reviews use optimistic versions, snapshot generations, a unique index, and a 20-entry history. Stale edits return 409. No invoices, payments or opportunities are modified by review.

## Import consistency and failures

Detail imports supplement existing aggregate syncs. A detail failure records `metadata.cashEvidenceStatus=failed` without replacing the previous complete cash snapshot or failing an otherwise successful aggregate import. These states are separate; overall integration success does not imply detail success. Current financial account and environment must match the snapshot lookup. Account switches cannot display or reuse another account's snapshot/reviews. A previously captured, disconnected, failed or >24-hour snapshot is visibly flagged.

Pagination is bounded at 5,000 invoices, 5,000 payments/charges and 5,000 RefundReceipts, 100 applications per payment and 10,000 applications per snapshot. Oversized, malformed or duplicate batches fail the detail import rather than publishing a truncated ledger. All complete normalized arrays replace one snapshot document atomically; failed fetch/normalization/write retains the prior document. Stripe charge retrieval itself follows the existing aggregate sync; detail validation still enforces its bound. Provider pagination is not a transactionally frozen export, and overlapping syncs across service instances are not serialized by this feature. Snapshots show capture time, not an assertion of provider transactional isolation.

Reads require authentication, CORE plan, both dashboard.view and command_center.view, and an explicit active membership. Search/filter invoice results are paginated by 25; supplementary exception lists are capped at 100 and opportunity search at 50. Only normalized financial fields are stored/returned; no payment credentials, tokens, card details or raw provider payloads.

## Validation after deployment

1. Run each connected provider's normal sync, verify detail status separately, and inspect a real invoice/payment/customer/currency trail.
2. Inspect paid-with-credit, unapplied payment, refund, dispute, multi-invoice payment and missing-currency examples.
3. Confirm account switch/sandbox behavior, manager vs viewer controls, and concurrent-review 409 behavior against the deployed database/indexes.
4. Test mobile, keyboard, draft preservation, source/filter pagination and workspace switching in a browser. Frontend build and populated server render checks do not establish interactive browser behavior.

Primary API references: [Stripe Invoice](https://docs.stripe.com/api/invoices/object), [Stripe Invoice Payments](https://docs.stripe.com/api/invoice-payment/list), [QuickBooks Invoice](https://developer.intuit.com/docs/api/accounting/invoice), [QuickBooks Payment](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/payment), [QuickBooks RefundReceipt](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/refundreceipt), [QuickBooks query pagination](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries).
