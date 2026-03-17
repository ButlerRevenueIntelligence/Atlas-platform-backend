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
  return mongoose.Types.ObjectId.isValid(s)
    ? new mongoose.Types.ObjectId(s)
    : null;
};

function pickUserId(req) {
  return (
    toObjectId(req.user?.userId) ||
    toObjectId(req.user?.id) ||
    toObjectId(req.user?._id) ||
    null
  );
}

function pickOrgId(req) {
  const header =
    req.headers["x-org-id"] ||
    req.headers["x-workspace-id"] ||
    null;

  const headerOrgId = toObjectId(header);

  const defaultOrgId =
    toObjectId(req.user?.orgId) ||
    toObjectId(req.user?.organizationId) ||
    toObjectId(req.user?.org) ||
    toObjectId(req.user?.activeWorkspace) ||
    null;

  return headerOrgId || defaultOrgId || null;
}

async function requireMembershipOr403({ userId, orgId }) {
  const membership = await Membership.findOne({
    userId,
    orgId,
    status: { $ne: "disabled" },
  })
    .select("_id role status userId orgId")
    .lean();

  return membership || null;
}

function canEditAccount(role) {
  return ["owner", "admin", "manager"].includes(String(role || "").toLowerCase());
}

/**
 * GET /api/accounts
 * List accounts for active org/workspace
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = pickUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const orgId = pickOrgId(req);
    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context (x-org-id).",
        code: "ORG_CONTEXT_REQUIRED",
      });
    }

    const membership = await requireMembershipOr403({ userId, orgId });
    if (!membership) {
      return res.status(403).json({
        ok: false,
        message: "Not a member of this workspace",
        code: "ORG_ACCESS_DENIED",
      });
    }

    const accounts = await Account.find({ orgId })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      ok: true,
      orgId,
      membership: {
        role: membership.role,
        status: membership.status,
      },
      accounts,
    });
  } catch (err) {
    console.error("GET /accounts error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to load accounts.",
    });
  }
});

/**
 * POST /api/accounts
 * Create an account for active org/workspace
 * body: { name, industry, website, status, notes }
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    const userId = pickUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const orgId = pickOrgId(req);
    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context (x-org-id).",
        code: "ORG_CONTEXT_REQUIRED",
      });
    }

    const membership = await requireMembershipOr403({ userId, orgId });
    if (!membership) {
      return res.status(403).json({
        ok: false,
        message: "Not a member of this workspace",
        code: "ORG_ACCESS_DENIED",
      });
    }

    if (!canEditAccount(membership.role)) {
      return res.status(403).json({
        ok: false,
        message: "You do not have permission to create accounts.",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }

    const {
      name,
      industry = "",
      website = "",
      status = "Active",
      notes = "",
    } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        ok: false,
        message: "Account name is required.",
      });
    }

    const doc = await Account.create({
  orgId,
  workspaceId: orgId,
  ownerUserId: userId,
  name: String(name).trim(),
  industry: String(industry || "").trim(),
  website: String(website || "").trim(),
  status: String(status || "Active").trim(),
  notes: String(notes || "").trim(),
});

    return res.status(201).json({
      ok: true,
      account: doc,
    });
  } catch (err) {
    console.error("POST /accounts error:", err);

    if (err?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message: "An account with that name already exists in this org.",
      });
    }

    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to create account.",
    });
  }
});

/**
 * GET /api/accounts/:id
 */
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const userId = pickUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const orgId = pickOrgId(req);
    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context (x-org-id).",
        code: "ORG_CONTEXT_REQUIRED",
      });
    }

    const membership = await requireMembershipOr403({ userId, orgId });
    if (!membership) {
      return res.status(403).json({
        ok: false,
        message: "Not a member of this workspace",
        code: "ORG_ACCESS_DENIED",
      });
    }

    const accountId = toObjectId(req.params?.id);
    if (!accountId) {
      return res.status(400).json({
        ok: false,
        message: "Invalid account id.",
      });
    }

    const account = await Account.findOne({ _id: accountId, orgId }).lean();
    if (!account) {
      return res.status(404).json({
        ok: false,
        message: "Account not found.",
      });
    }

    return res.json({
      ok: true,
      account,
      membership: {
        role: membership.role,
        status: membership.status,
      },
    });
  } catch (err) {
    console.error("GET /accounts/:id error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to load account.",
    });
  }
});

/**
 * PUT /api/accounts/:id
 * body: { name?, industry?, website?, status?, notes? }
 */
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const userId = pickUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const orgId = pickOrgId(req);
    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context (x-org-id).",
        code: "ORG_CONTEXT_REQUIRED",
      });
    }

    const membership = await requireMembershipOr403({ userId, orgId });
    if (!membership) {
      return res.status(403).json({
        ok: false,
        message: "Not a member of this workspace",
        code: "ORG_ACCESS_DENIED",
      });
    }

    if (!canEditAccount(membership.role)) {
      return res.status(403).json({
        ok: false,
        message: "You do not have permission to update accounts.",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }

    const accountId = toObjectId(req.params?.id);
    if (!accountId) {
      return res.status(400).json({
        ok: false,
        message: "Invalid account id.",
      });
    }

    const body = req.body || {};
    const patch = {};

    if (body.name !== undefined) patch.name = String(body.name || "").trim();
    if (body.industry !== undefined) patch.industry = String(body.industry || "").trim();
    if (body.website !== undefined) patch.website = String(body.website || "").trim();
    if (body.status !== undefined) patch.status = String(body.status || "").trim();
    if (body.notes !== undefined) patch.notes = String(body.notes || "").trim();

    if (patch.name !== undefined && !patch.name) {
      return res.status(400).json({
        ok: false,
        message: "Account name cannot be empty.",
      });
    }

    const updated = await Account.findOneAndUpdate(
      { _id: accountId, orgId },
      { $set: patch },
      { new: true }
    ).lean();

    if (!updated) {
      return res.status(404).json({
        ok: false,
        message: "Account not found.",
      });
    }

    return res.json({
      ok: true,
      account: updated,
    });
  } catch (err) {
    console.error("PUT /accounts/:id error:", err);

    if (err?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message: "An account with that name already exists in this org.",
      });
    }

    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to update account.",
    });
  }
});

/**
 * DELETE /api/accounts/:id
 */
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const userId = pickUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const orgId = pickOrgId(req);
    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context (x-org-id).",
        code: "ORG_CONTEXT_REQUIRED",
      });
    }

    const membership = await requireMembershipOr403({ userId, orgId });
    if (!membership) {
      return res.status(403).json({
        ok: false,
        message: "Not a member of this workspace",
        code: "ORG_ACCESS_DENIED",
      });
    }

    if (!canEditAccount(membership.role)) {
      return res.status(403).json({
        ok: false,
        message: "You do not have permission to delete accounts.",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }

    const accountId = toObjectId(req.params?.id);
    if (!accountId) {
      return res.status(400).json({
        ok: false,
        message: "Invalid account id.",
      });
    }

    const deleted = await Account.findOneAndDelete({ _id: accountId, orgId }).lean();
    if (!deleted) {
      return res.status(404).json({
        ok: false,
        message: "Account not found.",
      });
    }

    return res.json({
      ok: true,
      removed: true,
    });
  } catch (err) {
    console.error("DELETE /accounts/:id error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to delete account.",
    });
  }
});

export default router;