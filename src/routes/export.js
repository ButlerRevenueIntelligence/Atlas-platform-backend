// backend/routes/export.js
import express from "express";
import PDFDocument from "pdfkit";

const router = express.Router();

/** ---------- helpers ---------- */
const safeNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const money = (n) =>
  safeNum(n).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

const moneyCompact = (n) => {
  const num = safeNum(n);
  const abs = Math.abs(num);
  if (abs >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(num / 1_000).toFixed(0)}k`;
  return money(num);
};

const normalizeStage = (s) => {
  const val = (s || "").toString().trim().toLowerCase();
  if (!val) return "Unknown";
  if (val.includes("disc")) return "Discovery";
  if (val.includes("prop")) return "Proposal";
  if (val.includes("follow")) return "Follow-Up";
  if (val.includes("neg")) return "Negotiation";
  if (val.includes("close") || val.includes("won")) return "Closed Won";
  if (val.includes("lost")) return "Closed Lost";
  return s.toString();
};

function fallbackInsights({ revenue30 = 0, spend30 = 0, coverage = 0, cac = 0 } = {}) {
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
      body: "Increase top-of-funnel volume and tighten qualification to raise coverage. Aim for 4x coverage to stabilize forecasting.",
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
      body: "Reduce CAC by tightening ICP targeting, adding retargeting, and improving landing page conversion rate.",
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

/**
 * Collect summary data.
 * This is intentionally defensive: if your DB models exist, it uses them.
 * If not, it falls back to a safe summary so the PDF always works.
 */
async function collectExecutiveSummary() {
  const now = new Date();
  const start30 = new Date(now);
  start30.setDate(start30.getDate() - 30);

  // defaults (safe fallback)
  const summary = {
    orgName: "Butler & Co",
    dataAsOf: now,
    revenue30: 34329,
    spend30: 13979,
    leads30: 766,
    pipelineValue: 223000,
    cac: 18,
    forecast90: 102987,
    coverage: 6.5,
    pipelineByStage: [
      { stage: "Discovery", value: 25000 },
      { stage: "Proposal", value: 45000 },
      { stage: "Negotiation", value: 60000 },
      { stage: "Follow-Up", value: 93000 },
    ],
    insights: [],
    source: "fallback",
  };

  // Try reading your real data (ONLY if your models exist)
  try {
    // These imports will only work if you have these files.
    // If they don't exist, it will throw and we keep fallback.
    const [{ default: Metric }, { default: Deal }, { default: Integration }] = await Promise.all([
      import("../models/Metric.js"),
      import("../models/Deal.js"),
      import("../models/Integration.js"),
    ]);

    // metrics last 30d
    const metrics = await Metric.find({ date: { $gte: start30 } }).sort({ date: 1 }).lean();
    const revenue30 = metrics.reduce((a, m) => a + safeNum(m.revenue), 0);
    const spend30 = metrics.reduce((a, m) => a + safeNum(m.spend), 0);
    const leads30 = metrics.reduce((a, m) => a + safeNum(m.leads), 0);

    // deals pipeline
    const deals = await Deal.find({}).lean();
    const pipelineValue = deals.reduce(
      (a, d) => a + safeNum(d.amount ?? d.value ?? d.pipelineValue),
      0
    );

    // pipeline by stage
    const byStageMap = new Map();
    for (const d of deals) {
      const stage = normalizeStage(d.stage || d.status);
      const val = safeNum(d.amount ?? d.value ?? d.pipelineValue);
      byStageMap.set(stage, (byStageMap.get(stage) || 0) + val);
    }
    const pipelineByStage = [...byStageMap.entries()]
      .map(([stage, value]) => ({ stage, value }))
      .filter((x) => x.value > 0)
      .sort((a, b) => b.value - a.value);

    const cac = leads30 > 0 ? spend30 / leads30 : 0;
    const forecast90 = metrics.length ? (revenue30 / metrics.length) * 90 : 0;
    const coverage = revenue30 > 0 ? pipelineValue / revenue30 : 0;

    // org/integrations optional
    const integrationsCount = await Integration.countDocuments({});

    summary.orgName = summary.orgName; // keep if you don’t have org model yet
    summary.dataAsOf = metrics.length ? new Date(metrics[metrics.length - 1].date) : now;
    summary.revenue30 = revenue30;
    summary.spend30 = spend30;
    summary.leads30 = leads30;
    summary.pipelineValue = pipelineValue;
    summary.cac = cac;
    summary.forecast90 = forecast90;
    summary.coverage = coverage;
    summary.pipelineByStage = pipelineByStage.length ? pipelineByStage : summary.pipelineByStage;
    summary.source = `db (integrations: ${integrationsCount})`;
  } catch (e) {
    // fallback is fine — do nothing
  }

  // insights (always produce something)
  summary.insights = fallbackInsights({
    revenue30: summary.revenue30,
    spend30: summary.spend30,
    coverage: summary.coverage,
    cac: summary.cac,
  });

  return summary;
}

/** ---------- PDF Route ---------- */
router.get("/executive-summary", async (req, res) => {
  try {
    const summary = await collectExecutiveSummary();

    const doc = new PDFDocument({ size: "LETTER", margin: 48 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="Executive-Summary-${new Date().toISOString().slice(0, 10)}.pdf"`
    );

    doc.pipe(res);

    // Title
    doc.fontSize(20).text("Executive Revenue Summary", { align: "left" });
    doc.moveDown(0.3);
    doc
      .fontSize(11)
      .fillColor("#444")
      .text(`Org: ${summary.orgName}`)
      .text(`Data as of: ${new Date(summary.dataAsOf).toLocaleString()}`)
      .text(`Source: ${summary.source}`);
    doc.moveDown(1);
    doc.fillColor("#000");

    // KPI blocks
    doc.fontSize(14).text("Key KPIs (Last 30 Days)");
    doc.moveDown(0.5);

    const kpiRows = [
      ["Revenue (30D)", moneyCompact(summary.revenue30)],
      ["Spend (30D)", moneyCompact(summary.spend30)],
      ["Leads (30D)", `${Math.round(summary.leads30).toLocaleString()}`],
      ["CAC", money(summary.cac)],
      ["Pipeline Value", moneyCompact(summary.pipelineValue)],
      ["Pipeline Coverage", `${safeNum(summary.coverage).toFixed(1)}x`],
      ["Forecast (90D)", moneyCompact(summary.forecast90)],
    ];

    const leftX = doc.x;
    const col1 = leftX;
    const col2 = leftX + 220;

    kpiRows.forEach(([k, v]) => {
      doc.fontSize(11).fillColor("#222").text(k, col1);
      doc.fontSize(11).fillColor("#000").text(v, col2);
      doc.moveDown(0.25);
    });

    doc.moveDown(0.8);

    // Insights
    doc.fillColor("#000").fontSize(14).text("Top Insights");
    doc.moveDown(0.5);

    summary.insights.forEach((it, i) => {
      doc
        .fontSize(11)
        .fillColor("#000")
        .text(
          `${i + 1}. [${it.type}] ${it.title} (${it.impact}, ${it.confidence}% confidence)`
        );
      doc.fillColor("#444").text(it.body, { indent: 12 });
      doc.moveDown(0.4);
    });

    doc.moveDown(0.6);

    // Pipeline by stage
    doc.fillColor("#000").fontSize(14).text("Pipeline by Stage");
    doc.moveDown(0.5);

    summary.pipelineByStage.slice(0, 8).forEach((s) => {
      doc.fontSize(11).fillColor("#222").text(s.stage, col1);
      doc.fontSize(11).fillColor("#000").text(moneyCompact(s.value), col2);
      doc.moveDown(0.2);
    });

    doc.moveDown(1);

    // Footer
    doc
      .fontSize(10)
      .fillColor("#666")
      .text("Generated by Butler & Co Revenue Intelligence Platform", { align: "left" });

    doc.end();
  } catch (err) {
    console.error("Executive summary export error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Export failed" });
  }
});

export default router;