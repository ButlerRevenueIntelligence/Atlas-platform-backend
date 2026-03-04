// backend/routes/ai.js
import express from "express";

const router = express.Router();

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

export default router;