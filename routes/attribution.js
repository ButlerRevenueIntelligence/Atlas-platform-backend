// backend/routes/attribution.js
import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import Membership from "../models/Membership.js";

const router = express.Router();

const safeNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const toObjectId = (v) => {
  if (!v) return null;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
};

function pickOrgId(req) {
  const header = req.headers["x-org-id"] || req.headers["X-Org-Id"];
  const headerOrgId = toObjectId(header);
  const defaultOrgId = toObjectId(req.user?.orgId);
  return headerOrgId || defaultOrgId || null;
}

async function requireMembershipOr403({ userId, orgId }) {
  const m = await Membership.findOne({
    userId,
    orgId,
    status: { $ne: "disabled" },
  })
    .select("_id role status")
    .lean();

  return m || null;
}

function buildFallback() {
  // You can tweak these numbers anytime
  const rows = [
    { channel: "Google Ads", spend: 6200, leads: 210, revenue: 16200 },
    { channel: "Meta Ads", spend: 4300, leads: 180, revenue: 9800 },
    { channel: "LinkedIn Ads", spend: 2200, leads: 55, revenue: 7600 },
    { channel: "SEO", spend: 900, leads: 130, revenue: 11200 },
    { channel: "Email", spend: 250, leads: 60, revenue: 4200 },
  ];

  return rows.map((r) => {
    const spend = safeNum(r.spend);
    const revenue = safeNum(r.revenue);
    const roi = spend > 0 ? (revenue - spend) / spend : null;
    return { ...r, spend, revenue, leads: safeNum(r.leads), roi };
  });
}

/**
 * GET /api/attribution/summary
 * Org-scoped (x-org-id) with membership validation.
 * Currently returns fallback numbers, but is tenant-safe.
 */
router.get("/summary", requireAuth, async (req, res) => {
  try {
    const userId = toObjectId(req.user?.userId);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const orgId = pickOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context (x-org-id)." });

    const membership = await requireMembershipOr403({ userId, orgId });
    if (!membership) return res.status(403).json({ ok: false, message: "Not a member of this workspace" });

    // Later: replace buildFallback() with DB-driven attribution by orgId
    const channels = buildFallback();

    const totals = channels.reduce(
      (acc, c) => {
        acc.spend += safeNum(c.spend);
        acc.leads += safeNum(c.leads);
        acc.revenue += safeNum(c.revenue);
        return acc;
      },
      { spend: 0, leads: 0, revenue: 0 }
    );

    const overallROI =
      totals.spend > 0 ? (totals.revenue - totals.spend) / totals.spend : null;

    return res.json({
      ok: true,
      dataAsOf: new Date().toISOString(),
      totals: { ...totals, roi: overallROI },
      channels,
      source: "fallback",
    });
  } catch (err) {
    console.error("Attribution summary error:", err);
    return res
      .status(500)
      .json({ ok: false, message: err?.message || "Attribution failed" });
  }
});

export default router;