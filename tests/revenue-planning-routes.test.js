import test from 'node:test';
import assert from 'node:assert/strict';
import router from '../routes/revenuePlanning.js';
import Membership from '../models/Membership.js';
import Organization from '../models/Organization.js';
import RevenueTarget from '../models/RevenueTarget.js';
import ForecastSnapshot from '../models/ForecastSnapshot.js';
import { currentPeriods } from '../services/revenuePlanning.js';
const orgId = '507f1f77bcf86cd799439011',
  otherOrg = '507f1f77bcf86cd799439012',
  userId = '507f1f77bcf86cd799439013';
const period = currentPeriods().month;
const query = value => ({
  select() {
    return this;
  },
  sort() {
    return this;
  },
  limit() {
    return this;
  },
  lean: async () => value
});
const request = (role = 'owner') => ({
  orgId,
  user: {
    userId
  },
  planningMember: {
    role
  },
  headers: {},
  query: {},
  body: {}
});
const response = () => ({
  code: 200,
  status(code) {
    this.code = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});
const handler = (path, method) => router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
async function invoke(path, method, req) {
  const res = response();
  await handler(path, method)(req, res, error => {
    throw error;
  });
  return res;
}
function demo(t) {
  t.mock.method(Organization, 'findById', id => {
    assert.equal(String(id), orgId);
    return query({
      _id: orgId,
      name: 'Atlas Demo Company'
    });
  });
}
test('planning routes require authentication before any data access', async () => {
  const res = response();
  await router.stack[0].handle({
    headers: {}
  }, res, () => assert.fail('Missing token must not pass'));
  assert.equal(res.code, 401);
});
test('active workspace membership gate rejects suspended or missing membership', async t => {
  t.mock.method(Membership, 'findOne', filter => {
    assert.deepEqual(filter, {
      orgId,
      userId,
      status: 'active'
    });
    return query(null);
  });
  const res = response();
  await router.stack[3].handle(request(), res, () => assert.fail('Membership gate must stop request'));
  assert.equal(res.code, 403);
});
test('non-managers cannot edit targets or save forecasts', async () => {
  for (const role of ['viewer', 'member', 'analyst']) for (const [path, method] of [['/target', 'put'], ['/snapshots', 'post']]) assert.equal((await invoke(path, method, request(role))).code, 403);
});
test('target validation rejects invalid amounts and absent versions before writing', async () => {
  for (const amount of [-1, NaN, '100', Infinity, 1.234]) {
    const req = request();
    req.body = {
      amount,
      version: null
    };
    assert.equal((await invoke('/target', 'put', req)).code, 400);
  }
  const req = request();
  req.body = {
    amount: 100
  };
  assert.equal((await invoke('/target', 'put', req)).code, 400);
});
test('target creation is tenant scoped, records the actor, and ignores caller workspace/identity', async t => {
  demo(t);
  t.mock.method(RevenueTarget, 'create', async value => {
    assert.equal(value.orgId, orgId);
    assert.equal(value.updatedBy, userId);
    assert.equal(value.history[0].userId, userId);
    assert.equal(value.currency, 'USD');
    return {
      ...value,
      __v: 0
    };
  });
  const req = request('manager');
  req.body = {
    orgId: otherOrg,
    period,
    metric: 'bookings',
    amount: 100000,
    version: null,
    updatedBy: 'attacker'
  };
  const res = await invoke('/target', 'put', req);
  assert.equal(res.code, 200);
  assert.equal(res.body.target.amount, 100000);
});
test('target edits atomically check version, increment revision, and append limited history', async t => {
  demo(t);
  t.mock.method(RevenueTarget, 'findOneAndUpdate', (filter, update, options) => {
    assert.deepEqual(filter, {
      orgId,
      period,
      metric: 'bookings',
      __v: 3
    });
    assert.equal(update.$inc.__v, 1);
    assert.equal(update.$set.amount, 200000);
    assert.equal(update.$push.history.$slice, -50);
    assert.equal(options.runValidators, true);
    return query({
      ...filter,
      amount: 200000,
      __v: 4
    });
  });
  const req = request();
  req.body = {
    period,
    metric: 'bookings',
    amount: 200000,
    version: 3
  };
  assert.equal((await invoke('/target', 'put', req)).body.target.__v, 4);
});
test('conflicting target edits and concurrent first creations return 409', async t => {
  demo(t);
  t.mock.method(RevenueTarget, 'findOneAndUpdate', () => query(null));
  t.mock.method(RevenueTarget, 'create', async () => {
    throw Object.assign(new Error('duplicate'), {
      code: 11000
    });
  });
  const req = request();
  req.body = {
    period,
    metric: 'bookings',
    amount: 200000,
    version: 0
  };
  assert.equal((await invoke('/target', 'put', req)).code, 409);
  req.body.version = null;
  assert.equal((await invoke('/target', 'put', req)).code, 409);
});
test('completed period targets and retrospective forecasts cannot be saved', async t => {
  demo(t);
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - 1);
  const past = currentPeriods(date).month;
  const req = request();
  req.body = {
    period: past,
    metric: 'bookings',
    amount: 100,
    version: null
  };
  assert.equal((await invoke('/target', 'put', req)).code, 400);
  req.body = {
    period: past,
    metric: 'bookings',
    label: 'Backdated',
    forecastOverride: 100,
    rationale: 'Not allowed'
  };
  assert.equal((await invoke('/snapshots', 'post', req)).code, 400);
});
test('forecasts capture server data and original target; caller-supplied totals and asOf are ignored', async t => {
  demo(t);
  t.mock.method(RevenueTarget, 'findOne', filter => {
    assert.equal(filter.orgId, orgId);
    return query({
      amount: 300000
    });
  });
  t.mock.method(ForecastSnapshot, 'create', async value => {
    assert.equal(value.orgId, orgId);
    assert.equal(value.targetAtSave, 300000);
    assert.equal(value.method, 'weighted_pipeline');
    assert.notEqual(value.forecast, 7);
    assert.notEqual(value.actualAtSave, 777);
    assert.equal(value.asOf.getUTCFullYear(), new Date().getUTCFullYear());
    assert.ok(value.evidence.deals.every(d => !d.sourcePayload));
    return value;
  });
  const req = request();
  req.body = {
    period,
    metric: 'bookings',
    label: 'Revenue review',
    forecast: 7,
    actualAtSave: 777,
    targetAtSave: 1,
    asOf: '2020-01-01',
    evidence: {
      deals: [{
        sourcePayload: {
          token: 'secret'
        }
      }]
    }
  };
  assert.equal((await invoke('/snapshots', 'post', req)).code, 201);
});
test('leadership overrides require rationale and preserve the model alongside the estimate', async t => {
  demo(t);
  t.mock.method(RevenueTarget, 'findOne', () => query(null));
  t.mock.method(ForecastSnapshot, 'create', async value => {
    assert.equal(value.forecast, 500000);
    assert.equal(value.method, 'leadership_estimate');
    assert.equal(value.rationale, 'Buyer confirmed decision window');
    assert.ok(Number.isFinite(value.modelForecast));
    return value;
  });
  const req = request();
  req.body = {
    period,
    metric: 'bookings',
    label: 'Leadership call',
    forecastOverride: 500000
  };
  assert.equal((await invoke('/snapshots', 'post', req)).code, 400);
  req.body.rationale = 'Buyer confirmed decision window';
  assert.equal((await invoke('/snapshots', 'post', req)).code, 201);
});
test('missing revenue data cannot produce a model forecast; an explicit estimate keeps actuals null', async t => {
  demo(t);
  t.mock.method(RevenueTarget, 'findOne', () => query(null));
  t.mock.method(ForecastSnapshot, 'create', async value => {
    assert.equal(value.actualAtSave, null);
    assert.equal(value.evidence.actualAvailable, false);
    assert.equal(value.modelForecast, null);
    return value;
  });
  const req = request();
  req.body = {
    period,
    metric: 'stripe',
    label: 'No data'
  };
  assert.equal((await invoke('/snapshots', 'post', req)).code, 400);
  req.body.forecastOverride = 1000;
  req.body.rationale = 'Explicit planning assumption';
  assert.equal((await invoke('/snapshots', 'post', req)).code, 201);
});
test('plan defaults work without a GET body and every history read is tenant scoped', async t => {
  demo(t);
  t.mock.method(RevenueTarget, 'findOne', filter => {
    assert.deepEqual(filter, {
      orgId,
      period,
      metric: 'bookings'
    });
    return query(null);
  });
  t.mock.method(ForecastSnapshot, 'find', filter => {
    assert.deepEqual(filter, {
      orgId,
      metric: 'bookings'
    });
    return query([]);
  });
  const req = request('viewer');
  req.body = undefined;
  const res = await invoke('/plan', 'get', req);
  assert.equal(res.code, 200);
  assert.equal(res.body.canManage, false);
  assert.equal(res.body.targetIsSample, true);
  assert.deepEqual(res.body.snapshots, []);
});
test('summary chooses persisted targets for the same calendar period and measure', async t => {
  demo(t);
  t.mock.method(RevenueTarget, 'find', filter => {
    assert.equal(filter.orgId, orgId);
    assert.ok(filter.period.$in.includes(period));
    return query([{
      period,
      metric: 'sample_revenue',
      amount: 90000
    }]);
  });
  const res = await invoke('/summary', 'get', request());
  const selected = res.body.summaries.find(s => s.period === period);
  assert.equal(selected.target, 90000);
  assert.equal(selected.metric, 'sample_revenue');
  assert.equal(selected.targetIsSample, false);
});
test('invalid selection is a 400 and no routes can rewrite saved snapshots', async t => {
  demo(t);
  const req = request();
  req.query = {
    period: '2026-Q9'
  };
  assert.equal((await invoke('/plan', 'get', req)).code, 400);
  assert.ok(!router.stack.some(l => l.route?.path?.includes('snapshots') && (l.route.methods.patch || l.route.methods.put || l.route.methods.delete)));
});
test('non-USD requests are rejected rather than silently reinterpreted', async () => {
  const req = request();
  req.body = {
    currency: 'EUR',
    amount: 1000,
    version: null,
    label: 'Euro estimate'
  };
  assert.equal((await invoke('/target', 'put', req)).code, 400);
  assert.equal((await invoke('/snapshots', 'post', req)).code, 400);
});
