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
 * GET /api/revenue-intel/board?reactivateAfterDays=30
 * Returns the Revenue Intel board (reactivation + win/loss summary)
 */
router.get("/board", requireAuth, async (req, res) => {
  try {
    const userId = toObjectId(req.user?.userId || req.user?._id);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    // org from header first, then token/user, then membership fallback
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

    // validate membership (same pattern as seed.js)
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

    // Reactivation window
    const reactivateAfterDays = Math.max(
      1,
      Math.min(365, Number(req.query.reactivateAfterDays ?? 30) || 30)
    );
    const cutoff = new Date(Date.now() - reactivateAfterDays * 24 * 60 * 60 * 1000);

    // Pull org deals
    const deals = await Deal.find({ orgId }).lean();

    // Categorize (based on stage; tweak these stage names to match yours)
    const CLOSED_WON = new Set(["Closed Won", "Closed-Won", "Won", "won"]);
    const CLOSED_LOST = new Set(["Closed Lost", "Closed-Lost", "Lost", "lost"]);

    const won = [];
    const lost = [];
    const open = [];
    const closedLostCandidates = [];

    for (const d of deals) {
      const stage = String(d.stage || "").trim();

      if (CLOSED_WON.has(stage)) {
        won.push(d);
        continue;
      }
      if (CLOSED_LOST.has(stage)) {
        lost.push(d);

        const updatedAt = d.updatedAt ? new Date(d.updatedAt) : null;
        const createdAt = d.createdAt ? new Date(d.createdAt) : null;
        const lastTouch = updatedAt || createdAt;

        if (lastTouch && lastTouch <= cutoff) {
          closedLostCandidates.push(d);
        }
        continue;
      }
      open.push(d);
    }

    const totalClosed = won.length + lost.length;
    const winRate = totalClosed > 0 ? won.length / totalClosed : 0;

    const sumAmount = (arr) =>
      arr.reduce((sum, d) => sum + (Number(d.amount ?? d.value ?? 0) || 0), 0);

    const avg = (arr) => (arr.length ? sumAmount(arr) / arr.length : 0);

    const board = {
      reactivateAfterDays,
      stats: {
        totals: {
          deals: deals.length,
          open: open.length,
          won: won.length,
          lost: lost.length,
        },
        winRate, // 0-1
        avgWon: avg(won),
        avgLost: avg(lost),
        totalWon: sumAmount(won),
        totalLost: sumAmount(lost),
      },
      reactivation: {
        candidates: closedLostCandidates.map((d) => ({
          id: String(d._id),
          name: d.name,
          stage: d.stage,
          amount: Number(d.amount ?? d.value ?? 0) || 0,
          probability: Number(d.probability ?? 0) || 0,
          nextAction: d.nextAction || "",
          updatedAt: d.updatedAt || d.createdAt || null,
          clientId: d.clientId ? String(d.clientId) : null,
        })),
        count: closedLostCandidates.length,
      },
    };

    return res.json({
      ok: true,
      scope: {
        orgId: String(orgId),
        role: membership.role || null,
      },
      board,
    });
  } catch (e) {
    console.error("revenue-intel/board error:", e);
    return res.status(500).json({ ok: false, message: e?.message || "server error" });
  }
});

/**
 * GET /api/revenue-intel/health
 */
router.get("/health", requireAuth, async (req, res) => {
  res.json({ ok: true, orgId: req.user?.orgId || null });
});

export default router;