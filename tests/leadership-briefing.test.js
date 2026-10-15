import test from 'node:test';
import assert from 'node:assert/strict';
import { captureDeals, compareDeals, summarize, priorities, simulateSlip, matchExternalContext, demoComparison } from '../services/leadershipBriefing.js';
import { buildDemoWorkspaceDeals } from '../services/demoWorkspace.js';
const now = new Date('2026-10-15T12:00:00Z');
const deals = captureDeals(buildDemoWorkspaceDeals({}, now));
test('leadership totals agree with canonical workspace deals and exclude closed outcomes', () => {
  const s = summarize(deals, now);
  assert.equal(s.pipeline, 1665000);
  assert.equal(s.weighted, 963950);
  assert.equal(s.openCount, 6);
  assert.equal(summarize(deals, now, 30).weighted, 762650);
});
test('meeting comparison identifies changed fields, additions, and invisible records without assuming a loss', () => {
  const previous = structuredClone(deals);
  previous[0].stage = 'Proposal';
  previous[0].amount = 400000;
  const current = deals.slice(1);
  current.push({
    ...deals[0],
    id: 'new-deal'
  });
  const changes = compareDeals(previous, current);
  assert.equal(changes.find(c => c.dealId === deals[0].id).kind, 'no_longer_visible');
  assert.equal(changes.find(c => c.dealId === 'new-deal').kind, 'added');
  const changed = compareDeals(previous, deals);
  assert.deepEqual(changed[0].fields.map(f => f.field), ['amount', 'stage']);
  assert.deepEqual(compareDeals(deals, structuredClone(deals)), []);
});
test('scenario moves one expected close date without mutating records or double-counting existing coverage', () => {
  const original = JSON.stringify(deals);
  const result = simulateSlip(deals, {
    dealId: 'demo-deal-1',
    delayDays: 30,
    target: 800000,
    horizon: 30
  }, now);
  assert.equal(result.baseline.weighted, 762650);
  assert.equal(result.scenario.weighted, 417050);
  assert.equal(result.weightedImpact, 345600);
  assert.equal(result.gap, 382950);
  assert.ok(result.alternatives.every(d => new Date(d.closeDate) > new Date(now.getTime() + 30 * 86400000)));
  assert.ok(!result.alternatives.some(d => d.id === 'demo-deal-1'));
  assert.equal(JSON.stringify(deals), original);
});
test('a slip inside the outlook has zero effect and invalid scenario inputs are rejected', () => {
  assert.equal(simulateSlip(deals, {
    dealId: 'demo-deal-1',
    delayDays: 14,
    target: 0,
    horizon: 90
  }, now).weightedImpact, 0);
  for (const input of [{
    dealId: 'missing'
  }, {
    dealId: 'demo-closed-0'
  }, {
    dealId: 'demo-deal-1',
    delayDays: -1
  }, {
    dealId: 'demo-deal-1',
    horizon: 3
  }, {
    dealId: 'demo-deal-1',
    target: NaN
  }]) assert.throws(() => simulateSlip(deals, input, now));
});
test('overdue opportunities stay visible while missing close dates are excluded from dated totals', () => {
  const rows = [{
    ...deals[0],
    closeDate: '2026-10-01T00:00:00Z'
  }, {
    ...deals[1],
    closeDate: null
  }];
  assert.equal(summarize(rows, now, 30).weighted, 345600);
  assert.equal(summarize(rows, now, 30).undatedCount, 1);
  assert.ok(priorities(rows, now)[0].reasons.includes('Expected close date has passed'));
});
test('sparse malformed provider fields produce finite values and missing evidence stays missing', () => {
  const [d] = captureDeals([{
    id: 'sparse',
    amount: Infinity,
    probability: 500,
    closeDate: 'bad-date',
    lastActivityAt: null,
    sourcePayload: {
      accessToken: 'secret'
    }
  }]);
  assert.equal(d.amount, 0);
  assert.equal(d.probability, 1);
  assert.equal(d.closeDate, null);
  assert.equal(d.lastActivityAt, null);
  assert.equal(d.sourcePayload, undefined);
  assert.ok(priorities([d], now)[0].reasons.includes('Owner not recorded'));
});
test('external context matches only supplied unexpired company profiles, never substring intent', () => {
  const base = {
    _id: 'snapshot',
    createdAt: now,
    expiresAt: '2026-10-16T00:00:00Z',
    data: {
      organizations: [{
        name: 'Northstar Technology Group',
        description: 'Technology services',
        website: 'https://example.test'
      }, {
        name: 'Northstar',
        description: 'Unrelated'
      }]
    }
  };
  const matches = matchExternalContext([base, {
    ...base,
    expiresAt: '2026-10-14'
  }], deals, now);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].deals.length, 1);
  assert.equal(matches[0].deals[0].id, 'demo-deal-1');
  assert.equal(matches[0].source, 'GraphIQ');
  assert.equal(matches[0].event, undefined);
  assert.deepEqual(matchExternalContext([{
    ...base,
    data: {
      data: {
        entities: []
      }
    }
  }], deals, now), []);
});
test('demo rehearsal is visibly illustrative and never changes shared source data', () => {
  const before = JSON.stringify(deals);
  const checkpoint = demoComparison(deals, now);
  assert.equal(checkpoint.isIllustrative, true);
  assert.equal(compareDeals(checkpoint.deals, deals).length, 2);
  assert.equal(JSON.stringify(deals), before);
});
