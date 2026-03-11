// backend/routes/auth.js
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import User from "../models/User.js";
import Organization from "../models/Organization.js";
import Membership from "../models/Membership.js";

import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/* ------------------------------------------------ */
/* Defaults */
/* ------------------------------------------------ */
const FULL_PERMS = [
  "overview.view",
  "revenue_intel.view",
  "command_center.view",
  "deal_room.view",
  "market_signals.view",
  "accounts.view",
  "partners.view",
  "admin.view",
];

/* ------------------------------------------------ */
/* JWT helper */
/* ------------------------------------------------ */
function signToken({ userId, email, role, orgId }) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("Missing JWT_SECRET");

  return jwt.sign(
    {
      userId: String(userId),
      email,
      role: role || "user",
      orgId: orgId ? String(orgId) : null,
    },
    secret,
    { expiresIn: "7d" }
  );
}

/* ------------------------------------------------ */
/* Public signup disabled */
/* ------------------------------------------------ */
router.post("/signup", async (req, res) => {
  return res.status(403).json({
    ok: false,
    message:
      "Public signup is disabled. Atlas access is granted after a live demo, approved billing, and workspace invitation.",
  });
});

/* ------------------------------------------------ */
/* LOGIN */
/* ------------------------------------------------ */
router.post("/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({ ok: false, message: "Email + password required" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ ok: false, message: "Invalid credentials" });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({ ok: false, message: "Invalid credentials" });
    }

    let membership = null;
    let org = null;

    if (user.orgId) {
      membership = await Membership.findOne({
        userId: user._id,
        orgId: user.orgId,
        status: { $ne: "disabled" },
      }).lean();

      org = await Organization.findById(user.orgId).lean();
    }

    if (!membership) {
      membership = await Membership.findOne({
        userId: user._id,
        status: { $ne: "disabled" },
      }).lean();

      if (membership?.orgId) {
        org = await Organization.findById(membership.orgId).lean();
      }
    }

    if (!org) {
      return res.status(403).json({
        ok: false,
        message: "No workspace is attached to this account.",
      });
    }

    const orgRole = membership?.role || user.role || "member";

    let permissions = Array.isArray(membership?.permissions)
      ? membership.permissions
      : [];

    if (orgRole === "admin" || orgRole === "owner") {
      permissions = FULL_PERMS;
    }

    /* ------------------------------------------------ */
    /* Workspace access logic */
    /* Accept both old and new org field structures     */
    /* ------------------------------------------------ */
    const accessStatus = String(
      org?.accessStatus ?? org?.status ?? "pending"
    ).toLowerCase();

    const paymentStatus = String(
      org?.paymentStatus ?? org?.billingStatus ?? "pending"
    ).toLowerCase();

    const approvedForAccess =
      typeof org?.approvedForAccess === "boolean"
        ? org.approvedForAccess
        : Boolean(org?.isActive);

    const demoCompleted =
      typeof org?.demoCompleted === "boolean"
        ? org.demoCompleted
        : true;

    const workspaceActive =
      accessStatus === "active" &&
      (paymentStatus === "paid" || paymentStatus === "active") &&
      approvedForAccess &&
      demoCompleted;

    // Founder/admin/owner override
    if (!workspaceActive && orgRole !== "admin" && orgRole !== "owner") {
      return res.status(403).json({
        ok: false,
        message:
          "Your workspace is not active yet. Atlas access is enabled after demo completion, approved billing, and workspace activation.",
      });
    }

    const token = signToken({
      userId: user._id,
      email: user.email,
      role: orgRole,
      orgId: membership?.orgId || user.orgId || org?._id,
    });

    return res.json({
      ok: true,
      token,
      user: {
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: orgRole,
        orgId: membership?.orgId
          ? String(membership.orgId)
          : user.orgId
          ? String(user.orgId)
          : org?._id
          ? String(org._id)
          : "",
        orgName: org?.name || "",
        plan: org?.plan || "SCALE",
        permissions,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

/* ------------------------------------------------ */
/* ME */
/* ------------------------------------------------ */
router.get("/me", requireAuth, async (req, res) => {
  try {
    return res.json({
      ok: true,
      user: {
        id: req.user.userId,
        name: req.user.name,
        email: req.user.email,
        orgId: req.user.orgId,
        orgName: req.user.org?.name || "",
        role: req.user.orgRole || req.user.role || "analyst",
        plan: req.user.plan || "SCALE",
        perms: req.user.permissions || req.user.perms || [],
      },
    });
  } catch (err) {
    console.error("ME error:", err);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

/* ------------------------------------------------ */
router.get("/health", (req, res) => {
  res.json({ ok: true });
});

export default router;