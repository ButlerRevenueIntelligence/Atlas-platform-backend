import express from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { requirePlan } from '../middleware/requirePlan.js';
import Membership from '../models/Membership.js';
import IntegrationConnection from '../models/IntegrationConnection.js';
import CashEvidenceSnapshot from '../models/CashEvidenceSnapshot.js';
import CashOpportunityLink from '../models/CashOpportunityLink.js';
import Organization from '../models/Organization.js';
import { getUnifiedWorkspaceData } from '../services/workspaceData.js';
import { buildDemoWorkspaceDeals, isDemoWorkspace } from '../services/demoWorkspace.js';
import { buildRevenueToCash, demoCashSnapshot, invoiceEligible } from '../services/revenueToCash.js';
import { invoiceFingerprint } from '../services/cashEvidence.js';
const router = express.Router();
router.use(requireAuth, requirePlan('CORE'), requirePerm('dashboard.view'), requirePerm('command_center.view'));
router.use(async (req, res, next) => {
  try {
    const m = await Membership.findOne({
      orgId: req.orgId,
      userId: req.user.userId,
      status: 'active'
    }).lean();
    if (!m) return res.status(403).json({
      message: 'An active workspace membership is required'
    });
    req.cashMember = m;
    next();
  } catch (e) {
    next(e);
  }
});
const manage = req => ['owner', 'admin', 'manager'].includes(req.cashMember.role);
const wrap = fn => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({
      message: 'A teammate reviewed this invoice. Refresh before saving.'
    });
    next(e);
  }
};
async function workspace(orgId) {
  const org = await Organization.findById(orgId).select('_id name slug').lean();
  const demo = isDemoWorkspace(org);
  return {
    demo,
    deals: demo ? buildDemoWorkspaceDeals(org, new Date(new Date().toISOString().slice(0, 10))) : (await getUnifiedWorkspaceData(orgId, {
      days: 90
    })).deals.filter(d => !['demo'].includes(String(d.externalSource || d.source).toLowerCase()))
  };
}
async function context(req, res) {
  const ctx = await workspace(req.orgId);
  const connections = await IntegrationConnection.find({
    orgId: req.orgId,
    provider: {
      $in: ['quickbooks', 'stripe']
    }
  }).select('provider externalAccountId mode status lastSyncAt lastSyncStatus metadata.cashEvidenceStatus metadata.cashEvidenceAt metadata.cashEvidenceAttemptAt metadata.cashEvidenceAccountId metadata.cashEvidenceEnvironment').lean();
  const provider = req.query.provider || (ctx.demo || connections.some(c => c.provider === 'quickbooks' && c.externalAccountId) ? 'quickbooks' : connections.some(c => c.provider === 'stripe' && c.externalAccountId) ? 'stripe' : 'quickbooks');
  if (!['quickbooks', 'stripe'].includes(provider) || ctx.demo && provider !== 'quickbooks') {
    res.status(400).json({
      message: 'Choose an available financial source'
    });
    return null;
  }
  const connection = connections.find(c => c.provider === provider),
    accountId = connection?.mode === 'live' ? String(connection.externalAccountId || '') : '';
  const environment = connection?.metadata?.cashEvidenceEnvironment || 'live';
  const snapshot = ctx.demo ? demoCashSnapshot(ctx.deals) : accountId && ['live', 'test'].includes(environment) ? await CashEvidenceSnapshot.findOne({
    orgId: req.orgId,
    provider,
    accountId,
    environment
  }).lean() : null;
  const links = snapshot ? await CashOpportunityLink.find({
    orgId: req.orgId,
    provider,
    accountId: snapshot.accountId,
    environment: snapshot.environment
  }).lean() : [];
  const detailStatus = connection?.metadata?.cashEvidenceAccountId === accountId ? connection.metadata.cashEvidenceStatus || 'not_synced' : 'not_synced';
  return {
    ...ctx,
    provider,
    snapshot,
    links,
    source: ctx.demo ? {
      status: 'sample',
      detailStatus: 'sample',
      lastSyncAt: null
    } : {
      status: connection?.status || 'disconnected',
      detailStatus,
      lastSyncAt: connection?.lastSyncAt || null,
      lastSyncStatus: connection?.lastSyncStatus || 'never'
    },
    providers: ctx.demo ? ['quickbooks'] : ['quickbooks', 'stripe']
  };
}
router.get('/opportunities', wrap(async (req, res) => {
  const query = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
  if (query.length > 100) return res.status(400).json({
    message: 'Search is too long'
  });
  const ctx = await workspace(req.orgId),
    rows = ctx.deals.filter(d => !query || `${d.name} ${d.clientName || d.accountName || ''} ${d.externalId || ''} ${d._id || d.id}`.toLowerCase().includes(query)).sort((a, b) => Number(String(b.stage).toLowerCase() === 'closed won') - Number(String(a.stage).toLowerCase() === 'closed won'));
  res.json({
    ok: true,
    total: rows.length,
    opportunities: rows.slice(0, 50).map(d => ({
      id: String(d._id || d.id),
      name: d.name,
      stage: d.stage,
      amount: d.amount,
      account: d.clientName || d.accountName || ''
    }))
  });
}));
router.get('/', wrap(async (req, res) => {
  const ctx = await context(req, res);
  if (!ctx) return;
  const view = req.query.view || 'all',
    search = typeof req.query.search === 'string' ? req.query.search.toLowerCase().trim() : '',
    offset = Number(req.query.offset || 0);
  if (!['all', 'unmatched', 'overdue', 'issues'].includes(view) || search.length > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000) return res.status(400).json({
    message: 'Invalid ledger filter'
  });
  const ledger = buildRevenueToCash(ctx),
    rows = ledger ? ledger.invoices.filter(i => (view === 'all' || view === 'unmatched' && i.eligible && !i.deal || view === 'overdue' && i.overdue || view === 'issues' && i.issues.length) && (!search || `${i.number} ${i.customerName} ${i.id} ${i.deal?.name || ''}`.toLowerCase().includes(search))) : [];
  res.json({
    ok: true,
    provider: ctx.provider,
    providers: ctx.providers,
    workspaceMode: ctx.demo ? 'demo' : 'live',
    asOf: new Date(),
    source: ctx.source,
    canManage: manage(req) && Boolean(ctx.snapshot && (ctx.demo || ctx.snapshot.environment === 'live')),
    snapshot: ctx.snapshot ? {
      generation: ctx.snapshot.generation,
      capturedAt: ctx.snapshot.capturedAt,
      environment: ctx.snapshot.environment
    } : null,
    ledger: ledger ? {
      ...ledger,
      invoices: rows.slice(offset, offset + 25),
      unmatchedWon: ledger.unmatchedWon.slice(0, 100),
      unmatchedWonCount: ledger.unmatchedWon.length,
      paymentIssues: ledger.paymentIssues.slice(0, 100),
      paymentIssueCount: ledger.paymentIssues.length,
      totalRows: rows.length,
      offset,
      pageSize: 25
    } : null
  });
}));
router.put('/links/:invoiceId', wrap(async (req, res) => {
  if (!manage(req)) return res.status(403).json({
    message: 'A workspace manager must confirm financial record links'
  });
  const {
    dealId,
    state,
    note,
    version,
    generation
  } = req.body;
  if (!['confirmed', 'blocked'].includes(state) || typeof note !== 'string' || !note.trim() || note.length > 2000 || !(version === null || Number.isInteger(version) && version >= 0) || typeof generation !== 'string' || typeof req.params.invoiceId !== 'string' || req.params.invoiceId.length > 200 || state === 'confirmed' && (typeof dealId !== 'string' || dealId.length > 100)) return res.status(400).json({
    message: 'Provide a review reason, a current version and an opportunity or explicit unlink decision'
  });
  const ctx = await context(req, res);
  if (!ctx) return;
  if (!ctx.snapshot || ctx.snapshot.generation !== generation) return res.status(409).json({
    message: 'Financial evidence changed. Refresh before reviewing this link.'
  });
  if (!ctx.demo && ctx.snapshot.environment !== 'live') return res.status(409).json({
    message: 'Test financial evidence cannot be attached to live opportunities'
  });
  const invoice = ctx.snapshot.invoices.find(i => i.id === req.params.invoiceId);
  if (!invoice || !invoiceEligible(invoice)) return res.status(404).json({
    message: 'A supported USD invoice is required in the selected source snapshot'
  });
  if (state === 'confirmed' && !ctx.deals.some(d => String(d._id || d.id) === dealId)) return res.status(404).json({
    message: 'Opportunity not found in this workspace'
  });
  const filter = {
    orgId: req.orgId,
    provider: ctx.provider,
    accountId: ctx.snapshot.accountId,
    environment: ctx.snapshot.environment,
    invoiceId: invoice.id
  };
  const existing = await CashOpportunityLink.findOne(filter).lean();
  const value = {
    state,
    dealId: state === 'confirmed' ? dealId : null,
    note: note.trim(),
    invoiceFingerprint: invoiceFingerprint(invoice),
    generation,
    updatedBy: req.user.userId,
    authorName: req.user.name || 'Workspace member'
  };
  const history = {
    state,
    dealId: value.dealId,
    note: value.note,
    at: new Date(),
    userId: req.user.userId
  };
  let saved;
  if (version === null) {
    if (existing) return res.status(409).json({
      message: 'A review already exists. Refresh before editing.'
    });
    saved = await CashOpportunityLink.create({
      ...filter,
      ...value,
      history: [history]
    });
  } else saved = await CashOpportunityLink.findOneAndUpdate({
    ...filter,
    __v: version
  }, {
    $set: value,
    $inc: {
      __v: 1
    },
    $push: {
      history: {
        $each: [history],
        $slice: -20
      }
    }
  }, {
    new: true,
    runValidators: true
  }).lean();
  if (!saved) return res.status(409).json({
    message: 'A teammate changed this review. Refresh before saving again.'
  });
  res.json({
    ok: true,
    version: saved.__v
  });
}));
export default router;
