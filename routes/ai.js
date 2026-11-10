import {buildAskAtlasEvidence,specificWorkspaceAnswer,answerEvidenceMetadata,askAtlasMessages,wantsExternalEvidence} from '../services/askAtlasEvidence.js';
import {loadNewsContext} from '../services/graphiqResearch.js';
// backend/routes/ai.js
import { aiDataAccess } from "../middleware/dataAccess.js";
import CompanyIntelligence from "../models/CompanyIntelligence.js";
import express from "express";
import OpenAI from "openai";
import { requireAuth } from "../middleware/auth.js";
import Organization from "../models/Organization.js";
import Membership from "../models/Membership.js";
import { getUnifiedWorkspaceData } from "../services/workspaceData.js";

import { buildRevenueRiskBriefing, isRevenueRiskQuestion } from "../services/operatorRiskBriefing.js";

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

export { DEMO_DEALS } from "../services/demoWorkspace.js";
import { DEMO_DEALS, buildDemoWorkspaceDeals, buildDemoWorkspaceMetrics } from "../services/demoWorkspace.js";

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

export function normalizeDeal(deal = {}) {
  const amount = safeNum(deal.amount ?? deal.value ?? deal.pipelineValue);
  const rawProbability = safeNum(
    deal.probability ?? deal.winProbability ?? deal.confidence
  );
  const probability = Math.max(
    0,
    Math.min(
      100,
      rawProbability > 0 && rawProbability <= 1
        ? rawProbability * 100
        : rawProbability
    )
  );
  const closeDate = deal.closeDate || deal.expectedCloseDate || deal.targetCloseDate || null;
  const lastActivityAt =
    deal.lastActivityAt || deal.lastActivityDate || deal.lastContactedAt || null;
  const daysToClose =
    deal.daysToClose ?? (closeDate ? daysBetween(new Date(), closeDate) : null);
  const daysSinceActivity =
    deal.daysSinceActivity ??
    (lastActivityAt ? Math.max(0, daysBetween(lastActivityAt, new Date())) : null);

  return {
    id: String(deal._id || deal.id || ""),
    probabilityRecorded: deal.probability!==null && deal.probability!==undefined || deal.winProbability!==undefined || deal.confidence!==undefined,
    name: String(deal.name || deal.title || deal.dealName || "Untitled deal"),
    accountName: String(
      deal.clientName || deal.accountName || deal.companyName || deal.account?.name || deal.client?.name || "Account not recorded"
    ),
    amount,
    stage: normalizeStage(deal.stage || deal.status),
    probability,
    closeDate,
    daysToClose,
    daysSinceActivity,
    owner: String(
      deal.ownerName || deal.owner?.name || deal.assignedTo?.name || deal.salesRep || (typeof deal.owner === "string" ? deal.owner : "") || "Owner not recorded"
    ),
    nextActionDueAt: deal.nextActionDueAt || null,
    nextStep: String(deal.nextStep || deal.nextAction || deal.recommendedAction || "Recommended: confirm the next buyer action and its due date; no next step is recorded."),
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

export function buildDealPriorityAnswer({ deals, orgName, isDemo }) {
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
      (deal, index) => `${index + 1}. ${deal.name} — ${money(deal.amount)} | ${deal.stage} | ${deal.probabilityRecorded ? `${deal.probability}% probability` : "Probability not recorded"}
Account: ${deal.accountName}
Owner: ${deal.owner}
Why it matters: ${explainPriority(deal)}.
Risk: ${deal.risk}
Next action: ${deal.nextStep}`
    )
    .join("\n\n");

  return `Focus leadership attention on these ${ranked.length} deal${ranked.length===1?"":"s"} first:

${detail}

Leadership takeaway: These deals represent ${money(totalValue)} in total pipeline and approximately ${money(weightedValue)} in probability-weighted value using recorded probabilities (unknown probabilities contribute no estimated value). This is not realized revenue or a committed forecast. Review their next steps, owners, and decision dates in the next pipeline meeting.${
    isDemo
      ? ""
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
    status: "active",
  }).lean();
}

/* -------------------------------- */
/* Local fallback insights          */
/* -------------------------------- */
router.post("/insights", requireAuth, async (req, res) => {
  try {
    const data = await getUnifiedWorkspaceData(req.user.orgId, { days: 30 });
    const kpis = {
      revenue30: data.metrics.reduce((sum, row) => sum + safeNum(row.revenue), 0),
      spend30: data.metrics.reduce((sum, row) => sum + safeNum(row.spend), 0),
      leads30: data.metrics.reduce((sum, row) => sum + safeNum(row.leads), 0),
      pipelineValue: data.deals.filter(deal => !["Closed Won", "Closed Lost"].includes(deal.stage)).reduce((sum, deal) => sum + safeNum(deal.amount), 0),
    };
    return res.json({ ok: true, orgName: req.user.orgName, insights: buildInsights(kpis), source: "workspace" });
  } catch (error) { return res.status(500).json({ ok: false, message: error.message }); }
});

/* -------------------------------- */
/* OpenAI analysis                  */
/* -------------------------------- */
router.post("/analyze", requireAuth, aiDataAccess, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const orgId = req.user?.orgId;
    if ([getOrgId(req),req.body?.orgId].some(id=>id && String(id)!==String(orgId)))return res.status(403).json({ok:false,message:"Workspace does not match authenticated context."});

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

    const question=typeof req.body?.question==='string'?req.body.question.trim():'';
    if(!question || question.length>2000)return res.status(400).json({ok:false,message:'Ask a question of 1–2000 characters.'});
    const requestedContext=req.body?.context || {};
    const isDemo=String(org.slug || '').toLowerCase()==='atlas-demo-company' || String(org.name || '').toLowerCase()==='atlas demo company';
    const workspaceMode=isDemo?'demo':'live',now=new Date();
    const unified=isDemo?{deals:buildDemoWorkspaceDeals(org,now),metrics:buildDemoWorkspaceMetrics(now),accounts:[],dataAsOf:now.toISOString(),dataSources:{revenue:'demo',currency:'USD'}}:await getUnifiedWorkspaceData(orgId,{days:90});
    const evidence=buildAskAtlasEvidence({org,workspace:unified,isDemo,question,now});
    const metrics=evidence.metrics;
    // Only server-loaded fields enter analysis. Browser KPIs, alerts and instructions are not facts.
    const context={workspaceMode,orgName:org.name,summary:metrics};
    const metadata=answerEvidenceMetadata(evidence);
    const reply=async(result,source,extra={})=>{
      org.usage=org.usage || {};org.usage.aiAnalyses=safeNum(org.usage.aiAnalyses)+1;await org.save();
      return res.json({ok:true,result,source,evidence:metadata,usage:org.usage,intelligence:{internal:true,external:false,workspaceMode,dealsEvaluated:evidence.coverage.dealsInScope},...extra});
    };
    const specific=specificWorkspaceAnswer(question,evidence);
    if(specific)return reply(specific.text,'atlas-record-evidence',{answerIntent:specific.intent});

    const newsId=requestedContext?.externalNews?.snapshotId;
    context.externalNews=await loadNewsContext(orgId,newsId);
    const hasExternalNews=Boolean(context.externalNews && (context.externalNews.records?.length || context.externalNews.text));

    const analysisDeals=evidence.deals.filter(d=>!["closed won","closed lost"].includes(String(d.stage).toLowerCase())).map(d=>({...d,probability:d.probability===null?null:d.probability/100}));
    const useExternal=hasExternalNews && wantsExternalEvidence(question);
    if (isRevenueRiskQuestion(question) && !useExternal && !evidence.period.explicit && !wantsExternalEvidence(question)) {
      const briefing = buildRevenueRiskBriefing({
        deals: analysisDeals.map(normalizeDeal), orgName: org.name,
        isDemo, revenueSource: metrics.revenueSource,
      });
      org.usage = org.usage || {};
      org.usage.aiAnalyses = safeNum(org.usage.aiAnalyses) + 1;
      await org.save();
      return res.json({
        ok: true, result: briefing.text, briefing, evidence:metadata, usage: org.usage,
        source: "atlas-revenue-risk-engine",
        intelligence: { internal: true, external: false, workspaceMode, dealsEvaluated: analysisDeals.length },
      });
    }

    if (isDealPriorityQuestion(question) && !useExternal && !wantsExternalEvidence(question) && !evidence.period.explicit) {
      const deals = analysisDeals;

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
        evidence:metadata,
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

    const snapshotId = requestedContext?.externalCompanyIntelligence?.snapshotId;
    const externalSnapshot = /^[a-f0-9]{24}$/i.test(String(snapshotId || ""))
      ? await CompanyIntelligence.findOne({ _id: snapshotId, orgId, expiresAt: { $gt: new Date() } }).lean() : null;
    const rawExternal = externalSnapshot?.data;
    const externalRows = Array.isArray(rawExternal) ? rawExternal : rawExternal?.entities || rawExternal?.organizations || rawExternal?.results || rawExternal?.items || rawExternal?.data || [];
    const externalCompanyIntelligence = externalSnapshot ? {
      source: "GraphIQ", asOf: externalSnapshot.createdAt, query: externalSnapshot.query,
      organizations: Array.isArray(externalRows) ? externalRows.slice(0, 10) : [],
    } : null;
    context.externalCompanyIntelligence = externalCompanyIntelligence;


    const hasExternalCompanyIntelligence =
      Array.isArray(externalCompanyIntelligence?.organizations) &&
      externalCompanyIntelligence.organizations.length > 0;

    if (!openai) {
      return res.json({
        ok: true,
        result:
          "OpenAI is not connected yet. Add OPENAI_API_KEY in backend environment variables to enable Atlas AI analysis.",
        source: "fallback",
        evidence:metadata,
      });
    }

    const completion=await openai.chat.completions.create({
      model:'gpt-4o-mini',temperature:0.1,
      messages:askAtlasMessages({question,evidence,externalCompanyIntelligence,externalNews:context.externalNews}),
    });

    const generated=completion?.choices?.[0]?.message?.content || '';
    const validRefs=new Set([...evidence.deals.slice(0,100).map(d=>d.ref),...evidence.accounts.slice(0,50).map(a=>a.ref),'M1']);
    const cited=[...generated.matchAll(/\[([DAM]\d+)\]/g)].map(m=>m[1]);
    const result=cited.some(ref=>!validRefs.has(ref))?'I could not verify the record references in this generated answer. No recommendation is confirmed; ask about a specific account or deal to inspect its recorded evidence.':generated || 'No analysis returned.';

    org.usage = org.usage || {};
    org.usage.aiAnalyses = safeNum(org.usage.aiAnalyses) + 1;
    await org.save();

    return res.json({
      ok: true,
      result,
      usage: org.usage,
      source: "openai",
      evidence:metadata,
      intelligence: {
        internal: true,
        external: hasExternalCompanyIntelligence || hasExternalNews,
        externalNewsUsed: hasExternalNews,
        externalNewsArticles: context.externalNews?.records?.length || 0,
        externalSource: hasExternalCompanyIntelligence || hasExternalNews ? "GraphIQ" : null,
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
