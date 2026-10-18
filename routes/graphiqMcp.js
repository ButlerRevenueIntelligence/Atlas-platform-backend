import { graphIQDiagnostic, logGraphIQEvent } from '../services/graphiqDiagnostics.js';
import { retrieveGraphIQResearch } from '../services/retrieveGraphIQResearch.js';
import monitorRoutes from './graphiqMonitoring.js';
import IntegrationConnection from '../models/IntegrationConnection.js';
import { notifyGraphIQResearch, getGraphIQSlackStatus } from '../services/slackGraphIQAlerts.js';
import express from 'express';
import Membership from '../models/Membership.js';
import GraphIQResearch from '../models/GraphIQResearch.js';
import { withGraphIQMcp, searchToolStatus, GraphIQMcpError } from '../services/graphiqMcp.js';
import { researchDto } from '../services/graphiqResearch.js';
const router = express.Router();
// Parent router supplies authenticated canonical workspace and CORE billing gates.
router.use(async (req, res, next) => {
  try {
    const permissions = req.user?.permissions || [];
    if (!permissions.some(p => ['*', 'market_signals.view', 'clients.view', 'forecast.ai', 'forecast.basic_ai'].includes(p))) return res.status(403).json({
      message: 'Company intelligence or market access is required'
    });
    const member = await Membership.findOne({
      orgId: req.orgId,
      userId: req.user.userId,
      status: 'active'
    }).lean();
    if (!member) return res.status(403).json({
      message: 'An active workspace membership is required'
    });
    req.graphiqMember = member;
    next();
  } catch (e) {
    next(e);
  }
});
const wrap = fn => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof GraphIQMcpError) {
      const diagnostic = graphIQDiagnostic(e);
      logGraphIQEvent('request_failed', {
        orgId: req.orgId,
        ...diagnostic
      });
      return res.status(e.status).json({
        ok: false,
        code: e.code,
        message: e.message,
        diagnostic
      });
    }
    next(e);
  }
};
// Per-process guard bounds concurrent upstream searches; no user identifiers or credentials in keys.
const inFlight = new Set();
const upstream = fn => wrap(async (req, res) => {
  const key = String(req.orgId);
  if (inFlight.has(key)) return res.status(429).json({
    message: 'A GraphIQ MCP request is already running for this workspace.'
  });
  inFlight.add(key);
  try {
    await fn(req, res);
  } finally {
    inFlight.delete(key);
  }
});
router.use('/monitoring', monitorRoutes);
router.get('/notifications', wrap(async (req, res) => res.json({
  ok: true,
  ...(await getGraphIQSlackStatus(req.orgId)),
  canManage: ['owner', 'admin', 'manager'].includes(req.graphiqMember.role)
})));
router.put('/notifications', wrap(async (req, res) => {
  if (!['owner', 'admin', 'manager'].includes(req.graphiqMember.role)) return res.status(403).json({
    message: 'A workspace manager must change notification settings'
  });
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({
    message: 'Choose whether GraphIQ notifications are enabled'
  });
  const result = await IntegrationConnection.updateOne({
    orgId: req.orgId,
    provider: 'slack'
  }, {
    $set: {
      'settings.graphiqAlertsEnabled': req.body.enabled
    }
  });
  if (!result.matchedCount) return res.status(404).json({
    message: 'Connect Slack before changing its notifications'
  });
  res.json({
    ok: true,
    ...(await getGraphIQSlackStatus(req.orgId)),
    canManage: true
  });
}));
router.get('/status', wrap(async (req, res) => res.json({
  ok: true,
  configured: Boolean(process.env.GRAPHIQ_API_KEY),
  endpoint: 'https://app.graphiq.ai/mcp',
  automaticMonitoring: true
})));
router.post('/check', upstream(async (req, res) => {
  const result = await withGraphIQMcp(async (client, tools) => ({
    protocolVersion: client.version,
    toolCount: tools.length,
    searches: ['companies', 'news'].map(kind => {
      const name = kind === 'news' ? 'search_news' : 'search_organizations',
        tool = tools.find(t => t.name === name);
      return {
        kind,
        name,
        ...searchToolStatus(tool)
      };
    })
  }));
  res.json({
    ok: true,
    ...result,
    checkedAt: new Date(),
    automaticMonitoring: true
  });
}));
router.get('/research', wrap(async (req, res) => {
  const kind = req.query.kind || 'news';
  if (!['news', 'companies'].includes(kind)) return res.status(400).json({
    message: 'Choose companies or news'
  });
  const snapshot = await GraphIQResearch.findOne({
    orgId: req.orgId,
    kind,
    expiresAt: {
      $gt: new Date()
    }
  }).sort({
    createdAt: -1
  }).lean();
  res.json({
    ok: true,
    research: researchDto(snapshot)
  });
}));
router.post('/research', upstream(async (req, res) => {
  const {
    kind,
    query
  } = req.body || {};
  if (!['news', 'companies'].includes(kind) || typeof query !== 'string' || !query.trim() || query.length > 500) return res.status(400).json({
    message: 'Provide a company or news query of 1–500 characters'
  });
  const {
    snapshot,
    companySnapshotId,
    records
  } = await retrieveGraphIQResearch({
    orgId: req.orgId,
    kind,
    query: query.trim()
  });
  const slackNotification = await notifyGraphIQResearch({
    orgId: req.orgId,
    kind,
    query: query.trim(),
    records,
    sourcePage: req.body.sourcePage
  });
  res.json({
    ok: true,
    slackNotification,
    research: researchDto(snapshot),
    companySnapshotId
  });
}));
export default router;
