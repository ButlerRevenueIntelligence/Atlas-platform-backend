import { randomUUID, createHash } from 'node:crypto';
import CashEvidenceSnapshot from '../models/CashEvidenceSnapshot.js';
const text = (v, max = 200) => String(v || '').trim().slice(0, max);
const refId = v => {
  const value = String(v || '').trim();
  if (value.length > 200) throw new Error('Provider identity exceeds detail limit');
  return value;
};
const id = v => refId(v?.id || v);
const date = v => v && Number.isFinite(new Date(v).getTime()) ? new Date(v).toISOString() : null;
const unix = v => Number.isFinite(v) && v > 0 ? date(v * 1000) : null;
const money = v => v !== null && v !== undefined && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v) * 100) / 100 : null;
// This ledger is USD-only; do not misinterpret foreign minor-unit scales.
const cents = (v, c) => currency(c) === 'USD' && Number.isSafeInteger(v) && v >= 0 ? v / 100 : null;
const currency = v => /^[A-Z]{3}$/.test(text(v).toUpperCase()) ? text(v).toUpperCase() : 'UNKNOWN';
export function invoiceFingerprint(i) {
  return createHash('sha256').update(JSON.stringify([i.id, i.customerId, i.currency, i.amount])).digest('hex');
}
function refs(metadata = {}) {
  const list = [];
  for (const [key, source] of [['atlas_deal_id', 'atlas'], ['salesforce_opportunity_id', 'salesforce'], ['hubspot_deal_id', 'hubspot'], ['pipedrive_deal_id', 'pipedrive'], ['zoho_deal_id', 'zoho_crm']]) if (typeof metadata[key] === 'string' && metadata[key].trim()) list.push({
    source,
    id: refId(metadata[key])
  });
  return list;
}
const unique = (rows, label) => {
  if (rows.length > 5000) throw new Error(`${label} exceeds the 5000-record detail limit`);
  const seen = new Set();
  for (const row of rows) {
    if (!row.id || seen.has(row.id)) throw new Error(`Missing or duplicate ${label} identity`);
    seen.add(row.id);
  }
  return rows;
};
export async function listStripeEvidence(resource, stripeAccount, params = {}) {
  const rows = [];
  let cursor;
  while (true) {
    const page = await resource.list({
      ...params,
      limit: 100,
      ...(cursor ? {
        starting_after: cursor
      } : {})
    }, {
      stripeAccount
    });
    if (!Array.isArray(page.data)) throw new Error('Invalid Stripe detail response');
    rows.push(...page.data);
    if (rows.length > 5000) throw new Error('Stripe detail limit exceeded');
    if (!page.has_more) break;
    if (!page.data.length || !page.data.at(-1)?.id || page.data.at(-1).id === cursor) throw new Error('Stripe detail pagination did not advance');
    cursor = page.data.at(-1).id;
  }
  return rows;
}
export async function listQuickBooksEvidence(request, entity) {
  if (!['Invoice', 'Payment', 'RefundReceipt'].includes(entity)) throw new Error('Unsupported accounting entity');
  const rows = [];
  let start = 1;
  while (true) {
    const result = await request({
      path: 'query',
      query: {
        query: `select * from ${entity} STARTPOSITION ${start} MAXRESULTS 500`
      }
    });
    if (!result?.QueryResponse || result.Fault) throw new Error('Invalid accounting detail response');
    const page = result.QueryResponse[entity] || [];
    if (!Array.isArray(page)) throw new Error('Invalid accounting detail page');
    rows.push(...page);
    if (rows.length > 5000) throw new Error('Accounting detail limit exceeded');
    if (page.length < 500) break;
    start += page.length;
  }
  return rows;
}
export function normalizeQuickBooks({
  invoices = [],
  payments = [],
  refunds = [],
  homeCurrency
}) {
  const warnings = [];
  const inv = unique(invoices.map(i => ({
    id: refId(i.Id),
    number: text(i.DocNumber),
    customerId: refId(i.CustomerRef?.value),
    customerName: text(i.CustomerRef?.name, 240),
    currency: currency(i.CurrencyRef?.value || homeCurrency),
    amount: money(i.TotalAmt),
    balance: money(i.Balance),
    reportedPaid: money(i.TotalAmt) !== null && money(i.Balance) !== null ? money(Math.max(0, Number(i.TotalAmt) - Number(i.Balance))) : null,
    issuedAt: date(i.TxnDate),
    dueAt: date(i.DueDate),
    status: /void|delete/i.test(text(i.TxnStatus)) ? 'void' : 'issued',
    refs: (i.CustomField || []).filter(f => f.Name === 'Atlas Deal ID' && typeof f.StringValue === 'string' && f.StringValue.trim()).map(f => ({
      source: 'atlas',
      id: refId(f.StringValue)
    }))
  })), 'invoice');
  const pay = unique(payments.map(p => {
    const allocations = [];
    let ambiguous = 0;
    for (const line of p.Line || []) {
      const links = line.LinkedTxn || [];
      if (links.length === 1 && links[0].TxnType === 'Invoice' && money(line.Amount) !== null) allocations.push({
        invoiceId: refId(links[0].TxnId),
        amount: money(line.Amount)
      });else if (links.length) ambiguous++;
    }
    const amount = money(p.TotalAmt),
      unapplied = money(p.UnappliedAmt);
    if (allocations.length > 100) throw new Error('Payment allocation detail limit exceeded');
    const allocated = allocations.reduce((s, a) => s + a.amount, 0);
    const valid = ambiguous === 0 && amount !== null && allocated <= amount + .001 && (unapplied === null || allocated <= amount - unapplied + .001);
    return {
      id: refId(p.Id),
      customerId: refId(p.CustomerRef?.value),
      currency: currency(p.CurrencyRef?.value || homeCurrency),
      amount,
      refundedAmount: null,
      date: date(p.TxnDate),
      allocations: valid ? allocations : [],
      issues: [...(ambiguous ? ['Payment contains ambiguous or non-invoice applications'] : []), ...(!valid ? ['Payment applications exceed recorded receipt or amount is unavailable'] : [])],
      kind: 'receipt'
    };
  }), 'payment');
  const ret = unique(refunds.map(r => ({
    id: refId(r.Id),
    customerId: refId(r.CustomerRef?.value),
    currency: currency(r.CurrencyRef?.value || homeCurrency),
    amount: money(r.TotalAmt),
    date: date(r.TxnDate),
    kind: 'refund_receipt'
  })), 'refund');
  if ([...inv, ...pay, ...ret].some(r => r.currency === 'UNKNOWN')) warnings.push('Some accounting records lack a currency; these are excluded from USD totals.');
  return validateSnapshot({
    invoices: inv,
    payments: pay,
    refunds: ret,
    warnings
  });
}
export function normalizeStripe({
  invoices = [],
  charges = [],
  invoicePayments = []
}) {
  const warnings = [];
  const liveInvoices = invoices.filter(i => i.livemode === true),
    liveCharges = charges.filter(c => c.livemode === true && c.paid === true && c.status === 'succeeded');
  const inv = unique(liveInvoices.map(i => ({
    id: id(i.id),
    number: text(i.number),
    customerId: id(i.customer),
    customerName: text(i.customer_name, 240),
    currency: currency(i.currency),
    amount: cents(i.total, i.currency),
    balance: cents(i.amount_remaining, i.currency),
    reportedPaid: cents(i.amount_paid, i.currency),
    issuedAt: unix(i.status_transitions?.finalized_at || i.created),
    dueAt: unix(i.due_date),
    status: text(i.status) || 'unknown',
    refs: refs(i.metadata)
  })), 'invoice');
  const pay = unique(liveCharges.map(c => ({
    id: id(c.id),
    customerId: id(c.customer),
    currency: currency(c.currency),
    amount: cents(c.amount, c.currency),
    refundedAmount: cents(c.amount_refunded, c.currency),
    date: unix(c.created),
    paymentIntentId: id(c.payment_intent),
    disputed: c.disputed === true,
    allocations: [],
    issues: [],
    kind: 'charge'
  })), 'payment');
  const seen = new Set();
  for (const row of invoicePayments) {
    if (row.livemode !== true || row.status !== 'paid') continue;
    if (!row.id || seen.has(row.id)) throw new Error('Duplicate invoice-payment identity');
    seen.add(row.id);
    const candidates = row.payment?.type === 'charge' ? pay.filter(p => p.id === id(row.payment.charge)) : row.payment?.type === 'payment_intent' ? pay.filter(p => p.paymentIntentId && p.paymentIntentId === id(row.payment.payment_intent)) : [];
    if (candidates.length !== 1) {
      warnings.push('Some invoice payments cannot be traced to exactly one successful charge; no cash allocation was inferred.');
      continue;
    }
    const p = candidates[0],
      amount = cents(row.amount_paid, row.currency);
    if (amount === null || currency(row.currency) !== p.currency) {
      p.issues.push('Invoice payment amount/currency is unavailable or inconsistent');
      continue;
    }
    p.allocations.push({
      invoiceId: id(row.invoice),
      amount
    });
  }
  for (const p of pay) {
    if (p.allocations.length > 100) throw new Error('Charge allocation detail limit exceeded');
    if (p.amount === null || p.refundedAmount === null || p.refundedAmount > p.amount || p.allocations.reduce((s, a) => s + a.amount, 0) > p.amount + .001) {
      p.allocations = [];
      p.issues.push('Charge amounts or allocations are inconsistent');
    }
    if (p.disputed) p.issues.push('Charge is disputed; receipt is not evidence of retained cash');
    delete p.paymentIntentId;
  }
  if (invoices.some(i => i.livemode !== true) || charges.some(c => c.livemode !== true)) warnings.push('Stripe test/unknown-mode objects were excluded from this live evidence snapshot.');
  return validateSnapshot({
    invoices: inv,
    payments: pay,
    refunds: [],
    warnings: [...new Set(warnings)]
  });
}
function validateSnapshot(data) {
  const edges = data.payments.reduce((s, p) => s + p.allocations.length, 0);
  if (edges > 10000) throw new Error('Snapshot allocation detail limit exceeded');
  return data;
}
export async function saveCashSnapshot({
  orgId,
  provider,
  accountId,
  environment,
  data
}) {
  return CashEvidenceSnapshot.findOneAndUpdate({
    orgId,
    provider,
    accountId: String(accountId),
    environment
  }, {
    $set: {
      ...data,
      generation: randomUUID(),
      capturedAt: new Date()
    }
  }, {
    upsert: true,
    new: true,
    runValidators: true
  }).lean();
}
