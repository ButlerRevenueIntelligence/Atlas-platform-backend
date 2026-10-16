import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuickBooks as qbo, normalizeStripe as stripe, invoiceFingerprint, listStripeEvidence, listQuickBooksEvidence, saveCashSnapshot } from '../services/cashEvidence.js';
import { buildRevenueToCash as build, demoCashSnapshot } from '../services/revenueToCash.js';
import { buildDemoWorkspaceDeals } from '../services/demoWorkspace.js';
import CashEvidenceSnapshot from '../models/CashEvidenceSnapshot.js';
const deal = {
  _id: 'deal-a',
  name: 'Deal A',
  amount: 100,
  stage: 'Closed Won',
  externalSource: 'salesforce',
  externalId: 'opp-a'
};
const invoice = (extra = {}) => ({
  id: 'inv-a',
  number: '1',
  customerId: 'cust-a',
  currency: 'USD',
  amount: 100,
  balance: 30,
  reportedPaid: 70,
  status: 'issued',
  refs: [{
    source: 'atlas',
    id: 'deal-a'
  }],
  dueAt: '2026-01-01',
  ...extra
});
const payment = (extra = {}) => ({
  id: 'pay-a',
  customerId: 'cust-a',
  currency: 'USD',
  amount: 70,
  refundedAmount: 0,
  allocations: [{
    invoiceId: 'inv-a',
    amount: 70
  }],
  issues: [],
  ...extra
});
const snapshot = (extra = {}) => ({
  provider: 'stripe',
  environment: 'live',
  invoices: [invoice()],
  payments: [payment()],
  refunds: [],
  ...extra
});
const ledger = (extra = {}) => build({
  snapshot: snapshot(),
  deals: [deal],
  now: new Date('2026-02-01'),
  ...extra
});
test('exact source references link opportunities and gross receipts with separate balance measures', () => {
  const l = ledger();
  assert.equal(l.invoices[0].deal.id, 'deal-a');
  assert.equal(l.totals.invoiced, 100);
  assert.equal(l.totals.outstanding, 30);
  assert.equal(l.totals.overdue, 30);
  assert.equal(l.totals.grossReceipts, 70);
  assert.equal(l.totals.linkedWonValue, 100);
});
test('names, amounts and customers never automatically match an opportunity', () => {
  const l = ledger({
    snapshot: snapshot({
      invoices: [invoice({
        refs: [],
        customerName: 'Deal A'
      })]
    })
  });
  assert.equal(l.invoices[0].deal, null);
  assert.equal(l.unmatchedWon.length, 1);
});
test('ambiguous, unknown and conflicting explicit references stay unmatched', () => {
  for (const refs of [[{
    source: 'atlas',
    id: 'missing'
  }], [{
    source: 'atlas',
    id: 'deal-a'
  }, {
    source: 'salesforce',
    id: 'other'
  }], [{
    source: 'salesforce',
    id: 'opp-a'
  }]]) {
    const l = ledger({
      deals: [deal, {
        ...deal,
        _id: 'other'
      }],
      snapshot: snapshot({
        invoices: [invoice({
          refs
        })]
      })
    });
    assert.equal(l.invoices[0].deal, null);
  }
});
test('external references are case sensitive and require the exact provider', () => {
  for (const ref of [{
    source: 'hubspot',
    id: 'opp-a'
  }, {
    source: 'salesforce',
    id: 'OPP-A'
  }]) assert.equal(ledger({
    snapshot: snapshot({
      invoices: [invoice({
        refs: [ref]
      })]
    })
  }).invoices[0].deal, null);
  assert.equal(ledger({
    snapshot: snapshot({
      invoices: [invoice({
        refs: [{
          source: 'salesforce',
          id: 'opp-a'
        }]
      })]
    })
  }).invoices[0].deal.id, 'deal-a');
});
test('manual unlink overrides automatic references and changed identities require a fresh review', () => {
  const link = {
    invoiceId: 'inv-a',
    state: 'blocked'
  };
  assert.equal(ledger({
    links: [link]
  }).invoices[0].deal, null);
  link.state = 'confirmed';
  link.dealId = 'deal-a';
  link.invoiceFingerprint = invoiceFingerprint(invoice());
  assert.equal(ledger({
    links: [link]
  }).invoices[0].match.method, 'team_confirmed');
  assert.equal(ledger({
    links: [link],
    snapshot: snapshot({
      invoices: [invoice({
        amount: 101
      })]
    })
  }).invoices[0].deal, null);
  assert.equal(ledger({
    links: [link],
    deals: []
  }).invoices[0].deal, null);
});
test('balance/date updates preserve a reviewed association', () => {
  const link = {
    invoiceId: 'inv-a',
    state: 'confirmed',
    dealId: 'deal-a',
    invoiceFingerprint: invoiceFingerprint(invoice())
  };
  assert.equal(ledger({
    links: [link],
    snapshot: snapshot({
      invoices: [invoice({
        balance: 0,
        dueAt: '2027-01-01'
      })]
    })
  }).invoices[0].deal.id, 'deal-a');
});
test('sandbox evidence cannot attach to live opportunities', () => {
  assert.equal(ledger({
    snapshot: snapshot({
      environment: 'test'
    })
  }).invoices[0].deal, null);
});
test('multiple invoices count one Closed Won value, open deals have a visible exception', () => {
  const d = {
    ...deal,
    _id: 'open',
    stage: 'Proposal'
  };
  const l = ledger({
    deals: [deal, d],
    snapshot: snapshot({
      invoices: [invoice(), invoice({
        id: 'inv-b'
      }), invoice({
        id: 'inv-c',
        refs: [{
          source: 'atlas',
          id: 'open'
        }]
      })]
    })
  });
  assert.equal(l.totals.linkedWonValue, 100);
  assert.equal(l.totals.invoiced, 300);
  assert.match(l.invoices[2].issues.join(), /not currently Closed Won/);
});
test('foreign/draft/void/unknown invoices and foreign receipts are excluded', () => {
  const l = ledger({
    snapshot: snapshot({
      invoices: ['draft', 'void', 'unknown'].map((status, n) => invoice({
        id: 'i' + n,
        status
      })).concat(invoice({
        currency: 'EUR'
      })),
      payments: [payment({
        currency: 'EUR'
      })]
    })
  });
  assert.equal(l.totals.invoiced, 0);
  assert.equal(l.totals.grossReceipts, 0);
  assert.equal(l.totals.excludedInvoices, 4);
});
test('unknown/customer-mismatched applications remain unallocated', () => {
  for (const p of [payment({
    customerId: 'other'
  }), payment({
    allocations: [{
      invoiceId: 'missing',
      amount: 70
    }]
  }), payment({
    allocations: [{
      invoiceId: 'inv-a',
      amount: 71
    }]
  })]) {
    const l = ledger({
      snapshot: snapshot({
        payments: [p]
      })
    });
    assert.equal(l.invoices[0].receipts, 0);
    assert.equal(l.totals.unallocatedReceipts, 70);
    assert.ok(l.paymentIssues.length);
  }
});
test('paid balance reductions do not establish received cash', () => {
  const l = ledger({
    snapshot: snapshot({
      invoices: [invoice({
        balance: 0,
        reportedPaid: 100
      })],
      payments: []
    })
  });
  assert.equal(l.totals.grossReceipts, 0);
  assert.match(l.invoices[0].issues.join(), /settlement differs/);
});
test('refunds and disputes stay explicit without reopening provider invoice balances', () => {
  const l = ledger({
    snapshot: snapshot({
      payments: [payment({
        refundedAmount: 10,
        disputed: true
      })]
    })
  });
  assert.equal(l.totals.grossReceipts, 70);
  assert.equal(l.totals.recordedRefunds, 10);
  assert.equal(l.totals.outstanding, 30);
  assert.equal(l.invoices[0].linkedRefunds, 10);
  assert.match(l.invoices[0].issues.join(), /disputed/);
});
test('a charge refund spanning invoices is never proportionally guessed', () => {
  const l = ledger({
    snapshot: snapshot({
      invoices: [invoice(), invoice({
        id: 'inv-b'
      })],
      payments: [payment({
        refundedAmount: 10,
        allocations: [{
          invoiceId: 'inv-a',
          amount: 35
        }, {
          invoiceId: 'inv-b',
          amount: 35
        }]
      })]
    })
  });
  assert.equal(l.invoices[0].linkedRefunds, null);
  assert.equal(l.totals.recordedRefunds, 10);
});
test('QBO currency requires explicit record currency or verified home currency', () => {
  const raw = {
    invoices: [{
      Id: '1',
      TotalAmt: 100,
      Balance: 40
    }]
  };
  assert.equal(qbo(raw).invoices[0].currency, 'UNKNOWN');
  assert.equal(qbo({
    ...raw,
    homeCurrency: 'USD'
  }).invoices[0].currency, 'USD');
  assert.equal(qbo({
    ...raw,
    invoices: [{
      ...raw.invoices[0],
      CurrencyRef: {
        value: 'EUR'
      }
    }],
    homeCurrency: 'USD'
  }).invoices[0].currency, 'EUR');
});
test('QBO credits and ambiguous mixed applications are not treated as invoice cash', () => {
  const base = {
    Id: 'p',
    TotalAmt: 100,
    UnappliedAmt: 0,
    Line: [{
      Amount: 100,
      LinkedTxn: [{
        TxnId: '1',
        TxnType: 'Invoice'
      }, {
        TxnId: 'credit',
        TxnType: 'CreditMemo'
      }]
    }]
  };
  assert.equal(qbo({
    payments: [base],
    homeCurrency: 'USD'
  }).payments[0].allocations.length, 0);
  assert.equal(qbo({
    payments: [{
      ...base,
      Line: [{
        Amount: 100,
        LinkedTxn: [{
          TxnId: '1',
          TxnType: 'Invoice'
        }]
      }],
      UnappliedAmt: 50
    }],
    homeCurrency: 'USD'
  }).payments[0].allocations.length, 0);
});
test('QBO unapplied receipts and RefundReceipts stay separate', () => {
  const normalized = qbo({
    homeCurrency: 'USD',
    payments: [{
      Id: 'p',
      TotalAmt: 100,
      UnappliedAmt: 40,
      Line: [{
        Amount: 60,
        LinkedTxn: [{
          TxnId: 'inv-a',
          TxnType: 'Invoice'
        }]
      }],
      CustomerRef: {
        value: 'cust-a'
      }
    }],
    refunds: [{
      Id: 'r',
      TotalAmt: 20
    }]
  });
  const l = ledger({
    snapshot: snapshot({
      ...normalized,
      invoices: [invoice()],
      provider: 'quickbooks'
    })
  });
  assert.equal(l.totals.unallocatedReceipts, 40);
  assert.equal(l.totals.recordedRefunds, 20);
  assert.equal(l.invoices[0].linkedRefunds, null);
});
test('QBO duplicate custom fields preserve conflicting references', () => {
  const n = qbo({
    invoices: [{
      Id: 'i',
      CustomField: [{
        Name: 'Atlas Deal ID',
        StringValue: 'a'
      }, {
        Name: 'Atlas Deal ID',
        StringValue: 'b'
      }]
    }]
  });
  assert.equal(n.invoices[0].refs.length, 2);
});
const charge = {
  id: 'ch',
  livemode: true,
  paid: true,
  status: 'succeeded',
  amount: 7000,
  amount_refunded: 0,
  currency: 'usd',
  payment_intent: 'pi'
};
const ip = {
  id: 'ip',
  livemode: true,
  status: 'paid',
  amount_paid: 7000,
  currency: 'usd',
  invoice: 'inv-a',
  payment: {
    type: 'payment_intent',
    payment_intent: 'pi'
  }
};
test('Stripe Invoice Payments trace payment intents to exactly one successful live charge', () => {
  const n = stripe({
    charges: [charge],
    invoicePayments: [ip]
  });
  assert.deepEqual(n.payments[0].allocations, [{
    invoiceId: 'inv-a',
    amount: 70
  }]);
  assert.equal(n.payments[0].paymentIntentId, undefined);
});
test('Stripe test, failed, ambiguous intent and payment-record rows never infer cash applications', () => {
  assert.equal(stripe({
    charges: [{
      ...charge,
      livemode: false
    }, {
      ...charge,
      id: 'failed',
      status: 'failed'
    }]
  }).payments.length, 0);
  for (const args of [{
    charges: [charge, {
      ...charge,
      id: 'ch2'
    }]
  }, {
    charges: [charge],
    invoicePayments: [{
      ...ip,
      payment: {
        type: 'payment_record'
      }
    }]
  }]) {
    const n = stripe({
      invoicePayments: [ip],
      ...args
    });
    assert.ok(n.payments.every(p => p.allocations.length === 0));
    assert.ok(n.warnings.length);
  }
});
test('Stripe foreign minor units are unavailable rather than incorrectly scaled', () => {
  const n = stripe({
    charges: [{
      ...charge,
      currency: 'jpy'
    }]
  });
  assert.equal(n.payments[0].amount, null);
  assert.equal(n.payments[0].currency, 'JPY');
});
test('missing, duplicate, oversized identities and excessive invoice applications fail a detail batch', () => {
  assert.throws(() => qbo({
    invoices: [{
      Id: 'same'
    }, {
      Id: 'same'
    }]
  }), /duplicate/);
  assert.throws(() => qbo({
    invoices: [{}]
  }), /Missing/);
  assert.throws(() => qbo({
    invoices: [{
      Id: 'x'.repeat(201)
    }]
  }), /identity/);
  assert.throws(() => stripe({
    charges: [charge],
    invoicePayments: [ip, ip]
  }), /Duplicate/);
  assert.throws(() => qbo({
    payments: [{
      Id: 'p',
      Line: Array.from({
        length: 101
      }, () => ({
        Amount: 1,
        LinkedTxn: [{
          TxnId: 'i',
          TxnType: 'Invoice'
        }]
      }))
    }]
  }), /limit/);
});
test('Stripe pagination carries account and rejects stalled cursors and failed pages', async () => {
  let calls = 0;
  const rows = await listStripeEvidence({
    list: async (p, o) => {
      assert.equal(o.stripeAccount, 'acct');
      calls++;
      return calls === 1 ? {
        data: [{
          id: 'a'
        }],
        has_more: true
      } : (assert.equal(p.starting_after, 'a'), {
        data: [{
          id: 'b'
        }],
        has_more: false
      });
    }
  }, 'acct');
  assert.equal(rows.length, 2);
  await assert.rejects(listStripeEvidence({
    list: async () => ({
      data: [{
        id: 'a'
      }],
      has_more: true
    })
  }, 'acct'), /advance/);
  await assert.rejects(listStripeEvidence({
    list: async () => {
      throw Error('failed');
    }
  }, 'acct'), /failed/);
});
test('QBO uses bounded entity queries and rejects malformed detail responses', async () => {
  let calls = 0;
  const rows = await listQuickBooksEvidence(async ({
    query
  }) => {
    calls++;
    assert.match(query.query, /MAXRESULTS 500/);
    return {
      QueryResponse: {
        Invoice: calls === 1 ? Array.from({
          length: 500
        }, (_, n) => ({
          Id: String(n)
        })) : []
      }
    };
  }, 'Invoice');
  assert.equal(rows.length, 500);
  assert.equal(calls, 2);
  await assert.rejects(listQuickBooksEvidence(async () => ({
    Fault: {}
  }), 'Invoice'), /Invalid/);
  await assert.rejects(listQuickBooksEvidence(async () => ({}), 'Customer'), /Unsupported/);
});
test('snapshot publication replaces a complete scoped batch with a fresh generation', async t => {
  t.mock.method(CashEvidenceSnapshot, 'findOneAndUpdate', (filter, update, options) => {
    assert.deepEqual(filter, {
      orgId: 'org',
      provider: 'stripe',
      accountId: 'acct',
      environment: 'live'
    });
    assert.equal(options.upsert, true);
    assert.equal(update.$set.invoices.length, 1);
    assert.ok(update.$set.generation);
    return {
      lean: async () => update.$set
    };
  });
  const saved = await saveCashSnapshot({
    orgId: 'org',
    provider: 'stripe',
    accountId: 'acct',
    environment: 'live',
    data: {
      invoices: [invoice()],
      payments: [],
      refunds: [],
      warnings: []
    }
  });
  assert.ok(saved.capturedAt instanceof Date);
});
test('demo is explicitly fictional and internally reconciles without database writes', () => {
  const deals = buildDemoWorkspaceDeals({
    _id: 'demo',
    name: 'Atlas Demo Company'
  }, new Date('2026-10-15'));
  const s = demoCashSnapshot(deals, new Date('2026-10-15'));
  const l = build({
    snapshot: s,
    deals,
    demo: true,
    now: new Date('2026-10-15')
  });
  assert.equal(l.totals.invoiced, 296000);
  assert.equal(l.totals.grossReceipts, 180500);
  assert.equal(l.totals.outstanding, 119000);
  assert.equal(l.totals.unallocatedReceipts, 3500);
  assert.equal(l.totals.overdue, 39000);
  assert.equal(l.totals.linkedInvoices, 3);
  assert.deepEqual(l.warnings,[]);
  assert.equal(s.environment,'demo');
});
