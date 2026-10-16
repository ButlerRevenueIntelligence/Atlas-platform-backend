import test from 'node:test';
import assert from 'node:assert/strict';
import router from '../routes/revenueToCash.js';
import Membership from '../models/Membership.js';
import Organization from '../models/Organization.js';
import IntegrationConnection from '../models/IntegrationConnection.js';
import CashOpportunityLink from '../models/CashOpportunityLink.js';
import CashEvidenceSnapshot from '../models/CashEvidenceSnapshot.js';
const orgId = '507f1f77bcf86cd799439011',
  userId = '507f1f77bcf86cd799439012';
const query = v => ({
  select() {
    return this;
  },
  lean: async () => v
});
const request = (role = 'owner') => ({
  orgId,
  user: {
    userId,
    name: 'Actual reviewer',
    permissions: ['*']
  },
  cashMember: {
    role
  },
  headers: {},
  query: {},
  params: {
    invoiceId: 'sample-invoice-1'
  },
  body: {}
});
const response = () => ({
  code: 200,
  status(c) {
    this.code = c;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});
async function invoke(path, method, req) {
  const res = response();
  await router.stack.find(l => l.route?.path === path && l.route.methods[method]).route.stack.at(-1).handle(req, res, e => {
    throw e;
  });
  return res;
}
function demo(t, links = []) {
  t.mock.method(Organization, 'findById', id => {
    assert.equal(id, orgId);
    return query({
      _id: orgId,
      name: 'Atlas Demo Company'
    });
  });
  t.mock.method(IntegrationConnection, 'find', filter => {
    assert.equal(filter.orgId, orgId);
    return query([]);
  });
  t.mock.method(CashOpportunityLink, 'find', filter => {
    assert.deepEqual(filter, {
      orgId,
      provider: 'quickbooks',
      accountId: 'atlas-sample-ledger',
      environment: 'demo'
    });
    return query(links);
  });
}
async function reviewReq(t, extra = {}) {
  demo(t);
  const req = request();
  const data = (await invoke('/', 'get', req)).body;
  req.body = {
    state: 'confirmed',
    dealId: data.ledger.invoices[0].deal.id,
    note: 'Verified invoice purchase order against CRM source record',
    version: null,
    generation: data.snapshot.generation,
    ...extra
  };
  return req;
}
test('cash endpoints require authentication, both permissions, and active workspace membership', async t => {
  let res = response();
  await router.stack[0].handle({
    headers: {}
  }, res, () => assert.fail());
  assert.equal(res.code, 401);
  for (const idx of [2, 3]) {
    res = response();
    await router.stack[idx].handle({
      user: {
        permissions: []
      }
    }, res, () => assert.fail());
    assert.equal(res.code, 403);
  }
  t.mock.method(Membership, 'findOne', filter => {
    assert.deepEqual(filter, {
      orgId,
      userId,
      status: 'active'
    });
    return query(null);
  });
  res = response();
  await router.stack[4].handle(request(), res, () => assert.fail());
  assert.equal(res.code, 403);
});
test('read-only roles cannot change associations', async () => {
  for (const role of ['member', 'analyst', 'viewer']) assert.equal((await invoke('/links/:invoiceId', 'put', request(role))).code, 403);
});
test('demo reads are scoped, labeled and do not persist snapshots or reviews', async t => {
  demo(t);
  t.mock.method(CashEvidenceSnapshot, 'findOne', () => assert.fail('Do not load real evidence for demo'));
  t.mock.method(CashEvidenceSnapshot, 'findOneAndUpdate', () => assert.fail('No seed writes'));
  t.mock.method(CashOpportunityLink, 'create', () => assert.fail('No review writes'));
  const res = await invoke('/', 'get', request());
  assert.equal(res.body.workspaceMode, 'demo');
  assert.equal(res.body.ledger.totalRows, 4);
  assert.equal(res.body.canManage, true);
  assert.equal(res.body.ledger.totals.invoiced, 296000);
});
test('read-only viewers see evidence without write affordances', async t => {
  demo(t);
  const res = await invoke('/', 'get', request('viewer'));
  assert.equal(res.body.canManage, false);
  assert.equal(res.code, 200);
});
test('invoice filters and pagination bound the result without changing source totals', async t => {
  demo(t);
  const req = request();
  req.query = {
    view: 'unmatched'
  };
  let res = await invoke('/', 'get', req);
  assert.equal(res.body.ledger.totalRows, 1);
  assert.equal(res.body.ledger.totals.invoiced, 296000);
  req.query = {
    offset: '25'
  };
  res = await invoke('/', 'get', req);
  assert.equal(res.body.ledger.invoices.length, 0);
  req.query = {
    search: 'sample-invoice-1'
  };
  res = await invoke('/', 'get', req);
  assert.equal(res.body.ledger.invoices.length, 1);
  for (const invalid of [{
    offset: '-1'
  }, {
    offset: '0.5'
  }, {
    view: 'wrong'
  }, {
    search: 'a'.repeat(101)
  }, {
    provider: 'bad'
  }]) {
    req.query = invalid;
    assert.equal((await invoke('/', 'get', req)).code, 400);
  }
});
test('opportunity search returns current safe fields with exact local identifiers', async t => {
  demo(t);
  const req = request();
  req.query = {
    search: 'Northstar'
  };
  const res = await invoke('/opportunities', 'get', req);
  assert.ok(res.body.opportunities.length);
  assert.ok(res.body.opportunities.every(d => d.id && !d.sourcePayload && !d.orgId));
});
test('reviews whitelist actor, workspace, source account, fingerprint and history', async t => {
  const req = await reviewReq(t, {
    orgId: 'foreign',
    updatedBy: 'forged',
    history: ['forged']
  });
  t.mock.method(CashOpportunityLink, 'findOne', filter => {
    assert.equal(filter.orgId, orgId);
    return query(null);
  });
  t.mock.method(CashOpportunityLink, 'create', async input => {
    assert.equal(input.orgId, orgId);
    assert.equal(input.updatedBy, userId);
    assert.equal(input.authorName, 'Actual reviewer');
    assert.equal(input.provider, 'quickbooks');
    assert.equal(input.accountId, 'atlas-sample-ledger');
    assert.equal(input.environment, 'demo');
    assert.equal(input.history.length, 1);
    assert.equal(input.history[0].userId, userId);
    assert.equal(input.invoiceFingerprint.length, 64);
    return {
      ...input,
      __v: 0
    };
  });
  assert.equal((await invoke('/links/:invoiceId', 'put', req)).code, 200);
});
test('stale snapshots and foreign/ineligible source records cannot be linked', async t => {
  const req = await reviewReq(t);
  t.mock.method(CashOpportunityLink, 'create', () => assert.fail());
  req.body.generation = 'old';
  assert.equal((await invoke('/links/:invoiceId', 'put', req)).code, 409);
  req.body.generation = 'sample-' + new Date().toISOString().slice(0, 10);
  req.body.dealId = 'foreign';
  assert.equal((await invoke('/links/:invoiceId', 'put', req)).code, 404);
  req.params.invoiceId = 'foreign-invoice';
  assert.equal((await invoke('/links/:invoiceId', 'put', req)).code, 404);
});
test('concurrent creation and edits fail safely without overwriting teammate review', async t => {
  const req = await reviewReq(t);
  t.mock.method(CashOpportunityLink, 'findOne', () => query({
    __v: 1
  }));
  assert.equal((await invoke('/links/:invoiceId', 'put', req)).code, 409);
  req.body.version = 0;
  t.mock.method(CashOpportunityLink, 'findOneAndUpdate', (filter, update) => {
    assert.equal(filter.orgId, orgId);
    assert.equal(filter.__v, 0);
    assert.equal(update.$inc.__v, 1);
    assert.equal(update.$push.history.$slice, -20);
    return query(null);
  });
  assert.equal((await invoke('/links/:invoiceId', 'put', req)).code, 409);
});
test('explicit unlink saves no caller-supplied opportunity', async t => {
  const req = await reviewReq(t, {
    state: 'blocked',
    dealId: 'foreign'
  });
  t.mock.method(CashOpportunityLink, 'findOne', () => query(null));
  t.mock.method(CashOpportunityLink, 'create', async value => {
    assert.equal(value.dealId, null);
    return {
      ...value,
      __v: 0
    };
  });
  assert.equal((await invoke('/links/:invoiceId', 'put', req)).code, 200);
});
test('malformed review payloads fail before source access', async () => {
  for (const body of [{}, {
    state: 'confirmed',
    version: 0,
    note: '',
    generation: 'g',
    dealId: 'd'
  }, {
    state: 'confirmed',
    version: -1,
    note: 'reason',
    generation: 'g',
    dealId: 'd'
  }, {
    state: 'blocked',
    version: null,
    note: 'x'.repeat(2001),
    generation: 'g'
  }]) {
    const req = request();
    req.body = body;
    assert.equal((await invoke('/links/:invoiceId', 'put', req)).code, 400);
  }
});
test('live snapshot lookups use only the selected workspace, current account and environment', async t => {
  const {
      default: Deal
    } = await import('../models/Deal.js'),
    {
      default: Client
    } = await import('../models/Client.js'),
    {
      default: Account
    } = await import('../models/Account.js'),
    {
      default: MetricDaily
    } = await import('../models/MetricDaily.js'),
    {
      default: SourceMetricDaily
    } = await import('../models/SourceMetricDaily.js'),
    {
      default: QuickBooksSnapshot
    } = await import('../models/QuickBooksSnapshot.js');
  const chain = v => ({
    select() {
      return this;
    },
    sort() {
      return this;
    },
    lean: async () => v
  });
  t.mock.method(Organization, 'findById', () => chain({
    _id: orgId,
    name: 'Customer workspace'
  }));
  for (const model of [Deal, Client, Account, MetricDaily, SourceMetricDaily]) t.mock.method(model, 'find', filter => {
    assert.equal(String(filter.orgId), orgId);
    return chain([]);
  });
  t.mock.method(QuickBooksSnapshot, 'findOne', () => chain(null));
  t.mock.method(IntegrationConnection, 'findOne', () => chain({
    lastSyncStatus: 'never'
  }));
  let selected = 'current-account';
  t.mock.method(IntegrationConnection, 'find', filter => {
    assert.equal(String(filter.orgId), orgId);
    return chain([{
      provider: 'stripe',
      mode: 'live',
      status: 'connected',
      externalAccountId: selected,
      metadata: {
        cashEvidenceAccountId: 'old-account',
        cashEvidenceStatus: 'success',
        cashEvidenceEnvironment: 'live'
      }
    }]);
  });
  t.mock.method(CashEvidenceSnapshot, 'findOne', filter => {
    assert.deepEqual(filter, {
      orgId,
      provider: 'stripe',
      accountId: selected,
      environment: 'live'
    });
    return chain(selected === 'current-account' ? null : {
      accountId: selected,
      environment: 'live',
      provider: 'stripe',
      generation: 'generation',
      invoices: [],
      payments: [],
      refunds: [],
      warnings: [],
      capturedAt: new Date()
    });
  });
  t.mock.method(CashOpportunityLink, 'find', filter => {
    assert.deepEqual(filter, {
      orgId,
      provider: 'stripe',
      accountId: selected,
      environment: 'live'
    });
    return chain([]);
  });
  const req = request();
  req.query = {
    provider: 'stripe'
  };
  let res = await invoke('/', 'get', req);
  assert.equal(res.body.ledger, null);
  assert.equal(res.body.source.detailStatus, 'not_synced');
  assert.equal(JSON.stringify(res.body).includes('old-account'), false);
  selected = 'second-account';
  res = await invoke('/', 'get', req);
  assert.equal(res.body.ledger.invoices.length, 0);
  assert.equal(res.body.canManage, true);
});
