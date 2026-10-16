import test from 'node:test';
import assert from 'node:assert/strict';
import router from '../routes/accountActionPlans.js';
import AccountActionPlan from '../models/AccountActionPlan.js';
import RecoveryAction from '../models/RecoveryAction.js';
import Membership from '../models/Membership.js';
import Organization from '../models/Organization.js';
import User from '../models/User.js';
const orgId = '507f1f77bcf86cd799439011',
  userId = '507f1f77bcf86cd799439013',
  otherUser = '507f1f77bcf86cd799439014',
  key = 'demo:demo-deal-1';
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
    userId,
    name: 'Actual author'
  },
  headers: {},
  accountPlanMember: {
    role
  },
  params: {
    accountKey: key
  },
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
const handler = (path, method) => router.stack.find(l => l.route?.path === path && l.route.methods[method]).route.stack.at(-1).handle;
async function invoke(path, method, req) {
  const res = response();
  await handler(path, method)(req, res, e => {
    throw e;
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
function roster(t) {
  t.mock.method(Membership, 'find', filter => {
    assert.deepEqual(filter, {
      orgId,
      status: 'active'
    });
    return query([{
      userId,
      role: 'member'
    }, {
      userId: otherUser,
      role: 'member'
    }]);
  });
  t.mock.method(User, 'find', filter => {
    assert.ok(filter._id.$in.includes(userId));
    assert.deepEqual(filter.status, {
      $nin: ['disabled', 'suspended']
    });
    return query([{
      _id: userId,
      name: 'Real member'
    }, {
      _id: otherUser,
      name: 'Other teammate'
    }]);
  });
}
const body = () => ({
  version: null,
  objective: 'Validate economic buyer and legal review',
  ownerId: userId,
  reviewAt: '2026-11-01',
  stakeholders: [],
  blockers: [{
    text: 'Decision process unknown',
    ownerId: otherUser,
    status: 'open'
  }]
});
test('account plan routes require authentication and an explicitly active workspace membership', async t => {
  const res = response();
  await router.stack[0].handle({
    headers: {}
  }, res, () => assert.fail('Must require token'));
  assert.equal(res.code, 401);
  t.mock.method(Membership, 'findOne', filter => {
    assert.deepEqual(filter, {
      orgId,
      userId,
      status: 'active'
    });
    return query(null);
  });
  const blocked = response();
  await router.stack[3].handle(request(), blocked, () => assert.fail('Must require active member'));
  assert.equal(blocked.code, 403);
});
test('directory reads do not create demo plans and resolve by exact opportunity ID', async t => {
  demo(t);
  t.mock.method(AccountActionPlan, 'find', filter => {
    assert.deepEqual(filter, {
      orgId
    });
    return query([]);
  });
  t.mock.method(AccountActionPlan, 'create', () => assert.fail('Reads never seed plans'));
  const req = request();
  req.query.dealId = 'demo-deal-1';
  const res = await invoke('/', 'get', req);
  assert.equal(res.body.resolvedKey, key);
  assert.equal(res.body.accounts.length, 6);
  assert.equal(res.body.workspaceMode, 'demo');
  assert.equal(res.body.accounts[0].plan.isDemoRecord, true);
  assert.ok(res.body.accounts.every(a => a.plan?.objective && a.plan?.blockers.length));
});
test('unknown opportunity/account references never resolve by a matching name', async t => {
  demo(t);
  t.mock.method(AccountActionPlan, 'find', () => query([]));
  const req = request();
  req.query.dealId = 'Northstar Enterprise Expansion';
  assert.equal((await invoke('/', 'get', req)).code, 404);
  req.query = {
    accountRef: 'Northstar Technology Group'
  };
  assert.equal((await invoke('/', 'get', req)).code, 404);
});
test('account details scope plan and recovery reads to workspace and linked deal IDs', async t => {
  demo(t);
  roster(t);
  t.mock.method(AccountActionPlan, 'findOne', filter => {
    assert.deepEqual(filter, {
      orgId,
      accountKey: key
    });
    return query(null);
  });
  t.mock.method(RecoveryAction, 'find', filter => {
    assert.equal(filter.orgId, orgId);
    assert.ok(filter.dealId.$in.includes('demo-deal-1'));
    assert.ok(!filter.dealId.$in.includes('demo-deal-2'));
    return query([]);
  });
  const res = await invoke('/:accountKey', 'get', request('viewer'));
  assert.equal(res.body.canEdit, false);
  assert.equal(res.body.canComment, false);
  assert.equal(res.body.canAssignActions, false);
  assert.equal(res.body.account.name, 'Northstar Technology Group');
  assert.equal(res.body.deals.length, 2);
});
test('foreign or invalid account keys fail before plan or recovery data reads', async t => {
  demo(t);
  t.mock.method(AccountActionPlan, 'findOne', () => assert.fail('Unknown account must not read a plan'));
  t.mock.method(RecoveryAction, 'find', () => assert.fail('Unknown account must not read actions'));
  const req = request();
  req.params.accountKey = 'client:507f1f77bcf86cd799439099';
  assert.equal((await invoke('/:accountKey', 'get', req)).code, 404);
  req.body = body();
  assert.equal((await invoke('/:accountKey', 'put', req)).code, 404);
});
test('only managers create a plan; ordinary members and viewers cannot', async t => {
  demo(t);
  t.mock.method(AccountActionPlan, 'findOne', () => query(null));
  for (const role of ['viewer', 'member', 'analyst']) {
    const req = request(role);
    req.body = body();
    assert.equal((await invoke('/:accountKey', 'put', req)).code, 403);
  }
});
test('plan creation captures canonical account, real owners, and server audit identity', async t => {
  demo(t);
  roster(t);
  t.mock.method(AccountActionPlan, 'findOne', () => query(null));
  t.mock.method(AccountActionPlan, 'create', async input => {
    assert.equal(input.orgId, orgId);
    assert.equal(input.accountKey, key);
    assert.equal(input.ownerName, 'Real member');
    assert.equal(input.blockers[0].ownerName, 'Other teammate');
    assert.equal(input.history.length, 1);
    assert.equal(input.history[0].authorId, userId);
    assert.equal(input.history[0].authorName, 'Actual author');
    assert.ok(input.history[0].at instanceof Date);
    return {
      ...input,
      __v: 0
    };
  });
  const req = request('manager');
  req.body = {
    ...body(),
    orgId: 'attacker-org',
    accountKey: 'attacker-key',
    ownerName: 'Fake owner',
    history: [{
      text: 'forged history'
    }]
  };
  assert.equal((await invoke('/:accountKey', 'put', req)).code, 200);
});
test('plan owners can edit strategy but cannot reassign ownership or bypass the revision check', async t => {
  demo(t);
  roster(t);
  t.mock.method(AccountActionPlan, 'findOne', () => query({
    ownerId: userId
  }));
  t.mock.method(AccountActionPlan, 'findOneAndUpdate', (filter, update) => {
    assert.deepEqual(filter, {
      orgId,
      accountKey: key,
      __v: 2
    });
    assert.equal(update.$inc.__v, 1);
    assert.equal(update.$push.history.$slice, -100);
    assert.equal(update.$set.history, undefined);
    return query({
      ...update.$set,
      __v: 3
    });
  });
  const req = request('member');
  req.body = {
    ...body(),
    version: 2
  };
  assert.equal((await invoke('/:accountKey', 'put', req)).body.plan.__v, 3);
  req.body.ownerId = otherUser;
  assert.equal((await invoke('/:accountKey', 'put', req)).code, 403);
});
test('viewer ownership does not grant write rights', async t => {
  demo(t);
  t.mock.method(AccountActionPlan, 'findOne', () => query({
    ownerId: userId
  }));
  const req = request('viewer');
  req.body = body();
  assert.equal((await invoke('/:accountKey', 'put', req)).code, 403);
});
test('concurrent strategy edits return 409 and preserve teammates changes', async t => {
  demo(t);
  roster(t);
  t.mock.method(AccountActionPlan, 'findOne', () => query({
    ownerId: userId
  }));
  t.mock.method(AccountActionPlan, 'findOneAndUpdate', () => query(null));
  const req = request();
  req.body = {
    ...body(),
    version: 0
  };
  assert.equal((await invoke('/:accountKey', 'put', req)).code, 409);
  req.body.version = null;
  assert.equal((await invoke('/:accountKey', 'put', req)).code, 409);
});
test('simultaneous first creation returns a conflict instead of an unhandled duplicate-key error', async t => {
  demo(t);
  roster(t);
  t.mock.method(AccountActionPlan, 'findOne', () => query(null));
  t.mock.method(AccountActionPlan, 'create', async () => {
    throw Object.assign(new Error('duplicate'), {
      code: 11000
    });
  });
  const req = request();
  req.body = body();
  assert.equal((await invoke('/:accountKey', 'put', req)).code, 409);
});
test('team notes append atomically; caller authors, timestamps, versions, and history are ignored', async t => {
  demo(t);
  t.mock.method(AccountActionPlan, 'findOne', () => query({
    ownerId: otherUser
  }));
  t.mock.method(AccountActionPlan, 'findOneAndUpdate', (filter, update) => {
    assert.deepEqual(filter, {
      orgId,
      accountKey: key
    });
    assert.equal(update.$inc, undefined); // Notes do not invalidate an unchanged strategy draft.
    const entry = update.$push.history.$each[0];
    assert.equal(entry.authorId, userId);
    assert.equal(entry.authorName, 'Actual author');
    assert.equal(entry.kind, 'note');
    assert.equal(entry.text, 'Buyer requested a revised business case');
    assert.ok(entry.at instanceof Date);
    assert.equal(update.$set, undefined);
    return query({
      history: [entry],
      __v: 3
    });
  });
  const req = request('member');
  req.body = {
    kind: 'note',
    text: 'Buyer requested a revised business case',
    authorId: 'attacker',
    at: '2020-01-01',
    history: [{
      text: 'forged'
    }],
    version: -1
  };
  assert.equal((await invoke('/:accountKey/updates', 'post', req)).code, 201);
});
test('decisions require the plan owner or a manager; viewers cannot post notes', async t => {
  demo(t);
  t.mock.method(AccountActionPlan, 'findOne', () => query({
    ownerId: otherUser
  }));
  t.mock.method(AccountActionPlan, 'findOneAndUpdate', () => query({
    history: []
  }));
  const req = request('member');
  req.body = {
    kind: 'decision',
    text: 'Keep out of committed forecast until procurement confirms'
  };
  assert.equal((await invoke('/:accountKey/updates', 'post', req)).code, 403);
  req.accountPlanMember.role = 'owner';
  assert.equal((await invoke('/:accountKey/updates', 'post', req)).code, 201);
  req.accountPlanMember.role = 'viewer';
  req.body.kind = 'note';
  assert.equal((await invoke('/:accountKey/updates', 'post', req)).code, 403);
});
test('notes require an existing plan and cannot replace history or masquerade as system updates', async t => {
  demo(t);
  t.mock.method(AccountActionPlan, 'findOne', () => query(null));
  const req = request('member');
  req.body = {
    kind: 'note',
    text: 'A note'
  };
  assert.equal((await invoke('/:accountKey/updates', 'post', req)).code, 404);
  req.body.kind = 'plan_updated';
  assert.equal((await invoke('/:accountKey/updates', 'post', req)).code, 400);
  req.body = {
    kind: 'note',
    text: ' '.repeat(5)
  };
  assert.equal((await invoke('/:accountKey/updates', 'post', req)).code, 400);
});
test('a former plan owner cannot post a decision after concurrent ownership reassignment', async t => {
  demo(t);
  t.mock.method(AccountActionPlan, 'findOne', () => query({
    ownerId: userId
  }));
  t.mock.method(AccountActionPlan, 'findOneAndUpdate', filter => {
    assert.deepEqual(filter, {
      orgId,
      accountKey: key,
      ownerId: userId
    });
    return query(null);
  });
  const req = request('member');
  req.body = {
    kind: 'decision',
    text: 'Decision made while ownership changed'
  };
  assert.equal((await invoke('/:accountKey/updates', 'post', req)).code, 409);
});
test('demo detail shows one connected plan with stakeholders, decisions and account-specific actions', async t => {
  demo(t);
  roster(t);
  t.mock.method(AccountActionPlan, 'findOne', () => query(null));
  t.mock.method(RecoveryAction, 'find', () => query([]));
  t.mock.method(AccountActionPlan, 'create', () => assert.fail('A GET must not persist templates'));
  const data = (await invoke('/:accountKey', 'get', request('owner'))).body;
  assert.equal(data.plan.accountKey, data.account.key);
  assert.ok(data.plan.stakeholders.length >= 3);
  assert.ok(data.plan.history.some(h => h.kind === 'decision'));
  assert.ok(data.plan.blockers.some(b => b.status === 'open'));
  assert.ok(data.actions.length);
  assert.ok(data.actions.every(a => data.account.dealIds.includes(a.dealId)));
  assert.equal(data.plan.__v, null);
  assert.equal(data.canEdit, true);
  assert.equal(data.canComment, false);
});
test('a saved plan replaces the demo template without losing team ownership or version', async t => {
  demo(t);
  roster(t);
  const saved = {
    accountKey: key,
    objective: 'Team-owned objective',
    ownerId: userId,
    ownerName: 'Real member',
    __v: 7,
    history: [],
    blockers: [],
    stakeholders: []
  };
  t.mock.method(AccountActionPlan, 'findOne', () => query(saved));
  t.mock.method(RecoveryAction, 'find', () => query([]));
  const data = (await invoke('/:accountKey', 'get', request('member'))).body;
  assert.equal(data.plan.objective, 'Team-owned objective');
  assert.equal(data.plan.__v, 7);
  assert.equal(data.plan.isDemoRecord, undefined);
  assert.equal(data.canComment, true);
});
