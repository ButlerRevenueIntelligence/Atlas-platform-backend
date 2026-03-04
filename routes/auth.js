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
    });
  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
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

    const token = signToken({
      userId: user._id,
      email: user.email,
      role: user.role,
      orgId: user.orgId,
    });

    return res.json({ ok: true, token });
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
        perms: req.user.perms || [],
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