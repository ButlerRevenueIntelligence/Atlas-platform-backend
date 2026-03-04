// backend/routes/org.js
import express from "express";
import mongoose from "mongoose";
import Membership from "../models/Membership.js";
import Organization from "../models/Organization.js";
import { requireUser, requireAuth } from "../middleware/auth.js";

const router = express.Router();

// ✅ user-only auth so the UI can discover orgs BEFORE x-org-id exists
router.get("/mine", requireUser, async (req, res) => {
  try {
    const userIdRaw = req.user?.userId || req.user?._id || req.user?.id;
    if (!userIdRaw) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const userId = new mongoose.Types.ObjectId(String(userIdRaw));

    // memberships for this user
    const memberships = await Membership.find({ userId, status: "active" })
      .select("orgId role status")
      .lean();

    const orgIds = memberships.map((m) => m.orgId).filter(Boolean);

    // pull orgs
    const orgDocs = await Organization.find({ _id: { $in: orgIds } })
      .select("_id name slug plan type")
      .lean();

    // map orgId -> org doc
    const orgMap = new Map(orgDocs.map((o) => [String(o._id), o]));

    // return a UI-friendly shape
    const orgs = memberships
      .map((m) => {
        const org = orgMap.get(String(m.orgId));
        if (!org) return null;

        return {
          orgId: org._id,
          orgName: org.name,
          role: m.role || "member",

          // optional extras (safe)
          slug: org.slug,
          plan: org.plan,
          type: org.type,
        };
      })
      .filter(Boolean);

    return res.json({ ok: true, orgs });
  } catch (e) {
    console.error("org/mine error:", e);
    return res.status(500).json({ ok: false, error: "org/mine failed" });
  }
});

// everything else can stay org-locked
router.use(requireAuth);

export default router;