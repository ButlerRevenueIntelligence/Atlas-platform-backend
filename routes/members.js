import express from "express";
import mongoose from "mongoose";

import { requireAuth } from "../middleware/auth.js";
import Membership from "../models/Membership.js";
import User from "../models/User.js";

const router = express.Router();

const ALLOWED_ROLES = [
  "admin",
  "manager",
  "analyst",
  "member",
  "viewer",
];

const ALLOWED_STATUSES = [
  "active",
  "suspended",
  "disabled",
];

const toId = (value) => {
  if (!value) return null;

  const stringValue = String(value);

  return mongoose.Types.ObjectId.isValid(stringValue)
    ? new mongoose.Types.ObjectId(stringValue)
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
    .select(
      "_id userId orgId workspaceId role status permissions"
    )
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

  const canManageMembers =
    role === "owner" || role === "admin";

  return {
    ok: true,
    userId,
    orgId,
    membership,
    role,
    canManageMembers,
  };
}

function sendContextError(res, ctx) {
  return res.status(ctx.status).json({
    ok: false,
    message: ctx.message,
    code: ctx.code,
  });
}

function sendPermissionError(
  res,
  message = "Only workspace owners and admins can manage members."
) {
  return res.status(403).json({
    ok: false,
    message,
    code: "INSUFFICIENT_PERMISSIONS",
  });
}

/**
 * Keeps the user's embedded workspace record synchronized without
 * changing the user's global role, status, or active workspace.
 */
async function syncUserWorkspaceMembership({
  userId,
  orgId,
  role,
  status,
}) {
  const setPayload = {};

  if (role) {
    setPayload["workspaces.$[workspace].role"] = role;
  }

  if (status) {
    setPayload["workspaces.$[workspace].status"] = status;
  }

  if (!Object.keys(setPayload).length) {
    return;
  }

  await User.updateOne(
    {
      _id: userId,
      "workspaces.workspace": orgId,
    },
    {
      $set: setPayload,
    },
    {
      arrayFilters: [
        {
          "workspace.workspace": orgId,
        },
      ],
    }
  );
}

/**
 * GET /api/members
 *
 * Owners and admins can list members in the active workspace.
 * Membership records are scoped to the active organization.
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx.ok) {
      return sendContextError(res, ctx);
    }

    if (!ctx.canManageMembers) {
      return sendPermissionError(
        res,
        "Only workspace owners and admins can view members."
      );
    }

    const memberships = await Membership.find({
      orgId: ctx.orgId,
    })
      .select(
        "_id userId role status createdAt invitedBy joinedAt lastActiveAt"
      )
      .sort({ createdAt: -1 })
      .lean();

    const userIds = memberships
      .map((membership) => membership.userId)
      .filter(Boolean);

    const users = await User.find({
      _id: { $in: userIds },
    })
      .select("_id name email lastLoginAt status")
      .lean();

    const userMap = new Map(
      users.map((user) => [String(user._id), user])
    );

    const members = memberships.map((membership) => {
      const user = userMap.get(
        String(membership.userId)
      );

      return {
        membershipId: String(membership._id),
        userId: String(membership.userId),
        name: user?.name || "User",
        email: user?.email || "",
        role: String(
          membership.role || "member"
        ).toLowerCase(),
        membershipStatus: String(
          membership.status || "active"
        ).toLowerCase(),
        userStatus: user?.status || "active",
        createdAt: membership.createdAt || null,
        joinedAt: membership.joinedAt || null,
        lastActiveAt:
          membership.lastActiveAt || null,
        lastLoginAt: user?.lastLoginAt || null,
        invitedBy: membership.invitedBy || null,
        isCurrentUser:
          String(membership.userId) ===
          String(ctx.userId),
        isProtected:
          String(membership.role || "").toLowerCase() ===
          "owner",
      };
    });

    return res.json({
      ok: true,
      orgId: String(ctx.orgId),

      membership: {
        userId: String(ctx.userId),
        role: ctx.role,
        status: String(
          ctx.membership.status || "active"
        ).toLowerCase(),
        canManageMembers: ctx.canManageMembers,
      },

      members,
    });
  } catch (err) {
    console.error("GET /api/members error:", err);

    return res.status(500).json({
      ok: false,
      message: err?.message || "Server error",
    });
  }
});

/**
 * POST /api/members
 *
 * Direct account creation is disabled.
 * New members must use the invitation flow.
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx.ok) {
      return sendContextError(res, ctx);
    }

    if (!ctx.canManageMembers) {
      return sendPermissionError(
        res,
        "Only workspace owners and admins can invite members."
      );
    }

    return res.status(410).json({
      ok: false,
      message:
        "Direct member creation is disabled. Use the workspace invitation flow.",
      code: "USE_INVITATION_FLOW",
    });
  } catch (err) {
    console.error("POST /api/members error:", err);

    return res.status(500).json({
      ok: false,
      message: err?.message || "Server error",
    });
  }
});

/**
 * PATCH /api/members/:membershipId
 *
 * Updates a workspace-specific role or status.
 * It does not change the user's global Atlas account.
 */
