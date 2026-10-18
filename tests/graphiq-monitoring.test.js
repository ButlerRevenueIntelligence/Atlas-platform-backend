import test from 'node:test';
import assert from 'node:assert/strict';
import Monitor from '../models/GraphIQMonitor.js';
import Delivery from '../models/GraphIQSlackDelivery.js';
import Organization from '../models/Organization.js';
import Membership from '../models/Membership.js';
import router from '../routes/graphiqMonitoring.js';
import { runGraphIQMonitoring, workspaceCanMonitor } from '../jobs/graphiqMonitoring.js';
import { validateMonitor, monitorDto } from '../services/graphiqMonitoring.js';
const now = new Date('2026-10-18T03:00:00Z'),
  orgId = '507f1f77bcf86cd799439011',
  userId = '507f1f77bcf86cd799439012';
const search = {
  kind: 'news',
  query: 'Acme',
  sourcePage: 'market-signals'
};
const active = {
  accessStatus: 'active',
  billing: {
    status: 'active'
  }
};
const q = value => ({
  select() {
    return this;
  },
  lean: async () => value
});
function fixture(t, {
  org = active,
  member = {
    role: 'owner'
  },
  slack = {
    connected: true,
    enabled: true
  },
  fail = false
} = {}) {
  const prior = process.env.GRAPHIQ_API_KEY;
  process.env.GRAPHIQ_API_KEY = 'mock';
  t.after(() => {
    if (prior === undefined) delete process.env.GRAPHIQ_API_KEY;else process.env.GRAPHIQ_API_KEY = prior;
  });
  const doc = {
    _id: 'monitor',
    orgId,
    updatedBy: userId,
    revision: 1,
    enabled: true,
    intervalMinutes: 60,
    searches: [search],
    nextRunAt: new Date(0),
    leaseUntil: new Date(0),
    failureCount: 0
  };
  const calls = {
    retrieved: [],
    sent: []
  };
  t.mock.method(Monitor, 'init', async () => {});
  t.mock.method(Delivery, 'init', async () => {});
  t.mock.method(Monitor, 'findOneAndUpdate', (filter, update, options) => {
    assert.equal(filter.enabled, true);
    assert.ok(filter.nextRunAt.$lte instanceof Date);
    assert.ok(filter.leaseUntil.$lte instanceof Date);
    assert.deepEqual(options.sort, {
      nextRunAt: 1
    });
    if (!doc.enabled || doc.nextRunAt > filter.nextRunAt.$lte || doc.leaseUntil > filter.leaseUntil.$lte) return q(null);
    Object.assign(doc, update.$set);
    return q(structuredClone(doc));
  });
  t.mock.method(Monitor, 'exists', async filter => {
    assert.equal(filter.orgId, orgId);
    return doc.enabled && filter.revision === doc.revision && filter.claim === doc.claim && doc.leaseUntil > filter.leaseUntil.$gt ? {
      _id: doc._id
    } : null;
  });
  t.mock.method(Monitor, 'updateOne', async (filter, update) => {
    assert.equal(filter.orgId, orgId);
    if (filter.claim !== doc.claim || filter.revision !== undefined && filter.revision !== doc.revision) return {
      matchedCount: 0
    };
    Object.assign(doc, update.$set);
    return {
      matchedCount: 1
    };
  });
  t.mock.method(Organization, 'findById', id => {
    assert.equal(id, orgId);
    return q(org);
  });
  t.mock.method(Membership, 'findOne', filter => {
    assert.equal(filter.orgId, orgId);
    assert.equal(filter.userId, userId);
    assert.equal(filter.status, 'active');
    assert.ok(filter.role.$in.includes('manager'));
    return q(member);
  });
  const deps = {
    now,
    clock: () => now,
    slackStatus: async id => {
      assert.equal(id, orgId);
      return slack;
    },
    retrieve: async input => {
      calls.retrieved.push(input);
      if (fail) throw Object.assign(new Error('SECRET upstream body'), {
        code: 'network_error'
      });
      return {
        records: [{
          title: 'Acme launches',
          url: 'https://example.com/news'
        }]
      };
    },
    notify: async input => {
      calls.sent.push(input);
      return {
        state: 'sent',
        count: 1
      };
    }
  };
  return {
    doc,
    calls,
    deps
  };
}
test('monitor config validates bounded queries, cadence, revision and duplicate searches', () => {
  const good = {
    enabled: true,
    intervalMinutes: 60,
    revision: 0,
    searches: [search]
  };
  assert.equal(validateMonitor(good).searches[0].query, 'Acme');
  for (const bad of [{
    enabled: 'true'
  }, {
    intervalMinutes: 1
  }, {
    revision: -1
  }, {
    searches: []
  }, {
    searches: Array(6).fill(search)
  }, {
    searches: [search, {
      ...search,
      sourcePage: 'account-intelligence'
    }]
  }, {
    searches: [{
      ...search,
      sourcePage: 'operator'
    }]
  }, {
    searches: [{
      ...search,
      query: 'x'.repeat(501)
    }]
  }, {
    searches: [{
      ...search,
      kind: 'fetch_page'
    }]
  }]) assert.throws(() => validateMonitor({
    ...good,
    ...bad
  }));
  const dto = monitorDto({
    ...good,
    claim: 'secret',
    orgId: 'foreign'
  });
  assert.equal(dto.claim, undefined);
  assert.equal(dto.orgId, undefined);
});
test('workspace eligibility excludes suspended, expired and overdue trials', () => {
  assert.ok(workspaceCanMonitor(active, now));
  assert.ok(workspaceCanMonitor({
    accessStatus: 'active',
    paymentStatus: 'trialing',
    trial: {
      status: 'trialing',
      endsAt: '2026-11-01'
    }
  }, now));
  for (const org of [null, {
    ...active,
    accessStatus: 'suspended'
  }, {
    ...active,
    trial: {
      status: 'expired'
    }
  }, {
    accessStatus: 'active',
    billing: {
      status: 'canceled'
    }
  }, {
    accessStatus: 'active',
    paymentStatus: 'trialing',
    trial: {
      status: 'trialing',
      endsAt: '2026-10-01'
    }
  }]) assert.equal(workspaceCanMonitor(org, now), false);
});
test('scheduled check retrieves and notifies canonical workspace then advances schedule from completion', async t => {
  const {
    doc,
    calls,
    deps
  } = fixture(t);
  const summary = await runGraphIQMonitoring(deps);
  assert.equal(summary.completed, 1);
  assert.equal(calls.sent.length, 1);
  assert.deepEqual(calls.retrieved[0], {
    orgId,
    kind: 'news',
    query: 'Acme'
  });
  assert.equal(calls.sent[0].sourcePage, 'market-signals');
  assert.equal(doc.lastState, 'success');
  assert.equal(doc.lastResults[0].count, 1);
  assert.equal(doc.nextRunAt.toISOString(), '2026-10-18T04:00:00.000Z');
  assert.equal(doc.claim, null);
  await runGraphIQMonitoring(deps);
  assert.equal(calls.sent.length, 1, 'not due again');
});
test('overlapping workers claim a workspace only once and expired leases recover', async t => {
  const {
    doc,
    calls,
    deps
  } = fixture(t);
  await Promise.all([runGraphIQMonitoring(deps), runGraphIQMonitoring(deps)]);
  assert.equal(calls.sent.length, 1);
  doc.nextRunAt = new Date(0);
  doc.leaseUntil = new Date(now.getTime() + 1000);
  await runGraphIQMonitoring(deps);
  assert.equal(calls.sent.length, 1);
  doc.leaseUntil = new Date(now.getTime() - 1);
  await runGraphIQMonitoring(deps);
  assert.equal(calls.sent.length, 2);
});
test('paused monitors, missing keys, disabled Slack and removed managers consume no provider calls', async t => {
  for (const options of [{
    org: {
      ...active,
      accessStatus: 'suspended'
    }
  }, {
    member: null
  }, {
    slack: {
      connected: false,
      enabled: true
    }
  }, {
    slack: {
      connected: true,
      enabled: false
    }
  }]) await t.test(JSON.stringify(options), async t => {
    const {
      doc,
      calls,
      deps
    } = fixture(t, options);
    await runGraphIQMonitoring(deps);
    assert.equal(calls.retrieved.length, 0);
    assert.equal(doc.lastState, 'paused');
  });
  await t.test('disabled monitor', async t => {
    const {
      doc,
      calls,
      deps
    } = fixture(t);
    doc.enabled = false;
    await runGraphIQMonitoring(deps);
    assert.equal(calls.retrieved.length, 0);
  });
  await t.test('missing key', async t => {
    const {
      calls,
      deps
    } = fixture(t);
    delete process.env.GRAPHIQ_API_KEY;
    assert.equal((await runGraphIQMonitoring(deps)).reason, 'missing_graphiq_key');
    assert.equal(calls.retrieved.length, 0);
  });
});
test('revision changes during provider retrieval fence Slack and preserve replacement schedule', async t => {
  const {
    doc,
    calls,
    deps
  } = fixture(t);
  deps.retrieve = async () => {
    doc.revision++;
    doc.enabled = false;
    doc.nextRunAt = new Date('2026-11-01');
    return {
      records: [{
        title: 'Changed'
      }]
    };
  };
  await runGraphIQMonitoring(deps);
  assert.equal(calls.sent.length, 0);
  assert.equal(doc.enabled, false);
  assert.equal(doc.nextRunAt.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(doc.claim, null);
});
test('provider failures store safe errors, release lease and back off without notifying', async t => {
  const {
    doc,
    calls,
    deps
  } = fixture(t, {
    fail: true
  });
  doc.failureCount = 2;
  await runGraphIQMonitoring(deps);
  assert.equal(calls.sent.length, 0);
  assert.equal(doc.lastState, 'error');
  assert.equal(doc.failureCount, 3);
  assert.equal(doc.nextRunAt.toISOString(), '2026-10-18T07:00:00.000Z');
  assert.equal(JSON.stringify(doc).includes('SECRET'), false);
  assert.equal(doc.claim, null);
});
test('company watches use the shared retrieval contract and Slack failures do not lose research results', async t => {
  const {
    doc,
    calls,
    deps
  } = fixture(t);
  doc.searches = [{
    kind: 'companies',
    query: 'Manufacturers',
    sourcePage: 'account-intelligence'
  }];
  deps.notify = async v => {
    calls.sent.push(v);
    return {
      state: 'uncertain',
      reason: 'delivery_not_confirmed'
    };
  };
  await runGraphIQMonitoring(deps);
  assert.equal(calls.sent[0].sourcePage, 'account-intelligence');
  assert.equal(calls.retrieved[0].kind, 'companies');
  assert.equal(doc.lastResults[0].delivery.state, 'uncertain');
  assert.equal(doc.lastState, 'success');
});
const req = () => ({
  orgId,
  user: {
    userId
  },
  graphiqMember: {
    role: 'owner'
  },
  body: {
    enabled: true,
    revision: 0,
    intervalMinutes: 360,
    searches: [search]
  }
});
const res = () => ({
  code: 200,
  status(n) {
    this.code = n;
    return this;
  },
  json(v) {
    this.body = v;
    return this;
  }
});
async function invoke(method, request) {
  const response = res();
  await router.stack.find(l => l.route?.methods[method]).route.stack[0].handle(request, response, e => {
    throw e;
  });
  return response;
}
test('monitor read and writes are tenant scoped, role guarded, and reject stale revisions', async t => {
  t.mock.method(Monitor, 'findOne', filter => {
    assert.deepEqual(filter, {
      orgId
    });
    return q(null);
  });
  const response = await invoke('get', req());
  assert.equal(response.body.monitor.enabled, false);
  assert.equal(response.body.canManage, true);
  const viewer = req();
  viewer.graphiqMember.role = 'viewer';
  assert.equal((await invoke('put', viewer)).code, 403);
  const invalid = req();
  invalid.body.intervalMinutes = 5;
  assert.equal((await invoke('put', invalid)).code, 400);
  t.mock.method(Monitor, 'findOneAndUpdate', (filter, update, options) => {
    assert.deepEqual(filter, {
      orgId,
      revision: 0
    });
    assert.equal(update.$set.updatedBy, userId);
    assert.equal(update.$set.orgId, undefined);
    assert.equal(update.$inc.revision, 1);
    assert.equal(options.upsert, true);
    return q({
      ...update.$set,
      revision: 1
    });
  });
  const update = req();
  update.body.orgId = 'foreign';
  const saved = await invoke('put', update);
  assert.equal(saved.body.monitor.revision, 1);
  assert.equal(saved.body.monitor.enabled, true);
  t.mock.method(Monitor, 'findOneAndUpdate', () => q(null));
  const stale = req();
  stale.body.revision = 1;
  assert.equal((await invoke('put', stale)).code, 409);
  t.mock.method(Monitor, 'findOneAndUpdate', () => {
    throw Object.assign(new Error('duplicate'), {
      code: 11000
    });
  });
  assert.equal((await invoke('put', req())).code, 409);
});
test('access denial stops automatic polling until a manager explicitly resumes', async t => {
  const {
    doc,
    calls,
    deps
  } = fixture(t);
  deps.retrieve = async () => {
    throw Object.assign(new Error('secret'), {
      code: 'access_denied'
    });
  };
  await runGraphIQMonitoring(deps);
  assert.equal(doc.enabled, false);
  assert.equal(doc.lastReason, 'graphiq_access_check_required');
  await runGraphIQMonitoring(deps);
  assert.equal(calls.sent.length, 0);
  assert.equal(doc.lastResults[0].error, 'access_denied');
});
test('expired leases during retrieval fence notification', async t => {
  const {
    doc,
    calls,
    deps
  } = fixture(t);
  deps.retrieve = async () => {
    doc.leaseUntil = new Date(0);
    return {
      records: [{
        title: 'result'
      }]
    };
  };
  await runGraphIQMonitoring({
    ...deps,
    maxWorkspaces: 1
  });
  assert.equal(calls.sent.length, 0);
  assert.equal(doc.lastState, 'superseded');
});
test('switching Slack notifications off between queries stops further provider usage', async t => {
  const {
    doc,
    calls,
    deps
  } = fixture(t);
  doc.searches = [search, {
    ...search,
    query: 'Second company'
  }];
  deps.slackStatus = async () => ({
    connected: true,
    enabled: calls.retrieved.length === 0
  });
  await runGraphIQMonitoring(deps);
  assert.equal(calls.retrieved.length, 1);
  assert.equal(doc.lastState, 'paused');
  assert.equal(doc.lastReason, 'slack_unavailable_or_disabled');
});
