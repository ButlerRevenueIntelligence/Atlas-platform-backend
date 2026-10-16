import { invoiceFingerprint } from './cashEvidence.js';
const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
const known = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export const invoiceEligible = i => i.currency === 'USD' && known(i.amount) && known(i.balance) && !['draft', 'void', 'unknown'].includes(i.status);
function automaticLink(invoice, deals) {
  if (!invoice.refs?.length) return {
    dealId: null,
    reason: 'No explicit opportunity reference'
  };
  const targets = [];
  for (const ref of invoice.refs) {
    const found = deals.filter(d => ref.source === 'atlas' ? String(d._id || d.id) === ref.id : d.externalSource === ref.source && d.externalId === ref.id);
    if (found.length !== 1) return {
      dealId: null,
      reason: 'Explicit opportunity reference is missing or ambiguous'
    };
    targets.push(String(found[0]._id || found[0].id));
  }
  if (new Set(targets).size !== 1) return {
    dealId: null,
    reason: 'Explicit opportunity references conflict'
  };
  return {
    dealId: targets[0],
    reason: 'Explicit provider reference',
    method: 'source_reference'
  };
}
export function buildRevenueToCash({
  snapshot,
  deals = [],
  links = [],
  now = new Date(),
  demo = false
}) {
  if (!snapshot) return null;
  const byInvoice = new Map(snapshot.invoices.map(i => [i.id, i])),
    byDeal = new Map(deals.map(d => [String(d._id || d.id), d]));
  const evidence = new Map(),
    paymentIssues = [];
  let unallocated = 0,
    gross = 0,
    refunds = 0;
  for (const p of snapshot.payments) {
    if (p.currency !== 'USD' || !known(p.amount)) continue;
    gross += p.amount;
    if (known(p.refundedAmount)) refunds += p.refundedAmount;
    const accepted = [];
    for (const allocation of p.allocations || []) {
      const invoice = byInvoice.get(allocation.invoiceId);
      if (!invoice || !invoiceEligible(invoice) || allocation.amount < 0 || !known(allocation.amount) || invoice.currency !== p.currency || invoice.customerId && p.customerId && invoice.customerId !== p.customerId) {
        paymentIssues.push({
          paymentId: p.id,
          reason: 'Invoice application cannot be verified against the current invoice/customer/currency'
        });
        continue;
      }
      accepted.push(allocation);
    }
    const total = accepted.reduce((s, a) => s + a.amount, 0);
    if (total > p.amount + .001) {
      paymentIssues.push({
        paymentId: p.id,
        reason: 'Applications exceed recorded receipt'
      });
      unallocated += p.amount;
      continue;
    }
    unallocated += Math.max(0, p.amount - total);
    for (const a of accepted) {
      const row = evidence.get(a.invoiceId) || {
        receipts: 0,
        refunds: 0,
        refundsComplete: true,
        payments: [],
        issues: []
      };
      row.receipts += a.amount;
      const refundable = accepted.length === 1 && Math.abs(a.amount - p.amount) < .001 && known(p.refundedAmount);
      if (refundable) row.refunds += p.refundedAmount;else if (p.refundedAmount !== null && p.refundedAmount !== undefined && p.refundedAmount > 0) row.refundsComplete = false;
      if (p.disputed) row.issues.push('Linked charge is disputed');
      row.payments.push({
        id: p.id,
        amount: a.amount,
        date: p.date,
        kind: p.kind,
        disputed: Boolean(p.disputed)
      });
      row.issues.push(...(p.issues || []));
      evidence.set(a.invoiceId, row);
    }
    for (const issue of p.issues || []) paymentIssues.push({
      paymentId: p.id,
      reason: issue
    });
  }
  for (const r of snapshot.refunds || []) if (r.currency === 'USD' && known(r.amount)) refunds += r.amount;
  const invoices = snapshot.invoices.map(invoice => {
    const eligible = invoiceEligible(invoice),
      manual = links.find(l => l.invoiceId === invoice.id),
      e = evidence.get(invoice.id) || {
        receipts: 0,
        refunds: 0,
        refundsComplete: true,
        payments: [],
        issues: []
      };
    let match = {
      dealId: null,
      reason: 'Test financial evidence is not linked to live opportunities'
    };
    if (snapshot.environment === 'live' || demo) {
      if (manual) {
        match = manual.state === 'blocked' ? {
          dealId: null,
          reason: 'Explicitly unlinked by the team'
        } : manual.invoiceFingerprint !== invoiceFingerprint(invoice) ? {
          dealId: null,
          reason: 'Invoice identity, currency or value changed after review'
        } : !byDeal.has(manual.dealId) ? {
          dealId: null,
          reason: 'Reviewed opportunity is no longer visible'
        } : {
          dealId: manual.dealId,
          reason: 'Team-confirmed association',
          method: 'team_confirmed'
        };
      } else match = automaticLink(invoice, deals);
    }
    const deal = match.dealId ? byDeal.get(match.dealId) : null;
    const issues = [...e.issues];
    if (!eligible) issues.push('Invoice is draft/void/unsupported, has missing amounts, or is outside the USD view');
    if (invoice.balance > invoice.amount) issues.push('Provider balance exceeds this invoice total; inspect carryforward/adjustments');
    if (known(invoice.reportedPaid) && Math.abs(invoice.reportedPaid - e.receipts) > .01) issues.push('Provider settlement differs from linked receipt evidence; inspect credits, adjustments or missing applications');
    if (!e.refundsComplete) issues.push('Refund spans multiple invoice allocations; invoice-level refund amount is unknown');
    if (deal && String(deal.stage).toLowerCase() !== 'closed won') issues.push('Linked opportunity is not currently Closed Won');
    return {
      ...invoice,
      eligible,
      overdue: eligible && invoice.balance > 0 && invoice.dueAt && new Date(invoice.dueAt) < new Date(now.toISOString().slice(0, 10)),
      match,
      deal: deal ? {
        id: String(deal._id || deal.id),
        name: deal.name,
        stage: deal.stage,
        amount: deal.amount,
        account: deal.clientName || deal.accountName || ''
      } : null,
      review: manual ? {
        _id: manual._id,
        __v: manual.__v,
        state: manual.state,
        note: manual.note,
        authorName: manual.authorName,
        updatedAt: manual.updatedAt,
        history: manual.history || []
      } : null,
      receipts: round(e.receipts),
      linkedRefunds: snapshot.environment === 'live' && snapshot.provider === 'stripe' && e.refundsComplete ? round(e.refunds) : null,
      payments: e.payments,
      issues: [...new Set(issues)]
    };
  });
  const eligible = invoices.filter(i => i.eligible),
    linked = eligible.filter(i => i.deal),
    won = deals.filter(d => String(d.stage).toLowerCase() === 'closed won'),
    linkedIds = new Set(linked.map(i => i.deal.id));
  const unmatchedWon = won.filter(d => !linkedIds.has(String(d._id || d.id))).map(d => ({
    id: String(d._id || d.id),
    name: d.name,
    amount: d.amount,
    account: d.clientName || d.accountName || ''
  }));
  return {
    invoices,
    unmatchedWon,
    paymentIssues,
    totals: {
      invoiced: round(eligible.reduce((s, i) => s + i.amount, 0)),
      outstanding: round(eligible.reduce((s, i) => s + i.balance, 0)),
      overdue: round(eligible.filter(i => i.overdue).reduce((s, i) => s + i.balance, 0)),
      grossReceipts: round(gross),
      recordedRefunds: round(refunds),
      unallocatedReceipts: round(unallocated),
      linkedWonValue: round(won.filter(d => linkedIds.has(String(d._id || d.id))).reduce((s, d) => s + Number(d.amount || 0), 0)),
      eligibleInvoices: eligible.length,
      linkedInvoices: linked.length,
      unmatchedInvoices: eligible.length - linked.length,
      excludedInvoices: invoices.length - eligible.length,
      excludedPayments: snapshot.payments.filter(p => p.currency !== 'USD' || !known(p.amount)).length,
      excludedRefunds: (snapshot.refunds || []).filter(r => r.currency !== 'USD' || !known(r.amount)).length
    },
    receiptLimit: snapshot.provider === 'quickbooks' ? 'QuickBooks Payments are recorded customer receipts, potentially undeposited. RefundReceipt totals are shown separately; other refund methods, SalesReceipts, journal entries and bank reconciliation are not covered.' : 'Successful live Stripe charges are gross receipts before fees, payouts and disputes. Recorded charge refunds are shown separately; invoice settlement can also include credits or out-of-band payments.',
    warnings: snapshot.warnings || []
  };
}
export function demoCashSnapshot(deals, now = new Date()) {
  const won = deals.filter(d => String(d.stage).toLowerCase() === 'closed won'),
    open = deals.find(d => String(d._id || d.id) === 'demo-deal-1');
  const make = (id, deal, amount, balance, due) => ({
    id,
    number: id,
    customerId: 'sample-' + (deal?.clientName || deal?.accountName || id),
    customerName: deal?.clientName || deal?.accountName || 'Unmatched sample customer',
    currency: 'USD',
    amount,
    balance,
    reportedPaid: amount - balance,
    issuedAt: new Date(now - 20 * 86400000).toISOString(),
    dueAt: new Date(now.getTime() + due * 86400000).toISOString(),
    status: 'issued',
    refs: deal ? [{
      source: 'atlas',
      id: String(deal._id || deal.id)
    }] : []
  });
  const invoices = [make('sample-invoice-1', won[0], 64000, 24000, -5), make('sample-invoice-2', won[1], 97000, 0, -3), make('sample-invoice-3', open, 120000, 80000, 10), make('sample-invoice-4', null, 15000, 15000, -7)];
  const payments = invoices.slice(0, 3).map((i, n) => ({
    id: 'sample-payment-' + n,
    customerId: i.customerId,
    currency: 'USD',
    amount: i.amount - i.balance,
    refundedAmount: null,
    date: new Date(now - 7 * 86400000).toISOString(),
    allocations: [{
      invoiceId: i.id,
      amount: i.amount - i.balance
    }],
    issues: [],
    kind: 'receipt'
  }));
  payments.push({
    id: 'sample-unapplied-payment',
    customerId: 'sample-unmatched',
    currency: 'USD',
    amount: 3500,
    refundedAmount: null,
    date: now.toISOString(),
    allocations: [],
    issues: [],
    kind: 'receipt'
  });
  return {
    provider: 'quickbooks',
    accountId: 'atlas-sample-ledger',
    environment: 'demo',
    generation: 'sample-' + now.toISOString().slice(0, 10),
    capturedAt: now,
    invoices,
    payments,
    refunds: [],
    warnings: []
  };
}
