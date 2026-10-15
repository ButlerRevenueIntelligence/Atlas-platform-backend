import test from 'node:test';
import assert from 'node:assert/strict';
import router from '../routes/leadershipDecisions.js';
import LeadershipDecision from '../models/LeadershipDecision.js';
import RecoveryAction from '../models/RecoveryAction.js';
import AccountActionPlan from '../models/AccountActionPlan.js';
import Organization from '../models/Organization.js';
import Membership from '../models/Membership.js';
import User from '../models/User.js';
const orgId = '507f1f77bcf86cd799439011',
  userId = '507f1f77bcf86cd799439012',
  other = '507f1f77bcf86cd799439013',
  decisionId = '507f1f77bcf86cd799439014',
  actionId = '507f1f77bcf86cd799439015',
  entryId = '507f1f77bcf86cd799439016';
const query = value => ({
  select() {
    return this;
  },
  lean: async () => value
});
const req = (role = 'owner') => ({
  method: 'POST',
  orgId,
  user: {
    userId,
    name: 'Actual author',
    permissions: ['*']
  },
  leadershipMember: {
    role
  },
  params: {
    id: decisionId
  },
  query: {},
  body: {
    dealId: 'demo-deal-1',
    text: 'Escalate legal',
    reasoning: 'Review is still open',
    expectedResult: 'Legal signoff',
    ownerId: userId,
    reviewAt: '2026-10-20',
    actionIds: []
  }
});
const res = () => ({
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
const invoke = async (path, method, r) => {
  const s = res();
  await router.stack.find(l => l.route?.path === path && l.route.methods[method]).route.stack.at(-1).handle(r, s, e => {
    throw e;
  });
  return s;
};
const demo = t => t.mock.method(Organization, 'findById', () => query({
  _id: orgId,
  name: 'Atlas Demo Company'
}));
const stored = {
  _id: decisionId,
  dealId: 'demo-deal-1',
  ownerId: userId,
  sourceMode: 'demo',
  __v: 0
};
function owner(t, role = 'member', status = 'active') {
  t.mock.method(Membership, 'findOne', filter => {
    assert.equal(filter.orgId, orgId);
    assert.equal(filter.status, 'active');
    return query({
      role
    });
  });
  t.mock.method(User, 'findById', () => query({
    name: 'Actual owner',
    status
  }));
}
test('only managers can begin tracking; viewers and ordinary members cannot', async () => {
  for (const role of ['viewer', 'member', 'analyst']) assert.equal((await invoke('/', 'post', req(role))).code, 403);
});
test('creation preserves server evidence, owner and author; ignores forged source snapshots/reviews/tenant', async t => {
  demo(t);
  owner(t);
  t.mock.method(LeadershipDecision, 'create', async value => {
    assert.equal(value.orgId, orgId);
    assert.equal(value.ownerName, 'Actual owner');
    assert.equal(value.authorName, 'Actual author');
    assert.equal(value.evidence.amount, 480000);
    assert.equal(value.evidence.stage, 'Negotiation');
    assert.equal(value.reviews, undefined);
    assert.equal(value.__v, undefined);
    assert.equal(value.sourceMode, 'demo');
    return value;
  });
  const r = req();
  r.body = {
    ...r.body,
    orgId: other,
    evidence: {
      amount: 1
    },
    ownerName: 'Fake',
    reviews: [{
      assessment: 'improved'
    }],
    __v: 9
  };
  assert.equal((await invoke('/', 'post', r)).code, 201);
});
test('foreign opportunities, viewer owners and disabled users are rejected', async t => {
  demo(t);
  owner(t, 'viewer');
  assert.equal((await invoke('/', 'post', req())).code, 400);
  t.mock.restoreAll();
  demo(t);
  owner(t, 'member', 'disabled');
  assert.equal((await invoke('/', 'post', req())).code, 400);
  const r = req();
  r.body.dealId = 'foreign';
  assert.equal((await invoke('/', 'post', r)).code, 404);
});
test('action links are validated against tenant and exact opportunity, not supplied names', async t => {
  demo(t);
  owner(t);
  t.mock.method(RecoveryAction, 'find', filter => {
    assert.equal(filter.orgId, orgId);
    assert.equal(filter.dealId, 'demo-deal-1');
    assert.deepEqual(filter._id.$in, [actionId]);
    return query([]);
  });
  const r = req();
  r.body.actionIds = [actionId];
  assert.equal((await invoke('/', 'post', r)).code, 400);
});
test('account decision promotion requires account permission and its exact linked opportunity', async t => {
  demo(t);
  t.mock.method(AccountActionPlan, 'findOne', filter => {
    assert.deepEqual(filter, {
      orgId,
      accountKey: 'demo:demo-deal-1'
    });
    return query({
      history: [{
        _id: entryId,
        kind: 'decision',
        text: 'Original account decision',
        at: new Date()
      }]
    });
  });
  const r = req();
  r.body.accountKey = 'demo:demo-deal-1';
  r.body.entryId = entryId;
  r.user.permissions = [];
  assert.equal((await invoke('/', 'post', r)).code, 403);
  r.user.permissions = ['clients.view'];
  r.body.dealId = 'demo-deal-2';
  assert.equal((await invoke('/', 'post', r)).code, 400);
});
test('source decision text and timestamp are preserved rather than rewritten during promotion', async t => {
  demo(t);
  owner(t);
  const at = new Date('2026-10-01');
  t.mock.method(AccountActionPlan, 'findOne', () => query({
    history: [{
      _id: entryId,
      kind: 'decision',
      text: 'Original decision',
      at
    }]
  }));
  t.mock.method(LeadershipDecision, 'create', async value => {
    assert.equal(value.text, 'Original decision');
    assert.equal(value.sourceDecidedAt, at);
    assert.equal(value.sourceEntryId, entryId);
    assert.equal(value.sourceAccountKey, 'demo:demo-deal-1');
    return value;
  });
  const r = req();
  r.body = {
    ...r.body,
    accountKey: 'demo:demo-deal-1',
    entryId,
    text: 'Forged replacement'
  };
  assert.equal((await invoke('/', 'post', r)).code, 201);
});
test('source notes and unknown account keys cannot masquerade as account decisions', async t => {
  demo(t);
  t.mock.method(AccountActionPlan, 'findOne', () => query({
    history: [{
      _id: entryId,
      kind: 'note',
      text: 'Not a decision'
    }]
  }));
  const r = req();
  r.body = {
    ...r.body,
    accountKey: 'demo:demo-deal-1',
    entryId
  };
  assert.equal((await invoke('/', 'post', r)).code, 404);
  r.body.accountKey = 'client:foreign';
  assert.equal((await invoke('/', 'post', r)).code, 404);
});
test('duplicate promotion returns a useful conflict', async t => {
  demo(t);
  owner(t);
  t.mock.method(LeadershipDecision, 'create', async () => {
    throw Object.assign(new Error('duplicate'), {
      code: 11000
    });
  });
  assert.equal((await invoke('/', 'post', req())).code, 409);
});
test('decision reviews are tenant scoped and require owner or manager; viewer ownership grants no write', async t => {
  t.mock.method(LeadershipDecision, 'findOne', filter => {
    assert.deepEqual(filter, {
      _id: decisionId,
      orgId
    });
    return query({
      ...stored,
      ownerId: other
    });
  });
  const r = req('member');
  r.body = {
    version: 0,
    assessment: 'improved',
    note: 'Buyer confirmed approval'
  };
  assert.equal((await invoke('/:id', 'patch', r)).code, 403);
  r.leadershipMember.role = 'viewer';
  assert.equal((await invoke('/:id', 'patch', r)).code, 403);
  t.mock.restoreAll();
  t.mock.method(LeadershipDecision, 'findOne', () => query(null));
  assert.equal((await invoke('/:id', 'patch', r)).code, 404);
});
test('outcome review captures current server evidence, author and version without rewriting original decision', async t => {
  demo(t);
  t.mock.method(LeadershipDecision, 'findOne', () => query(stored));
  t.mock.method(LeadershipDecision, 'findOneAndUpdate', (filter, update) => {
    assert.deepEqual(filter, {
      _id: decisionId,
      orgId,
      __v: 0
    });
    assert.equal(update.$inc.__v, 1);
    assert.equal(update.$inc.reviewCount, 1);
    assert.equal(update.$push.reviews.$slice, -100);
    assert.equal(update.$set.text, undefined);
    const review = update.$push.reviews.$each[0];
    assert.equal(review.evidence.amount, 480000);
    assert.equal(review.authorId, userId);
    assert.equal(review.authorName, 'Actual author');
    assert.ok(review.at instanceof Date);
    return query({
      ...stored,
      __v: 1
    });
  });
  const r = req('member');
  r.body = {
    version: 0,
    assessment: 'unchanged',
    note: 'Legal still open',
    evidence: {
      amount: 1
    },
    authorId: other,
    text: 'Rewrite'
  };
  assert.equal((await invoke('/:id', 'patch', r)).body.decision.__v, 1);
});
test('stale reviews return 409 and cannot overwrite teammate work', async t => {
  demo(t);
  t.mock.method(LeadershipDecision, 'findOne', () => query(stored));
  t.mock.method(LeadershipDecision, 'findOneAndUpdate', () => query(null));
  const r = req();
  r.body = {
    version: 0,
    assessment: 'unchanged',
    note: 'Awaiting approval'
  };
  assert.equal((await invoke('/:id', 'patch', r)).code, 409);
});
test('missing evidence requires insufficient-evidence review; data-mode changes cannot fabricate outcomes', async t => {
  demo(t);
  t.mock.method(LeadershipDecision, 'findOne', () => query({
    ...stored,
    dealId: 'missing'
  }));
  const r = req();
  r.body = {
    version: 0,
    assessment: 'improved',
    note: 'Looks good'
  };
  assert.equal((await invoke('/:id', 'patch', r)).code, 400);
  t.mock.method(LeadershipDecision, 'findOneAndUpdate', (_, update) => {
    assert.equal(update.$push.reviews.$each[0].evidence.unavailable, true);
    return query(stored);
  });
  r.body.assessment = 'insufficient_evidence';
  assert.equal((await invoke('/:id', 'patch', r)).code, 200);
  t.mock.restoreAll();
  demo(t);
  t.mock.method(LeadershipDecision, 'findOne', () => query({
    ...stored,
    sourceMode: 'live'
  }));
  assert.equal((await invoke('/:id', 'patch', r)).code, 409);
});
test('link updates and reviews are distinct atomic operations; foreign links are rejected', async t => {
  t.mock.method(LeadershipDecision, 'findOne', () => query(stored));
  const r = req();
  r.body = {
    version: 0,
    actionIds: [],
    assessment: 'improved'
  };
  assert.equal((await invoke('/:id', 'patch', r)).code, 400);
  r.body = {
    version: 0,
    actionIds: [actionId]
  };
  t.mock.method(RecoveryAction, 'find', filter => {
    assert.equal(filter.orgId, orgId);
    assert.equal(filter.dealId, stored.dealId);
    return query([]);
  });
  assert.equal((await invoke('/:id', 'patch', r)).code, 400);
  r.body.actionIds = [];
  t.mock.method(LeadershipDecision, 'findOneAndUpdate', (_, update) => {
    assert.deepEqual(update, {
      $set: {
        actionIds: []
      },
      $inc: {
        __v: 1
      }
    });
    return query(stored);
  });
  assert.equal((await invoke('/:id', 'patch', r)).code, 200);
});
test('retained review history reads are tenant scoped and expose only reviews/version/count', async t => {
  t.mock.method(LeadershipDecision, 'findOne', filter => {
    assert.deepEqual(filter, {
      _id: decisionId,
      orgId
    });
    return query({
      reviews: [{
        note: 'Observed approval'
      }],
      reviewCount: 8,
      __v: 2
    });
  });
  const r = req();
  r.method = 'GET';
  const result = await invoke('/:id/reviews', 'get', r);
  assert.equal(result.body.version, 2);
  assert.equal(result.body.reviews[0].note, 'Observed approval');
  assert.equal(result.body.evidence, undefined);
  t.mock.restoreAll();
  t.mock.method(LeadershipDecision, 'findOne', () => query(null));
  assert.equal((await invoke('/:id/reviews', 'get', r)).code, 404);
});
