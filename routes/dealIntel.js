// backend/routes/dealIntel.js
import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import Membership from "../models/Membership.js";
import { computePriorities, runAutopilot } from "../services/dealAutopilot.js";

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

  const role = (membership.role || "analyst").toLowerCase();
  const canWrite = role === "owner" || role === "admin" || role === "manager";

  return { ok: true, userId, orgId, membership, canWrite };
}

// GET /api/deal-intel/priorities?limit=10
router.get("/priorities", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);
    if (!ctx.ok) return res.status(ctx.status).json({ ok: false, message: ctx.message });
    if (!ctx.orgId) return res.status(200).json({ ok: true, top: [], summary: { total: 0, stale: 0, atRisk: 0, hot: 0 } });

    const limit = Number(req.query.limit || 10);
    const result = await computePriorities({ orgId: ctx.orgId, limit });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("DealIntel priorities error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Failed to compute priorities" });
  }
});

// POST /api/deal-intel/autopilot/run
// body: { maxUpdates, dryRun, force }
router.post("/autopilot/run", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);
    if (!ctx.ok) return res.status(ctx.status).json({ ok: false, message: ctx.message });
    if (!ctx.canWrite) return res.status(403).json({ ok: false, message: "Insufficient permissions" });
    if (!ctx.orgId) return res.status(400).json({ ok: false, message: "No org selected" });

    const maxUpdates = Number(req.body?.maxUpdates || 200);
    const dryRun = Boolean(req.body?.dryRun);
    const force = Boolean(req.body?.force);

    const result = await runAutopilot({ orgId: ctx.orgId, maxUpdates, dryRun, force });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("DealIntel autopilot error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Autopilot failed" });
  }
});

export default router;