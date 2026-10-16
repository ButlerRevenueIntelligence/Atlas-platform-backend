import { buildDemoForecastHistory } from '../services/revenuePlanning.js';
import express from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { requirePlan } from '../middleware/requirePlan.js';
import Membership from '../models/Membership.js';
import Organization from '../models/Organization.js';
import RevenueTarget from '../models/RevenueTarget.js';
import ForecastSnapshot from '../models/ForecastSnapshot.js';
import { getUnifiedWorkspaceData } from '../services/workspaceData.js';
import { isDemoWorkspace, buildDemoWorkspaceDeals } from '../services/demoWorkspace.js';
import { buildPlan, currentPeriods, periodBounds, validateMetric, METRIC_LABELS, evaluateSnapshot, buildPlanningDemo, capturePlanningDeals } from '../services/revenuePlanning.js';
const router = express.Router();
router.use(requireAuth, requirePlan('CORE'), requirePerm('dashboard.view'));
router.use(async (req, res, next) => {
  try {
    const member = await Membership.findOne({
      orgId: req.orgId,
      userId: req.user.userId,
      status: 'active'
    }).lean();
    if (!member) return res.status(403).json({
      message: 'An active workspace membership is required'
    });
    req.planningMember = member;
    next();
  } catch (error) {
    next(error);
  }
});
const manager = req => ['owner', 'admin', 'manager'].includes(req.planningMember.role);
const wrap = fn => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({
      message: 'This target was saved by someone else. Refresh before editing.'
    });
    next(error);
  }
};
async function loadData(orgId, now) {
  const org = await Organization.findById(orgId).select('_id name slug').lean();
  if (!org) throw new Error('Workspace not found');
  return isDemoWorkspace(org) ? buildPlanningDemo(org, now, buildDemoWorkspaceDeals) : {
    ...(await getUnifiedWorkspaceData(orgId, {
      days: 730
    })),
    demo: false
  };
}
function selection(req, data, now) {
  const period = String(req.query?.period || req.body?.period || currentPeriods(now).month),
    metric = String(req.query?.metric || req.body?.metric || 'bookings');
  periodBounds(period, now);
  validateMetric(metric, data.demo);
  return {
    period,
    metric
  };
}
const sampleTarget = (data, period, metric) => data.demo ? metric === 'bookings' ? period.includes('Q') ? 1500000 : 750000 : period.includes('Q') ? 225000 : 75000 : null;
const keys = (req, period, metric) => ({
  orgId: req.orgId,
  period,
  metric
});
router.get('/plan', wrap(async (req, res) => {
  const now = new Date(),
    data = await loadData(req.orgId, now);
  let selected;
  try {
    selected = selection(req, data, now);
  } catch (error) {
    return res.status(400).json({
      message: error.message
    });
  }
  const {
    period,
    metric
  } = selected;
  const [target, snapshots] = await Promise.all([RevenueTarget.findOne(keys(req, period, metric)).lean(), ForecastSnapshot.find({
    orgId: req.orgId,
    metric
  }).sort({
    asOf: -1
  }).limit(50).lean()]);
  const amount = target?.amount ?? sampleTarget(data, period, metric);
  const plan = buildPlan(data, period, metric, amount, now);
  res.json({
    ok: true,
    asOf: now,
    workspaceMode: data.demo ? 'demo' : 'live',
    canManage: manager(req),
    target,
    targetIsSample: !target && amount !== null,
    plan,
    availableMetrics: Object.entries(METRIC_LABELS).filter(([key]) => key === 'bookings' || data.revenueObservationDays?.[key]?.length > 0).map(([key, label]) => ({
      key,
      label
    })),
    snapshots: [...snapshots.map(s => evaluateSnapshot(s, data, now)), ...buildDemoForecastHistory(data, period, metric, now).filter(example => !snapshots.some(saved => saved.period === example.period))],
    integrations: (data.integrations || []).map(i => ({
      provider: i.provider,
      status: i.status,
      lastSyncAt: i.lastSyncAt
    })),
    warnings: data.warnings || []
  });
}));
router.get('/summary', wrap(async (req, res) => {
  const now = new Date(),
    data = await loadData(req.orgId, now),
    periods = currentPeriods(now);
  const targets = await RevenueTarget.find({
    orgId: req.orgId,
    period: {
      $in: Object.values(periods)
    }
  }).sort({
    updatedAt: -1
  }).lean();
  const summaries = Object.values(periods).map(period => {
    const target = targets.find(t => t.period === period),
      metric = target?.metric || 'bookings',
      amount = target?.amount ?? sampleTarget(data, period, metric);
    return {
      ...buildPlan(data, period, metric, amount, now),
      targetIsSample: !target && amount !== null
    };
  });
  res.json({
    ok: true,
    summaries,
    workspaceMode: data.demo ? 'demo' : 'live'
  });
}));
router.put('/target', wrap(async (req, res) => {
  if (req.body.currency && req.body.currency !== 'USD') return res.status(400).json({
    message: 'Only USD targets are supported'
  });
  if (!manager(req)) return res.status(403).json({
    message: 'A workspace manager must set revenue targets'
  });
  const {
    amount,
    version
  } = req.body;
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e12 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.001 || !(version === null || Number.isInteger(version) && version >= 0)) return res.status(400).json({
    message: 'Enter a USD target with at most two decimals and the current version'
  });
  const now = new Date(),
    data = await loadData(req.orgId, now);
  let selected;
  try {
    selected = selection(req, data, now);
  } catch (error) {
    return res.status(400).json({
      message: error.message
    });
  }
  const {
    period,
    metric
  } = selected;
  if (periodBounds(period, now).end <= now) return res.status(400).json({
    message: 'Targets for completed periods cannot be changed'
  });
  const changes = {
    amount,
    currency: 'USD',
    updatedBy: req.user.userId
  };
  const history = {
    amount,
    at: now,
    userId: req.user.userId
  };
  let target;
  if (version === null) target = await RevenueTarget.create({
    ...keys(req, period, metric),
    ...changes,
    history: [history]
  });else target = await RevenueTarget.findOneAndUpdate({
    ...keys(req, period, metric),
    __v: version
  }, {
    $set: changes,
    $inc: {
      __v: 1
    },
    $push: {
      history: {
        $each: [history],
        $slice: -50
      }
    }
  }, {
    new: true,
    runValidators: true
  }).lean();
  if (!target) return res.status(409).json({
    message: 'This target changed. Refresh before editing again.'
  });
  res.json({
    ok: true,
    target
  });
}));
router.post('/snapshots', wrap(async (req, res) => {
  if (req.body.currency && req.body.currency !== 'USD') return res.status(400).json({
    message: 'Only USD forecasts are supported'
  });
  if (!manager(req)) return res.status(403).json({
    message: 'A workspace manager must save forecasts'
  });
  const label = typeof req.body.label === 'string' ? req.body.label.trim() : '';
  const rationale = typeof req.body.rationale === 'string' ? req.body.rationale.trim() : '';
  const override = req.body.forecastOverride;
  if (!label || label.length > 120 || rationale.length > 2000 || override !== undefined && (!Number.isFinite(override) || override < 0 || override > 1e12 || !rationale)) return res.status(400).json({
    message: 'Provide a forecast name and a rationale for any leadership estimate'
  });
  const now = new Date(),
    data = await loadData(req.orgId, now);
  let selected;
  try {
    selected = selection(req, data, now);
  } catch (error) {
    return res.status(400).json({
      message: error.message
    });
  }
  const {
    period,
    metric
  } = selected;
  if (periodBounds(period, now).end <= now) return res.status(400).json({
    message: 'Forecasts cannot be backdated into completed periods'
  });
  const target = await RevenueTarget.findOne(keys(req, period, metric)).lean();
  const plan = buildPlan(data, period, metric, target?.amount ?? sampleTarget(data, period, metric), now);
  if (plan.forecast === null && override === undefined) return res.status(400).json({
    message: 'Insufficient source history for a model forecast. Enter a clearly labeled leadership estimate or connect more data.'
  });
  const snapshot = await ForecastSnapshot.create({
    ...keys(req, period, metric),
    label,
    rationale,
    asOf: now,
    createdBy: req.user.userId,
    workspaceMode: data.demo ? 'demo' : 'live',
    forecast: override === undefined ? plan.forecast : Math.round(override * 100) / 100,
    modelForecast: plan.forecast,
    method: override === undefined ? plan.method : 'leadership_estimate',
    actualAtSave: plan.actual,
    targetAtSave: plan.target,
    evidence: {
      deals: capturePlanningDeals(data.deals || []).filter(d => [...plan.candidates, ...plan.actualDeals].some(c => c.id === d.id)),
      calculationVersion: "calendar-usd-v1",
      actualAvailable: plan.available,
      actualThrough: plan.actualThrough,
      actualRows: plan.daily.filter(row => row.observed),
      wonOutcomes: plan.actualDeals.map(deal => ({
        id: deal.id,
        amount: deal.amount,
        outcomeDate: deal.outcomeDate
      })),
      weightedOpen: plan.weightedOpen,
      baselineTotal: plan.baselineTotal,
      observedBaselineDays: plan.observedBaselineDays,
      baselineDays: 30,
      start: plan.start,
      end: plan.end,
      source: metric,
      warnings: data.warnings || []
    }
  });
  res.status(201).json({
    ok: true,
    snapshot
  });
}));
export default router;
