import { captureDeals, isOpen } from './leadershipBriefing.js';
const clean = value => String(value || '').trim();
const recordId = value => clean(value?._id || value);
const valid = record => !record.archivedAt && clean(record.status).toLowerCase() !== 'archived';
export function accountIdentity(record, type) {
  const source = clean(record.externalSource).toLowerCase(),
    externalId = clean(record.externalId);
  return source && externalId ? `provider:${Buffer.from(source).toString("base64url")}:${Buffer.from(externalId).toString("base64url")}` : `${type}:${recordId(record._id || record.id)}`;
}
export function buildAccountCatalog({
  clients = [],
  accounts = [],
  deals = [],
  demo = false
}) {
  const items = new Map(),
    aliases = new Map(),
    ids = new Map(),
    dealKeys = new Map();
  function add(record, type) {
    if (!valid(record)) return;
    const id = recordId(record._id || record.id);
    if (!id) return;
    const key = accountIdentity(record, type),
      alias = `${type}:${id}`;
    if (!items.has(key)) items.set(key, {
      key,
      name: clean(record.name) || 'Unnamed account',
      industry: clean(record.industry),
      website: clean(record.website),
      source: clean(record.externalSource) || 'Atlas',
      primaryContactName: clean(record.primaryContactName),
      primaryContactEmail: clean(record.primaryContactEmail),
      aliases: [],
      dealIds: []
    });
    const item = items.get(key);
    item.aliases.push(alias);
    aliases.set(alias, key);
    // Duplicate Mongo IDs with conflicting identities are ambiguous, not a name-based match.
    if (ids.has(id) && ids.get(id) !== key) ids.set(id, null);else if (!ids.has(id)) ids.set(id, key);
  }
  if (demo) {
    for (const deal of deals) {
      const name = clean(deal.clientName || deal.accountName);
      if (!name) continue;
      let item = [...items.values()].find(a => a.name === name);
      if (!item) {
        const key = `demo:${clean(deal._id || deal.id)}`;
        item = {
          key,
          name,
          industry: clean(deal.industry),
          website: '',
          source: 'Atlas sample data',
          primaryContactName: '',
          primaryContactEmail: '',
          aliases: [],
          dealIds: []
        };
        items.set(key, item);
      }
      item.dealIds.push(clean(deal._id || deal.id));
      dealKeys.set(clean(deal._id || deal.id), item.key);
    }
  } else {
    clients.forEach(row => add(row, 'client'));
    accounts.forEach(row => add(row, 'account'));
    for (const deal of deals) {
      const key = ids.get(recordId(deal.clientId));
      if (!key || !items.has(key)) continue;
      const id = clean(deal._id || deal.id);
      items.get(key).dealIds.push(id);
      dealKeys.set(id, key);
    }
  }
  const captured = captureDeals(deals);
  const capturedById = new Map(captured.map(deal => [deal.id, deal]));
  const rows = [...items.values()].map(item => {
    const linked = item.dealIds.map(id => capturedById.get(id)).filter(Boolean),
      open = linked.filter(isOpen);
    return {
      ...item,
      dealCount: linked.length,
      openCount: open.length,
      pipeline: open.reduce((s, d) => s + d.amount, 0),
      weighted: open.reduce((s, d) => s + d.amount * d.probability, 0)
    };
  }).sort((a, b) => b.pipeline - a.pipeline || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  return {
    accounts: rows,
    resolve: key => items.has(key) ? key : aliases.get(key) || null,
    dealKeys,
    unlinkedDealCount: captured.filter(d => !dealKeys.has(d.id)).length
  };
}
export const canManagePlan = (role, userId, plan) => ['owner', 'admin', 'manager'].includes(role) || Boolean(plan?.ownerId && userId && ['member','analyst'].includes(role) && String(plan.ownerId) === String(userId));
export function validatePlanInput(body, members) {
  const objective = typeof body.objective === 'string' ? body.objective.trim() : '';
  if (!objective || objective.length > 2000) throw new Error('Provide an account objective of 1–2000 characters');
  if (!Array.isArray(body.stakeholders) || body.stakeholders.length > 30 || !Array.isArray(body.blockers) || body.blockers.length > 50) throw new Error('Use at most 30 stakeholders and 50 blockers');
  const byId = new Map(members.filter(m => m.role !== 'viewer').map(m => [String(m.id), m]));
  const owner = byId.get(String(body.ownerId || ''));
  if (!owner) throw new Error('Choose an active workspace member as the plan owner');
  if (body.reviewAt !== null && body.reviewAt !== undefined && typeof body.reviewAt !== 'string') throw new Error('Choose a valid review date');
  const reviewAt = body.reviewAt ? new Date(body.reviewAt) : null;
  if (reviewAt && !Number.isFinite(reviewAt.getTime())) throw new Error('Choose a valid review date');
  const stakeholders = body.stakeholders.map(s => {
    if (!s || typeof s !== 'object' || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 150 || typeof s.title !== 'string' || s.title.length > 150 || typeof s.notes !== 'string' || s.notes.length > 1000 || !['economic_buyer', 'champion', 'technical', 'legal', 'procurement', 'other'].includes(s.role) || !['unknown', 'not_contacted', 'engaged', 'aligned'].includes(s.engagement)) throw new Error('Check stakeholder names, roles, and field lengths');
    return {
      name: s.name.trim(),
      title: s.title.trim(),
      role: s.role,
      engagement: s.engagement,
      notes: s.notes.trim()
    };
  });
  const blockers = body.blockers.map(b => {
    if (!b || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 1000 || !['open', 'resolved'].includes(b.status)) throw new Error('Check blocker descriptions and statuses');
    const member = b.ownerId ? byId.get(String(b.ownerId)) : null;
    if (b.ownerId && !member) throw new Error('A blocker owner must be an active workspace member');
    return {
      text: b.text.trim(),
      ownerId: member?.id || null,
      ownerName: member?.name || '',
      status: b.status
    };
  });
  return {
    objective,
    ownerId: owner.id,
    ownerName: owner.name,
    reviewAt,
    stakeholders,
    blockers
  };
}
