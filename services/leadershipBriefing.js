const DAY = 86400000;
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const text = value => String(value || '').trim();
export const isOpen = deal => !['closed won', 'closed lost'].includes(text(deal.stage).toLowerCase());
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
export function captureDeals(deals) {
  return deals.filter(d => !d.archivedAt).map(d => ({
    id: String(d._id || d.id),
    name: text(d.name),
    account: text(d.clientName || d.accountName),
    amount: Math.max(0, number(d.amount)),
    probability: Math.max(0, Math.min(1, number(d.probability) > 1 ? number(d.probability) / 100 : number(d.probability))),
    stage: text(d.stage),
    closeDate: date(d.closeDate),
    lastActivityAt: date(d.lastActivityAt),
    nextAction: text(d.nextAction),
    nextActionDueAt: date(d.nextActionDueAt),
    owner: text(d.ownerName || d.owner),
    source: text(d.externalSource || d.source) || 'Atlas',
    clientId: d.clientId ? String(d.clientId) : null
  }));
}
export function compareDeals(before, current) {
  const old = new Map(before.map(d => [d.id, d]));
  const fields = ['amount', 'probability', 'stage', 'closeDate', 'lastActivityAt', 'nextAction', 'nextActionDueAt', 'owner'];
  const changes = current.flatMap(deal => {
    const previous = old.get(deal.id);
    if (!previous) return [{
      dealId: deal.id,
      name: deal.name,
      amount: deal.amount,
      kind: 'added',
      fields: []
    }];
    const changed = fields.filter(key => previous[key] !== deal[key]).map(key => ({
      field: key,
      before: previous[key],
      after: deal[key]
    }));
    return changed.length ? [{
      dealId: deal.id,
      name: deal.name,
      amount: deal.amount,
      kind: 'changed',
      fields: changed
    }] : [];
  });
  const ids = new Set(current.map(d => d.id));
  before.filter(d => !ids.has(d.id)).forEach(d => changes.push({
    dealId: d.id,
    name: d.name,
    amount: d.amount,
    kind: 'no_longer_visible',
    fields: []
  }));
  return changes.sort((a, b) => b.amount - a.amount);
}
export function summarize(deals, now = new Date(), horizon = 90) {
  const end = now.getTime() + horizon * DAY;
  const open = deals.filter(isOpen);
  // Overdue open opportunities remain visible in the expected-close window.
  const inWindow = open.filter(d => d.closeDate && new Date(d.closeDate).getTime() <= end);
  return {
    pipeline: open.reduce((s, d) => s + d.amount, 0),
    weighted: inWindow.reduce((s, d) => s + d.amount * d.probability, 0),
    scheduled: inWindow.reduce((s, d) => s + d.amount, 0),
    openCount: open.length,
    undatedCount: open.filter(d => !d.closeDate).length
  };
}
export function priorities(deals, now = new Date()) {
  return deals.filter(isOpen).map(d => {
    const daysToClose = d.closeDate ? Math.ceil((new Date(d.closeDate) - now) / DAY) : null;
    const idleDays = d.lastActivityAt ? Math.floor((now - new Date(d.lastActivityAt)) / DAY) : null;
    const reasons = [];
    if (daysToClose !== null && daysToClose < 0) reasons.push('Expected close date has passed');else if (daysToClose !== null && daysToClose <= 30) reasons.push('Expected close within 30 days');
    if (idleDays !== null && idleDays >= 7) reasons.push(`${idleDays} days since recorded activity`);
    if (idleDays === null) reasons.push('No activity date recorded');
    if (!d.nextAction) reasons.push('No next action recorded');
    if (d.nextActionDueAt && new Date(d.nextActionDueAt) < now) reasons.push('Next action is overdue');
    if (!d.owner) reasons.push('Owner not recorded');
    return {
      ...d,
      daysToClose,
      idleDays,
      reasons,
      suggestedAction: d.nextAction || 'Confirm the buying process, accountable owner, and next decision date.'
    };
  }).filter(d => d.reasons.length).sort((a, b) => Number(b.daysToClose !== null && b.daysToClose <= 30) - Number(a.daysToClose !== null && a.daysToClose <= 30) || b.amount - a.amount).slice(0, 6);
}
export function simulateSlip(deals, {
  dealId,
  delayDays = 30,
  target = 0,
  horizon = 90
}, now = new Date()) {
  if (![30, 60, 90].includes(horizon) || !Number.isFinite(target) || target < 0 || !Number.isInteger(delayDays) || delayDays < 1 || delayDays > 365) throw new Error('Invalid scenario inputs');
  const chosen = deals.find(d => d.id === dealId && isOpen(d));
  if (!chosen?.closeDate) throw new Error('Choose an open opportunity with a close date');
  const after = deals.map(d => d.id === dealId ? {
    ...d,
    closeDate: new Date(new Date(d.closeDate).getTime() + delayDays * DAY).toISOString()
  } : d);
  const baseline = summarize(deals, now, horizon);
  const scenario = summarize(after, now, horizon);
  const end = now.getTime() + horizon * DAY;
  const alternatives = after.filter(d => isOpen(d) && d.id !== dealId && d.closeDate && new Date(d.closeDate).getTime() > end).sort((a, b) => b.amount * b.probability - a.amount * a.probability).slice(0, 3);
  return {
    baseline,
    scenario,
    weightedImpact: baseline.weighted - scenario.weighted,
    target,
    gap: Math.max(0, target - scenario.weighted),
    baselineGap: Math.max(0, target - baseline.weighted),
    revisedCloseDate: after.find(d => d.id === dealId).closeDate,
    alternatives
  };
}
const normalized = value => text(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function matchExternalContext(snapshots, deals, now = new Date()) {
  const matches = [];
  for (const snapshot of snapshots) {
    if (!snapshot || !date(snapshot.expiresAt) || new Date(snapshot.expiresAt) <= now) continue;
    const raw = snapshot.data;
    const rows = Array.isArray(raw) ? raw : raw?.entities || raw?.organizations || raw?.results || raw?.items || raw?.data || [];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const name = text(row.name || row.organization_name || row.company_name);
      if (!normalized(name)) continue;
      const related = deals.filter(d => isOpen(d) && normalized(d.account) === normalized(name));
      if (!related.length || matches.some(m => normalized(m.name) === normalized(name))) continue;
      matches.push({
        name,
        description: text(row.description).slice(0, 1500),
        website: text(row.website || row.website_url),
        asOf: snapshot.createdAt,
        source: 'GraphIQ',
        snapshotId: String(snapshot._id),
        deals: related.map(d => ({
          id: d.id,
          name: d.name,
          amount: d.amount
        }))
      });
    }
  }
  return matches.slice(0, 10);
}

// A labeled rehearsal only. Never presented as observed workspace history.
export function demoComparison(deals, now = new Date()) {
  const previous = structuredClone(deals);
  const northstar = previous.find(d => d.id === 'demo-deal-1');
  if (northstar) {
    northstar.stage = 'Proposal';
    northstar.probability = .60;
    northstar.closeDate = new Date(new Date(northstar.closeDate).getTime() - 7 * DAY).toISOString();
  }
  const elevate = previous.find(d => d.id === 'demo-deal-2');
  if (elevate) {
    elevate.amount = 325000;
    elevate.lastActivityAt = new Date(new Date(elevate.lastActivityAt).getTime() - 7 * DAY).toISOString();
  }
  return {
    label: 'Weekly revenue review',
    isIllustrative: true,
    createdAt: new Date(now.getTime() - 7 * DAY),
    deals: previous
  };
}
