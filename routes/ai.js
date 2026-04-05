// backend/routes/ai.js
import express from "express";
import OpenAI from "openai";
import { requireAuth } from "../middleware/auth.js";
import Organization from "../models/Organization.js";
import Membership from "../models/Membership.js";

const router = express.Router();

const openai =
  process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

const safeNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

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

    if (!openai) {
      return res.json({
        ok: true,
        result:
          "OpenAI is not connected yet. Add OPENAI_API_KEY in backend environment variables to enable Atlas AI analysis.",
        source: "fallback",
      });
    }

    const prompt = `
You are Atlas Revenue AI, a revenue intelligence system for agencies, B2B companies, and executive teams.

Your job:
- analyze the provided business data
- identify revenue risks
- identify growth opportunities
- recommend next best actions
- write clearly for an executive audience

Return your response in this structure:

Executive Summary:
- short summary

Top Risks:
- bullets

Top Opportunities:
- bullets

Recommended Actions:
- numbered list

Question:
${question || "Analyze this business and provide strategic revenue guidance."}

Metrics:
${JSON.stringify(metrics, null, 2)}

Context:
${JSON.stringify(context, null, 2)}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content:
            "You are Atlas Revenue AI. Be strategic, concise, executive-friendly, and focused on revenue, pipeline, forecasting, attribution, CAC, and growth.",
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