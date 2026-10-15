import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, periodBounds, currentPeriods, evaluateSnapshot, buildPlanningDemo } from '../services/revenuePlanning.js';
import { buildDemoWorkspaceDeals } from '../services/demoWorkspace.js';
const now = new Date('2026-10-15T18:00:00Z');
const deal = (id, extra = {}) => ({
  _id: id,
  name: id,
  amount: 100,
  probability: .5,
  stage: 'Negotiation',
  closeDate: '2026-10-20',
  ...extra
});
const rows = [deal('won', {
  stage: 'Closed Won',
  closedAt: '2026-10-10',
  closeDate: '2026-11-10',
  probability: 1
}), deal('open'), deal('overdue', {
  amount: 1000,
  closeDate: '2026-10-02'
}), deal('future', {
  closeDate: '2026-11-02'
}), deal('lost', {
  stage: 'Closed Lost'
}), deal('undated', {
  closeDate: null
}), deal('unknown-won', {
  stage: 'Closed Won',
  closeDate: null
}), deal('old-won', {
  stage: 'Closed Won',
  closedAt: '2026-09-30'
})];
function revenueFixture({
  skipDay = false,
  zero = false
} = {}) {
  const metrics = [],
    days = [];
  for (let i = 30; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    metrics.push({
      date,
      stripeRevenue: zero ? 0 : i === 0 ? 10000 : 100,
      shopifyRevenue: 500,
      baseRevenue: 900
    });
    if (!(skipDay && i === 10)) days.push(date);
  }
  return {
    deals: rows,
    metrics,
    revenueObservationDays: {
      stripe: days
    }
  };
}
test('calendar month, quarter, and leap-year boundaries use exclusive UTC end dates', () => {
  assert.equal(periodBounds('2026-10', now).end.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(periodBounds('2026-Q4', now).end.toISOString(), '2027-01-01T00:00:00.000Z');
  assert.equal(periodBounds('2024-02', new Date('2024-02-14')).end.toISOString(), '2024-03-01T00:00:00.000Z');
  assert.deepEqual(currentPeriods(now), {
    month: '2026-10',
    quarter: '2026-Q4'
  });
  for (const key of ['2026-00', '2026-Q5', '2026-10-01', '2020-01']) assert.throws(() => periodBounds(key, now));
});
test('bookings use won outcome date, exclude closed/lost and overdue from open coverage', () => {
  const p = buildPlan({
    deals: rows
  }, '2026-10', 'bookings', 300, now);
  assert.equal(p.actual, 100);
  assert.equal(p.weightedOpen, 50);
  assert.equal(p.forecast, 150);
  assert.equal(p.gap, 200);
  assert.equal(p.uncoveredGap, 150);
  assert.equal(p.candidates.length, 1);
  assert.equal(p.overdueCount, 1);
  assert.equal(p.missingClose, 1);
  assert.equal(p.missingWonDate, 1);
  assert.equal(p.status, 'in_progress');
  assert.equal(p.actualDeals[0].id, 'won');
});
test('recorded revenue stays source-pinned, excludes partial today, and never adds CRM or other payment totals', () => {
  const p = buildPlan(revenueFixture(), '2026-10', 'stripe', 5000, now);
  assert.equal(p.actual, 1400);
  assert.equal(p.forecast, 3100);
  assert.equal(p.remainingDays, 17);
  assert.equal(p.baselineTotal, 3000);
  assert.equal(p.observedBaselineDays, 30);
  assert.equal(p.uncoveredGap, null);
  assert.equal(p.gap, 3600);
});
test('generated zero-fill days do not establish baseline completeness', () => {
  const p = buildPlan(revenueFixture({
    skipDay: true
  }), '2026-10', 'stripe', 5000, now);
  assert.equal(p.actual, 1400);
  assert.equal(p.observedBaselineDays, 29);
  assert.equal(p.forecast, null);
  assert.match(p.warning, /30 days/);
});
test('missing observations are unavailable rather than zero; real zero records remain valid', () => {
  const missing = buildPlan({
    metrics: revenueFixture().metrics,
    revenueObservationDays: {}
  }, '2026-10', 'stripe', 5000, now);
  assert.equal(missing.actual, null);
  assert.equal(missing.gap, null);
  assert.equal(missing.forecast, null);
  const zero = buildPlan(revenueFixture({
    zero: true
  }), '2026-10', 'stripe', 5000, now);
  assert.equal(zero.actual, 0);
  assert.equal(zero.forecast, 0);
});
test('future periods have no actuals yet and model covers exactly the selected future period', () => {
  const p = buildPlan(revenueFixture(), '2026-11', 'stripe', 5000, now);
  assert.equal(p.actual, 0);
  assert.equal(p.status, 'future');
  assert.equal(p.forecast, 3000);
  assert.equal(p.remainingDays, 30);
});
test('period results are not scored as misses before the period ends', () => {
  const snapshot = {
    period: '2026-10',
    metric: 'bookings',
    forecast: 300,
    evidence: {
      deals: []
    }
  };
  const outcome = evaluateSnapshot(snapshot, {
    deals: rows
  }, now);
  assert.equal(outcome.currentActual, 100);
  assert.equal(outcome.variance, null);
  assert.equal(outcome.variancePct, null);
  assert.equal(outcome.periodStatus, 'in_progress');
});
test('ended-period variance retains saved forecast, detects deal slippage, and handles zero baseline', () => {
  const saved = deal('open');
  const snapshot = {
    period: '2026-10',
    metric: 'bookings',
    forecast: 200,
    evidence: {
      deals: [{
        id: 'open',
        name: 'open',
        amount: 100,
        probability: .5,
        stage: 'Negotiation',
        closeDate: new Date(saved.closeDate).toISOString(),
        lastActivityAt: null,
        nextAction: '',
        nextActionDueAt: null,
        owner: ''
      }]
    }
  };
  const original = JSON.stringify(snapshot);
  const outcome = evaluateSnapshot(snapshot, {
    deals: [...rows.filter(d => d._id !== 'open'), {
      ...saved,
      closeDate: '2026-11-20'
    }]
  }, new Date('2026-11-02'));
  assert.equal(outcome.currentActual, 100);
  assert.equal(outcome.variance, -100);
  assert.equal(outcome.variancePct, -50);
  assert.equal(outcome.periodStatus, 'ended');
  assert.ok(outcome.changes[0].fields.some(f => f.field === 'closeDate'));
  assert.equal(JSON.stringify(snapshot), original);
  assert.equal(evaluateSnapshot({
    ...snapshot,
    forecast: 0
  }, {
    deals: rows
  }, new Date('2026-11-02')).variancePct, null);
});
test('an ended period with no source observations never reports a financial miss', () => {
  const outcome = evaluateSnapshot({
    period: '2026-09',
    metric: 'stripe',
    forecast: 1000,
    evidence: {
      deals: []
    }
  }, revenueFixture(), now);
  // Fixture includes September observation days, so compare an earlier period instead.
  const missing = evaluateSnapshot({
    period: '2026-08',
    metric: 'stripe',
    forecast: 1000,
    evidence: {
      deals: []
    }
  }, revenueFixture(), now);
  assert.equal(outcome.periodStatus, 'ended');
  assert.equal(missing.currentActual, null);
  assert.equal(missing.variance, null);
});
test('sample metric is forbidden for real workspaces and demo totals share canonical deals', () => {
  assert.throws(() => buildPlan({}, '2026-10', 'sample_revenue', 100, now));
  const data = buildPlanningDemo({}, now, buildDemoWorkspaceDeals);
  const plan = buildPlan(data, '2026-Q4', 'bookings', 1500000, now);
  assert.equal(plan.actual, 161000);
  assert.equal(plan.weightedOpen, 963950);
  assert.equal(plan.forecast, 1124950);
  assert.equal(plan.uncoveredGap, 375050);
  const last30 = data.metrics.slice(-30).reduce((s, r) => s + r.revenue, 0);
  assert.equal(last30, 55215);
  assert.equal(buildPlan(data, '2026-10', 'sample_revenue', 75000, now).observedBaselineDays, 30);
});
test('outcome-date corrections remain visible even when stage and expected close are unchanged', () => {
  const old = {
    ...rows[0],
    closedAt: '2026-09-30'
  };
  const snapshot = {
    period: '2026-10',
    metric: 'bookings',
    forecast: 100,
    evidence: {
      deals: [{
        id: 'won',
        name: 'won',
        amount: 100,
        probability: 1,
        stage: 'Closed Won',
        closeDate: '2026-11-10T00:00:00.000Z',
        closedAt: '2026-09-30T00:00:00.000Z',
        lastActivityAt: null,
        nextAction: '',
        nextActionDueAt: null,
        owner: ''
      }]
    }
  };
  const result = evaluateSnapshot(snapshot, {
    deals: [{
      ...old,
      closedAt: '2026-10-10'
    }]
  }, new Date('2026-11-02'));
  assert.equal(result.currentActual, 100);
  assert.ok(result.changes[0].fields.some(field => field.field === 'closedAt'));
});
