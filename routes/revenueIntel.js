// backend/routes/revenueIntel.js
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

/**
 * GET /api/revenue-intel/board
 * Auth: requires a valid session + active membership in org
 * Org context: x-org-id header OR req.user.orgId OR membership fallback
 */
router.get("/board", requireAuth, async (req, res) => {
  try {
    const userId = toObjectId(req.user?.userId || req.user?._id);
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const headerOrgId = toObjectId(req.headers["x-org-id"]);
    const defaultOrgId = toObjectId(req.user?.orgId);
    let orgId = headerOrgId || defaultOrgId;

    if (!orgId) {
      const m = await Membership.findOne({ userId, status: "active" })
        .select("orgId")
        .lean();
      orgId = toObjectId(m?.orgId);
    }

    if (!orgId) {
      return res.status(400).json({ ok: false, message: "Missing org context" });
    }

    const membership = await Membership.findOne({
      userId,
      orgId,
      status: { $ne: "disabled" },
    })
      .select("role status orgId userId")
      .lean();

    if (!membership) {
      return res.status(403).json({ ok: false, message: "Not authorized for this org" });
    }

    const reactivateAfterDays = Number(req.query?.reactivateAfterDays || 30);

    return res.json({
      ok: true,
      orgId: String(orgId),
      membership,
      execution: {
        overdue: [],
        dueToday: [],
        upcoming: [],
        counts: {
          overdue: 0,
          dueToday: 0,
          upcoming: 0,
        },
      },
      reactivation: {
        items: [],
        count: 0,
        reactivateAfterDays,
      },
      winLoss: {
        won: 0,
        lost: 0,
        winRate: 0,
        avgWon: 0,
        avgLost: 0,
        avgCycleDaysWon: 0,
        avgCycleDaysLost: 0,
      },
    });
  } catch (e) {
    console.error("revenue-intel/board error:", e);
    return res.status(500).json({
      ok: false,
      message: e?.message || "server error",
    });
  }
});

router.get("/health", requireAuth, (req, res) => {
  res.json({ ok: true });
});

export default router;