router.patch(
  "/:membershipId",
  requireAuth,
  async (req, res) => {
    try {
      const ctx = await getOrgContext(req);

      if (!ctx.ok) {
        return sendContextError(res, ctx);
      }

      if (!ctx.canManageMembers) {
        return sendPermissionError(res);
      }

      const membershipId = toId(
        req.params.membershipId
      );

      if (!membershipId) {
        return res.status(400).json({
          ok: false,
          message: "Invalid membership ID.",
          code: "INVALID_MEMBERSHIP_ID",
        });
      }

      const targetMembership =
        await Membership.findOne({
          _id: membershipId,
          orgId: ctx.orgId,
        });

      if (!targetMembership) {
        return res.status(404).json({
          ok: false,
          message: "Membership not found.",
          code: "MEMBERSHIP_NOT_FOUND",
        });
      }

      const targetRole = String(
        targetMembership.role || ""
      ).toLowerCase();

      const isCurrentUser =
        String(targetMembership.userId) ===
        String(ctx.userId);

      if (isCurrentUser) {
        return res.status(403).json({
          ok: false,
          message:
            "You cannot change your own role or workspace status.",
          code: "SELF_MODIFY_NOT_ALLOWED",
        });
      }

      if (targetRole === "owner") {
        return res.status(403).json({
          ok: false,
          message:
            "The workspace owner cannot be modified through member access controls.",
          code: "OWNER_PROTECTED",
        });
      }

      if (
        ctx.role !== "owner" &&
        targetRole === "admin"
      ) {
        return res.status(403).json({
          ok: false,
          message:
            "Only the workspace owner can modify an administrator.",
          code: "OWNER_ONLY_ACTION",
        });
      }

      const updates = {};

      if (req.body?.role !== undefined) {
        const nextRole = String(
          req.body.role || ""
        )
          .trim()
          .toLowerCase();

        if (nextRole === "owner") {
          return res.status(403).json({
            ok: false,
            message:
              "Ownership cannot be assigned through member access controls.",
            code: "OWNER_PROTECTED",
          });
        }

        if (!ALLOWED_ROLES.includes(nextRole)) {
          return res.status(400).json({
            ok: false,
            message: "Invalid role value.",
            code: "INVALID_ROLE",
          });
        }

        if (
          nextRole === "admin" &&
          ctx.role !== "owner"
        ) {
          return res.status(403).json({
            ok: false,
            message:
              "Only the workspace owner can assign the admin role.",
            code: "OWNER_ONLY_ACTION",
          });
        }

        updates.role = nextRole;
      }

      const requestedStatus =
        req.body?.membershipStatus !== undefined
          ? req.body.membershipStatus
          : req.body?.status;

      if (requestedStatus !== undefined) {
        const nextStatus = String(
          requestedStatus || ""
        )
          .trim()
          .toLowerCase();

        if (!ALLOWED_STATUSES.includes(nextStatus)) {
          return res.status(400).json({
            ok: false,
            message: "Invalid membership status.",
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

      const updated =
        await Membership.findOneAndUpdate(
          {
            _id: membershipId,
            orgId: ctx.orgId,
          },
          {
            $set: updates,
          },
          {
            new: true,
            runValidators: true,
          }
        ).lean();

      await syncUserWorkspaceMembership({
        userId: updated.userId,
        orgId: ctx.orgId,
        role: updated.role,
        status: updated.status,
      });

      return res.json({
        ok: true,
        membership: {
          membershipId: String(updated._id),
          userId: String(updated.userId),
          role: updated.role,
          membershipStatus: updated.status,
        },
      });
    } catch (err) {
      console.error(
        "PATCH /api/members/:membershipId error:",
        err
      );

      return res.status(500).json({
        ok: false,
        message: err?.message || "Server error",
      });
    }
  }
);

/**
 * POST /api/members/:membershipId/reset-password
 *
 * Workspace administrators cannot replace another user's global
 * Atlas password. Users must use secure password recovery.
 */
router.post(
  "/:membershipId/reset-password",
  requireAuth,
  async (req, res) => {
    try {
      const ctx = await getOrgContext(req);

      if (!ctx.ok) {
        return sendContextError(res, ctx);
      }

      if (!ctx.canManageMembers) {
        return sendPermissionError(res);
      }

      return res.status(410).json({
        ok: false,
        message:
          "Administrator password replacement is disabled. The member must use the secure forgot-password flow.",
        code: "USE_PASSWORD_RECOVERY",
      });
    } catch (err) {
      console.error(
        "POST /api/members/:membershipId/reset-password error:",
        err
      );

      return res.status(500).json({
        ok: false,
        message: err?.message || "Server error",
      });
    }
  }
);

/**
 * DELETE /api/members/:membershipId
 *
 * Removes access to only the active workspace.
 * The user's global Atlas account is not deleted.
 */
router.delete(
  "/:membershipId",
  requireAuth,
  async (req, res) => {
    try {
      const ctx = await getOrgContext(req);

      if (!ctx.ok) {
        return sendContextError(res, ctx);
      }

      if (!ctx.canManageMembers) {
        return sendPermissionError(res);
      }

      const membershipId = toId(
        req.params.membershipId
      );

      if (!membershipId) {
        return res.status(400).json({
          ok: false,
          message: "Invalid membership ID.",
          code: "INVALID_MEMBERSHIP_ID",
        });
      }

      const targetMembership =
        await Membership.findOne({
          _id: membershipId,
          orgId: ctx.orgId,
        });

      if (!targetMembership) {
        return res.status(404).json({
          ok: false,
          message: "Membership not found.",
          code: "MEMBERSHIP_NOT_FOUND",
        });
      }

      const targetRole = String(
        targetMembership.role || ""
      ).toLowerCase();

      const isCurrentUser =
        String(targetMembership.userId) ===
        String(ctx.userId);

      if (isCurrentUser) {
        return res.status(403).json({
          ok: false,
          message:
            "You cannot remove your own workspace access.",
          code: "SELF_REMOVE_NOT_ALLOWED",
        });
      }

      if (targetRole === "owner") {
        return res.status(403).json({
          ok: false,
          message:
            "The workspace owner cannot be removed through member access controls.",
          code: "OWNER_PROTECTED",
        });
      }

      if (
        ctx.role !== "owner" &&
        targetRole === "admin"
      ) {
        return res.status(403).json({
          ok: false,
          message:
            "Only the workspace owner can remove an administrator.",
          code: "OWNER_ONLY_ACTION",
        });
      }

      await Membership.deleteOne({
        _id: membershipId,
        orgId: ctx.orgId,
      });

      await User.updateOne(
        {
          _id: targetMembership.userId,
        },
        {
          $pull: {
            workspaces: {
              workspace: ctx.orgId,
            },
          },
        }
      );

      return res.json({
        ok: true,
        message:
          "Member access was removed from this workspace.",
      });
    } catch (err) {
      console.error(
        "DELETE /api/members/:membershipId error:",
        err
      );

      return res.status(500).json({
        ok: false,
        message: err?.message || "Server error",
      });
    }
  }
);

export default router;
