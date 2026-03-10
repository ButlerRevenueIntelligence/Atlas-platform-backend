import express from "express";
import { requireAuth } from "../middleware/auth.js";
import Organization from "../models/Organization.js";

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const orgId =
      req.headers["x-org-id"] ||
      req.user?.orgId ||
      req.user?.organizationId ||
      req.user?.org;

    let organization = null;

    if (orgId) {
      organization = await Organization.findById(orgId).lean();
    }

    return res.json({
      ok: true,
      user: req.user,
      organization,
      billing: organization?.billing || { status: "inactive" }
    });

  } catch (err) {
    console.error("ME route error:", err);
    res.status(500).json({
      ok: false,
      error: "Failed to load user profile"
    });
  }
});

export default router;