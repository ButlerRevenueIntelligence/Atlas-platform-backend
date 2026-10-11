export const DEMO_DEALS = [
  {
    name: "Northstar Enterprise Expansion",
    accountName: "Northstar Technology Group",
    amount: 480000,
    stage: "Negotiation",
    probability: 72,
    daysToClose: 18,
    daysSinceActivity: 9,
    owner: "Maya Thompson",
    nextStep: "Confirm the legal review deadline and schedule an executive sponsor call.",
    risk: "Legal review is still open and buyer activity has slowed.",
  },
  {
    name: "Elevate Financial Platform Rollout",
    accountName: "Elevate Financial Partners",
    amount: 365000,
    stage: "Proposal",
    probability: 65,
    daysToClose: 24,
    daysSinceActivity: 4,
    owner: "Jordan Lee",
    nextStep: "Bring the economic buyer into the next meeting and confirm the decision process.",
    risk: "The economic buyer has not yet joined the evaluation.",
  },
  {
    name: "Atlas Manufacturing Modernization",
    accountName: "Atlas Manufacturing",
    amount: 310000,
    stage: "Negotiation",
    probability: 58,
    daysToClose: 14,
    daysSinceActivity: 6,
    owner: "Chris Morgan",
    nextStep: "Deliver the competitive response and lock a final decision meeting within 48 hours.",
    risk: "A competitor entered the deal late and the close date is approaching.",
  },
  {
    name: "Summit Revenue Operations Program",
    accountName: "Summit B2B Solutions",
    amount: 225000,
    stage: "Discovery",
    probability: 35,
    daysToClose: 46,
    daysSinceActivity: 3,
    owner: "Taylor Brooks",
    nextStep: "Complete discovery and validate the financial impact with the buying committee.",
    risk: "The opportunity is early stage and business impact has not been validated.",
  },
  {
    name: "Vertex Growth Intelligence Expansion",
    accountName: "Vertex Growth Agency",
    amount: 190000,
    stage: "Proposal",
    probability: 52,
    daysToClose: 32,
    daysSinceActivity: 12,
    owner: "Alex Carter",
    nextStep: "Re-engage the champion and confirm whether the proposal remains in the current buying window.",
    risk: "No meaningful activity has been recorded for 12 days.",
  },
];

export const isDemoWorkspace = (org) => String(org?.slug || "").toLowerCase() === "atlas-demo-company" || String(org?.name || "").toLowerCase() === "atlas demo company";

export function buildDemoWorkspaceDeals(org, now = new Date()) {
  const day = (offset) => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString();
  };
  const industries = ["Technology", "Financial Services", "Manufacturing", "Professional Services", "Marketing Services"];
  const dueOffsets = [-2, 0, 1, 3, -1];
  const active = DEMO_DEALS.map((deal, index) => ({
    ...deal, id: `demo-deal-${index + 1}`, _id: `demo-deal-${index + 1}`, orgId: org?._id,
    source: "demo", externalSource: "demo", clientName: deal.accountName,
    ownerName: deal.owner, probability: deal.probability / 100,
    nextAction: deal.nextStep, nextActionDueAt: day(dueOffsets[index]),
    closeDate: day(deal.daysToClose), lastActivityAt: day(-deal.daysSinceActivity),
    createdAt: day(-60), industry: industries[index],
    demoEngagement: [68, 82, 74, 61, 42][index], demoExpansion: [84, 76, 65, 48, 58][index],
  }));
  // A separate aged opportunity keeps reactivation meaningful without altering the Operator's five-deal ranking.
  active.push({ id: "demo-deal-6", _id: "demo-deal-6", orgId: org?._id, source: "demo", externalSource: "demo",
    name: "Harborview Customer Intelligence Pilot", clientName: "Harborview Care Partners", accountName: "Harborview Care Partners",
    ownerName: "Sam Rivera", owner: "Sam Rivera", amount: 95000, stage: "Discovery", probability: .25,
    nextAction: "Confirm whether the evaluation is still active and rebuild the buyer action plan.", nextStep: "Confirm whether the evaluation is still active and rebuild the buyer action plan.",
    risk: "No buyer activity has been recorded for 45 days.", nextActionDueAt: day(2), closeDate: day(60),
    lastActivityAt: day(-45), createdAt: day(-90), industry: "Healthcare", demoEngagement: 28, demoExpansion: 35,
  });
  const closed = [
    { name: "Northstar Analytics Launch", accountName: "Northstar Technology Group", amount: 64000, stage: "Closed Won", ownerName: "Maya Thompson", closedReason: "Business case approved" },
    { name: "Elevate Reporting Foundation", accountName: "Elevate Financial Partners", amount: 97000, stage: "Closed Won", ownerName: "Jordan Lee", closedReason: "Executive sponsor aligned" },
    { name: "Summit Initial Assessment", accountName: "Summit B2B Solutions", amount: 42000, stage: "Closed Lost", ownerName: "Taylor Brooks", closedReason: "Project timing deferred" },
  ].map((deal, index) => ({...deal, id: `demo-closed-${index}`, _id: `demo-closed-${index}`, orgId: org?._id,
    source: "demo", externalSource: "demo", clientName: deal.accountName, probability: deal.stage === "Closed Won" ? 1 : 0,
    closeDate: day(-10 - index * 4), closedAt: day(-10 - index * 4), createdAt: day(-50 - index * 4), lastActivityAt: day(-10 - index * 4),
  }));
  return [...active, ...closed];
}
