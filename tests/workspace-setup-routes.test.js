import test from 'node:test';
import assert from 'node:assert/strict';
import router from '../routes/workspaceSetup.js';
import WorkspaceSetup from '../models/WorkspaceSetup.js';
import Organization from '../models/Organization.js';
import IntegrationConnection from '../models/IntegrationConnection.js';
import Membership from '../models/Membership.js';
const orgId = '507f1f77bcf86cd799439011',
  userId = '507f1f77bcf86cd799439012';
const query = value => ({
  select() {
    return this;
  },
  lean: async () => value
});
const request = (role = 'owner') => ({
  orgId,
  user: {
    userId,
    permissions: ['*']
  },
  setupMember: {
    role
  },
  headers: {},
  params: {},
  query: {},
  body: {}
});
const response = () => ({
  code: 200,
  status(n) {
    this.code = n;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});
const invoke = async (path, method, req) => {
  const res = response();
  const handler = router.stack.find(l => l.route?.path === path && l.route.methods[method]).route.stack.at(-1).handle;
  await handler(req, res, e => {
    throw e;
  });
  return res;
};
const stored = {
  orgId,
  priorities: ['pipeline'],
  expectedSystems: [],
  status: 'in_progress',
  coverageReviewedAt: null,
  coverageReview: null,
  briefing: null,
  __v: 2
};
function facts(t, state = stored) {
  t.mock.method(WorkspaceSetup, 'findOne', filter => {
    assert.deepEqual(filter, {
      orgId
    });
    return query(state);
  });
  t.mock.method(Organization, 'findById', id => {
    assert.equal(String(id), orgId);
    return query({
      _id: orgId,
      name: 'Atlas Demo Company'
    });
  });
  t.mock.method(IntegrationConnection, 'find', filter => {
    assert.deepEqual(filter, {
      orgId
    });
    return query([]);
  });
}
async function token(req) {
  return (await invoke('/', 'get', req)).body.readiness.reviewToken;
}
test('setup requires authentication, command-center permission and explicit active workspace membership', async t => {
  let res = response();
  await router.stack[0].handle({
    headers: {}
  }, res, () => assert.fail('Authentication required'));
  assert.equal(res.code, 401);
  res = response();
  await router.stack[2].handle({
    user: {
      permissions: []
    }
  }, res, () => assert.fail('Command Center permission required'));
  assert.equal(res.code, 403);
  t.mock.method(Membership, 'findOne', filter => {
    assert.deepEqual(filter, {
      orgId,
      userId,
      status: 'active'
    });
    return query(null);
  });
  res = response();
  await router.stack[3].handle(request(), res, () => assert.fail('Active membership required'));
  assert.equal(res.code, 403);
});
test('setup reads do not create records and the compact status endpoint does not load provider data', async t => {
  t.mock.method(WorkspaceSetup, 'findOne', () => query(null));
  t.mock.method(WorkspaceSetup, 'create', () => assert.fail('Reads must not seed setup'));
  t.mock.method(IntegrationConnection, 'find', () => assert.fail('Status must stay lightweight'));
  const result = await invoke('/status', 'get', request());
  assert.equal(result.body.status, 'not_started');
  assert.equal(result.body.orgId, orgId);
  t.mock.restoreAll();
  facts(t, null);
  t.mock.method(WorkspaceSetup, 'create', () => assert.fail('Reads must not seed setup'));
  const detail = await invoke('/', 'get', request());
  assert.equal(detail.body.state.__v, null);
  assert.equal(detail.body.readiness.mode, 'demo');
});
test('ordinary members/analysts/viewers can inspect but cannot change shared setup choices or milestones', async () => {
  for (const role of ['member', 'analyst', 'viewer']) {
    assert.equal((await invoke('/', 'put', request(role))).code, 403);
    const req = request(role);
    req.params.action = 'defer';
    assert.equal((await invoke('/:action', 'post', req)).code, 403);
  }
});
test('preference creation scopes the workspace, whitelists inputs and ignores fake completion/evidence', async t => {
  t.mock.method(WorkspaceSetup, 'findOne', () => query(null));
  t.mock.method(WorkspaceSetup, 'create', async input => {
    assert.equal(input.orgId, orgId);
    assert.equal(input.updatedBy, userId);
    assert.deepEqual(input.priorities, ['pipeline']);
    assert.equal(input.status, 'in_progress');
    assert.equal(input.briefing, null);
    assert.equal(input.coverageReview, null);
    assert.equal(input.completedAt, null);
    assert.equal(input.history, undefined);
    return {
      ...input,
      __v: 0
    };
  });
  const req = request();
  req.body = {
    version: null,
    priorities: ['pipeline'],
    expectedSystems: ['salesforce'],
    orgId: 'foreign',
    completedAt: '2026-01-01',
    briefing: {
      revenue: 99999
    },
    coverageReviewedAt: '2026-01-01',
    history: ['forged']
  };
  const res = await invoke('/', 'put', req);
  assert.equal(res.code, 200);
  assert.equal(res.body.state.__v, 0);
});
test('a changed priority resets prior coverage/briefing/completion; stale preference edits return 409', async t => {
  t.mock.method(WorkspaceSetup, 'findOne', () => query({
    ...stored,
    status: 'completed'
  }));
  t.mock.method(WorkspaceSetup, 'findOneAndUpdate', (filter, update) => {
    assert.deepEqual(filter, {
      orgId,
      __v: 2
    });
    assert.equal(update.$inc.__v, 1);
    assert.equal(update.$set.completedAt, null);
    assert.equal(update.$set.briefing, null);
    assert.equal(update.$set.coverageReview, null);
    assert.deepEqual(update.$set.priorities, ['cash']);
    return query(null);
  });
  const req = request();
  req.body = {
    version: 2,
    priorities: ['cash'],
    expectedSystems: []
  };
  assert.equal((await invoke('/', 'put', req)).code, 409);
});
test('simultaneous first setup creation returns a conflict instead of overwriting a teammate', async t => {
  t.mock.method(WorkspaceSetup, 'findOne', () => query(null));
  t.mock.method(WorkspaceSetup, 'create', async () => {
    throw Object.assign(new Error('duplicate'), {
      code: 11000
    });
  });
  const req = request();
  req.body = {
    version: null,
    priorities: ['pipeline'],
    expectedSystems: []
  };
  assert.equal((await invoke('/', 'put', req)).code, 409);
});
test('invalid preferences and missing versions are rejected before writing', async t => {
  t.mock.method(WorkspaceSetup, 'create', () => assert.fail('Invalid body must not write'));
  const req = request();
  req.body = {
    priorities: ['pipeline'],
    expectedSystems: []
  };
  assert.equal((await invoke('/', 'put', req)).code, 400);
  req.body = {
    version: null,
    priorities: ['invented'],
    expectedSystems: []
  };
  assert.equal((await invoke('/', 'put', req)).code, 400);
});
test('coverage review requires acknowledgment of current gaps and a matching readiness token', async t => {
  facts(t);
  const req = request();
  req.params.action = 'review';
  req.body = {
    version: 2
  };
  assert.equal((await invoke('/:action', 'post', req)).code, 409);
  req.body.readinessToken = await token(req);
  assert.equal((await invoke('/:action', 'post', req)).code, 400);
  t.mock.method(WorkspaceSetup, 'findOneAndUpdate', (filter, update) => {
    assert.deepEqual(filter, {
      orgId,
      __v: 2
    });
    assert.ok(update.$set.coverageReviewedAt instanceof Date);
    assert.equal(update.$set.coverageReview.mode, 'demo');
    assert.equal(update.$set.briefing, null);
    return query({
      ...stored,
      ...update.$set,
      __v: 3
    });
  });
  req.body.acknowledgeGaps = true;
  assert.equal((await invoke('/:action', 'post', req)).body.state.__v, 3);
});
test('first briefing requires reviewed coverage and captures current workspace facts, never caller numbers', async t => {
  facts(t);
  const req = request();
  req.params.action = 'briefing';
  req.body = {
    version: 2,
    briefing: {
      summary: {
        pipeline: 1
      }
    }
  };
  assert.equal((await invoke('/:action', 'post', req)).code, 409);
  t.mock.restoreAll();
  facts(t, {
    ...stored,
    coverageReviewedAt: new Date(),
    coverageReview: {
      mode: 'demo'
    }
  });
  t.mock.method(WorkspaceSetup, 'findOneAndUpdate', (filter, update) => {
    assert.equal(filter.orgId, orgId);
    assert.equal(update.$set.briefing.summary.pipeline, 1665000);
    assert.equal(update.$set.briefing.mode, 'demo');
    assert.equal(update.$set.briefing.priorities.length, 3);
    assert.ok(update.$set.firstBriefingAt instanceof Date);
    return query({
      ...stored,
      ...update.$set,
      __v: 3
    });
  });
  assert.equal((await invoke('/:action', 'post', req)).body.state.briefing.summary.openCount, 6);
});
test('finishing needs a briefing, current reviewed mode, fresh coverage acknowledgment and a version guard', async t => {
  facts(t);
  const req = request();
  req.params.action = 'complete';
  req.body = {
    version: 2,
    acknowledgeGaps: true
  };
  req.body.readinessToken = await token(req);
  assert.equal((await invoke('/:action', 'post', req)).code, 409);
  t.mock.restoreAll();
  facts(t, {
    ...stored,
    coverageReviewedAt: new Date(),
    coverageReview: {
      mode: 'demo'
    },
    briefing: {
      mode: 'demo'
    }
  });
  t.mock.method(WorkspaceSetup, 'findOneAndUpdate', (filter, update) => {
    assert.deepEqual(filter, {
      orgId,
      __v: 2
    });
    assert.equal(update.$set.status, 'completed');
    assert.ok(update.$set.completedAt instanceof Date);
    assert.ok(update.$set.completionReview.gaps.length > 0);
    return query({
      ...stored,
      ...update.$set,
      __v: 3
    });
  });
  req.body.readinessToken = await token(req);
  const res = await invoke('/:action', 'post', req);
  assert.equal(res.code, 200);
  assert.equal(res.body.state.status, 'completed');
  assert.ok(res.body.readiness.gaps.length > 0);
});
test('a data-mode change cannot reuse a prior coverage review to build a live-looking briefing', async t => {
  facts(t, {
    ...stored,
    coverageReviewedAt: new Date(),
    coverageReview: {
      mode: 'live'
    },
    briefing: {
      mode: 'live'
    }
  });
  const req = request();
  req.params.action = 'briefing';
  req.body = {
    version: 2
  };
  assert.equal((await invoke('/:action', 'post', req)).code, 409);
});
test('Continue later persists only deferred setup progress, not fake coverage or billing changes', async t => {
  t.mock.method(WorkspaceSetup, 'findOne', () => query(null));
  t.mock.method(WorkspaceSetup, 'create', async input => {
    assert.equal(input.orgId, orgId);
    assert.equal(input.status, 'deferred');
    assert.equal(input.coverageReviewedAt, undefined);
    assert.equal(input.paymentStatus, undefined);
    return {
      ...input,
      __v: 0
    };
  });
  const req = request();
  req.params.action = 'defer';
  req.body = {
    version: null,
    orgId: 'foreign',
    paymentStatus: 'paid'
  };
  assert.equal((await invoke('/:action', 'post', req)).body.state.status, 'deferred');
});
test('stored protected coverage snapshots are redacted after permission loss', async t => {
  const old = {
    mode: 'demo',
    gaps: [{
      id: 'accounts',
      label: 'Accounts',
      state: 'partial',
      detail: 'Private 99 unlinked records'
    }],
    coverage: [{
      id: 'accounts',
      state: 'available'
    }]
  };
  facts(t, {
    ...stored,
    coverageReview: old,
    completionReview: old,
    briefing: {
      mode: 'demo',
      coverage: old
    }
  });
  const req = request('viewer');
  req.user.permissions = ['command_center.view'];
  const result = await invoke('/', 'get', req);
  assert.ok(!JSON.stringify(result.body).includes('Private 99'));
  assert.equal(result.body.state.coverageReview.coverage[0].state, 'restricted');
  assert.equal(result.body.readiness.cards.find(c => c.id === 'accounts').counts, undefined);
});
test('unknown setup actions do not read or write progress', async t => {
  t.mock.method(WorkspaceSetup, 'findOne', () => assert.fail('Unknown actions must not read state'));
  const req = request();
  req.params.action = 'approve-billing';
  assert.equal((await invoke('/:action', 'post', req)).code, 404);
});
