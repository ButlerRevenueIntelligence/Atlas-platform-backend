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
/* SIGNUP */
/* ------------------------------------------------ */
router.post("/signup", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const company = String(req.body?.company || "").trim();

    if (!name || !email || !password) {
      return res.status(400).json({ ok: false, message: "Name, email, password required" });
    }

    if (password.length < 8) {
      return res.status(400).json({ ok: false, message: "Password must be 8+ characters" });
    }

    const existing = await User.findOne({ email }).lean();
    if (existing) {
      return res.status(409).json({ ok: false, message: "Email already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await User.create({
      name,
      email,
      passwordHash,
      company,
      role: "admin",
      orgId: null,
    });

    const org = await Organization.create({
      name: company || `${name}'s Organization`,
      slug: `org-${Date.now()}`,
      ownerId: user._id,
      plan: "SCALE", // default
    });

    await User.updateOne({ _id: user._id }, { $set: { orgId: org._id } });

    await Membership.create({
      userId: user._id,
      orgId: org._id,
      role: "owner",
      status: "active",
      permissions: FULL_PERMS, // ✅ give owner full perms on signup
    });

    const token = signToken({
      userId: user._id,
      email: user.email,
      role: "owner",
      orgId: org._id,
    });

    return res.status(201).json({
      ok: true,
      token,
      user: {
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: "owner",
        orgId: String(org._id),
        orgName: org.name || "",
        plan: org.plan || "SCALE",
        permissions: FULL_PERMS,
      },
    });
  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

/* ------------------------------------------------ */
/* LOGIN (✅ FIXED) */
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

    // ✅ Determine active org
    const orgId = user.orgId ? String(user.orgId) : "";

    // ✅ Load membership + org (plan/name)
    let membership = null;
    let org = null;

    if (orgId) {
      membership = await Membership.findOne({ userId: user._id, orgId: user.orgId });
      org = await Organization.findById(user.orgId).lean();
    } else {
      // fallback: if user has any membership, use the first one
      membership = await Membership.findOne({ userId: user._id });
      if (membership?.orgId) {
        org = await Organization.findById(membership.orgId).lean();
      }
    }

    const orgRole = membership?.role || user.role || "member";

    // ✅ permissions:
    // - if admin/owner => always full perms
    // - else use membership.permissions
    let permissions = Array.isArray(membership?.permissions) ? membership.permissions : [];
    if (orgRole === "admin" || orgRole === "owner") {
      permissions = FULL_PERMS;
    }

    // ✅ plan comes from org (not from frontend guessing)
    const plan = org?.plan || "SCALE";

    // ✅ Sign token using orgRole (so backend auth knows you're admin/owner)
    const token = signToken({
      userId: user._id,
      email: user.email,
      role: orgRole,
      orgId: membership?.orgId || user.orgId,
    });

    return res.json({
      ok: true,
      token,
      user: {
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: orgRole,
        orgId: membership?.orgId ? String(membership.orgId) : (user.orgId ? String(user.orgId) : ""),
        orgName: org?.name || "",
        plan,
        permissions,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

/* ------------------------------------------------ */
/* ME (LOCKED VERSION) */
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