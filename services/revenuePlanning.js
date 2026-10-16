import { captureDeals, compareDeals } from './leadershipBriefing.js';
const DAY = 86400000;
const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
export const METRIC_LABELS = {
  bookings: 'CRM won value',
  stripe: 'Recorded revenue · Stripe',
  shopify: 'Recorded revenue · Shopify',
  metrics_daily: 'Recorded revenue · imported metrics',
  sample_revenue: 'Recorded revenue'
};
const sourceField = {
  stripe: 'stripeRevenue',
  shopify: 'shopifyRevenue',
  metrics_daily: 'baseRevenue',
  sample_revenue: 'revenue'
};
export const dayKey = value => new Date(value).toISOString().slice(0, 10);
export function periodBounds(key, now = new Date(), allowHistorical = false) {
  const match = /^(\d{4})-(?:(0[1-9]|1[0-2])|Q([1-4]))$/.exec(String(key));
  if (!match) throw new Error('Choose a calendar month or quarter');
  const year = Number(match[1]),
    month = match[2] ? Number(match[2]) - 1 : (Number(match[3]) - 1) * 3;
  const start = new Date(Date.UTC(year, month, 1)),
    end = new Date(Date.UTC(year, month + (match[2] ? 1 : 3), 1));
  const months = (year - now.getUTCFullYear()) * 12 + month - now.getUTCMonth();
  if (!allowHistorical && (months < -18 || months > 15)) throw new Error('Choose a period within the last 18 or next 15 months');
  return {
    key,
    start,
    end,
    kind: match[2] ? 'month' : 'quarter',
    label: match[2] ? start.toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC'
    }) : `Q${match[3]} ${year}`
  };
}
export function currentPeriods(now = new Date()) {
  return {
    month: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
    quarter: `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`
  };
}
export function validateMetric(metric, demo) {
  if (!Object.hasOwn(METRIC_LABELS, metric) || metric === 'sample_revenue' && !demo) throw new Error('Choose an available revenue measure');
  return metric;
}
export function buildPlan({
  deals = [],
  metrics = [],
  revenueObservationDays = {},
  demo = false
}, period, metric, target = null, now = new Date(), allowHistorical = false) {
  validateMetric(metric, demo);
  const bounds = periodBounds(period, now, allowHistorical),
    today = new Date(`${dayKey(now)}T00:00:00Z`);
  const rows = captureDeals(deals),
    booking = metric === 'bookings';
  const rawById = new Map(deals.map(d => [String(d._id || d.id), d]));
  const wonDate = d => rawById.get(d.id)?.closedAt || d.closeDate;
  const inPeriod = value => value && new Date(value) >= bounds.start && new Date(value) < bounds.end;
  const actualDeals = rows.filter(d => d.stage.toLowerCase() === 'closed won' && inPeriod(wonDate(d)) && new Date(wonDate(d)) <= now);
  const observations = new Set((revenueObservationDays[metric] || []).filter(d => d <= dayKey(now)));
  const actualRows = metrics.filter(row => inPeriod(row.date) && row.date < dayKey(now));
  const available = booking || (now < bounds.start ? observations.size > 0 : [...observations].some(d => inPeriod(d) && d < dayKey(now)));
  const actual = booking ? actualDeals.reduce((s, d) => s + d.amount, 0) : actualRows.reduce((s, row) => s + Number(row[sourceField[metric]] || 0), 0);
  const candidates = rows.filter(d => !['closed won', 'closed lost'].includes(d.stage.toLowerCase()) && inPeriod(d.closeDate) && new Date(d.closeDate) >= today);
  const overdue = rows.filter(d => !['closed won', 'closed lost'].includes(d.stage.toLowerCase()) && d.closeDate && new Date(d.closeDate) < today);
  const weighted = candidates.reduce((s, d) => s + d.amount * d.probability, 0);
  const missingClose = rows.filter(d => !['closed won', 'closed lost'].includes(d.stage.toLowerCase()) && !d.closeDate).length;
  const missingWonDate = deals.filter(d => String(d.stage).toLowerCase() === 'closed won' && !d.closedAt && !d.closeDate).length;
  const lookbackStart = new Date(today.getTime() - 30 * DAY),
    lookback = [];
  for (let d = new Date(lookbackStart); d < today; d.setUTCDate(d.getUTCDate() + 1)) lookback.push(dayKey(d));
  const completeBaseline = lookback.every(d => observations.has(d));
  const baselineTotal = metrics.filter(row => lookback.includes(row.date)).reduce((s, row) => s + Number(row[sourceField[metric]] || 0), 0);
  const remainingDays = Math.max(0, Math.ceil((bounds.end - Math.max(today.getTime(), bounds.start.getTime())) / DAY));
  const forecast = booking ? actual + weighted : available && (remainingDays === 0 || completeBaseline) ? actual + baselineTotal / 30 * remainingDays : null;
  const daily = metrics.filter(row => inPeriod(row.date) && row.date < dayKey(now)).map(row => ({
    date: row.date,
    value: Number(row[sourceField[metric]] || 0),
    observed: observations.has(row.date)
  }));
  const actualThrough = booking ? bounds.end <= now ? new Date(bounds.end - 1) : now : bounds.end <= today ? new Date(bounds.end - DAY) : new Date(today - DAY);
  return {
    period: bounds.key,
    label: bounds.label,
    start: bounds.start,
    end: bounds.end,
    timeZone: 'UTC',
    metric,
    metricLabel: METRIC_LABELS[metric],
    currency: 'USD',
    available,
    actual: available ? round(actual) : null,
    target: target === null ? null : round(target),
    gap: target !== null && available ? round(Math.max(0, target - actual)) : null,
    attainment: target > 0 && available ? actual / target * 100 : null,
    weightedOpen: round(weighted),
    openFaceValue: round(candidates.reduce((s, d) => s + d.amount, 0)),
    uncoveredGap: booking && target !== null ? round(Math.max(0, target - actual - weighted)) : null,
    forecast: forecast === null ? null : round(forecast),
    method: booking ? 'weighted_pipeline' : 'trailing_30_days',
    remainingDays,
    baselineDays: 30,
    observedBaselineDays: lookback.filter(d => observations.has(d)).length,
    baselineTotal: round(baselineTotal),
    actualThrough: actualThrough < bounds.start ? null : actualThrough,
    status: now < bounds.start ? 'future' : now >= bounds.end ? 'ended' : 'in_progress',
    candidates,
    actualDeals: booking ? actualDeals.map(deal => ({
      ...deal,
      outcomeDate: wonDate(deal)
    })) : [],
    daily: booking ? [] : daily,
    missingClose,
    missingWonDate,
    overdueCount: overdue.length,
    warning: !booking && !completeBaseline && remainingDays > 0 ? 'A full 30 days of original source observations is required for the run-rate forecast. You can save an explicit leadership estimate instead.' : null,
    historyCaveat: 'Results are observed Atlas records and may be incomplete or revised by later imports. Dates use UTC calendar boundaries.'
  };
}
export function capturePlanningDeals(deals) {
  const original = new Map(deals.map(deal => [String(deal._id || deal.id), deal]));
  return captureDeals(deals).map(deal => {
    const value = original.get(deal.id)?.closedAt;
    return {
      ...deal,
      closedAt: value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null
    };
  });
}
export function evaluateSnapshot(snapshot, data, now = new Date()) {
  const plan = buildPlan(data, snapshot.period, snapshot.metric, null, now, true);
  const delta = plan.actual === null || plan.status !== 'ended' ? null : round(plan.actual - snapshot.forecast);
  const baseline = snapshot.evidence?.deals || [];
  const current = capturePlanningDeals(data.deals || []).filter(d => baseline.some(saved => saved.id === d.id));
  const changes = compareDeals(baseline, current);
  for (const deal of current) {
    const previous = baseline.find(saved => saved.id === deal.id);
    if ((previous?.closedAt ?? null) === deal.closedAt) continue;
    let change = changes.find(item => item.dealId === deal.id);
    if (!change) {
      change = {
        dealId: deal.id,
        name: deal.name,
        amount: deal.amount,
        kind: 'changed',
        fields: []
      };
      changes.push(change);
    }
    change.fields.push({
      field: 'closedAt',
      before: previous?.closedAt || null,
      after: deal.closedAt
    });
  }
  return {
    ...snapshot,
    currentActual: plan.actual,
    variance: delta,
    variancePct: delta === null || snapshot.forecast === 0 ? null : delta / Math.abs(snapshot.forecast) * 100,
    periodStatus: plan.status,
    periodLabel: plan.label,
    changes,
    direction: delta === null ? 'unavailable' : delta > 0 ? 'above' : delta < 0 ? 'below' : 'equal',
    dataWarning: plan.available ? plan.historyCaveat : 'No original observations are available for this revenue source.'
  };
}
// Display-only sample data. Same last-30-day revenue formula as Overview, with additional labeled sample history.
export function buildPlanningDemo(org, now = new Date(), buildDeals) {
  const metrics = [];
  for (let i = 729; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const index = ((29 - i) % 7 + 7) % 7;
    const revenue = 1200 + index * 180 + (i <= 29 ? i : i % 30) * 9;
    metrics.push({
      date: dayKey(d),
      revenue
    });
  }
  return {
    demo: true,
    deals: buildDeals(org, new Date(`${dayKey(now)}T00:00:00Z`)),
    metrics,
    revenueObservationDays: {
      sample_revenue: metrics.map(m => m.date)
    },
    integrations: [],
    warnings: []
  };
}

