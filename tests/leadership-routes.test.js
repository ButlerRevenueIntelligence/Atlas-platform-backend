import LeadershipDecision from '../models/LeadershipDecision.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import router from '../routes/leadership.js';
import RecoveryAction from '../models/RecoveryAction.js';
import LeadershipCheckpoint from '../models/LeadershipCheckpoint.js';
import Membership from '../models/Membership.js';
import Organization from '../models/Organization.js';
import User from '../models/User.js';
import CompanyIntelligence from '../models/CompanyIntelligence.js';
const orgId = '507f1f77bcf86cd799439011',
  otherOrg = '507f1f77bcf86cd799439012',
  userId = '507f1f77bcf86cd799439013',
  otherUser = '507f1f77bcf86cd799439014',
  actionId = '507f1f77bcf86cd799439015';
const response = () => ({
  code: 200,
  status(n) {
    this.code = n;
    return this;
  },
  json(value) {
    this.body = value;
    return this;
  }
});
const request = (role = 'owner') => ({
  orgId,
  user: {
    userId
  },
  leadershipMember: {
    role
  },
  body: {},
  query: {},
  params: {}
});
const handler = (path, method) => router.stack.find(l => l.route?.path === path && l.route.methods[method]).route.stack.at(-1).handle;
const invoke = async (path, method, req) => {
  const res = response();
  await handler(path, method)(req, res, error => {
    throw error;
  });
  return res;
};
const query = value => ({
  sort() {
    return this;
  },
  limit() {
    return this;
  },
  select() {
    return this;
  },
  lean: async () => value
});
function demo(t) {
  t.mock.method(Organization, 'findById', () => query({
    _id: orgId,
    name: 'Atlas Demo Company'
  }));
}
test('leadership gate requires active membership in canonical workspace', async t => {
  t.mock.method(Membership, 'findOne', filter => {
    assert.deepEqual(filter, {
      orgId,
      userId,
      status: 'active'
    });
    return query(null);
  });
  const res = response();
  await router.stack[3].handle(request(), res, () => assert.fail('No membership must not pass'));
  assert.equal(res.code, 403);
});
test('analysts cannot assign actions or create meeting checkpoints', async () => {
  for (const path of ['/actions', '/checkpoints']) {
    const res = await invoke(path, 'post', request('analyst'));
    assert.equal(res.code, 403);
  }
});
test('action update is tenant scoped and rejects cross-workspace IDs', async t => {
  t.mock.method(RecoveryAction, 'findOne', filter => {
    assert.deepEqual(filter, {
      _id: actionId,
      orgId
    });
    return query(null);
  });
  const req = request();
  req.params.id = actionId;
  req.body = {
    status: 'in_progress',
    outcome: '',
    version: 0
  };
  assert.equal((await invoke('/actions/:id', 'patch', req)).code, 404);
});
test('non-owner members cannot update someone else’s action', async t => {
  t.mock.method(RecoveryAction, 'findOne', () => query({
    _id: actionId,
    assigneeId: otherUser
  }));
  const req = request('member');
  req.params.id = actionId;
  req.body = {
    status: 'blocked',
    outcome: 'Awaiting legal',
    version: 0
  };
  assert.equal((await invoke('/actions/:id', 'patch', req)).code, 403);
});
test('viewer assignees cannot change actions and completion requires an outcome', async t => {
  t.mock.method(RecoveryAction, 'findOne', () => query({
    _id: actionId,
    assigneeId: userId
  }));
  const req = request('viewer');
  req.params.id = actionId;
  req.body = {
    status: 'completed',
    outcome: 'Done',
    version: 0
  };
  assert.equal((await invoke('/actions/:id', 'patch', req)).code, 403);
  req.leadershipMember.role = 'owner';
  req.body.outcome = '';
  assert.equal((await invoke('/actions/:id', 'patch', req)).code, 400);
});
test('updates atomically guard version and persist actor, outcome, completion time', async t => {
  t.mock.method(RecoveryAction, 'findOne', () => query({
    _id: actionId,
    assigneeId: userId
  }));
  t.mock.method(RecoveryAction, 'findOneAndUpdate', (filter, update) => {
    assert.deepEqual(filter, {
      _id: actionId,
      orgId,
      __v: 2
    });
    assert.equal(update.$inc.__v, 1);
    assert.equal(update.$set.status, 'completed');
    assert.equal(update.$set.outcome, 'Decision meeting scheduled');
    assert.ok(update.$set.completedAt instanceof Date);
    assert.equal(update.$push.history.$each[0].userId, userId);
    return query({
      __v: 3,
      status: 'completed'
    });
  });
  const req = request('member');
  req.params.id = actionId;
  req.body = {
    status: 'completed',
    outcome: 'Decision meeting scheduled',
    version: 2
  };
  assert.equal((await invoke('/actions/:id', 'patch', req)).body.action.__v, 3);
});
test('concurrent action edits return a conflict rather than overwriting new work', async t => {
  t.mock.method(RecoveryAction, 'findOne', () => query({
    _id: actionId,
    assigneeId: userId
  }));
  t.mock.method(RecoveryAction, 'findOneAndUpdate', () => query(null));
  const req = request();
  req.params.id = actionId;
  req.body = {
    status: 'open',
    outcome: '',
    version: 0
  };
  assert.equal((await invoke('/actions/:id', 'patch', req)).code, 409);
});
test('actions require a member in this workspace and cannot assign a viewer', async t => {
  t.mock.method(Membership, 'findOne', filter => {
    assert.equal(filter.orgId, orgId);
    assert.equal(filter.userId, otherUser);
    assert.equal(filter.status, 'active');
    return query({
      role: 'viewer'
    });
  });
  const req = request();
  req.body = {
    dealId: 'demo-deal-1',
    title: 'Confirm legal deadline',
    assigneeId: otherUser,
    dueAt: '2026-10-18'
  };
  assert.equal((await invoke('/actions', 'post', req)).code, 400);
});
test('action creation captures server-side deal evidence and real assignee identity', async t => {
  demo(t);
  t.mock.method(Membership, 'findOne', () => query({
    role: 'member'
  }));
  t.mock.method(User, 'findById', () => query({
    name: 'Actual team member'
  }));
  t.mock.method(RecoveryAction, 'create', async input => {
    assert.equal(input.orgId, orgId);
    assert.equal(input.ownerName, 'Actual team member');
    assert.equal(input.evidence.amount, 480000);
    assert.equal(input.createdBy, userId);
    assert.equal(input.history[0].status, 'open');
    return input;
  });
  const req = request();
  req.body = {
    dealId: 'demo-deal-1',
    title: 'Confirm legal deadline',
    assigneeId: otherUser,
    dueAt: '2026-10-18',
    evidence: {
      amount: 1
    }
  };
  const res = await invoke('/actions', 'post', req);
  assert.equal(res.code, 201);
});
test('checkpoint snapshots come from workspace records, never caller-supplied deal arrays', async t => {
  demo(t);
  t.mock.method(RecoveryAction, 'find', () => query([]));
  t.mock.method(LeadershipDecision, 'find', () => query([]));
  t.mock.method(LeadershipCheckpoint, 'create', async input => {
    assert.equal(input.orgId, orgId);
    assert.equal(input.deals.length, 9);
    assert.equal(input.deals[0].amount, 480000);
    return input;
  });
  const req = request();
  req.body = {
    label: 'Monday review',
    deals: [{
      amount: 1
    }]
  };
  assert.equal((await invoke('/checkpoints', 'post', req)).code, 201);
});
test('briefing rejects another workspace checkpoint and scopes every collection read', async t => {
  demo(t);
  for (const model of [LeadershipCheckpoint, RecoveryAction, Membership, CompanyIntelligence, LeadershipDecision]) t.mock.method(model, 'find', filter => {
    assert.equal(filter.orgId, orgId);
    return query([]);
  });
  t.mock.method(LeadershipCheckpoint, 'findOne', filter => {
    assert.equal(filter.orgId, orgId);
    return query(null);
  });
  const req = request();
  req.query.checkpointId = otherOrg;
  assert.equal((await invoke('/briefing', 'get', req)).code, 404);
});
test('first demo briefing includes labeled rehearsal but saves nothing', async t => {
  demo(t);
  for (const model of [LeadershipCheckpoint, RecoveryAction, Membership, LeadershipDecision]) t.mock.method(model, 'find', () => query([]));
  t.mock.method(User, 'find', () => query([]));
  t.mock.method(LeadershipCheckpoint, 'create', () => assert.fail('Read-only briefing must not seed data'));
  const res = await invoke('/briefing', 'get', request());
  assert.equal(res.body.workspaceMode, 'demo');
  assert.equal(res.body.checkpoint.isIllustrative, true);
  assert.equal(res.body.changes.length, 2);
  assert.equal(res.body.externalEventsAvailable, false);
});
test('scenario endpoint rejects invalid dates/deals instead of mutating opportunities', async t => {
  demo(t);
  const req = request();
  req.body = {
    dealId: 'outside-workspace',
    target: 10000
  };
  assert.equal((await invoke('/scenario', 'post', req)).code, 400);
  req.body = {
    dealId: 'demo-deal-1',
    delayDays: 30,
    target: 800000,
    horizon: 30
  };
  const res = await invoke('/scenario', 'post', req);
  assert.equal(res.body.weightedImpact, 345600);
});
test('new checkpoints capture tenant-scoped execution records and return no raw account snapshot', async t => {
  demo(t);
  const decisions = (await import('../models/LeadershipDecision.js')).default,
    plans = (await import('../models/AccountActionPlan.js')).default;
  for (const model of [RecoveryAction, decisions, plans]) t.mock.method(model, 'find', filter => {
    assert.equal(filter.orgId, orgId);
    return query([]);
  });
  t.mock.method(LeadershipCheckpoint, 'create', async input => {
    assert.equal(input.sourceMode, 'demo');
    assert.equal(input.execution.version, 1);
    assert.equal(input.execution.plansAvailable, true);
    assert.equal(input.createdBy, userId);
    return {
      _id: actionId,
      ...input
    };
  });
  const req = request();
  req.user.permissions = ['*'];
  req.body = {
    label: 'Leadership review',
    execution: {
      forged: true
    }
  };
  const res = await invoke('/checkpoints', 'post', req);
  assert.equal(res.code, 201);
  assert.equal(res.body.checkpoint.execution, undefined);
});
test('briefing hides account-plan snapshots after permission loss while preserving opportunity comparison', async t => {
  demo(t);
  const plans = (await import('../models/AccountActionPlan.js')).default;
  t.mock.method(plans, 'find', () => assert.fail('Account permission required to read plan collection'));
  for (const model of [LeadershipCheckpoint, RecoveryAction, Membership, LeadershipDecision]) t.mock.method(model, 'find', filter => {
    assert.equal(filter.orgId, orgId);
    return query([]);
  });
  t.mock.method(User, 'find', () => query([]));
  t.mock.method(LeadershipCheckpoint, 'findOne', () => query({
    _id: otherOrg,
    label: 'Earlier meeting',
    createdAt: new Date(),
    sourceMode: 'demo',
    deals: [],
    execution: {
      version: 1,
      plansAvailable: true,
      actions: [],
      decisions: [],
      plans: [{
        accountKey: 'secret',
        objective: 'Protected account plan'
      }]
    }
  }));
  const req = request();
  req.query.checkpointId = otherOrg;
  req.user.permissions = ['command_center.view'];
  const res = await invoke('/briefing', 'get', req);
  assert.equal(res.body.canReadAccountPlans, false);
  assert.equal(res.body.meetingChanges.plansCompared, false);
  assert.deepEqual(res.body.meetingChanges.planChanges, []);
  assert.equal(res.body.checkpoint.execution, undefined);
  assert.ok(!JSON.stringify(res.body).includes('Protected account plan'));
});
test('new demo/live mode mismatches cannot appear as pipeline gains or losses', async t => {
  demo(t);
  for (const model of [LeadershipCheckpoint, RecoveryAction, Membership, LeadershipDecision]) t.mock.method(model, 'find', () => query([]));
  t.mock.method(User, 'find', () => query([]));
  t.mock.method(LeadershipCheckpoint, 'findOne', () => query({
    _id: otherOrg,
    label: 'Live meeting',
    createdAt: new Date(),
    sourceMode: 'live',
    deals: [{
      id: 'one',
      amount: 100,
      stage: 'Proposal',
      probability: .5
    }]
  }));
  const req = request();
  req.query.checkpointId = otherOrg;
  const result = await invoke('/briefing', 'get', req);
  assert.equal(result.body.pipelineComparisonAvailable, false);
  assert.deepEqual(result.body.changes, []);
  assert.equal(result.body.previousSummary, null);
});
