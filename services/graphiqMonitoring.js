import GraphIQMonitor from '../models/GraphIQMonitor.js';
export const MANAGERS = ['owner', 'admin', 'manager'];
export function validateMonitor(body) {
  if (typeof body?.enabled !== 'boolean' || ![60, 360, 1440].includes(body.intervalMinutes) || !Number.isInteger(body.revision) || body.revision < 0 || !Array.isArray(body.searches) || body.searches.length > 5) throw new Error('Choose a schedule and up to five saved searches.');
  const seen = new Set();
  const searches = body.searches.map(s => {
    if (!s || !['news', 'companies'].includes(s.kind) || !['market-signals', 'account-intelligence'].includes(s.sourcePage) || typeof s.query !== 'string' || !s.query.trim() || s.query.length > 500) throw new Error('Each saved search needs a page, research type and a query of 1–500 characters.');
    const key = JSON.stringify([s.kind, s.query.trim().toLowerCase()]);
    if (seen.has(key)) throw new Error('This research query is already monitored in this workspace.');
    seen.add(key);
    return {
      kind: s.kind,
      query: s.query.trim(),
      sourcePage: s.sourcePage
    };
  });
  if (body.enabled && !searches.length) throw new Error('Save at least one search before enabling monitoring.');
  return {
    enabled: body.enabled,
    intervalMinutes: body.intervalMinutes,
    searches
  };
}
export const monitorDto = doc => ({
  enabled: doc?.enabled || false,
  intervalMinutes: doc?.intervalMinutes || 360,
  searches: (doc?.searches || []).map(s => ({
    kind: s.kind,
    query: s.query,
    sourcePage: s.sourcePage
  })),
  revision: doc?.revision || 0,
  nextRunAt: doc?.enabled ? doc.nextRunAt : null,
  lastRunAt: doc?.lastRunAt || null,
  lastCompletedAt: doc?.lastCompletedAt || null,
  lastState: doc?.lastState || 'never',
  lastReason: doc?.lastReason || null,
  lastResults: doc?.lastResults || []
});
export const loadMonitor = async orgId => monitorDto(await GraphIQMonitor.findOne({
  orgId
}).lean());
