// backend/routes/forecast.js
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

const safeNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// very simple mode engine (we can make this much smarter later)
function applyMode({ amount, probability, mode }) {
  let p = safeNum(probability);
  let a = safeNum(amount);

  if (mode === "current") return { amount: a, probability: p };

  if (mode === "growth") {
    // push volume + slightly better win rate
    a = a * 1.12;
    p = Math.min(1, p + 0.08);
    return { amount: a, probability: p };
  }

  if (mode === "efficiency") {
    // reduce waste, focus on higher quality
    a = a * 0.95;
    p = Math.min(1, p + 0.12);
    return { amount: a, probability: p };
  }

  if (mode === "aggressive") {
    // aggressive spend + stronger lift
    a = a * 1.25;
    p = Math.min(1, p + 0.15);
    return { amount: a, probability: p };
  }

  return { amount: a, probability: p };
}

function calcForecast(deals, mode) {
  const openDeals = (deals || []).filter((d) => {
    const s = (d?.stage || "").toLowerCase();
    return !s.includes("closed");
  });

  const weighted = openDeals.reduce((sum, d) => {
    const baseAmount = safeNum(d?.amount ?? d?.value ?? 0);
    const baseProb = d?.probability == null ? 0.5 : safeNum(d.probability);

    const adj = applyMode({ amount: baseAmount, probability: baseProb, mode });
    return sum + adj.amount * adj.probability;
  }, 0);

  const raw = openDeals.reduce((sum, d) => sum + safeNum(d?.amount ?? d?.value ?? 0), 0);

  return {
    mode,
    weighted: Math.round(weighted),
    raw: Math.round(raw),
    dealCount: openDeals.length,
  };
}

// GET /api/forecast/scenarios
router.get("/scenarios", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);
    if (!ctx.ok) return res.status(ctx.status).json({ ok: false, message: ctx.message });
    if (!ctx.orgId) return res.status(200).json({ ok: true, scenarios: [] });

    const deals = await Deal.find({ orgId: ctx.orgId })
      .select("stage amount value probability createdAt")
      .lean();

    const scenarios = [
      calcForecast(deals, "current"),
      calcForecast(deals, "growth"),
      calcForecast(deals, "efficiency"),
      calcForecast(deals, "aggressive"),
    ];

    const byMode = Object.fromEntries(scenarios.map((s) => [s.mode, s]));
    const base = byMode.current?.weighted || 0;

    const deltas = {
      growth: (byMode.growth?.weighted || 0) - base,
      efficiency: (byMode.efficiency?.weighted || 0) - base,
      aggressive: (byMode.aggressive?.weighted || 0) - base,
    };

    return res.status(200).json({
      ok: true,
      baseMode: "current",
      scenarios,
      deltas,
      computedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Forecast scenarios error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Failed to compute scenarios" });
  }
});

export default router;