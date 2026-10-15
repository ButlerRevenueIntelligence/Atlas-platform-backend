import express from 'express';
import mongoose from 'mongoose';
import { requirePerm } from '../middleware/auth.js';
import LeadershipDecision from '../models/LeadershipDecision.js';
import AccountActionPlan from '../models/AccountActionPlan.js';
import RecoveryAction from '../models/RecoveryAction.js';
import Membership from '../models/Membership.js';
import User from '../models/User.js';
import { accountPlanContext } from '../services/accountPlanContext.js';
import { currentLeadershipData } from '../services/leadershipData.js';
import { validateDecision, assessments } from '../services/decisionOutcomes.js';
const router = express.Router();
const manage = req => ['owner', 'admin', 'manager'].includes(req.leadershipMember.role);
const wrap = fn => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({
      message: 'This account decision is already being tracked. Refresh the decision view.'
    });
    next(error);
  }
};
async function sourceDecision(req, res) {
  const {
    accountKey,
    entryId
  } = req.method === 'GET' ? req.query : req.body;
  if (typeof accountKey !== 'string' || accountKey.length > 500 || !mongoose.isValidObjectId(entryId)) {
    res.status(400).json({
      message: 'Choose an existing account decision'
    });
    return null;
  }
  const ctx = await accountPlanContext(req.orgId),
    key = ctx.catalog.resolve(accountKey);
  if (!key) {
    res.status(404).json({
      message: 'Account not found in this workspace'
    });
    return null;
  }
  const plan = await AccountActionPlan.findOne({
    orgId: req.orgId,
    accountKey: key
  }).lean();
  const entry = plan?.history?.find(h => String(h._id) === entryId && h.kind === 'decision');
  if (!entry) {
    res.status(404).json({
      message: 'Account decision is no longer in the working history'
    });
    return null;
  }
  const account = ctx.catalog.accounts.find(a => a.key === key);
  return {
    entry,
    key,
    deals: ctx.deals.filter(d => account.dealIds.includes(d.id))
  };
}
// Parent leadership router supplies authentication, CORE, command_center.view and active membership gates.
router.get('/source', requirePerm('clients.view'), wrap(async (req, res) => {
  const source = await sourceDecision(req, res);
  if (!source) return;
  res.json({
    ok: true,
    text: source.entry.text,
    decidedAt: source.entry.at,
    accountKey: source.key,
    entryId: String(source.entry._id),
    deals: source.deals
  });
}));
router.post('/', wrap(async (req, res) => {
  if (!manage(req)) return res.status(403).json({
    message: 'A workspace manager must start decision tracking'
  });
  const {
    ownerId,
    dealId,
    accountKey,
    entryId
  } = req.body;
  if (!mongoose.isValidObjectId(ownerId) || typeof dealId !== 'string' || dealId.length > 100) return res.status(400).json({
    message: 'Choose an opportunity and active decision owner'
  });
  let source = null;
  if (accountKey || entryId) {
    if (!(req.user.permissions || []).some(p => p === '*' || p === 'clients.view')) return res.status(403).json({
      message: 'Account permission is required to link an account decision'
    });
    source = await sourceDecision(req, res);
    if (!source) return;
    if (!source.deals.some(d => d.id === dealId)) return res.status(400).json({
      message: 'Choose an opportunity explicitly linked to this account'
    });
  }
  let value;
  try {
    value = validateDecision({
      ...req.body,
      text: source ? source.entry.text : req.body.text
    });
  } catch (error) {
    return res.status(400).json({
      message: error.message
    });
  }
  const {
      deals,
      now,
      demo
    } = await currentLeadershipData(req.orgId),
    deal = deals.find(d => d.id === dealId);
  if (!deal) return res.status(404).json({
    message: 'Opportunity not found in this workspace'
  });
  const member = await Membership.findOne({
    orgId: req.orgId,
    userId: ownerId,
    status: 'active'
  }).lean();
  const user = member && member.role !== 'viewer' ? await User.findById(ownerId).select('name email status').lean() : null;
  if (!user || ['disabled', 'suspended'].includes(user.status)) return res.status(400).json({
    message: 'Choose an active non-viewer workspace member'
  });
  const actions = value.actionIds.length ? await RecoveryAction.find({
    orgId: req.orgId,
    _id: {
      $in: value.actionIds
    },
    dealId
  }).lean() : [];
  if (actions.length !== value.actionIds.length) return res.status(400).json({
    message: 'Linked actions must belong to this workspace and opportunity'
  });
  const decision = await LeadershipDecision.create({
    orgId: req.orgId,
    ...value,
    dealId,
    dealName: deal.name,
    ownerId,
    ownerName: user.name || user.email,
    createdBy: req.user.userId,
    authorName: req.user.name || 'Workspace member',
    sourceMode: demo ? 'demo' : 'live',
    evidence: {
      ...deal,
      capturedAt: now
    },
    ...(source ? {
      sourceAccountKey: source.key,
      sourceEntryId: String(source.entry._id),
      sourceDecidedAt: source.entry.at,
      sourceAuthorId: source.entry.authorId,
      sourceAuthorName: source.entry.authorName
    } : {})
  });
  res.status(201).json({
    ok: true,
    decision
  });
}));
router.get('/:id/reviews', wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({
    message: 'Invalid decision'
  });
  const decision = await LeadershipDecision.findOne({
    _id: req.params.id,
    orgId: req.orgId
  }).select('reviews reviewCount __v').lean();
  if (!decision) return res.status(404).json({
    message: 'Decision not found'
  });
  res.json({
    ok: true,
    reviews: decision.reviews || [],
    reviewCount: decision.reviewCount || 0,
    version: decision.__v
  });
}));
router.patch('/:id', wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({
    message: 'Invalid decision'
  });
  const {
    version,
    actionIds,
    assessment,
    note
  } = req.body;
  if (!Number.isInteger(version) || version < 0) return res.status(400).json({
    message: 'Include the current decision version'
  });
  const decision = await LeadershipDecision.findOne({
    _id: req.params.id,
    orgId: req.orgId
  }).lean();
  if (!decision) return res.status(404).json({
    message: 'Decision not found'
  });
  if (req.leadershipMember.role === 'viewer' || !manage(req) && String(decision.ownerId) !== String(req.user.userId)) return res.status(403).json({
    message: 'Only the decision owner or a manager may update tracking'
  });
  let update;
  if (actionIds !== undefined) {
    if (assessment !== undefined || note !== undefined) return res.status(400).json({
      message: 'Save action links separately from outcome reviews'
    });
    if (!Array.isArray(actionIds) || actionIds.length > 20 || new Set(actionIds).size !== actionIds.length || actionIds.some(v => typeof v !== 'string' || !mongoose.isValidObjectId(v))) return res.status(400).json({
      message: 'Choose up to 20 distinct existing actions'
    });
    const actions = actionIds.length ? await RecoveryAction.find({
      orgId: req.orgId,
      dealId: decision.dealId,
      _id: {
        $in: actionIds
      }
    }).lean() : [];
    if (actions.length !== actionIds.length) return res.status(400).json({
      message: 'Linked actions must belong to this workspace and opportunity'
    });
    update = {
      $set: {
        actionIds
      },
      $inc: {
        __v: 1
      }
    };
  } else {
    if (!assessments.includes(assessment) || typeof note !== 'string' || !note.trim() || note.length > 2000) return res.status(400).json({
      message: 'Choose an assessment and record supporting observations (1–2000 characters)'
    });
    const {
      deals,
      now,
      demo
    } = await currentLeadershipData(req.orgId);
    if (decision.sourceMode !== (demo ? 'demo' : 'live')) return res.status(409).json({
      message: 'This decision belongs to a different workspace data mode'
    });
    const deal = deals.find(d => d.id === decision.dealId);
    if (!deal && assessment !== 'insufficient_evidence') return res.status(400).json({
      message: 'The opportunity is no longer visible. Use insufficient evidence until the source can be verified.'
    });
    const review = {
      assessment,
      note: note.trim(),
      authorId: req.user.userId,
      authorName: req.user.name || 'Workspace member',
      at: now,
      evidence: deal ? {
        ...deal,
        capturedAt: now
      } : {
        id: decision.dealId,
        unavailable: true,
        capturedAt: now
      }
    };
    update = {
      $set: {
        latestReviewAt: now
      },
      $inc: {
        __v: 1,
        reviewCount: 1
      },
      $push: {
        reviews: {
          $each: [review],
          $slice: -100
        }
      }
    };
  }
  const saved = await LeadershipDecision.findOneAndUpdate({
    _id: decision._id,
    orgId: req.orgId,
    __v: version
  }, update, {
    new: true,
    runValidators: true
  }).lean();
  if (!saved) return res.status(409).json({
    message: 'This decision changed. Refresh before saving again.'
  });
  res.json({
    ok: true,
    decision: saved
  });
}));
export default router;
