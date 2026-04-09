// backend/routes/partners.js
import express from "express";
import mongoose from "mongoose";
import User from "../models/User.js";
import Membership from "../models/Membership.js";
import { requireAuth, requireOrgRole } from "../middleware/auth.js";

const router = express.Router();

const toObjId = (v) => {
  if (!v) return null;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
};

/**
 * GET /api/partners
 * Returns members in the active org (tenant)
 * ✅ Any authenticated org member can view the list
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const orgId = toObjId(req.user?.orgId);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

    const memberships = await Membership.find({ orgId, status: { $ne: "disabled" } })
      .select("_id userId orgId role permissions status createdAt")
      .sort({ createdAt: -1 })
      .lean();

    const userIds = memberships.map((m) => m.userId).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } })
      .select("_id name email company role")
      .lean();

    const userMap = new Map(users.map((u) => [String(u._id), u]));

    const partners = memberships.map((m) => {
      const u = userMap.get(String(m.userId));
      return {
        membershipId: m._id,
        userId: m.userId,
        name: u?.name || "—",
        email: u?.email || "—",
        company: u?.company || "",
        orgRole: String(m.role || "analyst").toLowerCase(),
        status: m.status || "active",
        overrides: Array.isArray(m.permissions) ? m.permissions : [],
        createdAt: m.createdAt,
      };
    });

    return res.json({ ok: true, partners });
  } catch (err) {
    console.error("GET /api/partners error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Server error" });
  }
});

/**
 * PATCH /api/partners/:membershipId/role
 * body: { role }
 * ✅ LOCKED: only org admin/owner can change roles
 */
router.patch("/:membershipId/role", requireAuth, requireOrgRole("admin"), async (req, res) => {
  try {
    const orgId = toObjId(req.user?.orgId);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

    const membershipId = toObjId(req.params.membershipId);
    if (!membershipId) return res.status(400).json({ ok: false, message: "Invalid membershipId" });

    const role = String(req.body?.role || "").toLowerCase();
    const allowed = ["owner", "admin", "manager", "analyst", "sales"];
    if (!allowed.includes(role)) {
      return res.status(400).json({ ok: false, message: `Invalid role. Use: ${allowed.join(", ")}` });
    }

    const m = await Membership.findOne({ _id: membershipId, orgId });
    if (!m) return res.status(404).json({ ok: false, message: "Membership not found" });

    // Optional: prevent demoting yourself from owner/admin if you want (hard lock)
    // if (String(m.userId) === String(req.user.userId) && role !== m.role) {
    //   return res.status(403).json({ ok: false, message: "You can't change your own role." });
    // }

    m.role = role;
    await m.save();

    return res.json({ ok: true, membershipId: m._id, role: m.role });
  } catch (err) {
    console.error("PATCH /api/partners/:membershipId/role error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Server error" });
  }
});

export default router;