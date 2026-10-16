import { buildDemoExecution, withDemoRecords } from '../services/demoLeadership.js';
import decisionRoutes from './leadershipDecisions.js';
import LeadershipDecision from '../models/LeadershipDecision.js';
import AccountActionPlan from '../models/AccountActionPlan.js';
import { currentLeadershipData as currentData } from '../services/leadershipData.js';
import { captureExecution, meetingChanges, decisionView, canReadAccountPlans } from '../services/decisionOutcomes.js';
import express from 'express';
import mongoose from 'mongoose';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { requirePlan } from '../middleware/requirePlan.js';
import Membership from '../models/Membership.js';
import User from '../models/User.js';
import LeadershipCheckpoint from '../models/LeadershipCheckpoint.js';
import RecoveryAction from '../models/RecoveryAction.js';
import CompanyIntelligence from '../models/CompanyIntelligence.js';
import { compareDeals, summarize, priorities, simulateSlip, matchExternalContext, demoComparison } from '../services/leadershipBriefing.js';
const router = express.Router();
router.use(requireAuth, requirePlan('CORE'), requirePerm('command_center.view'));
router.use(async (req, res, next) => {
  // An explicitly active membership is required, including for globally privileged accounts.
  try {
    const membership = await Membership.findOne({
      orgId: req.orgId,
      userId: req.user.userId,
      status: 'active'
    }).lean();
    if (!membership) return res.status(403).json({
      message: 'An active workspace membership is required'
    });
    req.leadershipMember = membership;
    next();
  } catch (error) {
    next(error);
  }
});
const canManage = req => ['owner', 'admin', 'manager'].includes(req.leadershipMember.role);
const wrap = fn => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};
router.use('/decisions', decisionRoutes);
router.get('/briefing', wrap(async (req, res) => {
  const {
    now,
    demo,
    deals,
    integrations
  } = await currentData(req.orgId);
  const [checkpoints, rawActions, members, snapshots, rawDecisions, rawPlans] = await Promise.all([LeadershipCheckpoint.find({
    orgId: req.orgId
  }).sort({
    createdAt: -1
  }).limit(12).select('-deals -execution').lean(), RecoveryAction.find({
    orgId: req.orgId
  }).sort({
    createdAt: -1
  }).limit(101).lean(), Membership.find({
    orgId: req.orgId,
    status: 'active'
  }).select('userId role').lean(), demo ? [] : CompanyIntelligence.find({
    orgId: req.orgId,
    expiresAt: {
      $gt: now
    }
  }).sort({
    createdAt: -1
  }).limit(20).lean(), LeadershipDecision.find({
    orgId: req.orgId,
    sourceMode: demo ? 'demo' : 'live'
  }).sort({
    createdAt: -1
  }).limit(101).select({
    reviews: {
      $slice: -5
    }
  }).lean(), canReadAccountPlans(req) ? AccountActionPlan.find({
    orgId: req.orgId
  }).sort({
    updatedAt: -1
  }).limit(101).select('accountKey objective ownerId ownerName reviewAt blockers createdAt').lean() : []]);
  const scenario = demo ? buildDemoExecution(deals, now) : null;
  const allActions = scenario ? withDemoRecords(rawActions, scenario.actions, '_id') : rawActions;
  const allDecisions = scenario ? withDemoRecords(rawDecisions, scenario.decisions, '_id') : rawDecisions;
  const allPlans = scenario && canReadAccountPlans(req) ? withDemoRecords(rawPlans, scenario.plans, 'accountKey') : rawPlans;
  const actions = allActions.slice(0, 100),
    decisions = allDecisions.slice(0, 100);
  const execution = captureExecution(allActions, allDecisions, allPlans, canReadAccountPlans(req));
  const requested = req.query.checkpointId;
  if (requested && !mongoose.isValidObjectId(requested)) return res.status(400).json({
    message: 'Invalid checkpoint'
  });
  let checkpoint = requested ? await LeadershipCheckpoint.findOne({
    _id: requested,
    orgId: req.orgId
  }).lean() : checkpoints[0] ? await LeadershipCheckpoint.findOne({
    _id: checkpoints[0]._id,
    orgId: req.orgId
  }).lean() : null;
  if (requested && !checkpoint) return res.status(404).json({
    message: 'Checkpoint not found'
  });
  if (!checkpoint && demo) {
    checkpoint = demoComparison(deals, now);
    checkpoint.sourceMode = 'demo';
    checkpoint.execution = captureExecution(scenario.actions.map(a => ({
      ...a,
      status: 'open',
      outcome: '',
      completedAt: null
    })), scenario.decisions.map(d => ({
      ...d,
      reviews: [],
      reviewCount: 0,
      latestReviewAt: null
    })), canReadAccountPlans(req) ? scenario.plans.map(p => ({
      ...p,
      blockers: p.blockers.map(b => ({
        ...b,
        status: 'open'
      }))
    })) : [], canReadAccountPlans(req));
  }
  const pipelineComparable = Boolean(checkpoint && (!checkpoint.sourceMode || checkpoint.sourceMode === (demo ? 'demo' : 'live')));
  const users = await User.find({
    _id: {
      $in: members.map(m => m.userId)
    },
    status: {
      $nin: ['disabled', 'suspended']
    }
  }).select('_id name email').lean();
  res.json({
    ok: true,
    asOf: now,
    workspaceMode: demo ? 'demo' : 'live',
    canManage: canManage(req),
    userId: req.user.userId,
    deals,
    summary: summarize(deals, now),
    priorities: priorities(deals, now),
    checkpoint: checkpoint ? {
      _id: checkpoint._id,
      label: checkpoint.label,
      createdAt: checkpoint.createdAt,
      isIllustrative: checkpoint.isIllustrative
    } : null,
    checkpoints,
    meetingChanges: meetingChanges(checkpoint, {
      ...execution,
      deals
    }, now, demo ? 'demo' : 'live'),
    decisions: decisions.map(d => decisionView(d, deals, actions, demo ? 'demo' : 'live')),
    decisionsLimited: rawDecisions.length > 100,
    canReadAccountPlans: canReadAccountPlans(req),
    pipelineComparisonAvailable: pipelineComparable,
    changes: pipelineComparable ? compareDeals(checkpoint.deals, deals) : [],
    previousSummary: pipelineComparable ? summarize(checkpoint.deals, now) : null,
    actions: actions.map(action => ({
      ...action,
      currentDeal: deals.find(d => d.id === action.dealId) || null,
      dealChanges: compareDeals([action.evidence], deals.filter(d => d.id === action.dealId))
    })),
    members: users.map(u => ({
      id: String(u._id),
      name: u.name || u.email,
      role: members.find(m => String(m.userId) === String(u._id))?.role
    })),
    integrations: integrations.map(i => ({
      provider: i.provider,
      status: i.status,
      lastSyncAt: i.lastSyncAt,
      lastSyncStatus: i.lastSyncStatus
    })),
    externalContext: scenario ? scenario.externalContext : matchExternalContext(snapshots, deals, now),
    externalEventsAvailable: false
  });
}));
router.post('/checkpoints', wrap(async (req, res) => {
  if (!canManage(req)) return res.status(403).json({
    message: 'A workspace manager must save meeting checkpoints'
  });
  const label = String(req.body.label || '').trim();
  if (!label || label.length > 120) return res.status(400).json({
    message: 'Provide a meeting name of 1–120 characters'
  });
  const {
    deals,
    demo
  } = await currentData(req.orgId);
  const [actions, decisions, plans] = await Promise.all([RecoveryAction.find({
    orgId: req.orgId
  }).sort({
    createdAt: -1
  }).limit(101).lean(), LeadershipDecision.find({
    orgId: req.orgId,
    sourceMode: demo ? 'demo' : 'live'
  }).sort({
    createdAt: -1
  }).limit(101).lean(), canReadAccountPlans(req) ? AccountActionPlan.find({
    orgId: req.orgId
  }).sort({
    updatedAt: -1
  }).limit(101).select('accountKey objective ownerId ownerName reviewAt blockers createdAt').lean() : []]);
  const checkpoint = await LeadershipCheckpoint.create({
    orgId: req.orgId,
    createdBy: req.user.userId,
    label,
    deals,
    sourceMode: demo ? 'demo' : 'live',
    execution: captureExecution(demo ? withDemoRecords(actions, buildDemoExecution(deals).actions, '_id') : actions, demo ? withDemoRecords(decisions, buildDemoExecution(deals).decisions, '_id') : decisions, demo && canReadAccountPlans(req) ? withDemoRecords(plans, buildDemoExecution(deals).plans, 'accountKey') : plans, canReadAccountPlans(req))
  });
  res.status(201).json({
    ok: true,
    checkpoint: {
      _id: checkpoint._id,
      label: checkpoint.label,
      createdAt: checkpoint.createdAt
    }
  });
}));
router.post('/scenario', wrap(async (req, res) => {
  const {
    deals,
    now
  } = await currentData(req.orgId);
  try {
    res.json({
      ok: true,
      asOf: now,
      ...simulateSlip(deals, req.body, now)
    });
  } catch (error) {
    res.status(400).json({
      message: error.message
    });
  }
}));
router.post('/actions', wrap(async (req, res) => {
  if (!canManage(req)) return res.status(403).json({
    message: 'A workspace manager must assign recovery actions'
  });
  const {
    dealId,
    title,
    assigneeId,
    dueAt
  } = req.body;
  const due = new Date(dueAt);
  if (typeof title !== 'string' || !title.trim() || title.length > 500 || !mongoose.isValidObjectId(assigneeId) || !dueAt || !Number.isFinite(due.getTime())) return res.status(400).json({
    message: 'Provide an action, active member, and valid deadline'
  });
  const member = await Membership.findOne({
    orgId: req.orgId,
    userId: assigneeId,
    status: 'active'
  }).lean();
  if (!member || member.role === 'viewer') return res.status(400).json({
    message: 'Choose an active member who can update actions'
  });
  const {
    deals,
    now
  } = await currentData(req.orgId);
  const deal = deals.find(d => d.id === dealId);
  if (!deal) return res.status(404).json({
    message: 'Opportunity not found in this workspace'
  });
  const owner = await User.findById(assigneeId).select('name email status').lean();
  if (!owner || ['disabled', 'suspended'].includes(owner.status)) return res.status(400).json({
    message: 'Member no longer available'
  });
  const action = await RecoveryAction.create({
    orgId: req.orgId,
    dealId,
    dealName: deal.name,
    title: title.trim(),
    assigneeId,
    ownerName: owner.name || owner.email,
    dueAt: due,
    createdBy: req.user.userId,
    evidence: {
      ...deal,
      capturedAt: now
    },
    history: [{
      status: 'open',
      userId: req.user.userId,
      at: now
    }]
  });
  res.status(201).json({
    ok: true,
    action
  });
}));
router.patch('/actions/:id', wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({
    message: 'Invalid action'
  });
  const {
    status,
    outcome,
    version
  } = req.body;
  if (!['open', 'in_progress', 'blocked', 'completed'].includes(status) || typeof outcome !== 'string' || outcome.length > 2000 || !Number.isInteger(version)) return res.status(400).json({
    message: 'Invalid action update'
  });
  const action = await RecoveryAction.findOne({
    _id: req.params.id,
    orgId: req.orgId
  }).lean();
  if (!action) return res.status(404).json({
    message: 'Action not found'
  });
  if (req.leadershipMember.role === 'viewer' || !canManage(req) && String(action.assigneeId) !== req.user.userId) return res.status(403).json({
    message: 'Only the assignee or a workspace manager may update this action'
  });
  if (status === 'completed' && !outcome.trim()) return res.status(400).json({
    message: 'Record the outcome before completing an action'
  });
  const at = new Date();
  const updated = await RecoveryAction.findOneAndUpdate({
    _id: action._id,
    orgId: req.orgId,
    __v: version
  }, {
    $set: {
      status,
      outcome: outcome.trim(),
      completedAt: status === 'completed' ? at : null
    },
    $inc: {
      __v: 1
    },
    $push: {
      history: {
        $each: [{
          status,
          outcome: outcome.trim(),
          userId: req.user.userId,
          at
        }],
        $slice: -100
      }
    }
  }, {
    new: true,
    runValidators: true
  }).lean();
  if (!updated) return res.status(409).json({
    message: 'This action changed. Refresh before updating it again.'
  });
  res.json({
    ok: true,
    action: updated
  });
}));
export default router;
