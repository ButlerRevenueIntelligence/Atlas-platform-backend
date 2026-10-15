import express from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { requirePlan } from '../middleware/requirePlan.js';
import WorkspaceSetup from '../models/WorkspaceSetup.js';
import Membership from '../models/Membership.js';
import IntegrationConnection from '../models/IntegrationConnection.js';
import { accountPlanContext } from '../services/accountPlanContext.js';
import { setupPriorities, validateSetup, buildSetupReadiness, setupReviewSnapshot, buildFirstBriefing } from '../services/workspaceSetup.js';
const router = express.Router();
router.use(requireAuth, requirePlan('CORE'), requirePerm('command_center.view'));
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
    req.setupMember = member;
    next();
  } catch (error) {
    next(error);
  }
});
const manage = req => ['owner', 'admin', 'manager'].includes(req.setupMember.role);
const wrap = fn => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({
      message: 'A teammate started workspace setup. Reload its saved progress before saving.'
    });
    next(error);
  }
};
const redactReview = (review, permissions) => {
  if (!review) return review;
  const allowed = key => permissions.includes('*') || permissions.includes(key);
  const restricted = id => id === 'accounts' && !allowed('clients.view') || ['revenue', 'accounting'].includes(id) && !allowed('dashboard.view');
  return {
    ...review,
    gaps: (review.gaps || []).map(g => restricted(g.id) ? {
      id: g.id,
      label: g.label,
      state: 'restricted',
      detail: 'Additional workspace permission is required to inspect this coverage.'
    } : g),
    coverage: (review.coverage || []).map(c => restricted(c.id) ? {
      ...c,
      state: 'restricted'
    } : c)
  };
};
const dto = (state, permissions = []) => state ? {
  _id: state._id,
  priorities: state.priorities || [],
  expectedSystems: state.expectedSystems || [],
  status: state.status,
  coverageReviewedAt: state.coverageReviewedAt,
  coverageReview: redactReview(state.coverageReview, permissions),
  briefing: state.briefing ? {
    ...state.briefing,
    coverage: redactReview(state.briefing.coverage, permissions),
    coverageHighlights: redactReview({
      gaps: state.briefing.coverageHighlights || []
    }, permissions).gaps.map(c => c.state === 'restricted' ? {
      ...c,
      href: null
    } : c)
  } : null,
  firstBriefingAt: state.firstBriefingAt,
  completedAt: state.completedAt,
  completionReview: redactReview(state.completionReview, permissions),
  updatedAt: state.updatedAt,
  __v: state.__v
} : {
  priorities: [],
  expectedSystems: [],
  status: 'not_started',
  coverageReviewedAt: null,
  briefing: null,
  completedAt: null,
  __v: null
};
async function facts(req, state) {
  const [ctx, connections] = await Promise.all([accountPlanContext(req.orgId), IntegrationConnection.find({
    orgId: req.orgId
  }).select('provider status mode lastSyncAt lastSyncStatus metadata.needsSelection').lean()]);
  return {
    ctx,
    readiness: buildSetupReadiness({
      ctx,
      connections,
      permissions: req.user.permissions || [],
      selectedPriorities: state?.priorities || [],
      expectedSystems: state?.expectedSystems || [],
      now: ctx.now
    })
  };
}
async function persist(req, res, existing, changes, version) {
  if (!(version === null || Number.isInteger(version) && version >= 0)) {
    res.status(400).json({
      message: 'Include the current setup version'
    });
    return null;
  }
  if (!existing) {
    if (version !== null) {
      res.status(409).json({
        message: 'Setup changed. Reload its saved progress.'
      });
      return null;
    }
    return WorkspaceSetup.create({
      orgId: req.orgId,
      ...changes,
      updatedBy: req.user.userId
    });
  }
  if (version === null) {
    res.status(409).json({
      message: 'Setup already exists. Reload its saved progress.'
    });
    return null;
  }
  const value = await WorkspaceSetup.findOneAndUpdate({
    orgId: req.orgId,
    __v: version
  }, {
    $set: {
      ...changes,
      updatedBy: req.user.userId
    },
    $inc: {
      __v: 1
    }
  }, {
    new: true,
    runValidators: true
  }).lean();
  if (!value) res.status(409).json({
    message: 'A teammate changed setup. Your draft is still open; reload saved choices before trying again.'
  });
  return value;
}
router.get('/status', wrap(async (req, res) => {
  const state = await WorkspaceSetup.findOne({
    orgId: req.orgId
  }).select('status priorities completedAt __v').lean();
  res.json({
    ok: true,
    orgId: req.orgId,
    status: state?.status || 'not_started',
    canManage: manage(req),
    version: state?.__v ?? null
  });
}));
router.get('/', wrap(async (req, res) => {
  const state = await WorkspaceSetup.findOne({
    orgId: req.orgId
  }).lean();
  const {
    readiness
  } = await facts(req, state);
  res.json({
    ok: true,
    orgId: req.orgId,
    canManage: manage(req),
    state: dto(state, req.user.permissions || []),
    priorities: setupPriorities,
    readiness
  });
}));
router.put('/', wrap(async (req, res) => {
  if (!manage(req)) return res.status(403).json({
    message: 'A workspace manager must choose shared setup priorities'
  });
  let value;
  try {
    value = validateSetup(req.body);
  } catch (error) {
    return res.status(400).json({
      message: error.message
    });
  }
  const state = await WorkspaceSetup.findOne({
    orgId: req.orgId
  }).lean();
  const changed = !state || JSON.stringify(state.priorities || []) !== JSON.stringify(value.priorities) || JSON.stringify(state.expectedSystems || []) !== JSON.stringify(value.expectedSystems);
  const saved = await persist(req, res, state, {
    ...value,
    ...(changed ? {
      status: 'in_progress',
      coverageReviewedAt: null,
      coverageReview: null,
      briefing: null,
      completedAt: null,
      completionReview: null
    } : {})
  }, req.body.version);
  if (saved) res.json({
    ok: true,
    state: dto(saved, req.user.permissions || [])
  });
}));
router.post('/:action', wrap(async (req, res) => {
  if (!manage(req)) return res.status(403).json({
    message: 'A workspace manager must update shared setup progress'
  });
  const action = req.params.action;
  if (!['review', 'briefing', 'complete', 'defer'].includes(action)) return res.status(404).json({
    message: 'Setup action not found'
  });
  const state = await WorkspaceSetup.findOne({
    orgId: req.orgId
  }).lean();
  if (action === 'defer') {
    const saved = await persist(req, res, state, {
      status: 'deferred',
      completedAt: null
    }, req.body.version);
    if (saved) res.json({
      ok: true,
      state: dto(saved, req.user.permissions || [])
    });
    return;
  }
  if (!state?.priorities?.length) return res.status(400).json({
    message: 'Save at least one leadership priority first'
  });
  const {
    ctx,
    readiness
  } = await facts(req, state);
  const snapshot = setupReviewSnapshot(readiness);
  if (['review', 'complete'].includes(action) && req.body.readinessToken !== readiness.reviewToken) return res.status(409).json({
    message: 'Coverage changed or has not been refreshed. Refresh coverage and review the current limits before continuing.'
  });
  let changes;
  if (action === 'review') {
    if (readiness.gaps.length && req.body.acknowledgeGaps !== true) return res.status(400).json({
      message: 'Acknowledge the listed data gaps to continue with limited coverage'
    });
    changes = {
      status: 'in_progress',
      coverageReviewedAt: ctx.now,
      coverageReview: snapshot,
      briefing: null,
      completedAt: null,
      completionReview: null
    };
  } else if (action === 'briefing') {
    if (!state.coverageReviewedAt || state.coverageReview?.mode !== readiness.mode) return res.status(409).json({
      message: 'Review coverage in the current workspace data mode before building the briefing'
    });
    changes = {
      status: 'in_progress',
      briefing: buildFirstBriefing(ctx, readiness, ctx.now),
      firstBriefingAt: state.firstBriefingAt || ctx.now,
      completedAt: null
    };
  } else {
    if (!state.coverageReviewedAt || !state.briefing || state.coverageReview?.mode !== readiness.mode || state.briefing.mode !== readiness.mode) return res.status(409).json({
      message: 'Review current coverage and build a briefing before finishing setup'
    });
    if (readiness.gaps.length && req.body.acknowledgeGaps !== true) return res.status(400).json({
      message: 'Acknowledge the remaining data gaps before finishing setup'
    });
    changes = {
      status: 'completed',
      completedAt: ctx.now,
      completionReview: snapshot
    };
  }
  const saved = await persist(req, res, state, changes, req.body.version);
  if (saved) res.json({
    ok: true,
    state: dto(saved, req.user.permissions || []),
    readiness
  });
}));
export default router;
