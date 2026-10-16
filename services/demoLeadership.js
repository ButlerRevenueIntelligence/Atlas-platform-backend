// Read-only scenarios for the strict Atlas demo workspace. Never persisted by a read.
import { buildAccountCatalog } from './accountActionPlans.js';
const DAY = 86400000;
export function buildDemoExecution(deals, now = new Date()) {
  now = new Date(now.toISOString().slice(0, 10));
  const at = days => new Date(now.getTime() + days * DAY).toISOString();
  const catalog = buildAccountCatalog({
    demo: true,
    deals: deals.map(d => ({
      ...d,
      accountName: d.account || d.clientName || d.accountName
    }))
  });
  const open = deals.filter(d => !['closed won', 'closed lost'].includes(d.stage.toLowerCase()));
  const actions = open.map((d, n) => ({
    _id: `demo-action-${d.id}`,
    isDemoRecord: true,
    __v: null,
    dealId: d.id,
    dealName: d.name,
    title: d.nextAction || 'Confirm the buying process and agree the next decision date.',
    assigneeId: null,
    ownerName: d.owner || 'Revenue leadership',
    status: n === 1 ? 'blocked' : 'in_progress',
    dueAt: at(n === 1 ? -1 : 2),
    outcome: n === 1 ? 'Champion confirmed the evaluation is active. Economic buyer attendance is still unconfirmed.' : n === 0 ? 'Legal redlines received. Sponsor call requested for the next business day.' : 'Account owner is coordinating the next buyer meeting.',
    createdAt: at(-6),
    evidence: {
      ...d,
      capturedAt: at(-6)
    },
    history: [{
      status: 'open',
      at: at(-6),
      outcome: 'Agreed in the weekly revenue review.'
    }, {
      status: n === 1 ? 'blocked' : 'in_progress',
      at: at(-1),
      outcome: n === 1 ? 'Waiting for economic buyer confirmation.' : 'Next step is in motion.'
    }]
  }));
  if (open[0]) actions.push({
    _id: 'demo-action-sponsor',
    isDemoRecord: true,
    __v: null,
    dealId: open[0].id,
    dealName: open[0].name,
    title: 'Confirm executive sponsor alignment on the expansion business case.',
    assigneeId: null,
    ownerName: open[0].owner,
    status: 'completed',
    dueAt: at(-2),
    completedAt: at(-3),
    createdAt: at(-7),
    outcome: 'Executive sponsor approved the business case and requested a dated legal completion plan.',
    evidence: {
      ...open[0],
      stage: 'Proposal',
      probability: .60,
      capturedAt: at(-7)
    },
    history: [{
      status: 'open',
      at: at(-7),
      outcome: 'Sponsor confirmation requested.'
    }, {
      status: 'completed',
      at: at(-3),
      outcome: 'Business case approved; legal remains open.'
    }]
  });
  const decisions = open.slice(0, 3).map((d, n) => ({
    _id: `demo-decision-${d.id}`,
    isDemoRecord: true,
    __v: null,
    sourceMode: 'demo',
    dealId: d.id,
    dealName: d.name,
    ownerId: null,
    ownerName: d.owner,
    authorName: 'Revenue leadership',
    createdAt: at(-7),
    reviewAt: at(n === 1 ? -1 : 2),
    text: n === 0 ? 'Prioritize legal completion and executive sponsorship before increasing the Northstar forecast.' : n === 1 ? 'Keep Elevate in proposal until the economic buyer validates the decision process.' : 'Respond to the competing proposal before the final manufacturing decision meeting.',
    reasoning: n === 0 ? 'Northstar represents the largest near-term opportunity, but legal review and buyer activity need attention.' : n === 1 ? 'A champion is engaged, but budget authority has not joined the evaluation.' : 'A late competitor introduces decision risk while the close date is approaching.',
    expectedResult: n === 0 ? 'A confirmed legal deadline and final buyer decision meeting.' : n === 1 ? 'Economic buyer attendance and an agreed approval path.' : 'A documented competitive response and a confirmed decision date.',
    actionIds: actions.filter(a => a.dealId === d.id).map(a => a._id),
    sourceAccountKey: catalog.dealKeys.get(d.id),
    evidence: {
      ...d,
      ...(n === 0 ? {
        stage: 'Proposal',
        probability: .60
      } : n === 2 ? {
        probability: .68
      } : {}),
      capturedAt: at(-7)
    },
    reviewCount: n === 1 ? 0 : 1,
    latestReviewAt: n === 1 ? null : at(-1),
    reviews: n === 1 ? [] : [{
      assessment: n === 0 ? 'improved' : 'worsened',
      note: n === 0 ? 'Sponsor alignment is complete and the opportunity moved into negotiation. Legal completion is still required.' : 'A competing supplier entered the evaluation. The team must address differentiation before the decision meeting.',
      authorName: 'Revenue leadership',
      at: at(-1),
      evidence: {
        ...d,
        capturedAt: at(-1)
      }
    }]
  }));
  const plans = catalog.accounts.map((a, n) => {
    const d = deals.find(d => d.id === a.dealIds[0]),
      decision = decisions.find(v => v.dealId === d?.id),
      owner = d?.owner || 'Revenue leadership';
    return {
      accountKey: a.key,
      isDemoRecord: true,
      __v: null,
      ownerId: null,
      ownerName: owner,
      objective: n === 0 ? 'Secure Northstar’s enterprise expansion by aligning the sponsor, legal review and final approval date.' : `Advance ${a.name} with a clear buying process, an agreed business case and accountable next steps.`,
      reviewAt: at(3),
      createdAt: at(-14),
      updatedAt: at(-1),
      stakeholders: [{
        name: ['Dana Mitchell', 'Morgan Ellis', 'Cameron Price', 'Riley Bennett', 'Avery Reed', 'Jamie Foster'][n % 6],
        title: 'Chief Financial Officer',
        role: 'economic_buyer',
        engagement: d?.id === 'demo-deal-2' ? 'not_contacted' : 'engaged',
        notes: 'Validate budget authority and the approval sequence.'
      }, {
        name: ['Casey Chen', 'Drew Parker', 'Quinn Hayes', 'Jordan Wells', 'Blake Santos', 'Skyler Moore'][n % 6],
        title: 'Operations Director',
        role: 'champion',
        engagement: 'aligned',
        notes: 'Owns the internal business case and coordinates the evaluation.'
      }, {
        name: 'Alexis Grant',
        title: 'Legal Counsel',
        role: 'legal',
        engagement: n === 0 ? 'engaged' : 'unknown',
        notes: 'Confirm contracting requirements before the final decision.'
      }],
      blockers: [{
        text: d?.id === 'demo-deal-1' ? 'Legal redlines require an agreed completion deadline.' : d?.id === 'demo-deal-2' ? 'Economic buyer has not joined the evaluation.' : d?.id === 'demo-deal-3' ? 'Competitive response must be reviewed by the buying committee.' : 'Confirm the buying committee and financial success criteria.',
        ownerId: null,
        ownerName: owner,
        status: 'open'
      }, {
        text: 'Initial business requirements documented with the champion.',
        ownerId: null,
        ownerName: owner,
        status: 'resolved'
      }],
      history: [{
        kind: 'plan_updated',
        text: 'Account objective, buying roles and blocker ownership agreed.',
        authorName: owner,
        at: at(-10)
      }, {
        kind: 'decision',
        text: decision?.text || 'Validate the buying process and business impact before moving the opportunity forward.',
        authorName: 'Revenue leadership',
        at: at(-7)
      }, {
        kind: 'note',
        text: actions.find(v => v.dealId === d?.id)?.outcome || 'Review the next buyer commitment at the weekly account meeting.',
        authorName: owner,
        at: at(-1)
      }]
    };
  });
  const externalContext = catalog.accounts.slice(0, 4).map(a => ({
    snapshotId: `demo-context-${a.key}`,
    name: a.name,
    source: 'Account research',
    asOf: at(-1),
    description: a.name.startsWith('Northstar') ? 'Technology services business evaluating enterprise expansion across multiple operating teams. The current buying plan depends on executive sponsorship and legal approval.' : a.name.startsWith('Elevate') ? 'Financial services organization reviewing a platform rollout. Budget authority, evaluation criteria and the approval sequence are the key questions for the next meeting.' : a.name === 'Atlas Manufacturing' ? 'Manufacturing organization assessing modernization options. A competing supplier has joined the evaluation; the team needs to validate differentiation with the buying committee.' : 'B2B services business evaluating a revenue operations program. Discovery should establish financial impact, stakeholder ownership and the buying timeline.',
    website: '',
    accountKey: a.key,
    deals: deals.filter(d => a.dealIds.includes(d.id) && !['closed won', 'closed lost'].includes(d.stage.toLowerCase())).map(d => ({
      id: d.id,
      name: d.name,
      amount: d.amount
    }))
  }));
  return {
    actions,
    decisions,
    plans,
    externalContext
  };
}
export function withDemoRecords(saved, examples, key) {
  const present = new Set(saved.map(row => String(row[key])));
  return [...saved, ...examples.filter(row => !present.has(String(row[key])))];
}
