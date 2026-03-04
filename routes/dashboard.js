// backend/routes/dashboard.js
import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import Organization from "../models/Organization.js";
import Membership from "../models/Membership.js";

// ✅ Add this model (from earlier fix)
import MetricDaily from "../models/MetricDaily.js";

const router = express.Router();

const toObjectId = (v) => {
  if (!v) return null;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
};

const coerceNumber = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// Some older data can accidentally store orgId as string.
// This lets dashboard still work even if some docs were inserted with string orgId.
const orgIdMatch = (orgId) => ({
  $or: [
    { orgId }, // ObjectId
    { orgId: String(orgId) }, // string
  ],
});

const normalizeMetric = (m) => {
  const d = m?.date ? new Date(m.date) : null;
  return {
    // keep both to be safe for frontend chart keys
    date: d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null, // YYYY-MM-DD
    dateISO: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null,
    revenue: coerceNumber(m?.revenue, 0),
    spend: coerceNumber(m?.spend, 0),
    leads: coerceNumber(m?.leads, 0),
  };
};

/**
 * GET /api/dashboard
 * Org-scoped dashboard using x-org-id header (tenant switch)
 * Validates membership to prevent spoofing.
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const db = mongoose.connection;

    const userId = toObjectId(req.user?.userId || req.user?._id);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    // Prefer org from header (workspace switch), fallback to user's default org
    const headerOrgId = toObjectId(req.headers["x-org-id"]);
    const defaultOrgId = toObjectId(req.user?.orgId);
    const orgId = headerOrgId || defaultOrgId;

    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

    // Validate user belongs to this org (prevents x-org-id spoofing)
    const membership = await Membership.findOne({
      userId,
      orgId,
      status: { $ne: "disabled" },
    })
      .select("_id role status")
      .lean();

    if (!membership) {
      return res.status(403).json({ ok: false, message: "Not a member of this workspace" });
    }

    // Pull org (for display in UI)
    const org = await Organization.findById(orgId).select("_id name").lean();

    // Org-scoped data pulls
    const integrations = await db.collection("integrations").find(orgIdMatch(orgId)).toArray();
    const deals = await db.collection("deals").find(orgIdMatch(orgId)).toArray();

    // ✅ Metrics (last 30 days) — prefer Mongoose model, fallback to raw collection
    let metricsRaw = [];
    try {
      metricsRaw = await MetricDaily.find(orgIdMatch(orgId)).sort({ date: -1 }).limit(30).lean();
    } catch (e) {
      // fallback if model missing/misconfigured in some environments
      metricsRaw = await db
        .collection("metrics_daily")
        .find(orgIdMatch(orgId))
        .sort({ date: -1 })
        .limit(30)
        .toArray();
    }

    // Normalize and sort ASC for charts (Recharts usually expects left-to-right time)
    const metrics = (metricsRaw || [])
      .map(normalizeMetric)
      .filter((m) => !!m.date) // keep only valid dates
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const dataAsOf =
      metrics?.length && metrics[metrics.length - 1]?.dateISO
        ? metrics[metrics.length - 1].dateISO
        : new Date().toISOString();

    const lastUpdated = new Date().toISOString();

    // --- KPI calculations ---
    const revenue30d = metrics.reduce((sum, m) => sum + coerceNumber(m.revenue, 0), 0);
    const spend30d = metrics.reduce((sum, m) => sum + coerceNumber(m.spend, 0), 0);
    const leads30d = metrics.reduce((sum, m) => sum + coerceNumber(m.leads, 0), 0);

    const cac = leads30d > 0 ? spend30d / leads30d : 0;

    const pipelineValue = (deals || []).reduce((sum, d) => {
      const v =
        coerceNumber(d?.amount, 0) ||
        coerceNumber(d?.value, 0) ||
        coerceNumber(d?.pipelineValue, 0);
      return sum + v;
    }, 0);

    const avgDailyRevenue = metrics.length ? revenue30d / metrics.length : 0;
    const forecast90d = avgDailyRevenue * 90;

    // Demo health score
    let revenueHealth = 70;
    if (pipelineValue > 0) revenueHealth += 10;
    if (cac > 0 && cac < 300) revenueHealth += 10;
    if (revenue30d > 0) revenueHealth += 10;
    revenueHealth = Math.min(100, revenueHealth);

    return res.json({
      ok: true,
      lastUpdated,
      dataAsOf,

      org,
      membership: {
        role: (membership.role || "analyst").toString(),
        status: (membership.status || "active").toString(),
      },

      revenue: Math.round(revenue30d),
      pipelineValue: Math.round(pipelineValue),
      cac: Math.round(cac),
      forecast90d: Math.round(forecast90d),
      revenueHealth,

      integrations,
      deals,
      metrics, // ✅ now guaranteed normalized + sorted for charts
    });
  } catch (err) {
    console.error("Dashboard route error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Server error" });
  }
});

export default router;