import { compareDeals } from './leadershipBriefing.js';
export const assessments = ['improved', 'unchanged', 'worsened', 'insufficient_evidence'];
const id = value => String(value?._id || value || '');
const date = value => value ? new Date(value).toISOString() : null;
const late = (value, now) => value && new Date(value) < now;
export const canReadAccountPlans = req => (req.user?.permissions || []).some(p => p === '*' || p === 'clients.view');
export function validateDecision(body) {
  const out = {};
  for (const [key, limit] of [['text', 4000], ['reasoning', 2000], ['expectedResult', 1000]]) {
    if (typeof body[key] !== 'string' || !body[key].trim() || body[key].trim().length > limit) throw new Error(`Provide ${key === 'text' ? 'a decision' : key === 'reasoning' ? 'supporting reasoning' : 'an expected result'} of 1–${limit} characters`);
    out[key] = body[key].trim();
  }
  if (typeof body.reviewAt !== 'string' || !Number.isFinite(new Date(body.reviewAt).getTime())) throw new Error('Provide a valid review date');
  out.reviewAt = new Date(body.reviewAt);
  if (!Array.isArray(body.actionIds) || body.actionIds.length > 20 || body.actionIds.some(v => typeof v !== 'string' || !/^[a-f\d]{24}$/i.test(v)) || new Set(body.actionIds).size !== body.actionIds.length) throw new Error('Choose up to 20 distinct existing actions');
  out.actionIds = body.actionIds;
  return out;
}
export function decisionView(decision, deals, actions, mode) {
  const current = deals.find(d => d.id === decision.dealId) || null;
  const comparable = decision.sourceMode === mode;
  return {
    ...decision,
    currentDeal: comparable ? current : null,
    dealChanges: comparable && current ? compareDeals([decision.evidence], [current]) : [],
    comparisonAvailable: comparable && Boolean(current),
    linkedActions: (decision.actionIds || []).map(key => actions.find(a => id(a._id) === id(key))).filter(Boolean),
    missingActionCount: (decision.actionIds || []).filter(key => !actions.some(a => id(a._id) === id(key))).length
  };
}
// Checkpoints capture a bounded working view, never caller-supplied snapshots or raw provider data.
export function captureExecution(actions, decisions, plans, plansAvailable = false) {
  return {
    version: 1,
    limited: actions.length > 100 || decisions.length > 100 || plans.length > 100,
    plansAvailable,
    actions: actions.slice(0, 100).map(a => ({
      id: id(a._id),
      title: a.title,
      dealId: a.dealId,
      status: a.status,
      outcome: a.outcome || '',
      dueAt: date(a.dueAt),
      assigneeId: id(a.assigneeId),
      ownerName: a.ownerName,
      completedAt: date(a.completedAt),
      createdAt: date(a.createdAt),
      version: a.__v || 0
    })),
    decisions: decisions.slice(0, 100).map(d => ({
      id: id(d._id),
      text: d.text,
      ownerName: d.ownerName,
      createdAt: date(d.createdAt),
      reviewAt: date(d.reviewAt),
      reviewCount: d.reviewCount || 0,
      latestReviewAt: date(d.latestReviewAt)
    })),
    plans: plans.slice(0, 100).map(p => ({
      accountKey: p.accountKey,
      objective: p.objective,
      ownerId: id(p.ownerId),
      ownerName: p.ownerName,
      createdAt: date(p.createdAt),
      reviewAt: date(p.reviewAt),
      blockers: (p.blockers || []).map(b => ({
        text: b.text,
        status: b.status
      }))
    }))
  };
}
export function meetingChanges(checkpoint, current, now = new Date(), mode = 'live') {
  const previous = checkpoint?.execution;
  if (!previous || previous.version !== 1 || checkpoint.sourceMode !== mode) return {
    available: false,
    reason: 'Save a new meeting checkpoint to compare actions, decisions, and account plans in this workspace mode.'
  };
  const actions = new Map(previous.actions.map(a => [a.id, a]));
  const decisions = new Map(previous.decisions.map(d => [d.id, d]));
  const plans = new Map(previous.plans.map(p => [p.accountKey, p]));
  const actionChanges = current.actions.flatMap(a => {
    const before = actions.get(a.id);
    const events = [];
    if (!before) {
      events.push('added');
      if (a.status === 'completed' && a.completedAt && new Date(a.completedAt) > new Date(checkpoint.createdAt)) events.push('completed');
    } else {
      if (before.status !== a.status) events.push(a.status === 'completed' ? 'completed' : before.status === 'blocked' ? 'unblocked' : 'status_changed');
      if (before.outcome !== a.outcome) events.push('outcome_updated');
      if (before.dueAt !== a.dueAt) events.push('deadline_changed');
    }
    const overdue = a.status !== 'completed' && late(a.dueAt, now);
    if (overdue) events.push('overdue');
    return events.length ? [{
      ...a,
      before: before || null,
      events,
      alreadyOverdueAtMeeting: Boolean(before && before.status !== 'completed' && late(before.dueAt, new Date(checkpoint.createdAt)))
    }] : [];
  });
  const decisionChanges = current.decisions.flatMap(d => {
    const before = decisions.get(d.id),
      events = [];
    if (!before) {
      events.push('added');
      if (d.latestReviewAt && new Date(d.latestReviewAt) > new Date(checkpoint.createdAt)) events.push('reviewed');
    } else if (d.reviewCount > before.reviewCount) events.push('reviewed');
    const reviewDue = late(d.reviewAt, now) && (!d.latestReviewAt || new Date(d.latestReviewAt) < new Date(d.reviewAt));
    if (reviewDue) events.push('review_due');
    return events.length ? [{
      ...d,
      events
    }] : [];
  });
  const planChanges = current.plansAvailable && previous.plansAvailable ? current.plans.flatMap(p => {
    const before = plans.get(p.accountKey),
      events = [];
    if (!before) events.push('added');else {
      if (p.objective !== before.objective) events.push('objective_changed');
      if (p.ownerId !== before.ownerId) events.push('owner_changed');
      if (p.reviewAt !== before.reviewAt) events.push('review_date_changed');
    }
    // A deleted or renamed blocker is not a resolution. Duplicate wording is compared as counts.
    const count = (rows, status) => rows.filter(b => b.status === status).reduce((m, b) => m.set(b.text, (m.get(b.text) || 0) + 1), new Map());
    const oldOpen = count(before?.blockers || [], 'open'),
      oldResolved = count(before?.blockers || [], 'resolved'),
      newOpen = count(p.blockers, 'open'),
      newResolved = count(p.blockers, 'resolved');
    const resolved = [...oldOpen].flatMap(([text, n]) => {
      const number = Math.min(Math.max(0, n - (newOpen.get(text) || 0)), Math.max(0, (newResolved.get(text) || 0) - (oldResolved.get(text) || 0)));
      return number ? [{
        text,
        count: number
      }] : [];
    });
    const opened = before ? [...newOpen].flatMap(([text, n]) => n > (oldOpen.get(text) || 0) ? [{
      text,
      count: n - (oldOpen.get(text) || 0)
    }] : []) : [];
    if (resolved.length) events.push('blockers_resolved');
    if (opened.length) events.push('blockers_opened');
    return events.length ? [{
      ...p,
      events,
      resolved,
      opened
    }] : [];
  }) : [];
  const risks = (d, at) => {
    if (['closed won', 'closed lost'].includes(String(d.stage).toLowerCase())) return [];
    const result = [];
    if (late(d.closeDate, at)) result.push('Expected close date passed');
    if (d.lastActivityAt && (at - new Date(d.lastActivityAt)) / 86400000 >= 7) result.push('At least 7 days without recorded activity');
    if (late(d.nextActionDueAt, at)) result.push('CRM next action overdue');
    if (!d.nextAction) result.push('No CRM next action');
    if (!d.owner) result.push('No recorded CRM owner');
    return result;
  };
  const oldDeals = new Map((checkpoint.deals || []).map(d => [d.id, d]));
  const riskChanges = (current.deals || []).flatMap(d => {
    const before = oldDeals.get(d.id),
      previousRisks = before ? risks(before, new Date(checkpoint.createdAt)) : [];
    const added = risks(d, now).filter(r => !previousRisks.includes(r));
    return added.length ? [{
      dealId: d.id,
      name: d.name,
      reasons: added,
      newlyVisible: !before
    }] : [];
  });
  return {
    available: true,
    riskChanges,
    limited: previous.limited || current.limited,
    plansCompared: current.plansAvailable && previous.plansAvailable,
    actionChanges,
    decisionChanges,
    planChanges,
    counts: {
      overdue: actionChanges.filter(a => a.events.includes('overdue')).length,
      completed: actionChanges.filter(a => a.events.includes('completed')).length,
      reviewsDue: decisionChanges.filter(d => d.events.includes('review_due')).length,
      newRisks: riskChanges.length,
      resolvedBlockers: planChanges.reduce((sum, p) => sum + p.resolved.reduce((s, b) => s + b.count, 0), 0)
    }
  };
}
