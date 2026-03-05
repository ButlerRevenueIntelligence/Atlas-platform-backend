// backend/routes/revenueIntel.js
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

async function resolveOrgId(req) {
  const headerOrgId = toObjectId(req.headers["x-org-id"]);
  const defaultOrgId = toObjectId(req.user?.orgId);
  let orgId = headerOrgId || defaultOrgId;

  if (!orgId) {
    const userId = toObjectId(req.user?.userId || req.user?._id);
    if (!userId) return null;

    const m = await Membership.findOne({ userId, status: "active" })
      .select("orgId")
      .lean();

    orgId = toObjectId(m?.orgId);
  }

  return orgId;
}

async function requireWorkspaceMember(req, res, next) {
  try {
    const userId = toObjectId(req.user?.userId || req.user?._id);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const orgId = await resolveOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

    const membership = await Membership.findOne({
      userId,
      orgId,
      status: { $ne: "disabled" },
    })
      .select("_id role status orgId")
      .lean();

    if (!membership) {
      return res.status(403).json({ ok: false, message: "Not authorized for this workspace" });
    }

    req.orgId = orgId;
    req.membership = membership;
    next();
  } catch (e) {
    console.error("requireWorkspaceMember error:", e);
    res.status(500).json({ ok: false, message: "Auth check failed" });
  }
}

/**
 * GET /api/revenue-intel/board
 * Now authorized by membership (not requirePerm).
 */
router.get("/board", requireAuth, requireWorkspaceMember, async (req, res) => {
  const reactivateAfterDays = Number(req.query.reactivateAfterDays ?? 30) || 30;

  // Minimal “board” payload so UI loads (you can expand later)
  const deals = await Deal.find({ orgId: req.orgId }).select("stage amount probability createdAt").lean();

  return res.json({
    ok: true,
    orgId: String(req.orgId),
    reactivateAfterDays,
    summary: {
      totalDeals: deals.length,
      pipelineValue: Math.round(
        deals.reduce((sum, d) => sum + (Number(d.amount || 0) * Number(d.probability ?? 1)), 0)
      ),
    },
    board: deals,
  });
});

router.get("/health", requireAuth, requireWorkspaceMember, (req, res) => {
  res.json({ ok: true, orgId: String(req.orgId) });
});

export default router;