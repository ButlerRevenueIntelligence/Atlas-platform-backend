// backend/routes/pipeline.js
import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import Membership from "../models/Membership.js";
import Deal from "../models/Deal.js";

const router = express.Router();

const toObjectId = (v) => {
  if (!v) return null;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
};

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeStage(s) {
  const val = (s || "").toString().trim().toLowerCase();
  if (!val) return "Discovery";
  if (val.includes("disc")) return "Discovery";
  if (val.includes("prop")) return "Proposal";
  if (val.includes("follow")) return "Follow-Up";
  if (val.includes("neg")) return "Negotiation";
  if (val.includes("won")) return "Closed Won";
  if (val.includes("lost")) return "Closed Lost";
  return s?.toString?.() || "Discovery";
}

const STAGES = ["Discovery", "Proposal", "Follow-Up", "Negotiation", "Closed Won", "Closed Lost"];

/**
 * Mounted as:
 *   app.use("/api/pipeline", router)
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = toObjectId(req.user?.userId);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const headerOrgId = toObjectId(req.headers["x-org-id"]);
    const defaultOrgId = toObjectId(req.user?.orgId);
    const orgId = headerOrgId || defaultOrgId;

    if (!orgId) return res.status(200).json({ ok: true, deals: [], pipelineValue: 0 });

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

    const deals = await Deal.find({ orgId })
      .sort({ createdAt: -1 })
      .limit(200)
      .populate({ path: "clientId", select: "name industry website status" })
      .lean();

    const now = Date.now();

    // Weighted pipeline
    const pipelineValue = deals.reduce((sum, d) => {
      const value = safeNum(d.amount ?? d.value ?? d.pipelineValue, 0);
      const prob = safeNum(d.probability, 1); // if missing, treat as 1
      return sum + value * prob;
    }, 0);

    // Stage velocity + bottlenecks
    const stageStats = {};
    for (const st of STAGES) stageStats[st] = { stage: st, count: 0, avgAgeDays: 0, totalAgeDays: 0 };

    for (const d of deals) {
      const st = normalizeStage(d.stage);
      const t = d.stageUpdatedAt || d.updatedAt || d.createdAt;
      const ageDays = t ? Math.max(0, Math.floor((now - new Date(t).getTime()) / 86400000)) : 0;

      if (!stageStats[st]) stageStats[st] = { stage: st, count: 0, avgAgeDays: 0, totalAgeDays: 0 };
      stageStats[st].count += 1;
      stageStats[st].totalAgeDays += ageDays;
    }

    const stageVelocity = Object.values(stageStats).map((s) => ({
      stage: s.stage,
      count: s.count,
      avgAgeDays: s.count ? Math.round((s.totalAgeDays / s.count) * 10) / 10 : 0,
    }));

    // Bottleneck = highest avgAge among active stages with at least 2 deals
    const activeStages = stageVelocity.filter(
      (s) => !["Closed Won", "Closed Lost"].includes(s.stage) && s.count >= 2
    );
    const bottleneck = activeStages.sort((a, b) => b.avgAgeDays - a.avgAgeDays)[0] || null;

    return res.status(200).json({
      ok: true,
      deals,
      pipelineValue: Math.round(pipelineValue),
      velocity: {
        stageVelocity,
        bottleneck, // {stage, count, avgAgeDays} or null
      },
    });
  } catch (err) {
    console.error("Pipeline error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Pipeline failed" });
  }
});

export default router;