// backend/routes/members.js
import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import Membership from "../models/Membership.js";
import User from "../models/User.js";

const router = express.Router();

const toId = (v) => {
  if (!v) return null;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s)
    ? new mongoose.Types.ObjectId(s)
    : null;
};

function pickUserId(req) {
  return (
    toId(req.user?.userId) ||
    toId(req.user?.id) ||
    toId(req.user?._id) ||
    null
  );
}

function pickOrgId(req) {
  const headerOrgId =
    toId(req.headers["x-org-id"]) ||
    toId(req.headers["x-workspace-id"]) ||
    null;

  const defaultOrgId =
    toId(req.user?.orgId) ||
    toId(req.user?.organizationId) ||
    toId(req.user?.org) ||
    toId(req.user?.activeWorkspace) ||
    null;

  return headerOrgId || defaultOrgId || null;
}

async function getOrgContext(req) {
  const userId = pickUserId(req);

  if (!userId) {
    return {
      ok: false,
      status: 401,
      message: "Unauthorized",
      code: "UNAUTHORIZED",
    };
  }

  const orgId = pickOrgId(req);

  if (!orgId) {
    return {
      ok: false,
      status: 400,
      message: "Missing org context (x-org-id).",
      code: "ORG_CONTEXT_REQUIRED",
    };
  }

  const membership = await Membership.findOne({
    userId,
    orgId,
    status: { $ne: "disabled" },
  })
    .select("_id userId orgId workspaceId role status permissions")
    .lean();

  if (!membership) {
    return {
      ok: false,
      status: 403,
      message: "Not a member of this workspace",
      code: "ORG_ACCESS_DENIED",
    };
  }

  const role = String(membership.role || "").toLowerCase();
  const canManageMembers = role === "owner" || role === "admin";

  return {
    ok: true,
    userId,
    orgId,
    membership,
    canManageMembers,
  };
}

const ALLOWED_ROLES = ["owner", "admin", "manager", "analyst", "member", "viewer"];
const ALLOWED_STATUSES = ["active", "invited", "disabled", "suspended"];

/**
 * GET /api/members
 * Owner/Admin in current workspace: list members
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx.ok) {
      return res.status(ctx.status).json({
        ok: false,
        message: ctx.message,
        code: ctx.code,
      });
    }

    if (!ctx.canManageMembers) {
      return res.status(403).json({
        ok: false,
        message: "Only owners and admins can view workspace members.",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }

    const memberships = await Membership.find({
      orgId: ctx.orgId,
      status: { $ne: "disabled" },
    })
      .select("_id userId role status createdAt invitedBy joinedAt lastActiveAt")
      .sort({ createdAt: -1 })
      .lean();

    const userIds = memberships
      .map((m) => m.userId)
      .filter(Boolean);

    const users = await User.find({ _id: { $in: userIds } })
      .select("_id name email")
      .lean();

    const userMap = new Map(users.map((u) => [String(u._id), u]));

    const rows = memberships.map((m) => {
      const u = userMap.get(String(m.userId));

      return {
        membershipId: String(m._id),
        userId: String(m.userId),
        name: u?.name || "User",
        email: u?.email || "",
        role: m.role || "analyst",
        status: m.status || "active",
        createdAt: m.createdAt || null,
        joinedAt: m.joinedAt || null,
        lastActiveAt: m.lastActiveAt || null,
        invitedBy: m.invitedBy || null,
      };
    });

    return res.json({
      ok: true,
      orgId: ctx.orgId,
      membership: {
        role: ctx.membership.role,
        status: ctx.membership.status,
      },
      members: rows,
    });
  } catch (err) {
    console.error("members list error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Server error",
    });
  }
});

/**
 * PUT /api/members/:membershipId
 * Owner/Admin can change role/status
 */
router.put("/:membershipId", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx.ok) {
      return res.status(ctx.status).json({
        ok: false,
        message: ctx.message,
        code: ctx.code,
      });
    }

    if (!ctx.canManageMembers) {
      return res.status(403).json({
        ok: false,
        message: "Only owners and admins can manage workspace members.",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }

    const membershipId = toId(req.params.membershipId);

    if (!membershipId) {
      return res.status(400).json({
        ok: false,
        message: "Invalid membershipId",
      });
    }

    const targetMembership = await Membership.findOne({
      _id: membershipId,
      orgId: ctx.orgId,
    });

    if (!targetMembership) {
      return res.status(404).json({
        ok: false,
        message: "Membership not found",
      });
    }

    const requesterRole = String(ctx.membership.role || "").toLowerCase();
    const targetRole = String(targetMembership.role || "").toLowerCase();

    // admin cannot modify owner
    if (requesterRole !== "owner" && targetRole === "owner") {
      return res.status(403).json({
        ok: false,
        message: "Only the workspace owner can modify another owner.",
        code: "OWNER_ONLY_ACTION",
      });
    }

    // prevent self-disable
    if (
      String(targetMembership.userId) === String(ctx.userId) &&
      req.body?.status &&
      String(req.body.status).toLowerCase() === "disabled"
    ) {
      return res.status(400).json({
        ok: false,
        message: "You cannot disable your own membership.",
        code: "SELF_DISABLE_NOT_ALLOWED",
      });
    }

    const updates = {};

    if (req.body?.role !== undefined) {
      const nextRole = String(req.body.role || "").trim().toLowerCase();

      if (!ALLOWED_ROLES.includes(nextRole)) {
        return res.status(400).json({
          ok: false,
          message: "Invalid role value.",
          code: "INVALID_ROLE",
        });
      }

      // only owner can assign owner
      if (nextRole === "owner" && requesterRole !== "owner") {
        return res.status(403).json({
          ok: false,
          message: "Only the workspace owner can assign the owner role.",
          code: "OWNER_ONLY_ACTION",
        });
      }

      updates.role = nextRole;
    }

    if (req.body?.status !== undefined) {
      const nextStatus = String(req.body.status || "").trim().toLowerCase();

      if (!ALLOWED_STATUSES.includes(nextStatus)) {
        return res.status(400).json({
          ok: false,
          message: "Invalid status value.",
          code: "INVALID_STATUS",
        });
      }

      updates.status = nextStatus;
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({
        ok: false,
        message: "No valid updates provided.",
        code: "NO_UPDATES",
      });
    }

    const updated = await Membership.findOneAndUpdate(
      { _id: membershipId, orgId: ctx.orgId },
      { $set: updates },
      { new: true }
    ).lean();

    return res.json({
      ok: true,
      membership: updated,
    });
  } catch (err) {
    console.error("members update error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Server error",
    });
  }
});

export default router;