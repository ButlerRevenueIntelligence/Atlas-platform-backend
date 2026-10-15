import { createHash } from 'node:crypto';
import { captureDeals, priorities as reviewPriorities, summarize, isOpen } from './leadershipBriefing.js';
export const setupPriorities = [{
  id: 'pipeline',
  label: 'Protect the pipeline',
  description: 'Spot closing pressure and give next steps an owner.',
  systems: ['salesforce', 'hubspot', 'zoho_crm', 'pipedrive', 'bitrix24', 'excel_csv']
}, {
  id: 'forecast',
  label: 'Improve forecast visibility',
  description: 'Check opportunity dates and probabilities before setting a baseline.',
  systems: ['salesforce', 'hubspot', 'zoho_crm', 'pipedrive', 'excel_csv']
}, {
  id: 'accounts',
  label: 'Coordinate account growth',
  description: 'Connect account records, stakeholders, and shared action plans.',
  systems: ['salesforce', 'hubspot', 'zoho_crm', 'pipedrive', 'bitrix24', 'excel_csv']
}, {
  id: 'cash',
  label: 'Understand revenue and cash',
  description: 'Inspect recorded revenue and accounting coverage as separate measures.',
  systems: ['stripe', 'quickbooks', 'shopify', 'excel_csv']
}];
export const setupSystems = [['salesforce', 'Salesforce', 'CRM'], ['hubspot', 'HubSpot', 'CRM'], ['zoho_crm', 'Zoho CRM', 'CRM'], ['pipedrive', 'Pipedrive', 'CRM'], ['bitrix24', 'Bitrix24', 'CRM'], ['stripe', 'Stripe', 'Payments'], ['quickbooks', 'QuickBooks Online', 'Accounting'], ['shopify', 'Shopify', 'Commerce'], ['google_ads', 'Google Ads', 'Advertising'], ['meta_ads', 'Meta Ads', 'Advertising'], ['linkedin_ads', 'LinkedIn Ads', 'Advertising'], ['ga4', 'Google Analytics 4', 'Analytics'], ['slack', 'Slack', 'Collaboration'], ['excel_csv', 'Excel / CSV import', 'Manual import']].map(([id, name, category]) => ({
  id,
  name,
  category
}));
const validDate = value => value && Number.isFinite(new Date(value).getTime());
const knownNumber = value => value !== null && value !== undefined && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value));
const permission = (perms, key) => perms.includes('*') || perms.includes(key);
export function validateSetup(body) {
  const {
    priorities,
    expectedSystems,
    version
  } = body;
  if (!(version === null || Number.isInteger(version) && version >= 0)) throw new Error('Include the current setup version');
  if (!Array.isArray(priorities) || priorities.length < 1 || priorities.length > 3 || new Set(priorities).size !== priorities.length || priorities.some(id => !setupPriorities.some(p => p.id === id))) throw new Error('Choose one to three leadership priorities');
  if (!Array.isArray(expectedSystems) || expectedSystems.length > 14 || new Set(expectedSystems).size !== expectedSystems.length || expectedSystems.some(id => !setupSystems.some(s => s.id === id))) throw new Error('Choose available systems, or leave this empty to decide later');
  return {
    priorities,
    expectedSystems
  };
}
export function connectionReadiness(connection, now = new Date()) {
  if (!connection) return {
    state: 'not_connected',
    label: 'Not connected',
    lastSyncAt: null
  };
  const lastSyncAt = validDate(connection.lastSyncAt) ? new Date(connection.lastSyncAt).toISOString() : null;
  const result = {
    lastSyncAt
  };
  if (connection.mode !== 'live') return {
    ...result,
    state: 'sample_connection',
    label: 'Demo connection; no live readiness implied'
  };
  if (connection.status === 'disconnected') return {
    ...result,
    state: 'not_connected',
    label: 'Disconnected'
  };
  if (connection.status === 'error' || connection.lastSyncStatus === 'failed') return {
    ...result,
    state: 'needs_attention',
    label: 'Connection or sync needs attention'
  };
  if (connection.status === 'syncing' || connection.lastSyncStatus === 'running') return {
    ...result,
    state: 'syncing',
    label: 'Sync in progress'
  };
  if (connection.status !== 'connected') return {
    ...result,
    state: 'needs_attention',
    label: 'Connection state needs checking'
  };
  if (connection.metadata?.needsSelection) return {
    ...result,
    state: 'needs_selection',
    label: 'Choose an account or property'
  };
  if (connection.provider === 'slack') return {
    ...result,
    state: 'connected',
    label: 'Connected for notifications; not a data source'
  };
  if (connection.lastSyncStatus !== 'success' || !lastSyncAt) return {
    ...result,
    state: 'awaiting_sync',
    label: 'Connected; successful sync not recorded'
  };
  const age = now - new Date(lastSyncAt);
  if (age < 0) return {
    ...result,
    state: 'needs_attention',
    label: 'Sync timestamp is ahead of this read; check it'
  };
  return {
    ...result,
    state: age > 86400000 ? 'stale' : 'synced',
    label: age > 86400000 ? 'Last successful sync over 24 hours ago' : 'Successful sync within 24 hours'
  };
}
export function buildSetupReadiness({
  ctx,
  connections = [],
  permissions = [],
  selectedPriorities = [],
  expectedSystems = [],
  now = new Date()
}) {
  const demo = ctx.demo,
    workspace = ctx.workspace || {};
  const raw = (workspace.deals || []).filter(d => !d.archivedAt && (demo || ![d.externalSource, d.source].some(v => String(v).toLowerCase() === 'demo')));
  const deals = captureDeals(raw),
    open = deals.filter(isOpen),
    rawMap = new Map(raw.map(d => [String(d._id || d.id), d]));
  const missing = {
    closeDate: open.filter(d => !d.closeDate).length,
    owner: open.filter(d => !d.owner).length,
    probability: open.filter(d => {
      const p = rawMap.get(d.id)?.probability;
      return !knownNumber(p) || Number(p) < 0 || Number(p) > 100;
    }).length,
    amount: open.filter(d => {
      const n = rawMap.get(d.id)?.amount;
      return !knownNumber(n) || Number(n) < 0;
    }).length
  };
  const overdue = open.filter(d => d.closeDate && new Date(d.closeDate) < new Date(now.toISOString().slice(0, 10))).length;
  const systems = setupSystems.map(s => ({
    ...s,
    ...connectionReadiness(connections.find(c => c.provider === s.id), now),
    expected: expectedSystems.includes(s.id),
    recommended: selectedPriorities.some(id => setupPriorities.find(p => p.id === id)?.systems.includes(s.id)),
    href: `/data-connectors?setup=1#connector-${s.id}`
  }));
  const readAccounts = permission(permissions, 'clients.view'),
    readDashboard = permission(permissions, 'dashboard.view');
  const linked = open.filter(d => ctx.catalog.dealKeys.has(d.id)).length;
  const minDay = new Date(now.getTime() - 29 * 86400000).toISOString().slice(0, 10),
    today = now.toISOString().slice(0, 10);
  const observations = Object.entries(workspace.revenueObservationDays || {}).filter(([source]) => ['stripe', 'shopify', 'metrics_daily'].includes(source)).map(([source, days]) => ({
    source,
    days: new Set(days.filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= minDay && d <= today)).size
  }));
  const observedDays = Math.max(0, ...observations.map(v => v.days));
  const financial = workspace.financials,
    financialAge = validDate(financial?.syncedAt) ? now - new Date(financial.syncedAt) : null;
  const accountingValid = financial && String(financial.currency).toUpperCase() === 'USD' && financialAge !== null && financialAge >= 0;
  const cards = [{
    id: 'pipeline',
    label: demo ? 'Sample opportunity coverage' : 'Opportunity coverage',
    state: demo ? 'sample' : !open.length ? 'missing' : Object.values(missing).some(Boolean) || overdue ? 'partial' : 'available',
    detail: !open.length ? 'No open opportunities available in the USD workspace dataset.' : `${open.length} open opportunities · ${missing.closeDate} missing close dates · ${missing.owner} missing owners · ${missing.probability} missing/invalid probabilities · ${missing.amount} missing/invalid values · ${overdue} overdue close dates.`,
    href: '/deal-war-room',
    required: selectedPriorities.some(p => ['pipeline', 'forecast'].includes(p)),
    counts: {
      open: open.length,
      ...missing,
      overdue
    }
  }, {
    id: 'accounts',
    label: 'Explicit account links',
    state: !readAccounts ? 'restricted' : demo ? 'sample' : !open.length ? 'missing' : linked === open.length ? 'available' : 'partial',
    detail: !readAccounts ? 'Account access is required to inspect link coverage.' : `${linked} of ${open.length} open opportunities have an unambiguous account link. Names alone do not establish a link.`,
    href: readAccounts ? '/account-plans' : null,
    required: selectedPriorities.includes('accounts'),
    ...(readAccounts ? {
      counts: {
        linked,
        total: open.length
      }
    } : {})
  }, {
    id: 'revenue',
    label: 'Recorded revenue observations',
    state: !readDashboard ? 'restricted' : demo ? 'sample' : observedDays ? 'available' : 'missing',
    detail: !readDashboard ? 'Overview access is required to inspect recorded-revenue coverage.' : demo ? 'Sample opportunities do not verify live revenue observations.' : observedDays ? `${observedDays} observed days from at least one source in the last 30 UTC days. Recorded zero values count; filled-in chart days do not.` : 'No original recorded-revenue observation days found in the last 30 UTC days.',
    href: readDashboard ? '/revenue-planning' : null,
    required: selectedPriorities.includes('cash'),
    ...(readDashboard && !demo ? {
      observations
    } : {})
  }, {
    id: 'accounting',
    label: 'Accounting snapshot',
    state: !readDashboard ? 'restricted' : demo ? 'sample' : !accountingValid ? 'missing' : financialAge > 86400000 ? 'partial' : 'available',
    detail: !readDashboard ? 'Overview access is required to inspect accounting coverage.' : demo ? 'No live accounting readiness is implied by this sample workspace.' : !accountingValid ? 'No usable USD accounting snapshot found.' : `Accounting snapshot read from ${new Date(financial.syncedAt).toISOString()}${financialAge > 86400000 ? '; over 24 hours old' : ''}. Reporting period: ${validDate(financial.periodStart) && validDate(financial.periodEnd) ? new Date(financial.periodStart).toISOString().slice(0, 10) + ' to ' + new Date(financial.periodEnd).toISOString().slice(0, 10) : 'not supplied'}. This is not a revenue-to-cash reconciliation.`,
    href: readDashboard ? '/data-connectors?setup=1#connector-quickbooks' : null,
    required: selectedPriorities.includes('cash')
  }];
  const gaps = cards.filter(c => c.required && c.state !== 'available').map(c => ({
    id: c.id,
    label: c.label,
    state: c.state,
    detail: c.detail
  }));
  for (const system of systems.filter(s => (s.expected || s.recommended && connections.some(c => c.provider === s.id && c.mode === 'live' && c.status !== 'disconnected')) && s.id !== 'excel_csv' && !['synced', 'connected'].includes(s.state))) gaps.push({
    id: 'system:' + system.id,
    label: system.name,
    state: system.state,
    detail: system.label
  });
  const reviewToken = createHash('sha256').update(JSON.stringify({
    mode: demo ? 'demo' : 'live',
    selectedPriorities,
    expectedSystems,
    gaps
  })).digest('hex');
  return {
    reviewToken,
    focus: selectedPriorities,
    mode: demo ? 'demo' : 'live',
    asOf: now.toISOString(),
    cards,
    systems,
    gaps,
    canOpenConnectors: readDashboard,
    warnings: ctx.warnings || [],
    sample: demo,
    pipelineAvailable: open.length > 0,
    openCount: open.length,
    nextStep: !selectedPriorities.length ? 'Choose your priorities' : gaps.length ? 'Review the listed data gaps before relying on the briefing' : 'Inspect your first leadership briefing'
  };
}
export function setupReviewSnapshot(readiness) {
  return {
    mode: readiness.mode,
    asOf: readiness.asOf,
    gaps: readiness.gaps,
    coverage: readiness.cards.map(c => ({
      id: c.id,
      state: c.state
    })),
    expectedConnections: readiness.systems.filter(s => s.expected).map(s => ({
      id: s.id,
      state: s.state
    }))
  };
}
export function buildFirstBriefing(ctx, readiness, now = new Date()) {
  const raw = (ctx.workspace?.deals || []).filter(d => !d.archivedAt && (ctx.demo || ![d.externalSource, d.source].some(v => String(v).toLowerCase() === 'demo')));
  const deals = captureDeals(raw),
    summary = summarize(deals, now);
  return {
    generatedAt: now.toISOString(),
    mode: readiness.mode,
    kind: summary.openCount ? 'pipeline' : readiness.cards.some(c => c.required && c.state === 'available') ? 'coverage' : 'starter',
    coverageHighlights: readiness.cards.filter(c => c.required).map(c => ({
      id: c.id,
      label: c.label,
      state: c.state,
      detail: c.detail,
      href: c.href
    })),
    summary,
    priorities: reviewPriorities(deals, now).slice(0, 3),
    coverage: setupReviewSnapshot(readiness),
    message: summary.openCount ? `${summary.openCount} open opportunities available for leadership review. Inspect their source records before assigning actions and check the coverage for your selected priorities below.` : readiness.cards.some(c => c.required && c.state === 'available') ? 'Some coverage is available for your selected priorities. Open the relevant views below to inspect the records and set your next steps. No open opportunity pipeline is available yet.' : 'Your selected priorities need more data before Atlas can build a substantive briefing. Review the source checks below, connect or import the relevant records, and refresh coverage.'
  };
}
