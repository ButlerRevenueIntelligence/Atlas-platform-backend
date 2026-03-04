// backend/services/revenueStability.js
import mongoose from "mongoose";

const safeNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/**
 * Revenue Stability Score (RSS)
 * 0 - 100
 *
 * Pillars (0-25 each):
 * 1) Pipeline Protection
 * 2) Acquisition Efficiency
 * 3) Revenue Predictability
 * 4) Growth Strength
 */
export async function computeRevenueStability({ orgId }) {
  const db = mongoose.connection;
  const oid = new mongoose.Types.ObjectId(String(orgId));

  // Pull latest 30d metrics (sorted newest -> oldest)
  const metrics = await db
    .collection("metrics_daily")
    .find({ orgId: oid })
    .sort({ date: -1 })
    .limit(30)
    .toArray();

  // Pull deals + pipeline
  const deals = await db.collection("deals").find({ orgId: oid }).toArray();

  const revenue30 = (metrics || []).reduce((s, m) => s + safeNum(m.revenue), 0);
  const spend30 = (metrics || []).reduce((s, m) => s + safeNum(m.spend), 0);
  const leads30 = (metrics || []).reduce((s, m) => s + safeNum(m.leads), 0);

  const cac = leads30 > 0 ? spend30 / leads30 : 0;

  const pipelineValue = (deals || []).reduce((sum, d) => {
    return (
      sum +
      (safeNum(d.amount) || safeNum(d.value) || safeNum(d.pipelineValue) || 0)
    );
  }, 0);

  const coverage = revenue30 > 0 ? pipelineValue / revenue30 : 0;

  // --- Revenue volatility (predictability) ---
  // compute std dev of daily revenue
  const revSeries = (metrics || [])
    .map((m) => safeNum(m.revenue))
    .filter((x) => x >= 0);

  const mean = revSeries.length ? revSeries.reduce((a, b) => a + b, 0) / revSeries.length : 0;
  const variance =
    revSeries.length > 1
      ? revSeries.reduce((acc, x) => acc + Math.pow(x - mean, 2), 0) / (revSeries.length - 1)
      : 0;
  const std = Math.sqrt(variance);
  const volatility = mean > 0 ? std / mean : 0; // coefficient of variation

  // --- Growth strength (WoW / momentum) ---
  // Compare last 7 days vs previous 7 days if we have 14+ points
  const sorted = [...(metrics || [])].sort((a, b) => new Date(a.date) - new Date(b.date));
  const last7 = sorted.slice(-7).reduce((s, m) => s + safeNum(m.revenue), 0);
  const prev7 = sorted.slice(-14, -7).reduce((s, m) => s + safeNum(m.revenue), 0);
  const wow = prev7 > 0 ? ((last7 - prev7) / prev7) * 100 : null;

  // ==========================
  // Pillar scoring (0-25 each)
  // ==========================

  // 1) Pipeline Protection: based on coverage (0x..4x+)
  const pipelineProtection = clamp((coverage / 4) * 25, 0, 25);

  // 2) Acquisition Efficiency: based on CAC bands (tune anytime)
  // lower CAC => higher score
  let acquisitionEfficiency = 10;
  if (cac === 0 && spend30 === 0) acquisitionEfficiency = 8; // no paid data
  else if (cac > 0 && cac <= 150) acquisitionEfficiency = 25;
  else if (cac <= 250) acquisitionEfficiency = 20;
  else if (cac <= 400) acquisitionEfficiency = 14;
  else acquisitionEfficiency = 8;

  // 3) Revenue Predictability: lower volatility => higher score
  // volatility ~ 0.0 is perfect, 0.5+ is unstable
  const revenuePredictability = clamp((1 - clamp(volatility, 0, 0.6) / 0.6) * 25, 0, 25);

  // 4) Growth Strength: based on WoW change
  // -20% => 5, 0% => 12, +20% => 22, +40% => 25
  let growthStrength = 12;
  if (wow == null) growthStrength = 12;
  else if (wow <= -20) growthStrength = 5;
  else if (wow < 0) growthStrength = 9;
  else if (wow < 10) growthStrength = 16;
  else if (wow < 20) growthStrength = 22;
  else growthStrength = 25;

  const score = Math.round(
    pipelineProtection + acquisitionEfficiency + revenuePredictability + growthStrength
  );

  const status =
    score >= 85 ? "Elite" : score >= 70 ? "Strong" : score >= 55 ? "Moderate" : "At Risk";

  return {
    score: clamp(score, 0, 100),
    status,
    inputs: {
      revenue30,
      spend30,
      leads30,
      cac: Math.round(cac),
      pipelineValue,
      coverage: Number(coverage.toFixed(2)),
      volatility: Number(volatility.toFixed(3)),
      wow: wow == null ? null : Number(wow.toFixed(1)),
    },
    pillars: {
      pipelineProtection: Math.round(pipelineProtection),
      acquisitionEfficiency: Math.round(acquisitionEfficiency),
      revenuePredictability: Math.round(revenuePredictability),
      growthStrength: Math.round(growthStrength),
    },
  };
}