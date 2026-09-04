// backend/routes/ai.js
import express from "express";
import OpenAI from "openai";
import { requireAuth } from "../middleware/auth.js";
import Organization from "../models/Organization.js";
import Membership from "../models/Membership.js";
import Deal from "../models/Deal.js";

const router = express.Router();

const openai =
  process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

const safeNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const money = (value) =>
  safeNum(value).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

const DEMO_DEALS = [
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

function normalizeStage(value) {
  const stage = String(value || "Unknown").trim();
  const lower = stage.toLowerCase();
  if (lower.includes("neg")) return "Negotiation";
  if (lower.includes("prop")) return "Proposal";
  if (lower.includes("disc")) return "Discovery";
  if (lower.includes("qual")) return "Qualification";
  if (lower.includes("won")) return "Closed Won";
  if (lower.includes("lost")) return "Closed Lost";
  return stage;
}

function daysBetween(from, to) {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.ceil((end.getTime() - start.getTime()) / 86400000);
}

function isDealPriorityQuestion(question) {
  const q = String(question || "").toLowerCase();
  const dealTerms = ["deal", "deals", "opportunity", "opportunities", "pipeline"];
  const priorityTerms = [
    "focus",
    "prioritize",
    "priority",
    "work on",
    "attention",
    "close",
    "at risk",
    "save",
    "next",
  ];
  return dealTerms.some((term) => q.includes(term)) &&
    priorityTerms.some((term) => q.includes(term));
}

function normalizeDeal(deal = {}) {
  const amount = safeNum(deal.amount ?? deal.value ?? deal.pipelineValue);
  const probability = Math.max(
    0,
    Math.min(100, safeNum(deal.probability ?? deal.winProbability ?? deal.confidence))
  );
  const closeDate = deal.closeDate || deal.expectedCloseDate || deal.targetCloseDate || null;
  const lastActivityAt =
    deal.lastActivityAt || deal.lastActivityDate || deal.lastContactedAt || deal.updatedAt || null;
  const daysToClose =
    deal.daysToClose ?? (closeDate ? daysBetween(new Date(), closeDate) : null);
  const daysSinceActivity =
    deal.daysSinceActivity ??
    (lastActivityAt ? Math.max(0, daysBetween(lastActivityAt, new Date())) : null);

  return {
    id: String(deal._id || deal.id || ""),
    name: String(deal.name || deal.title || deal.dealName || "Untitled deal"),
    accountName: String(
      deal.accountName || deal.companyName || deal.account?.name || deal.client?.name || "Account not recorded"
    ),
    amount,
    stage: normalizeStage(deal.stage || deal.status),
    probability,
    closeDate,
    daysToClose,
    daysSinceActivity,
    owner: String(
      deal.ownerName || deal.owner?.name || deal.assignedTo?.name || deal.salesRep || "Owner not recorded"
    ),
    nextStep: String(deal.nextStep || deal.recommendedAction || "Confirm the next buyer action and its due date."),
    risk: String(deal.risk || deal.riskReason || deal.blocker || deal.notes || "No explicit blocker is recorded."),
  };
}

function scoreDeal(deal) {
  const stageWeight = {
    Negotiation: 30,
    Proposal: 24,
    Qualification: 14,
    Discovery: 10,
  }[deal.stage] || 6;
  const valueScore = Math.min(30, deal.amount / 20000);
  const probabilityScore = deal.probability * 0.2;
  const closeScore =
    deal.daysToClose == null
      ? 3
      : deal.daysToClose < 0
      ? 18
      : deal.daysToClose <= 30
      ? 16
      : deal.daysToClose <= 60
      ? 9
      : 3;
  const inactivityScore =
    deal.daysSinceActivity == null
      ? 4
      : deal.daysSinceActivity >= 14
      ? 14
      : deal.daysSinceActivity >= 7
      ? 10
      : 4;

  return Math.round((stageWeight + valueScore + probabilityScore + closeScore + inactivityScore) * 10) / 10;
}

function explainPriority(deal) {
  const reasons = [];
  if (deal.amount > 0) reasons.push(`${money(deal.amount)} in potential revenue`);
  if (["Negotiation", "Proposal"].includes(deal.stage)) reasons.push(`${deal.stage.toLowerCase()}-stage momentum`);
  if (deal.daysToClose != null && deal.daysToClose >= 0 && deal.daysToClose <= 30) {
    reasons.push(`a close date inside ${deal.daysToClose} days`);
  }
  if (deal.daysToClose != null && deal.daysToClose < 0) reasons.push("an overdue close date");
  if (deal.daysSinceActivity != null && deal.daysSinceActivity >= 7) {
    reasons.push(`${deal.daysSinceActivity} days without recorded activity`);
  }
  return reasons.length ? reasons.join(", ") : "its combination of value, stage, and execution risk";
}

function buildDealPriorityAnswer({ deals, orgName, isDemo }) {
  const ranked = deals
    .map(normalizeDeal)
    .filter((deal) => !["Closed Won", "Closed Lost"].includes(deal.stage))
    .map((deal) => ({ ...deal, priorityScore: scoreDeal(deal) }))
    .sort((a, b) => b.priorityScore - a.priorityScore || b.amount - a.amount)
    .slice(0, 3);

  if (!ranked.length) {
    return `I cannot rank deals for ${orgName} yet because no open deal records are available. Connect or add deal-level data including amount, stage, probability, close date, owner, last activity, and next step.`;
  }

  const totalValue = ranked.reduce((sum, deal) => sum + deal.amount, 0);
  const weightedValue = ranked.reduce(
    (sum, deal) => sum + deal.amount * (deal.probability / 100),
    0
  );

  const detail = ranked
    .map(
      (deal, index) => `${index + 1}. ${deal.name} — ${money(deal.amount)} | ${deal.stage} | ${deal.probability}% probability
Account: ${deal.accountName}
Owner: ${deal.owner}
Why it matters: ${explainPriority(deal)}.
Risk: ${deal.risk}
Next action: ${deal.nextStep}`
    )
    .join("\n\n");

  return `${isDemo ? "Demo analysis — " : ""}Focus leadership attention on these three deals first:

${detail}

Leadership takeaway: These deals represent ${money(totalValue)} in total pipeline and approximately ${money(weightedValue)} in probability-weighted value. Review their next steps, owners, and decision dates in the next pipeline meeting.${
    isDemo
      ? " This recommendation was generated from the Atlas sample revenue dataset and demonstrates how the same ranking will use connected workspace data."
      : ""
  }`;
}

function buildInsights(kpis = {}) {
  const revenue30 = safeNum(kpis.revenue30 ?? 0);
  const spend30 = safeNum(kpis.spend30 ?? 0);
  const coverage = safeNum(kpis.coverage ?? 0);
  const cac = safeNum(kpis.cac ?? 0);

  const items = [];

  const roi = spend30 > 0 ? (revenue30 - spend30) / spend30 : null;

  if (roi == null) {
    items.push({
      type: "OPPORTUNITY",
      impact: "HIGH IMPACT",
      confidence: 78,
      title: "Connect data sources to unlock attribution",
      body: "Once ads + CRM are connected, the platform will show true revenue attribution and predictable pipeline forecasting.",
    });
  } else if (roi >= 1) {
    items.push({
      type: "OPPORTUNITY",
      impact: "HIGH IMPACT",
      confidence: 92,
      title: "Marketing efficiency is strong",
      body: "ROI is trending positive. Increase budget carefully in the best-performing channels to compound growth.",
    });
  } else if (roi < 0) {
    items.push({
      type: "WARNING",
      impact: "MEDIUM IMPACT",
      confidence: 84,
      title: "Paid efficiency drift detected",
      body: "Spend is outpacing revenue. Tighten targeting, remove weak ad sets, and improve conversion rate on the highest-traffic pages.",
    });
  } else {
    items.push({
      type: "OPPORTUNITY",
      impact: "MEDIUM IMPACT",
      confidence: 80,
      title: "Performance is stable",
      body: "Run controlled experiments (landing page + offer tests) to lift conversion rate while maintaining CAC.",
    });
  }

  if (coverage >= 4) {
    items.push({
      type: "SUCCESS",
      impact: "HIGH IMPACT",
      confidence: 90,
      title: "Pipeline coverage is healthy",
      body: "Prioritize closing motions and remove deal friction to accelerate wins.",
    });
  } else if (coverage >= 2) {
    items.push({
      type: "OPPORTUNITY",
      impact: "MEDIUM IMPACT",
      confidence: 82,
      title: "Pipeline is workable, but needs lift",
      body: "Increase top-of-funnel volume and tighten qualification to raise coverage toward 4x.",
    });
  } else {
    items.push({
      type: "WARNING",
      impact: "HIGH IMPACT",
      confidence: 88,
      title: "Pipeline coverage is low",
      body: "Launch aggressive lead-gen and reactivation to build pipeline before forecasting becomes unstable.",
    });
  }

  if (cac > 500) {
    items.push({
      type: "WARNING",
      impact: "MEDIUM IMPACT",
      confidence: 81,
      title: "CAC is elevated",
      body: "Tighten ICP targeting, add retargeting, and improve landing page conversion rate.",
    });
  } else {
    items.push({
      type: "SUCCESS",
      impact: "MEDIUM IMPACT",
      confidence: 86,
      title: "CAC is under control",
      body: "Maintain efficiency while scaling budget in channels that drive the highest close-rate leads.",
    });
  }

  return items.slice(0, 3);
}

function getOrgId(req) {
  return (
    req.headers["x-org-id"] ||
    req.headers["x-workspace-id"] ||
    req.body?.orgId ||
    null
  );
}

async function requireMembership(userId, orgId) {
  if (!userId || !orgId) return null;

  return Membership.findOne({
    userId,
    orgId,
    status: { $nin: ["disabled", "suspended"] },
  }).lean();
}

/* -------------------------------- */
/* Local fallback insights          */
/* -------------------------------- */
router.post("/insights", (req, res) => {
  const body = req.body || {};
  const kpis = body.kpis || {};
  const orgName = body.orgName || "Your org";

  return res.json({
    ok: true,
    orgName,
    insights: buildInsights(kpis),
    source: "local",
  });
});

/* -------------------------------- */
/* OpenAI analysis                  */
/* -------------------------------- */
router.post("/analyze", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const orgId = getOrgId(req);

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized",
      });
    }

    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context.",
      });
    }

    const membership = await requireMembership(userId, orgId);
    if (!membership) {
      return res.status(403).json({
        ok: false,
        message: "You do not have access to this workspace.",
      });
    }

    const org = await Organization.findById(orgId);
    if (!org) {
      return res.status(404).json({
        ok: false,
        message: "Organization not found.",
      });
    }

    const question = String(req.body?.question || "").trim();
    const metrics = req.body?.metrics || {};
    const context = req.body?.context || {};

    if (isDealPriorityQuestion(question)) {
      const workspaceMode = String(context?.workspaceMode || "live").toLowerCase();
      const isDemo = workspaceMode === "demo";

      let deals = [];

      try {
        deals = await Deal.find({
          orgId,
          status: { $nin: ["archived", "closed_lost", "lost"] },
        })
          .sort({ amount: -1, updatedAt: -1 })
          .limit(50)
          .lean();
      } catch (dealError) {
        console.error("DEAL PRIORITY LOOKUP ERROR:", dealError);
      }

      if (isDemo && deals.length < 3) {
        deals = DEMO_DEALS;
      }

      const result = buildDealPriorityAnswer({
        deals,
        orgName: org.name || context?.orgName || "this workspace",
        isDemo,
      });

      org.usage = org.usage || {};
      org.usage.aiAnalyses = safeNum(org.usage.aiAnalyses) + 1;
      await org.save();

      return res.json({
        ok: true,
        result,
        usage: org.usage,
        source: "atlas-deal-priority-engine",
        intelligence: {
          internal: true,
          external: false,
          dealRanking: true,
          dealsEvaluated: deals.length,
          workspaceMode,
        },
      });
    }

    const externalCompanyIntelligence =
      context?.externalCompanyIntelligence || null;

    const hasExternalCompanyIntelligence =
      Array.isArray(externalCompanyIntelligence?.organizations) &&
      externalCompanyIntelligence.organizations.length > 0;

    if (!openai) {
      return res.json({
        ok: true,
        result:
          "OpenAI is not connected yet. Add OPENAI_API_KEY in backend environment variables to enable Atlas AI analysis.",
        source: "fallback",
      });
    }

    const prompt = `
You are Atlas Revenue AI, a decision-intelligence system for agencies, B2B companies, and executive teams.

Atlas can work with two types of intelligence:

1. INTERNAL REVENUE INTELLIGENCE
This includes the organization's revenue, pipeline, forecast, deals, account activity, alerts, recommendations, and other workspace data supplied in Metrics and Context.

2. EXTERNAL COMPANY INTELLIGENCE
When available, this comes from GraphIQ and may include company names, websites, descriptions, industries, capabilities, locations, and total matching organizations.

Your job:
- analyze the provided business data
- identify revenue risks
- identify growth opportunities
- recommend next best actions
- use GraphIQ company intelligence when it is supplied and relevant to the user's question
- connect internal revenue intelligence with external company intelligence when both are relevant
- clearly distinguish information coming from the user's Atlas workspace from external GraphIQ company intelligence
- never invent company facts, market signals, buying intent, funding events, hiring signals, technologies, or other external information that is not explicitly present in the supplied data
- if external company intelligence is not supplied, do not claim that GraphIQ was searched
- write clearly for an executive audience

When GraphIQ results are available:
- answer the user's question directly first
- highlight the most relevant organizations returned
- explain why each appears relevant using only the supplied GraphIQ fields
- use company websites when available
- mention the total number of GraphIQ matches when useful
- do not treat a GraphIQ match as proof of buying intent or sales readiness
- do not claim a company is a qualified prospect unless the supplied data supports that conclusion
- where helpful, suggest the next Atlas action leadership should take

Return the response in a format that best fits the question.

For internal strategic analysis, prefer:

Executive Summary:
- short summary

Top Risks:
- bullets

Top Opportunities:
- bullets

Recommended Actions:
- numbered list

For external company discovery questions, prefer:

External Company Intelligence:
- concise explanation of what Atlas found

Relevant Companies:
- company name
- website if available
- why it matches the search using supplied GraphIQ data

Leadership Takeaway:
- what the user should do next

Question:
${question || "Analyze this business and provide strategic revenue guidance."}

Metrics:
${JSON.stringify(metrics, null, 2)}

Context:
${JSON.stringify(context, null, 2)}

External Company Intelligence Available:
${hasExternalCompanyIntelligence ? "YES" : "NO"}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content:
            "You are Atlas Revenue AI. Act as an executive decision-intelligence operator. Use internal Atlas revenue data and, when supplied, external GraphIQ company intelligence. Never invent unsupported facts. Clearly distinguish internal business intelligence from external company intelligence.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const result =
      completion?.choices?.[0]?.message?.content ||
      "No analysis returned.";

    org.usage = org.usage || {};
    org.usage.aiAnalyses = safeNum(org.usage.aiAnalyses) + 1;
    await org.save();

    return res.json({
      ok: true,
      result,
      usage: org.usage,
      source: "openai",
      intelligence: {
        internal: true,
        external: hasExternalCompanyIntelligence,
        externalSource: hasExternalCompanyIntelligence ? "GraphIQ" : null,
        externalCompaniesUsed: hasExternalCompanyIntelligence
          ? externalCompanyIntelligence.organizations.length
          : 0,
      },
    });
  } catch (err) {
    console.error("AI ANALYZE ERROR:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "AI analysis failed.",
    });
  }
});

export default router;
