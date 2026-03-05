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

/**
 * Resolve orgId from:
 * 1) x-org-id header (preferred)
 * 2) req.user.orgId
 * 3) active Membership lookup
 *
 * IMPORTANT: If no org is selected yet, do NOT 403 — return ok:true and tell UI to select workspace.
 */
async function resolveOrgId(req) {
  const userId = toObjectId(req.user?.userId || req.user?._id);
  if (!userId) return { userId: null, orgId: null };

  const headerOrgId = toObjectId(req.headers["x-org-id"]);
  const tokenOrgId = toObjectId(req.user?.orgId);

  let orgId = headerOrgId || tokenOrgId;

  if (!orgId) {
    const m = await Membership.findOne({ userId, status: "active" }).select("orgId").lean();
    orgId = toObjectId(m?.orgId);
  }

  return { userId, orgId };
}

/**
 * GET /api/revenue-intel/board
 * NOTE: We intentionally only requireAuth here.
 * Authorization is enforced by membership check (below), and we avoid 403 if org not selected yet.
 */
router.get("/board", requireAuth, async (req, res) => {
  try {
    const { userId, orgId } = await resolveOrgId(req);

    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    // If org isn't selected yet, don't hard-fail the UI.
    if (!orgId) {
      return res.json({
        ok: true,
        needsWorkspace: true,
        board: {
          overdue: [],
          dueToday: [],
          winLoss: { won: 0, lost: 0, avgWon: 0, avgLost: 0 },
          reactivateCandidates: [],
        },
        message: "No workspace selected yet. Please select a workspace.",
      });
    }

    // Membership authorization
    const membership = await Membership.findOne({
      userId,
      orgId,
      status: { $ne: "disabled" },
    })
      .select("_id role status")
      .lean();

    if (!membership) {
      return res.status(403).json({ ok: false, message: "Not authorized for this org" });
    }

    // Basic board example (safe defaults)
    const reactivateAfterDays = Number(req.query.reactivateAfterDays ?? 30) || 30;

    const deals = await Deal.find({ orgId }).lean();

    // OPTIONAL: you can enhance logic later — for now just return something valid
    const board = {
      reactivateAfterDays,
      overdue: [],
      dueToday: [],
      winLoss: { won: 0, lost: 0, avgWon: 0, avgLost: 0 },
      reactivateCandidates: [],
      dealsCount: deals.length,
    };

    return res.json({ ok: true, orgId: String(orgId), board });
  } catch (e) {
    console.error("revenue-intel/board error:", e);
    return res.status(500).json({ ok: false, message: e?.message || "server error" });
  }
});

/**
 * GET /api/revenue-intel/health
 */
router.get("/health", requireAuth, async (req, res) => {
  const orgId = req.headers["x-org-id"] || req.user?.orgId || null;
  res.json({ ok: true, orgId });
});

export default router;