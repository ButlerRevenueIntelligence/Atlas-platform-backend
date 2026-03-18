import express from "express";
import Organization from "../models/Organization.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.post("/start", requireAuth, async (req, res) => {
  try {
    const orgId =
      req.headers["x-org-id"] ||
      req.body.orgId ||
      req.user?.orgId ||
      "";

    if (!orgId) {
      return res.status(400).json({ ok: false, message: "Organization ID is required" });
    }

    const org = await Organization.findById(orgId);

    if (!org) {
      return res.status(404).json({ ok: false, message: "Organization not found" });
    }

    if (org.trial?.status === "trialing") {
      return res.json({
        ok: true,
        message: "Trial already active",
        trial: org.trial,
      });
    }

    if (org.trial?.status === "converted") {
      return res.status(400).json({
        ok: false,
        message: "This workspace already converted from trial",
      });
    }

    const now = new Date();
    const endsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    org.plan = "GROWTH";
    org.paymentStatus = "pending";
    org.accessStatus = "active";
    org.approvedForAccess = true;

    org.billing = {
      ...(org.billing || {}),
      status: "trialing",
    };

    org.trial = {
      startedAt: now,
      endsAt,
      status: "trialing",
    };

    await org.save();

    return res.json({
      ok: true,
      message: "Free trial started",
      trial: org.trial,
      plan: org.plan,
    });
  } catch (err) {
    console.error("Start trial failed:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to start free trial",
    });
  }
});

export default router;