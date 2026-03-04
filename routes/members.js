import express from "express";
import mongoose from "mongoose";
import { requireAuth, requireOrgRole } from "../middleware/auth.js";
import Membership from "../models/Membership.js";
import User from "../models/User.js";

const router = express.Router();

const toId = (v) => {
  if (!v) return null;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
};

/**
 * GET /api/members
 * Admin+ in current org: list members in org
 */
router.get("/", requireAuth, requireOrgRole("admin"), async (req, res) => {
  try {
    const orgId = toId(req.user?.orgId);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

    const memberships = await Membership.find({ orgId, status: { $ne: "disabled" } })
      .select("_id userId role status createdAt")
      .sort({ createdAt: -1 })
      .lean();

    const userIds = memberships.map((m) => m.userId);
    const users = await User.find({ _id: { $in: userIds } })
      .select("_id name email")
      .lean();

    const userMap = new Map(users.map((u) => [String(u._id), u]));

    const rows = memberships.map((m) => {
      const u = userMap.get(String(m.userId));
      return {
        membershipId: String(m._id),
        userId: String(m.userId),
        name: u?.name || "User",
        email: u?.email || "",
        role: m.role || "analyst",
        status: m.status || "active",
      };
    });

    return res.json({ ok: true, members: rows });
  } catch (err) {
    console.error("members list error:", err);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

/**
 * PUT /api/members/:membershipId
 * Admin+ can change role/status (optional)
 */
router.put("/:membershipId", requireAuth, requireOrgRole("admin"), async (req, res) => {
  try {
    const orgId = toId(req.user?.orgId);
    const membershipId = toId(req.params.membershipId);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });
    if (!membershipId) return res.status(400).json({ ok: false, message: "Invalid membershipId" });

    const updates = {};
    if (req.body?.role) updates.role = String(req.body.role);
    if (req.body?.status) updates.status = String(req.body.status);

    const m = await Membership.findOneAndUpdate(
      { _id: membershipId, orgId },
      { $set: updates },
      { new: true }
    ).lean();

    if (!m) return res.status(404).json({ ok: false, message: "Membership not found" });

    return res.json({ ok: true, membership: m });
  } catch (err) {
    console.error("members update error:", err);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

export default router;