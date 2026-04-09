// backend/routes/revenueStability.js
import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import Membership from "../models/Membership.js";

const router = express.Router();

const toObjectId = (v) => {
  if (!v) return null;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
};

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const safeNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Revenue Stability Score: combines pipeline coverage + CAC + momentum (WoW)
router.get("/", requireAuth, async (req, res) => {
  try {
    const db = mongoose.connection;

    const userId = toObjectId(req.user?.userId || req.user?._id);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const headerOrgId = toObjectId(req.headers["x-org-id"]);
    const defaultOrgId = toObjectId(req.user?.orgId);
    const orgId = headerOrgId || defaultOrgId;

    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

    // Validate membership so x-org-id can’t be spoofed
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

    // Pull last 30 metrics
    const metrics = await db
      .collection("metrics_daily")
      .find({ orgId })
      .sort({ date: -1 })
      .limit(30)
      .toArray();

    const revenue30 = metrics.reduce((a, m) => a + safeNum(m.revenue), 0);
    const spend30 = metrics.reduce((a, m) => a + safeNum(m.spend), 0);
    const leads30 = metrics.reduce((a, m) => a + safeNum(m.leads), 0);

    const cac = leads30 > 0 ? spend30 / leads30 : 0;

    // Pipeline value
    const deals = await db.collection("deals").find({ orgId }).toArray();
    const pipelineValue = deals.reduce((sum, d) => {
      const v = Number(d.amount) || Number(d.value) || Number(d.pipelineValue) || 0;
      return sum + v;
    }, 0);

    const coverage = revenue30 > 0 ? pipelineValue / revenue30 : 0;

    // WoW (needs 14+ days of data, but we only have 30 most recent; good enough)
    let wow = null;
    if (metrics.length >= 14) {
      const sorted = [...metrics].sort((a, b) => new Date(a.date) - new Date(b.date));
      const sumRev = (arr) => arr.reduce((acc, m) => acc + safeNum(m.revenue), 0);
      const last7 = sumRev(sorted.slice(-7));
      const prev7 = sumRev(sorted.slice(-14, -7));
      if (prev7 > 0) wow = ((last7 - prev7) / prev7) * 100;
    }

    // Score model (simple + believable)
    // coverage: 0..6x mapped to 0..55 points
    const coveragePts = clamp((coverage / 6) * 55, 0, 55);

    // cac: lower is better. 0..800 mapped to 30..0 points
    const cacPts = clamp(30 - (cac / 800) * 30, 0, 30);

    // wow: -20..+20 mapped to 0..15 points
    const wowPts =
      wow == null ? 8 : clamp(((clamp(wow, -20, 20) + 20) / 40) * 15, 0, 15);

    const score = Math.round(clamp(coveragePts + cacPts + wowPts, 0, 100));

    let status = "At Risk";
    if (score >= 85) status = "Strong";
    else if (score >= 70) status = "Stable";

    return res.json({
      ok: true,
      score,
      status,
      dataAsOf: metrics?.[0]?.date ? new Date(metrics[0].date).toISOString() : new Date().toISOString(),
      inputs: {
        coverage: Number(coverage.toFixed(1)),
        cac: Math.round(cac),
        wow: wow == null ? null : Number(wow.toFixed(1)),
        revenue30: Math.round(revenue30),
        pipelineValue: Math.round(pipelineValue),
      },
    });
  } catch (err) {
    console.error("Revenue Stability error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Server error" });
  }
});

export default router;