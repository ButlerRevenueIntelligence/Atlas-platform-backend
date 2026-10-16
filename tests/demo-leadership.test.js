import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoExecution, withDemoRecords } from '../services/demoLeadership.js';
import { buildDemoWorkspaceDeals, isDemoWorkspace } from '../services/demoWorkspace.js';
import { captureDeals } from '../services/leadershipBriefing.js';
import { buildAccountCatalog } from '../services/accountActionPlans.js';
import { decisionView, captureExecution, meetingChanges } from '../services/decisionOutcomes.js';
import { buildDemoForecastHistory, buildPlanningDemo, currentPeriods } from '../services/revenuePlanning.js';
const fixture = day => {
  const now = new Date(day),
    raw = buildDemoWorkspaceDeals({
      name: 'Atlas Demo Company'
    }, now),
    deals = captureDeals(raw);
  return {
    now,
    raw,
    deals,
    scenario: buildDemoExecution(deals, now)
  };
};
test('all shared demo accounts have complete plans linked to the canonical opportunity catalog', () => {
  const {
    raw,
    deals,
    scenario
  } = fixture('2026-10-16');
  const catalog = buildAccountCatalog({
    deals: raw,
    demo: true
  });
  assert.equal(scenario.plans.length, catalog.accounts.length);
  for (const a of catalog.accounts) {
    const p = scenario.plans.find(p => p.accountKey === a.key);
    assert.ok(p.objective);
    assert.ok(p.stakeholders.some(s => s.role === 'economic_buyer'));
    assert.ok(p.stakeholders.some(s => s.role === 'champion'));
    assert.ok(p.blockers.some(b => b.status === 'open'));
    assert.ok(p.history.some(h => h.kind === 'decision'));
    assert.equal(p.isDemoRecord, true);
    for (const id of a.dealIds) assert.ok(deals.some(d => d.id === id));
  }
});
test('recovery records include active, blocked, overdue and completed work with readable outcomes', () => {
  const {
    now,
    deals,
    scenario
  } = fixture('2026-10-16');
  assert.ok(scenario.actions.some(a => a.status === 'blocked'));
  assert.ok(scenario.actions.some(a => a.status === 'completed' && a.outcome));
  assert.ok(scenario.actions.some(a => a.status !== 'completed' && new Date(a.dueAt) < now));
  for (const a of scenario.actions) {
    assert.ok(deals.some(d => d.id === a.dealId));
    assert.equal(a.assigneeId, null);
    assert.ok(a.ownerName);
    assert.ok(a.history.length);
    assert.equal(a.isDemoRecord, true);
  }
});
test('decision examples resolve all actions, account plans and current deal evidence', () => {
  const {
    deals,
    scenario
  } = fixture('2026-10-16');
  const decisions = scenario.decisions.map(d => decisionView(d, deals, scenario.actions, 'demo'));
  assert.equal(decisions.length, 3);
  assert.ok(decisions.some(d => d.reviews.some(r => r.assessment === 'improved')));
  assert.ok(decisions.some(d => d.reviews.some(r => r.assessment === 'worsened')));
  assert.ok(decisions.some(d => d.reviewCount === 0));
  for (const d of decisions) {
    assert.equal(d.missingActionCount, 0);
    assert.ok(d.linkedActions.length);
    assert.ok(d.comparisonAvailable);
    assert.ok(scenario.plans.some(p => p.accountKey === d.sourceAccountKey));
  }
  assert.ok(decisions.some(d => d.dealChanges.length));
});
test('account context is local research, never falsely attributed to a live GraphIQ lookup', () => {
  const {
    deals,
    scenario
  } = fixture('2026-10-16');
  assert.ok(scenario.externalContext.length >= 3);
  for (const c of scenario.externalContext) {
    assert.equal(c.source, 'Account research');
    assert.ok(c.description);
    assert.ok(scenario.plans.some(p => p.accountKey === c.accountKey));
    assert.ok(c.deals.every(d => deals.some(v => v.id === d.id)));
  }
});
test('existing shared records take precedence and fixture objects are not mutated', () => {
  const {
    scenario
  } = fixture('2026-10-16');
  const before = JSON.stringify(scenario);
  const stored = {
    accountKey: scenario.plans[0].accountKey,
    objective: 'Keep my saved plan',
    __v: 9
  };
  const merged = withDemoRecords([stored], scenario.plans, 'accountKey');
  assert.equal(merged.length, scenario.plans.length);
  assert.equal(merged[0], stored);
  assert.equal(JSON.stringify(scenario), before);
});
test('scenario IDs remain stable and action/review dates stay useful across months', () => {
  const a = fixture('2026-10-16').scenario,
    b = fixture('2027-02-16').scenario;
  assert.deepEqual(a.actions.map(a => a._id), b.actions.map(a => a._id));
  assert.deepEqual(a.plans.map(p => p.accountKey), b.plans.map(p => p.accountKey));
  assert.notEqual(a.actions[0].dueAt, b.actions[0].dueAt);
  assert.equal(isDemoWorkspace({
    name: 'Real customer'
  }), false);
});
test('forecast history includes in-progress and completed periods with calculated variances', () => {
  for (const day of ['2026-10-01', '2026-10-16', '2027-01-01']) for (const metric of ['bookings', 'sample_revenue']) for (const period of Object.values(currentPeriods(new Date(day)))) {
    const now = new Date(day),
      data = buildPlanningDemo({}, now, buildDemoWorkspaceDeals),
      rows = buildDemoForecastHistory(data, period, metric, now);
    assert.equal(rows.length, 3);
    assert.ok(rows.some(r => r.periodStatus === 'in_progress'));
    const ended = rows.filter(r => r.periodStatus === 'ended');
    assert.equal(ended.length, 2);
    assert.ok(ended.every(r => r.currentActual > 0 && r.variance !== null));
    for (const row of ended) {
      assert.equal(Math.round((row.currentActual - row.forecast) * 100) / 100, row.variance);
      assert.ok(row.asOf < new Date(row.evidence.end));
      assert.ok(row.evidence.deals.every(d => d.stage === 'Proposal') || metric !== 'bookings');
    }
    assert.ok(rows.every(r => r.workspaceMode === 'demo' && r.isDemoRecord));
  }
});
test('live planning never receives manufactured forecast history', () => {
  assert.deepEqual(buildDemoForecastHistory({
    demo: false
  }, '2026-10', 'bookings'), []);
});
test('refreshing on the same day does not manufacture changed action deadlines or plan review dates', () => {
  const a = fixture('2026-10-16T01:00:00Z').scenario,
    b = fixture('2026-10-16T19:40:00Z').scenario;
  assert.deepEqual(a.actions.map(a => a.dueAt), b.actions.map(a => a.dueAt));
  assert.deepEqual(a.plans.map(p => p.reviewAt), b.plans.map(p => p.reviewAt));
});
