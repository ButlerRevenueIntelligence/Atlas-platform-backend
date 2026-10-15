import { accountPlanContext as context } from '../services/accountPlanContext.js';
import express from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { requirePlan } from '../middleware/requirePlan.js';
import Membership from '../models/Membership.js';
import User from '../models/User.js';
import AccountActionPlan from '../models/AccountActionPlan.js';
import RecoveryAction from '../models/RecoveryAction.js';
import { compareDeals } from '../services/leadershipBriefing.js';
import { canManagePlan, validatePlanInput } from '../services/accountActionPlans.js';
const router = express.Router();
router.use(requireAuth, requirePlan('CORE'), requirePerm('clients.view'));
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
    req.accountPlanMember = member;
    next();
  } catch (error) {
    next(error);
  }
});
const wrap = fn => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({
      message: 'Another teammate created this plan. Refresh before editing.'
    });
    next(error);
  }
};
async function roster(orgId) {
  const memberships = await Membership.find({
    orgId,
    status: 'active'
  }).select('userId role').lean();
  const users = await User.find({
    _id: {
      $in: memberships.map(m => m.userId)
    },
    status: {
      $nin: ['disabled', 'suspended']
    }
  }).select('_id name email').lean();
  return users.map(u => ({
    id: String(u._id),
    name: u.name || u.email,
    role: memberships.find(m => String(m.userId) === String(u._id))?.role
  }));
}
const keyFor = (ctx, ref) => typeof ref === 'string' && ref.length <= 500 ? ctx.catalog.resolve(ref) : null;
router.get('/', wrap(async (req, res) => {
  const ctx = await context(req.orgId);
  const plans = await AccountActionPlan.find({
    orgId: req.orgId
  }).select('accountKey ownerId ownerName reviewAt objective blockers updatedAt').lean();
  let resolvedKey = null;
  if (req.query.dealId) {
    resolvedKey = ctx.catalog.dealKeys.get(String(req.query.dealId));
    if (!resolvedKey) return res.status(404).json({
      message: 'This opportunity has no unambiguous account link. Link it to an account before creating a plan.'
    });
  }
  if (req.query.accountRef) {
    resolvedKey = keyFor(ctx, req.query.accountRef);
    if (!resolvedKey) return res.status(404).json({
      message: 'Account not found in this workspace'
    });
  }
  const plansByKey = new Map(plans.map(plan => [plan.accountKey, plan]));
  res.json({
    ok: true,
    workspaceMode: ctx.demo ? 'demo' : 'live',
    asOf: ctx.now,
    resolvedKey,
    unlinkedDealCount: ctx.catalog.unlinkedDealCount,
    accounts: ctx.catalog.accounts.map(a => ({
      ...a,
      plan: plansByKey.get(a.key) || null
    }))
  });
}));
router.get('/:accountKey', wrap(async (req, res) => {
  const ctx = await context(req.orgId),
    key = keyFor(ctx, req.params.accountKey);
  if (!key) return res.status(404).json({
    message: 'Account not found in this workspace'
  });
  const account = ctx.catalog.accounts.find(a => a.key === key);
  const dealIds = new Set(account.dealIds);
  const deals = ctx.deals.filter(d => dealIds.has(d.id));
  const [plan, members, actions] = await Promise.all([AccountActionPlan.findOne({
    orgId: req.orgId,
    accountKey: key
  }).lean(), roster(req.orgId), RecoveryAction.find({
    orgId: req.orgId,
    dealId: {
      $in: account.dealIds
    }
  }).sort({
    createdAt: -1
  }).limit(100).lean()]);
  res.json({
    ok: true,
    workspaceMode: ctx.demo ? 'demo' : 'live',
    asOf: ctx.now,
    userId: req.user.userId,
    role: req.accountPlanMember.role,
    account,
    plan,
    members,
    deals,
    warnings: ctx.warnings,
    canEdit: canManagePlan(req.accountPlanMember.role, req.user.userId, plan),
    canReassign: ['owner', 'admin', 'manager'].includes(req.accountPlanMember.role),
    canComment: req.accountPlanMember.role !== 'viewer',
    canAssignActions: ['owner', 'admin', 'manager'].includes(req.accountPlanMember.role),
    actions: actions.map(a => ({
      ...a,
      currentDeal: deals.find(d => d.id === a.dealId) || null,
      dealChanges: compareDeals([a.evidence], deals.filter(d => d.id === a.dealId))
    }))
  });
}));
router.put('/:accountKey', wrap(async (req, res) => {
  const ctx = await context(req.orgId),
    key = keyFor(ctx, req.params.accountKey);
  if (!key) return res.status(404).json({
    message: 'Account not found in this workspace'
  });
  const plan = await AccountActionPlan.findOne({
    orgId: req.orgId,
    accountKey: key
  }).lean();
  if (!canManagePlan(req.accountPlanMember.role, req.user.userId, plan)) return res.status(403).json({
    message: 'Only the plan owner or a workspace manager may edit this plan'
  });
  const {
    version
  } = req.body;
  if (!(version === null || Number.isInteger(version) && version >= 0)) return res.status(400).json({
    message: 'Include the current plan version'
  });
  if (plan && String(req.body.ownerId) !== String(plan.ownerId) && !['owner', 'admin', 'manager'].includes(req.accountPlanMember.role)) return res.status(403).json({
    message: 'A workspace manager must reassign the plan owner'
  });
  let value;
  try {
    value = validatePlanInput(req.body, await roster(req.orgId));
  } catch (error) {
    return res.status(400).json({
      message: error.message
    });
  }
  const entry = {
    kind: 'plan_updated',
    text: plan ? 'Account action plan saved.' : 'Account action plan created.',
    authorId: req.user.userId,
    authorName: req.user.name || 'Workspace member',
    at: ctx.now
  };
  let updated;
  if (version === null) {
    if (plan) return res.status(409).json({
      message: 'This plan already exists. Refresh before editing.'
    });
    updated = await AccountActionPlan.create({
      orgId: req.orgId,
      accountKey: key,
      ...value,
      updatedBy: req.user.userId,
      history: [entry]
    });
  } else updated = await AccountActionPlan.findOneAndUpdate({
    orgId: req.orgId,
    accountKey: key,
    __v: version
  }, {
    $set: {
      ...value,
      updatedBy: req.user.userId
    },
    $inc: {
      __v: 1
    },
    $push: {
      history: {
        $each: [entry],
        $slice: -100
      }
    }
  }, {
    new: true,
    runValidators: true
  }).lean();
  if (!updated) return res.status(409).json({
    message: 'A teammate changed this plan. Refresh before saving your edits again.'
  });
  res.json({
    ok: true,
    plan: updated
  });
}));
router.post('/:accountKey/updates', wrap(async (req, res) => {
  if (req.accountPlanMember.role === 'viewer') return res.status(403).json({
    message: 'Viewers cannot add account updates'
  });
  const {
    kind,
    text
  } = req.body;
  if (!['note', 'decision'].includes(kind) || typeof text !== 'string' || !text.trim() || text.length > 4000) return res.status(400).json({
    message: 'Provide a note or decision of 1–4000 characters'
  });
  const ctx = await context(req.orgId),
    key = keyFor(ctx, req.params.accountKey);
  if (!key) return res.status(404).json({
    message: 'Account not found in this workspace'
  });
  const plan = await AccountActionPlan.findOne({
    orgId: req.orgId,
    accountKey: key
  }).lean();
  if (!plan) return res.status(404).json({
    message: 'Save the account plan before adding updates'
  });
  if (kind === 'decision' && !canManagePlan(req.accountPlanMember.role, req.user.userId, plan)) return res.status(403).json({
    message: 'The plan owner or a workspace manager must record decisions'
  });
  const entry = {
    kind,
    text: text.trim(),
    authorId: req.user.userId,
    authorName: req.user.name || 'Workspace member',
    at: ctx.now
  };
  const filter = {
    orgId: req.orgId,
    accountKey: key,
    ...(kind === 'decision' && !['owner', 'admin', 'manager'].includes(req.accountPlanMember.role) ? {
      ownerId: req.user.userId
    } : {})
  };
  const updated = await AccountActionPlan.findOneAndUpdate(filter, {
    $push: {
      history: {
        $each: [entry],
        $slice: -100
      }
    }
  }, {
    new: true,
    runValidators: true
  }).lean();
  if (!updated) return res.status(409).json({
    message: 'This account plan or its ownership changed. Refresh before posting again.'
  });
  res.status(201).json({
    ok: true,
    plan: updated
  });
}));
export default router;
