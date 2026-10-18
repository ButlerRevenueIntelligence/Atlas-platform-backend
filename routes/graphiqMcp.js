import express from 'express';
import Membership from '../models/Membership.js';
import GraphIQResearch from '../models/GraphIQResearch.js';
import CompanyIntelligence from '../models/CompanyIntelligence.js';
import { withGraphIQMcp, searchArguments, searchToolStatus, GraphIQMcpError } from '../services/graphiqMcp.js';
import { normalizeResearch, researchDto } from '../services/graphiqResearch.js';
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
    next();
  } catch (e) {
    next(e);
  }
});
const wrap = fn => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof GraphIQMcpError) return res.status(e.status).json({
      ok: false,
      code: e.code,
      message: e.message
    });
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
router.get('/status', wrap(async (req, res) => res.json({
  ok: true,
  configured: Boolean(process.env.GRAPHIQ_API_KEY),
  endpoint: 'https://app.graphiq.ai/mcp',
  automaticMonitoring: false
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
    automaticMonitoring: false
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
  const name = kind === 'news' ? 'search_news' : 'search_organizations';
  const result = await withGraphIQMcp(async (client, tools) => {
    const tool = tools.find(t => t.name === name);
    return client.call(name, searchArguments(tool, query.trim()));
  });
  const normalized = normalizeResearch(result, kind),
    expiresAt = new Date(Date.now() + 86400000);
  const snapshot = await GraphIQResearch.create({
    orgId: req.orgId,
    kind,
    query: query.trim(),
    tool: name,
    ...normalized,
    expiresAt
  });
  // Preserve the shared company-context contract for existing Atlas consumers.
  let companySnapshotId = null;
  if (kind === 'companies' && normalized.records.length) {
    const company = await CompanyIntelligence.create({
      orgId: req.orgId,
      query: {
        mcpQuery: query.trim()
      },
      data: {
        organizations: normalized.records
      },
      expiresAt
    });
    companySnapshotId = String(company._id);
  }
  res.json({
    ok: true,
    research: researchDto(snapshot),
    companySnapshotId
  });
}));
export default router;
