// backend/routes/integrations.js
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
 * GET /api/integrations
 * Org-scoped using x-org-id header (workspace switch)
 * Validates membership to prevent spoofing
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = toObjectId(req.user?.userId);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const headerOrgId = toObjectId(req.headers["x-org-id"]);
    const defaultOrgId = toObjectId(req.user?.orgId);
    const orgId = headerOrgId || defaultOrgId;

    if (!orgId) return res.json({ ok: true, integrations: [] });

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

    const db = mongoose.connection;

    const integrations = await db
      .collection("integrations")
      .find({ orgId })
      .sort({ createdAt: -1 })
      .toArray();

    return res.json({ ok: true, integrations });
  } catch (err) {
    console.error("GET /integrations error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Server error" });
  }
});

export default router;