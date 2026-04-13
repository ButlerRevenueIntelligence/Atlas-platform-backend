import express from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

import { requireAuth } from "../middleware/auth.js";
import Membership from "../models/Membership.js";
import User from "../models/User.js";

const router = express.Router();

const ALLOWED_ROLES = ["owner", "admin", "manager", "analyst", "member", "viewer"];
const ALLOWED_STATUSES = ["active", "invited", "disabled", "suspended"];

const toId = (v) => {
  if (!v) return null;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s)
    ? new mongoose.Types.ObjectId(s)
    : null;
};

const normalizeEmail = (v) => String(v || "").trim().toLowerCase();

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

    const userIds = memberships.map((m) => m.userId).filter(Boolean);

    const users = await User.find({ _id: { $in: userIds } })
      .select("_id name email lastLoginAt status")
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
        membershipStatus: m.status || "active",
        userStatus: u?.status || "active",
        createdAt: m.createdAt || null,
        joinedAt: m.joinedAt || null,
        lastActiveAt: m.lastActiveAt || null,
        lastLoginAt: u?.lastLoginAt || null,
        invitedBy: m.invitedBy || null,
      };
    });

    return res.json({
      ok: true,
      orgId: String(ctx.orgId),
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
 * POST /api/members
 * Owner/Admin can create a member in current workspace
 */
router.post("/", requireAuth, async (req, res) => {
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
        message: "Only owners and admins can create workspace members.",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }

    const name = String(req.body?.name || "").trim();
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const role = String(req.body?.role || "member").trim().toLowerCase();
    const membershipStatus = String(req.body?.status || "active").trim().toLowerCase();

    if (!name || !email || !password) {
      return res.status(400).json({
        ok: false,
        message: "Name, email, and password are required.",
        code: "REQUIRED_FIELDS_MISSING",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        ok: false,
        message: "Password must be at least 8 characters.",
        code: "PASSWORD_TOO_SHORT",
      });
    }

    if (!ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid role value.",
        code: "INVALID_ROLE",
      });
    }

    if (!ALLOWED_STATUSES.includes(membershipStatus)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid status value.",
        code: "INVALID_STATUS",
      });
    }

    const requesterRole = String(ctx.membership.role || "").toLowerCase();

    if (role === "owner" && requesterRole !== "owner") {
      return res.status(403).json({
        ok: false,
        message: "Only the workspace owner can assign the owner role.",
        code: "OWNER_ONLY_ACTION",
      });
    }

    let user = await User.findOne({ email }).select("_id name email orgId activeWorkspace role status");

    if (user) {
      const existingMembership = await Membership.findOne({
        userId: user._id,
        orgId: ctx.orgId,
      }).lean();

      if (existingMembership) {
        return res.status(409).json({
          ok: false,
          message: "This user is already a member of the workspace.",
          code: "MEMBER_ALREADY_EXISTS",
        });
      }
    } else {
      const passwordHash = await bcrypt.hash(password, 10);

      user = await User.create({
        name,
        email,
        passwordHash,
        orgId: ctx.orgId,
        activeWorkspace: ctx.orgId,
        role,
        status: membershipStatus === "invited" ? "invited" : "active",
        workspaces: [
          {
            workspace: ctx.orgId,
            role,
            status: membershipStatus,
          },
        ],
      });
    }

    const createdMembership = await Membership.create({
      userId: user._id,
      orgId: ctx.orgId,
      workspaceId: ctx.orgId,
      role,
      status: membershipStatus,
      invitedBy: ctx.userId,
      joinedAt: membershipStatus === "active" ? new Date() : null,
    });

    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          name,
          email,
          orgId: user.orgId || ctx.orgId,
          activeWorkspace: user.activeWorkspace || ctx.orgId,
          role,
          status: membershipStatus === "invited" ? "invited" : "active",
        },
        $pull: {
          workspaces: { workspace: ctx.orgId },
        },
      }
    );

    await User.updateOne(
      { _id: user._id },
      {
        $push: {
          workspaces: {
            workspace: ctx.orgId,
            role,
            status: membershipStatus,
          },
        },
        $unset: {
          password: "",
        },
      }
    );

    const freshUser = await User.findById(user._id)
      .select("_id name email lastLoginAt status")
      .lean();

    return res.status(201).json({
      ok: true,
      member: {
        membershipId: String(createdMembership._id),
        userId: String(freshUser._id),
        name: freshUser.name || "User",
        email: freshUser.email || "",
        role: createdMembership.role || role,
        membershipStatus: createdMembership.status || membershipStatus,
        userStatus: freshUser.status || "active",
        createdAt: createdMembership.createdAt || null,
        joinedAt: createdMembership.joinedAt || null,
        lastActiveAt: createdMembership.lastActiveAt || null,
        lastLoginAt: freshUser.lastLoginAt || null,
      },
    });
  } catch (err) {
    console.error("members create error:", err);

    if (err?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message: "A duplicate member record was detected.",
        code: "DUPLICATE_KEY",
      });
    }

    return res.status(500).json({
      ok: false,
      message: err?.message || "Server error",
    });
  }
});

