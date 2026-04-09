// backend/routes/metrics.js
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

async function getOrgContext(req) {
  const userId = toObjectId(req.user?.userId);
  if (!userId) return { ok: false, status: 401, message: "Unauthorized" };

  const headerOrgId = toObjectId(req.headers["x-org-id"]);
  const defaultOrgId = toObjectId(req.user?.orgId);
  const orgId = headerOrgId || defaultOrgId;

  if (!orgId) return { ok: false, status: 200, message: "No org selected", userId, orgId: null };

  const membership = await Membership.findOne({
    userId,
    orgId,
    status: { $ne: "disabled" },
  })
    .select("_id role status")
    .lean();

  if (!membership) return { ok: false, status: 403, message: "Not a member of this workspace" };

  return { ok: true, userId, orgId, membership };
}

const STAGES = ["Discovery", "Proposal", "Follow-Up", "Negotiation", "Closed Won", "Closed Lost"];

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * GET /metrics/summary?days=30
 * Returns KPI cards: deals, raw, weighted, won, winRate, avgDeal, avgCycleDays, staleCount
 */
router.get("/summary", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);
    if (!ctx.ok) return res.status(ctx.status).json({ ok: false, message: ctx.message });
    if (!ctx.orgId) return res.status(200).json({ ok: true, summary: {} });

    const days = Math.max(7, Math.min(365, parseInt(req.query.days || "30", 10) || 30));
    const from = addDays(startOfDay(new Date()), -days);

    const deals = await Deal.find({ orgId: ctx.orgId, createdAt: { $gte: from } })
      .select("stage amount probability createdAt closeDate lastActivityAt")
      .lean();

    const totalDeals = deals.length;

    const raw = deals.reduce((s, d) => s + safeNum(d.amount), 0);
    const weighted = deals.reduce((s, d) => s + safeNum(d.amount) * safeNum(d.probability ?? 1), 0);

    const wonDeals = deals.filter((d) => String(d.stage) === "Closed Won");
    const wonCount = wonDeals.length;
    const wonRevenue = wonDeals.reduce((s, d) => s + safeNum(d.amount), 0);

    const closedDeals = deals.filter(
      (d) => String(d.stage) === "Closed Won" || String(d.stage) === "Closed Lost"
    );
    const closedCount = closedDeals.length;
    const winRate = closedCount ? wonCount / closedCount : 0;

    const avgDeal = totalDeals ? raw / totalDeals : 0;

    // avg cycle days (createdAt -> closeDate for closed deals)
    const cycles = closedDeals
      .map((d) => {
        const a = new Date(d.createdAt);
        const b = d.closeDate ? new Date(d.closeDate) : null;
        if (!b || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
        return Math.max(0, Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24)));
      })
      .filter((x) => x != null);

    const avgCycleDays = cycles.length ? cycles.reduce((s, x) => s + x, 0) / cycles.length : 0;

    // stale deals (not closed and no activity in 14 days)
    const staleThreshold = addDays(new Date(), -14).getTime();
    const staleCount = deals.filter((d) => {
      const stage = String(d.stage || "");
      if (stage === "Closed Won" || stage === "Closed Lost") return false;
      const last = d.lastActivityAt ? new Date(d.lastActivityAt).getTime() : new Date(d.createdAt).getTime();
      return last < staleThreshold;
    }).length;

    return res.status(200).json({
      ok: true,
      summary: {
        days,
        totalDeals,
        raw,
        weighted,
        wonRevenue,
        wonCount,
        winRate,
        avgDeal,
        avgCycleDays,
        staleCount,
      },
    });
  } catch (err) {
    console.error("Metrics summary error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Failed to load metrics summary" });
  }
});

/**
 * GET /metrics/daily?days=30
 * Returns daily series for created deals, weighted pipeline created that day, won revenue that day
 */
router.get("/daily", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);
    if (!ctx.ok) return res.status(ctx.status).json({ ok: false, message: ctx.message });
    if (!ctx.orgId) return res.status(200).json({ ok: true, days: [] });

    const days = Math.max(7, Math.min(365, parseInt(req.query.days || "30", 10) || 30));
    const end = startOfDay(new Date());
    const start = addDays(end, -days + 1);

    // pull deals created in range + deals won in range (by closeDate OR updatedAt fallback)
    const createdDeals = await Deal.find({ orgId: ctx.orgId, createdAt: { $gte: start, $lte: addDays(end, 1) } })
      .select("createdAt amount probability stage closeDate updatedAt")
      .lean();

    const buckets = new Map();
    for (let i = 0; i < days; i++) {
      const day = addDays(start, i);
      const key = day.toISOString().slice(0, 10);
      buckets.set(key, { date: key, dealsCreated: 0, weightedCreated: 0, wonRevenue: 0, wonCount: 0 });
    }

    for (const d of createdDeals) {
      const key = startOfDay(d.createdAt).toISOString().slice(0, 10);
      if (!buckets.has(key)) continue;
      const b = buckets.get(key);
      b.dealsCreated += 1;
      b.weightedCreated += safeNum(d.amount) * safeNum(d.probability ?? 1);
    }

    // won revenue by day (use closeDate if present, else updatedAt)
    for (const d of createdDeals) {
      if (String(d.stage) !== "Closed Won") continue;
      const winDate = d.closeDate ? startOfDay(d.closeDate) : startOfDay(d.updatedAt || d.createdAt);
      const key = winDate.toISOString().slice(0, 10);
      if (!buckets.has(key)) continue;
      const b = buckets.get(key);
      b.wonRevenue += safeNum(d.amount);
      b.wonCount += 1;
    }

    return res.status(200).json({ ok: true, days: [...buckets.values()] });
  } catch (err) {
    console.error("Metrics daily error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Failed to load daily metrics" });
  }
});

export default router;