// Scenario history is returned only for the strict demo workspace; saved forecasts remain separate.
export function buildDemoForecastHistory(data, period, metric, now = new Date()) {
  if (!data.demo || !['bookings', 'sample_revenue'].includes(metric)) return [];
  const selected = periodBounds(period, now),
    step = selected.kind === 'quarter' ? 3 : 1;
  const periods = [period];
  for (let n = 1; n <= 2; n++) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - step * n, 1));
    periods.push(selected.kind === 'quarter' ? currentPeriods(date).quarter : currentPeriods(date).month);
  }
  return [...new Set(periods)].map((key, n) => {
    const bounds = periodBounds(key, now),
      ended = bounds.end <= now;
    // Historical booking cohorts are independent archived scenario records, not reused live deal IDs.
    const historicalDeals = ended && metric === 'bookings' ? [64000, 97000, 83000].map((amount, i) => ({
      _id: `demo-history-${key}-${i}`,
      name: ['Northstar Analytics Foundation', 'Elevate Reporting Program', 'Atlas Manufacturing Assessment'][i],
      accountName: ['Northstar Technology Group', 'Elevate Financial Partners', 'Atlas Manufacturing'][i],
      amount: amount + (n === 2 ? 12000 : 0),
      stage: 'Closed Won',
      probability: 1,
      source: 'demo',
      closedAt: new Date(bounds.start.getTime() + (i + 3) * DAY).toISOString(),
      closeDate: new Date(bounds.start.getTime() + (i + 3) * DAY).toISOString()
    })) : data.deals;
    const context = {
      ...data,
      deals: historicalDeals
    };
    const current = buildPlan(context, key, metric, null, now),
      asOf = new Date(Math.min(now.getTime() - DAY, bounds.start.getTime() + 2 * DAY));
    const baselineDeals = metric === 'bookings' ? historicalDeals.map(d => String(d.stage).toLowerCase() === 'closed won' && new Date(d.closedAt || d.closeDate) > asOf ? {
      ...d,
      stage: 'Proposal',
      probability: .7,
      closedAt: null
    } : d) : historicalDeals;
    const baseline = buildPlan({
      ...context,
      deals: baselineDeals
    }, key, metric, null, asOf, true);
    const forecast = ended ? round(current.actual * (n === 1 ? 1.12 : .94)) : baseline.forecast;
    const snapshot = {
      _id: `demo-forecast-${metric}-${key}`,
      isDemoRecord: true,
      workspaceMode: 'demo',
      period: key,
      metric,
      label: ended ? `${bounds.label} leadership forecast` : `${bounds.label} operating forecast`,
      asOf,
      forecast: forecast ?? 0,
      modelForecast: baseline.forecast,
      method: ended ? 'leadership_estimate' : current.method,
      actualAtSave: baseline.actual,
      targetAtSave: metric === 'bookings' ? selected.kind === 'quarter' ? 1500000 : 750000 : selected.kind === 'quarter' ? 225000 : 75000,
      rationale: ended ? 'Expected the planned customer launches to complete within the period. Review the outcome against the original commitment.' : 'Based on current won value and the recorded probabilities of opportunities due in the period.',
      evidence: {
        deals: capturePlanningDeals(baselineDeals),
        actualRows: baseline.daily.filter(d => d.observed),
        weightedOpen: baseline.weightedOpen,
        observedBaselineDays: baseline.observedBaselineDays,
        baselineDays: 30,
        start: bounds.start,
        end: bounds.end,
        source: metric
      }
    };
    return evaluateSnapshot(snapshot, context, now);
  });
}