/**
 * PATCH /api/members/:membershipId
 * Owner/Admin can change role/status
 */
router.patch("/:membershipId", requireAuth, async (req, res) => {
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

    if (requesterRole !== "owner" && targetRole === "owner") {
      return res.status(403).json({
        ok: false,
        message: "Only the workspace owner can modify another owner.",
        code: "OWNER_ONLY_ACTION",
      });
    }

    const requestedStatus =
      req.body?.membershipStatus !== undefined
        ? req.body.membershipStatus
        : req.body?.status;

    if (
      String(targetMembership.userId) === String(ctx.userId) &&
      requestedStatus &&
      String(requestedStatus).toLowerCase() === "disabled"
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

      if (nextRole === "owner" && requesterRole !== "owner") {
        return res.status(403).json({
          ok: false,
          message: "Only the workspace owner can assign the owner role.",
          code: "OWNER_ONLY_ACTION",
        });
      }

      updates.role = nextRole;
    }

    if (requestedStatus !== undefined) {
      const nextStatus = String(requestedStatus || "").trim().toLowerCase();

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

    if (updated?.role || updated?.status) {
      const setPayload = {};
      if (updated.role) setPayload.role = updated.role;

      if (updated.status === "disabled" || updated.status === "suspended") {
        setPayload.status = updated.status;
      } else if (updated.status === "active" || updated.status === "invited") {
        setPayload.status = updated.status === "invited" ? "invited" : "active";
      }

      await User.updateOne(
        { _id: updated.userId },
        {
          $set: setPayload,
          $pull: {
            workspaces: { workspace: ctx.orgId },
          },
        }
      );

      await User.updateOne(
        { _id: updated.userId },
        {
          $push: {
            workspaces: {
              workspace: ctx.orgId,
              role: updated.role || "member",
              status: updated.status || "active",
            },
          },
        }
      );
    }

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

/**
 * POST /api/members/:membershipId/reset-password
 * Owner/Admin can reset a member password
 */
router.post("/:membershipId/reset-password", requireAuth, async (req, res) => {
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
        message: "Only owners and admins can reset member passwords.",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }

    const membershipId = toId(req.params.membershipId);
    const newPassword = String(req.body?.newPassword || "");

    if (!membershipId) {
      return res.status(400).json({
        ok: false,
        message: "Invalid membershipId",
      });
    }

    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({
        ok: false,
        message: "New password must be at least 8 characters.",
        code: "PASSWORD_TOO_SHORT",
      });
    }

    const targetMembership = await Membership.findOne({
      _id: membershipId,
      orgId: ctx.orgId,
    }).lean();

    if (!targetMembership) {
      return res.status(404).json({
        ok: false,
        message: "Membership not found",
      });
    }

    const requesterRole = String(ctx.membership.role || "").toLowerCase();
    const targetRole = String(targetMembership.role || "").toLowerCase();

    if (requesterRole !== "owner" && targetRole === "owner") {
      return res.status(403).json({
        ok: false,
        message: "Only the workspace owner can reset another owner password.",
        code: "OWNER_ONLY_ACTION",
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await User.updateOne(
      { _id: targetMembership.userId },
      {
        $set: {
          passwordHash,
          resetToken: null,
          resetTokenExpiry: null,
        },
        $unset: {
          password: "",
        },
      }
    );

    return res.json({
      ok: true,
      message: "Password reset successfully.",
    });
  } catch (err) {
    console.error("members reset password error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Server error",
    });
  }
});

/**
 * DELETE /api/members/:membershipId
 * Owner/Admin can remove a member from the current workspace
 */
router.delete("/:membershipId", requireAuth, async (req, res) => {
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

    if (String(targetMembership.userId) === String(ctx.userId)) {
      return res.status(400).json({
        ok: false,
        message: "You cannot remove your own membership.",
        code: "SELF_REMOVE_NOT_ALLOWED",
      });
    }

    if (requesterRole !== "owner" && targetRole === "owner") {
      return res.status(403).json({
        ok: false,
        message: "Only the workspace owner can remove another owner.",
        code: "OWNER_ONLY_ACTION",
      });
    }

    await Membership.deleteOne({
      _id: membershipId,
      orgId: ctx.orgId,
    });

    await User.updateOne(
      { _id: targetMembership.userId },
      {
        $pull: {
          workspaces: { workspace: ctx.orgId },
        },
      }
    );

    return res.json({
      ok: true,
      message: "Member removed from workspace",
    });
  } catch (err) {
    console.error("members delete error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Server error",
    });
  }
});

export default router;