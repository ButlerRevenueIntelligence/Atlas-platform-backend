// backend/routes/revenueIntel.js
import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import Membership from "../models/Membership.js";
import { getUnifiedWorkspaceData } from "../services/workspaceData.js";

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

    const reactivateAfterDays = Math.max(
      1,
      Number(req.query?.reactivateAfterDays || 30)
    );
    const unified = await getUnifiedWorkspaceData(orgId, { days: 90 });
    const deals = Array.isArray(unified.deals) ? unified.deals : [];
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    const upcomingEnd = new Date(todayStart);
    upcomingEnd.setDate(upcomingEnd.getDate() + 8);
    const reactivationCutoff = new Date(now);
    reactivationCutoff.setDate(
      reactivationCutoff.getDate() - reactivateAfterDays
    );

    const closedStages = new Set(["closed won", "closed lost"]);
    const openDeals = deals.filter(
      (deal) => !closedStages.has(String(deal.stage || "").toLowerCase())
    );

    const toExecutionItem = (deal) => ({
      id: deal._id || deal.id,
      name: deal.name,
      clientName: deal.clientName || "Unassigned account",
      stage: deal.stage,
      amount: Number(deal.amount || 0),
      probability: Number(deal.probability || 0),
      dueAt: deal.nextActionDueAt,
      nextAction: deal.nextAction || "Review next step",
      lastActivityAt: deal.lastActivityAt || deal.updatedAt || deal.createdAt,
    });

    const withDueDate = openDeals.filter(
      (deal) => deal.nextActionDueAt && !Number.isNaN(new Date(deal.nextActionDueAt).getTime())
    );
    const overdue = withDueDate
      .filter((deal) => new Date(deal.nextActionDueAt) < todayStart)
      .map(toExecutionItem);
    const dueToday = withDueDate
      .filter((deal) => {
        const due = new Date(deal.nextActionDueAt);
        return due >= todayStart && due < tomorrowStart;
      })
      .map(toExecutionItem);
    const upcoming = withDueDate
      .filter((deal) => {
        const due = new Date(deal.nextActionDueAt);
        return due >= tomorrowStart && due < upcomingEnd;
      })
      .map(toExecutionItem);

    const reactivationItems = openDeals
      .filter((deal) => {
        const lastTouch = new Date(
          deal.lastActivityAt || deal.updatedAt || deal.createdAt || now
        );
        return !Number.isNaN(lastTouch.getTime()) && lastTouch <= reactivationCutoff;
      })
      .map((deal) => {
        const lastTouch = new Date(
          deal.lastActivityAt || deal.updatedAt || deal.createdAt
        );
        const lastTouchAgeDays = Math.max(
          0,
          Math.floor((now.getTime() - lastTouch.getTime()) / 86400000)
        );
        return {
          id: deal._id || deal.id,
          name: deal.name,
          clientName: deal.clientName || "Unassigned account",
          amount: Number(deal.amount || 0),
          lastTouchAgeDays,
          suggested: deal.nextAction || "Re-engage and confirm the next step",
        };
      });

    const wonDeals = deals.filter(
      (deal) => String(deal.stage || "").toLowerCase() === "closed won"
    );
    const lostDeals = deals.filter(
      (deal) => String(deal.stage || "").toLowerCase() === "closed lost"
    );
    const average = (items, field) =>
      items.length
        ? items.reduce((sum, item) => sum + Number(item[field] || 0), 0) /
          items.length
        : 0;
    const averageCycleDays = (items) => {
      const cycles = items
        .map((deal) => {
          const start = new Date(deal.createdAt);
          const end = new Date(deal.closedAt || deal.closeDate || deal.updatedAt);
          return !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())
            ? Math.max(0, (end.getTime() - start.getTime()) / 86400000)
            : null;
        })
        .filter((value) => value !== null);
      return cycles.length
        ? cycles.reduce((sum, value) => sum + value, 0) / cycles.length
        : 0;
    };
    const closedCount = wonDeals.length + lostDeals.length;

    return res.json({
      ok: true,
      orgId: String(orgId),
      membership,
      execution: {
        overdue,
        dueToday,
        upcoming,
        counts: {
          overdue: overdue.length,
          dueToday: dueToday.length,
          upcoming: upcoming.length,
        },
      },
      reactivation: {
        items: reactivationItems,
        count: reactivationItems.length,
        reactivateAfterDays,
      },
      winLoss: {
        won: wonDeals.length,
        lost: lostDeals.length,
        winRate: closedCount ? (wonDeals.length / closedCount) * 100 : 0,
        avgWon: average(wonDeals, "amount"),
        avgLost: average(lostDeals, "amount"),
        avgCycleDaysWon: averageCycleDays(wonDeals),
        avgCycleDaysLost: averageCycleDays(lostDeals),
      },
      dataSources: unified.dataSources,
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
