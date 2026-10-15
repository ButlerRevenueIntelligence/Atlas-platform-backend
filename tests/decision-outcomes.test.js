import test from 'node:test';
import assert from 'node:assert/strict';
import { captureExecution, meetingChanges, decisionView, validateDecision, canReadAccountPlans } from '../services/decisionOutcomes.js';
const at = new Date('2026-10-15T12:00:00Z'),
  beforeAt = new Date('2026-10-08T12:00:00Z');
const action = {
  _id: 'action-1',
  title: 'Schedule decision meeting',
  status: 'blocked',
  outcome: 'Awaiting buyer',
  dueAt: '2026-10-10',
  assigneeId: 'user',
  ownerName: 'Alex',
  __v: 0
};
const decision = {
  _id: 'decision-1',
  dealId: 'deal',
  text: 'Escalate',
  reviewAt: '2026-10-12',
  ownerName: 'Alex',
  reviewCount: 0,
  sourceMode: 'live',
  actionIds: ['action-1'],
  evidence: {
    id: 'deal',
    stage: 'Proposal',
    amount: 100
  }
};
const plan = {
  accountKey: 'client:one',
  objective: 'Confirm buyer',
  ownerName: 'Alex',
  blockers: [{
    text: 'Legal review',
    status: 'open'
  }]
};
const baseline = (actions = [action], decisions = [decision], plans = [plan]) => ({
  createdAt: beforeAt,
  sourceMode: 'live',
  deals: [],
  execution: captureExecution(actions, decisions, plans, true)
});
test('legacy checkpoints, illustrative checkpoints and workspace-mode switches need a fresh execution baseline', () => {
  const current = captureExecution([], [], [], true);
  assert.equal(meetingChanges(null, current, at).available, false);
  assert.equal(meetingChanges({
    createdAt: at
  }, current, at).available, false);
  assert.equal(meetingChanges(baseline(), current, at, 'demo').available, false);
});
test('meeting comparison distinguishes completed work, missed deadlines, reviewed decisions and resolved blockers', () => {
  const current = captureExecution([{
    ...action,
    status: 'completed',
    outcome: 'Buyer accepted meeting'
  }], [{
    ...decision,
    reviewCount: 1,
    latestReviewAt: at
  }], [{
    ...plan,
    blockers: [{
      text: 'Legal review',
      status: 'resolved'
    }]
  }], true);
  const changes = meetingChanges(baseline(), current, at);
  assert.equal(changes.counts.completed, 1);
  assert.equal(changes.counts.overdue, 0);
  assert.equal(changes.counts.reviewsDue, 0);
  assert.equal(changes.counts.resolvedBlockers, 1);
  assert.ok(changes.decisionChanges[0].events.includes('reviewed'));
});
test('an overdue commitment stays visible even with no record-field changes', () => {
  const changes = meetingChanges(baseline(), captureExecution([action], [decision], [plan], true), at);
  assert.equal(changes.counts.overdue, 1);
  assert.equal(changes.counts.reviewsDue, 1);
  assert.equal(changes.actionChanges[0].alreadyOverdueAtMeeting, false);
  const old = {
    ...action,
    dueAt: '2026-10-01'
  };
  assert.equal(meetingChanges(baseline([old]), captureExecution([old], [], [], true), at).actionChanges[0].alreadyOverdueAtMeeting, true);
});
test('a review before the review deadline does not falsely settle a later due review', () => {
  const current = captureExecution([], [{
    ...decision,
    reviewCount: 1,
    latestReviewAt: '2026-10-09'
  }], [], true);
  assert.equal(meetingChanges(baseline(), current, at).counts.reviewsDue, 1);
});
test('deleted/renamed/missing blockers and vanished actions are not reported as successful resolutions', () => {
  for (const blockers of [[], [{
    text: 'Different blocker',
    status: 'resolved'
  }]]) {
    const changes = meetingChanges(baseline(), captureExecution([], [], [{
      ...plan,
      blockers
    }], true), at);
    assert.equal(changes.counts.resolvedBlockers, 0);
    assert.equal(changes.counts.completed, 0);
  }
});
test('duplicate blocker wording cannot inflate resolution counts', () => {
  const first = {
    ...plan,
    blockers: [{
      text: 'Legal review',
      status: 'open'
    }, {
      text: 'Legal review',
      status: 'resolved'
    }]
  };
  const current = {
    ...plan,
    blockers: [{
      text: 'Legal review',
      status: 'resolved'
    }]
  };
  assert.equal(meetingChanges(baseline([], [], [first]), captureExecution([], [], [current], true), at).counts.resolvedBlockers, 0);
});
test('account permission loss hides plan comparisons and bounded snapshots disclose partial coverage', () => {
  const current = captureExecution(Array.from({
    length: 101
  }, (_, i) => ({
    ...action,
    _id: String(i)
  })), [], [plan], false);
  assert.equal(current.actions.length, 100);
  const changes = meetingChanges(baseline(), current, at);
  assert.equal(changes.limited, true);
  assert.equal(changes.plansCompared, false);
  assert.deepEqual(changes.planChanges, []);
  assert.equal(canReadAccountPlans({
    user: {
      permissions: ['command_center.view']
    }
  }), false);
  assert.equal(canReadAccountPlans({
    user: {
      permissions: ['clients.view']
    }
  }), true);
});
test('new risk flags account for elapsed time without treating already-known risks as new', () => {
  const deal = {
    id: 'd',
    name: 'Expansion',
    stage: 'Proposal',
    owner: 'Alex',
    nextAction: 'Call',
    closeDate: '2026-11-01',
    lastActivityAt: '2026-10-07'
  };
  const old = baseline([], [], []);
  old.deals = [deal];
  const changes = meetingChanges(old, {
    ...captureExecution([], [], [], true),
    deals: [deal]
  }, at);
  assert.deepEqual(changes.riskChanges[0].reasons, ['At least 7 days without recorded activity']);
  const oldRisk = {
    ...old,
    createdAt: '2026-10-14'
  };
  assert.equal(meetingChanges(oldRisk, {
    ...captureExecution([], [], [], true),
    deals: [deal]
  }, at).riskChanges.length, 0);
});
test('observed results use exact opportunity IDs and never sum action completions into recovered revenue', () => {
  const view = decisionView(decision, [{
    id: 'deal',
    stage: 'Closed Won',
    amount: 100
  }, {
    id: 'other',
    stage: 'Closed Won',
    amount: 999
  }], [{
    ...action,
    status: 'completed'
  }], 'live');
  assert.equal(view.currentDeal.amount, 100);
  assert.equal(view.linkedActions.length, 1);
  assert.equal(view.recoveredRevenue, undefined);
  assert.equal(view.dealChanges[0].fields.find(f => f.field === 'stage').after, 'Closed Won');
  assert.equal(decisionView(decision, [], [], 'live').comparisonAvailable, false);
  assert.equal(decisionView(decision, [{
    id: 'deal'
  }], [], 'demo').comparisonAvailable, false);
});
test('decision validation requires expected result, real review date, and unique bounded action IDs', () => {
  const body = {
    text: 'Escalate',
    reasoning: 'Legal deadline missed',
    expectedResult: 'Legal signoff',
    reviewAt: '2026-10-20',
    actionIds: []
  };
  assert.ok(validateDecision(body).reviewAt instanceof Date);
  for (const change of [{
    text: ''
  }, {
    reasoning: ''
  }, {
    expectedResult: ''
  }, {
    reviewAt: {}
  }, {
    actionIds: ['bad']
  }, {
    actionIds: Array(21).fill('507f1f77bcf86cd799439011')
  }]) assert.throws(() => validateDecision({
    ...body,
    ...change
  }));
});
test('new or reopened account blockers appear without pretending deleted blockers were resolved', () => {
  const current = captureExecution([], [], [{
    ...plan,
    blockers: [{
      text: 'Procurement reopened',
      status: 'open'
    }]
  }], true);
  const changes = meetingChanges(baseline(), current, at);
  assert.ok(changes.planChanges[0].events.includes('blockers_opened'));
  assert.equal(changes.planChanges[0].opened[0].text, 'Procurement reopened');
  assert.equal(changes.counts.resolvedBlockers, 0);
});
test('actions created and completed after a meeting count as completed work, not recovered revenue', () => {
  const current = captureExecution([{
    ...action,
    status: 'completed',
    createdAt: '2026-10-10',
    completedAt: '2026-10-14'
  }], [], [], true);
  const changes = meetingChanges(baseline([], [], []), current, at);
  assert.equal(changes.counts.completed, 1);
  assert.equal(changes.recoveredRevenue, undefined);
});
