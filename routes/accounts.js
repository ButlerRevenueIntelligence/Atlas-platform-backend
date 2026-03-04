// backend/routes/accounts.js
import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import Account from "../models/Account.js";
import Membership from "../models/Membership.js";

const router = express.Router();

const toObjectId = (v) => {
  if (!v) return null;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
};

function pickOrgId(req) {
  // Prefer tenant header set by workspace switch
  const header = req.headers["x-org-id"] || req.headers["X-Org-Id"];
  const headerOrgId = toObjectId(header);

  // Fallback to user default orgId from token/user record
  const defaultOrgId = toObjectId(req.user?.orgId);

  return headerOrgId || defaultOrgId || null;
}

async function requireMembershipOr403({ userId, orgId }) {
  const m = await Membership.findOne({
    userId,
    orgId,
    status: { $ne: "disabled" },
  })
    .select("_id role status")
    .lean();

  return m || null;
}

/**
 * GET /api/accounts
 * List accounts for active org
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = toObjectId(req.user?.userId);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const orgId = pickOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context (x-org-id)." });

    const membership = await requireMembershipOr403({ userId, orgId });
    if (!membership) return res.status(403).json({ ok: false, message: "Not a member of this workspace" });

    const accounts = await Account.find({ orgId })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ ok: true, accounts });
  } catch (err) {
    console.error("GET /accounts error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Failed to load accounts." });
  }
});

/**
 * POST /api/accounts
 * Create an account for active org
 * body: { name, industry, website, status, notes }
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    const userId = toObjectId(req.user?.userId);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const orgId = pickOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context (x-org-id)." });

    const membership = await requireMembershipOr403({ userId, orgId });
    if (!membership) return res.status(403).json({ ok: false, message: "Not a member of this workspace" });

    const { name, industry = "", website = "", status = "Active", notes = "" } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ ok: false, message: "Account name is required." });
    }

    const doc = await Account.create({
      orgId,
      ownerUserId: userId, // ✅ correct id
      name: String(name).trim(),
      industry: String(industry || "").trim(),
      website: String(website || "").trim(),
      status,
      notes: String(notes || "").trim(),
    });

    return res.status(201).json({ ok: true, account: doc });
  } catch (err) {
    console.error("POST /accounts error:", err);

    if (err?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message: "An account with that name already exists in this org.",
      });
    }

    return res.status(500).json({ ok: false, message: err?.message || "Failed to create account." });
  }
});

/**
 * GET /api/accounts/:id
 */
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const userId = toObjectId(req.user?.userId);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const orgId = pickOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context (x-org-id)." });

    const membership = await requireMembershipOr403({ userId, orgId });
    if (!membership) return res.status(403).json({ ok: false, message: "Not a member of this workspace" });

    const accountId = toObjectId(req.params?.id);
    if (!accountId) return res.status(400).json({ ok: false, message: "Invalid account id." });

    const account = await Account.findOne({ _id: accountId, orgId }).lean();
    if (!account) return res.status(404).json({ ok: false, message: "Account not found." });

    return res.json({ ok: true, account });
  } catch (err) {
    console.error("GET /accounts/:id error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Failed to load account." });
  }
});

/**
 * PUT /api/accounts/:id
 * body: { name?, industry?, website?, status?, notes? }
 */
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const userId = toObjectId(req.user?.userId);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const orgId = pickOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context (x-org-id)." });

    const membership = await requireMembershipOr403({ userId, orgId });
    if (!membership) return res.status(403).json({ ok: false, message: "Not a member of this workspace" });

    const accountId = toObjectId(req.params?.id);
    if (!accountId) return res.status(400).json({ ok: false, message: "Invalid account id." });

    const patch = {};
    const body = req.body || {};

    if (body.name !== undefined) patch.name = String(body.name || "").trim();
    if (body.industry !== undefined) patch.industry = String(body.industry || "").trim();
    if (body.website !== undefined) patch.website = String(body.website || "").trim();
    if (body.status !== undefined) patch.status = body.status;
    if (body.notes !== undefined) patch.notes = String(body.notes || "").trim();

    if (patch.name !== undefined && !patch.name) {
      return res.status(400).json({ ok: false, message: "Account name cannot be empty." });
    }

    const updated = await Account.findOneAndUpdate(
      { _id: accountId, orgId },
      { $set: patch },
      { new: true }
    ).lean();

    if (!updated) return res.status(404).json({ ok: false, message: "Account not found." });

    return res.json({ ok: true, account: updated });
  } catch (err) {
    console.error("PUT /accounts/:id error:", err);

    if (err?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message: "An account with that name already exists in this org.",
      });
    }

    return res.status(500).json({ ok: false, message: err?.message || "Failed to update account." });
  }
});

/**
 * DELETE /api/accounts/:id
 */
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const userId = toObjectId(req.user?.userId);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const orgId = pickOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context (x-org-id)." });

    const membership = await requireMembershipOr403({ userId, orgId });
    if (!membership) return res.status(403).json({ ok: false, message: "Not a member of this workspace" });

    const accountId = toObjectId(req.params?.id);
    if (!accountId) return res.status(400).json({ ok: false, message: "Invalid account id." });

    const deleted = await Account.findOneAndDelete({ _id: accountId, orgId }).lean();
    if (!deleted) return res.status(404).json({ ok: false, message: "Account not found." });

    return res.json({ ok: true, removed: true });
  } catch (err) {
    console.error("DELETE /accounts/:id error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Failed to delete account." });
  }
});

export default router;