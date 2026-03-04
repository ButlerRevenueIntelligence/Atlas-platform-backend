// backend/routes/invites.js
import express from "express";
import mongoose from "mongoose";
import crypto from "crypto";
import { requireAuth } from "../middleware/auth.js";
import Membership from "../models/Membership.js";
import Invite from "../models/Invite.js";

const router = express.Router();

const toObjectId = (v) => {
  if (!v) return null;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
};

async function requireMembership(req) {
  const userId = toObjectId(req.user?.userId);
  if (!userId) return { ok: false, status: 401, message: "Unauthorized" };

  const headerOrgId = toObjectId(req.headers["x-org-id"]);
  const defaultOrgId = toObjectId(req.user?.orgId);
  const orgId = headerOrgId || defaultOrgId;

  if (!orgId) return { ok: false, status: 400, message: "No workspace selected" };

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

function canInvite(role) {
  // tighten later if you want (owner/admin only)
  return role === "owner" || role === "admin";
}

/**
 * Mounted as:
 *   app.use("/api/invites", router)
 */

// GET /api/invites
router.get("/", requireAuth, async (req, res) => {
  try {
    const ctx = await requireMembership(req);
    if (!ctx.ok) return res.status(ctx.status).json({ ok: false, message: ctx.message });

    const invites = await Invite.find({ orgId: ctx.orgId })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return res.status(200).json({ ok: true, invites });
  } catch (err) {
    console.error("Invites list error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Failed to list invites" });
  }
});

// POST /api/invites  (create)
router.post("/", requireAuth, async (req, res) => {
  try {
    const ctx = await requireMembership(req);
    if (!ctx.ok) return res.status(ctx.status).json({ ok: false, message: ctx.message });

    if (!canInvite(ctx.membership.role)) {
      return res.status(403).json({ ok: false, message: "Only admins can create invites" });
    }

    const email = String(req.body?.email || "").trim().toLowerCase();
    const role = String(req.body?.role || "analyst").trim();

    if (!email) return res.status(400).json({ ok: false, message: "Email is required" });

    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const invite = await Invite.create({
      orgId: ctx.orgId,
      createdBy: ctx.userId,
      email,
      role,
      status: "pending",
      token,
      expiresAt,
    });

    return res.status(201).json({ ok: true, invite });
  } catch (err) {
    console.error("Invite create error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Failed to create invite" });
  }
});

// GET /api/invites/token/:token  (public-ish but still auth-gated for now)
router.get("/token/:token", requireAuth, async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token) return res.status(400).json({ ok: false, message: "Missing token" });

    const invite = await Invite.findOne({ token }).lean();
    if (!invite) return res.status(404).json({ ok: false, message: "Invite not found" });

    return res.status(200).json({ ok: true, invite });
  } catch (err) {
    console.error("Invite get error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Failed to get invite" });
  }
});

// POST /api/invites/accept  { token }
router.post("/accept", requireAuth, async (req, res) => {
  try {
    const userId = toObjectId(req.user?.userId);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const token = String(req.body?.token || "").trim();
    if (!token) return res.status(400).json({ ok: false, message: "Token is required" });

    const invite = await Invite.findOne({ token });
    if (!invite) return res.status(404).json({ ok: false, message: "Invite not found" });

    // expired?
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
      invite.status = "expired";
      await invite.save();
      return res.status(410).json({ ok: false, message: "Invite expired" });
    }

    if (invite.status === "accepted") {
      return res.status(200).json({ ok: true, message: "Already accepted" });
    }

    // create membership if not exists
    const exists = await Membership.findOne({
      userId,
      orgId: invite.orgId,
      status: { $ne: "disabled" },
    }).lean();

    if (!exists) {
      await Membership.create({
        userId,
        orgId: invite.orgId,
        role: invite.role || "analyst",
        status: "active",
      });
    }

    invite.status = "accepted";
    invite.acceptedAt = new Date();
    invite.acceptedBy = userId;
    await invite.save();

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Invite accept error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Failed to accept invite" });
  }
});

export default router;