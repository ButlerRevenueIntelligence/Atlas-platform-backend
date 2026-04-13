import express from "express";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";

import User from "../models/User.js";
import Membership from "../models/Membership.js";
import Organization from "../models/Organization.js";

import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

const ROLE_ENUM = ["owner", "admin", "manager", "analyst", "member", "viewer"];
const STATUS_ENUM = ["active", "invited", "disabled", "suspended"];

const FULL_PERMS = [
  "dashboard.view",
  "command_center.view",
  "deal_room.view",
  "market_signals.view",
  "clients.view",
  "partners.manage",
  "admin.audit",
];

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function normalizeId(v) {
  return v ? String(v) : null;
}

function isObjectId(v) {
  return mongoose.Types.ObjectId.isValid(v);
}

function resolvePermissions(role, explicitPermissions = []) {
  const normalizedRole = String(role || "member").toLowerCase();

  if (normalizedRole === "owner" || normalizedRole === "admin") {
    return FULL_PERMS;
  }

  return Array.isArray(explicitPermissions) ? explicitPermissions : [];
}

async function getRequestContext(req) {
  const userId = req.user?.userId || req.user?.id;
  if (!userId) {
    return { error: { status: 401, message: "Unauthorized" } };
  }

  const dbUser = await User.findById(userId).lean();
  if (!dbUser) {
    return { error: { status: 401, message: "User not found" } };
  }

  if (dbUser.status === "disabled" || dbUser.status === "suspended") {
    return { error: { status: 403, message: "This account is not active." } };
  }

  const requestedOrgId =
    req.headers["x-org-id"] ||
    req.headers["x-workspace-id"] ||
    req.body?.orgId ||
    req.body?.workspaceId ||
    dbUser.activeWorkspace ||
    dbUser.orgId ||
    null;

  if (!requestedOrgId) {
    return { error: { status: 400, message: "No workspace selected." } };
  }

  const actorMembership = await Membership.findOne({
    userId,
    orgId: requestedOrgId,
    status: { $nin: ["disabled", "suspended"] },
  }).lean();

  if (!actorMembership) {
    return { error: { status: 403, message: "No access to this workspace." } };
  }

  const org = await Organization.findById(requestedOrgId).lean();
  if (!org) {
    return { error: { status: 404, message: "Workspace not found." } };
  }

  return {
    actorUser: dbUser,
    actorMembership,
    org,
    orgId: String(requestedOrgId),
  };
}

function canManageMembers(actorRole) {
  return ["owner", "admin"].includes(String(actorRole || "").toLowerCase());
}

function canAssignRole(actorRole, targetRole) {
  const a = String(actorRole || "").toLowerCase();
  const t = String(targetRole || "").toLowerCase();

  if (!ROLE_ENUM.includes(t)) return false;
  if (a === "owner") return true;
  if (a === "admin" && t !== "owner") return true;
  return false;
}

function canEditTarget(actorRole, targetRole, actorUserId, targetUserId) {
  const a = String(actorRole || "").toLowerCase();
  const t = String(targetRole || "").toLowerCase();

  if (a === "owner") return true;
  if (a === "admin") {
    if (t === "owner") return false;
    return true;
  }

  return String(actorUserId) === String(targetUserId);
}

/* ------------------------------------------------ */
/* GET MEMBERS FOR ACTIVE WORKSPACE */
/* ------------------------------------------------ */
router.get("/", requireAuth, async (req, res) => {
  try {
    const ctx = await getRequestContext(req);
    if (ctx.error) {
      return res.status(ctx.error.status).json({
        ok: false,
        message: ctx.error.message,
      });
    }

    const { actorMembership, orgId, org } = ctx;

    if (!canManageMembers(actorMembership.role)) {
      return res.status(403).json({
        ok: false,
        message: "Only owners and admins can view members.",
      });
    }

    const memberships = await Membership.find({
      orgId,
    })
      .sort({ createdAt: 1 })
      .lean();

    const userIds = memberships.map((m) => m.userId).filter(Boolean);

    const users = await User.find({ _id: { $in: userIds } })
      .select("name email status lastLoginAt orgId activeWorkspace role createdAt updatedAt")
      .lean();

    const userMap = new Map(users.map((u) => [String(u._id), u]));

    const members = memberships
      .map((m) => {
        const user = userMap.get(String(m.userId));
        if (!user) return null;

        const role = m.role || user.role || "member";

        return {
          membershipId: String(m._id),
          userId: String(user._id),
          orgId: normalizeId(m.orgId),
          workspaceId: normalizeId(m.workspaceId || m.orgId),
          name: user.name || "",
          email: user.email || "",
          role,
          permissions: resolvePermissions(role, m.permissions),
          membershipStatus: m.status || "active",
          userStatus: user.status || "active",
          joinedAt: m.joinedAt || null,
          lastActiveAt: m.lastActiveAt || null,
          lastLoginAt: user.lastLoginAt || null,
          createdAt: m.createdAt || user.createdAt || null,
          updatedAt: m.updatedAt || user.updatedAt || null,
          accountId: m.accountId ? String(m.accountId) : null,
        };
      })
      .filter(Boolean);

    return res.json({
      ok: true,
      workspace: {
        id: String(org._id),
        name: org.name || "Workspace",
        slug: org.slug || null,
        plan: org.plan || null,
      },
      members,
    });
  } catch (err) {
    console.error("GET /members error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to load members.",
    });
  }
});

/* ------------------------------------------------ */
/* CREATE MEMBER */
/* ------------------------------------------------ */
router.post("/", requireAuth, async (req, res) => {
  try {
    const ctx = await getRequestContext(req);
    if (ctx.error) {
      return res.status(ctx.error.status).json({
        ok: false,
        message: ctx.error.message,
      });
    }

    const { actorUser, actorMembership, orgId, org } = ctx;

    if (!canManageMembers(actorMembership.role)) {
      return res.status(403).json({
        ok: false,
        message: "Only owners and admins can create members.",
      });
    }

    const name = String(req.body?.name || "").trim();
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const role = String(req.body?.role || "member").toLowerCase();
    const status = String(req.body?.status || "active").toLowerCase();

    if (!name || !email || !password) {
      return res.status(400).json({
        ok: false,
        message: "Name, email, and password are required.",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        ok: false,
        message: "Password must be at least 8 characters.",
      });
    }

    if (!ROLE_ENUM.includes(role)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid role.",
      });
    }

    if (!STATUS_ENUM.includes(status)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid status.",
      });
    }

    if (!canAssignRole(actorMembership.role, role)) {
      return res.status(403).json({
        ok: false,
        message: "You do not have permission to assign that role.",
      });
    }

    let user = await User.findOne({ email }).select("+passwordHash");

    if (!user) {
      const hash = await bcrypt.hash(password, 10);

      user = await User.create({
        name,
        email,
        passwordHash: hash,
        orgId,
        activeWorkspace: orgId,
        role,
        status: status === "invited" ? "invited" : "active",
        workspaces: [
          {
            workspace: orgId,
            role,
            status,
          },
        ],
      });
    } else {
      const existingMembership = await Membership.findOne({
        userId: user._id,
        orgId,
      }).lean();

      if (existingMembership) {
        return res.status(409).json({
          ok: false,
          message: "That user is already a member of this workspace.",
        });
      }

      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            name: user.name || name,
            activeWorkspace: user.activeWorkspace || orgId,
            orgId: user.orgId || orgId,
          },
          $addToSet: {
            workspaces: {
              workspace: orgId,
              role,
              status,
            },
          },
          $unset: {
            password: "",
          },
        }
      );

      user = await User.findById(user._id).lean();
    }

    const membership = await Membership.create({
      userId: user._id,
      orgId,
      workspaceId: orgId,
      role,
      status,
      permissions: resolvePermissions(role, []),
      invitedBy: actorUser._id,
      joinedAt: status === "active" ? new Date() : null,
    });

    if (String(user.activeWorkspace || "") === String(orgId)) {
      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            role,
            status: status === "disabled" || status === "suspended" ? status : user.status || "active",
          },
          $unset: {
            password: "",
          },
        }
      );
    }

    const freshUser = await User.findById(user._id).lean();

    return res.status(201).json({
      ok: true,
      member: {
        membershipId: String(membership._id),
        userId: String(freshUser._id),
        orgId: String(org._id),
        workspaceId: String(org._id),
        name: freshUser.name,
        email: freshUser.email,
        role: membership.role,
        permissions: resolvePermissions(membership.role, membership.permissions),
        membershipStatus: membership.status,
        userStatus: freshUser.status,
        joinedAt: membership.joinedAt,
        lastLoginAt: freshUser.lastLoginAt || null,
      },
    });
  } catch (err) {
    console.error("POST /members error:", err);

    if (err?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message: "That user already exists in this workspace.",
      });
    }

    return res.status(500).json({
      ok: false,
      message: "Failed to create member.",
    });
  }
});

/* ------------------------------------------------ */
/* UPDATE MEMBER */
/* ------------------------------------------------ */
router.patch("/:membershipId", requireAuth, async (req, res) => {
  try {
    const ctx = await getRequestContext(req);
    if (ctx.error) {
      return res.status(ctx.error.status).json({
        ok: false,
        message: ctx.error.message,
      });
    }

    const { actorUser, actorMembership, orgId } = ctx;
    const membershipId = req.params?.membershipId;

    if (!isObjectId(membershipId)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid membership id.",
      });
    }

    if (!canManageMembers(actorMembership.role)) {
      return res.status(403).json({
        ok: false,
        message: "Only owners and admins can update members.",
      });
    }

    const membership = await Membership.findOne({
      _id: membershipId,
      orgId,
    });

    if (!membership) {
      return res.status(404).json({
        ok: false,
        message: "Member not found.",
      });
    }

    const user = await User.findById(membership.userId);
    if (!user) {
      return res.status(404).json({
        ok: false,
        message: "User not found.",
      });
    }

    if (
      !canEditTarget(
        actorMembership.role,
        membership.role,
        actorUser._id,
        user._id
      )
    ) {
      return res.status(403).json({
        ok: false,
        message: "You do not have permission to edit this member.",
      });
    }

    const nextName =
      req.body?.name !== undefined ? String(req.body.name || "").trim() : undefined;

    const nextEmail =
      req.body?.email !== undefined ? normalizeEmail(req.body.email) : undefined;

    const nextRole =
      req.body?.role !== undefined ? String(req.body.role || "").toLowerCase() : undefined;

    const nextMembershipStatus =
      req.body?.membershipStatus !== undefined
        ? String(req.body.membershipStatus || "").toLowerCase()
        : req.body?.status !== undefined
        ? String(req.body.status || "").toLowerCase()
        : undefined;

    if (nextRole !== undefined) {
      if (!ROLE_ENUM.includes(nextRole)) {
        return res.status(400).json({
          ok: false,
          message: "Invalid role.",
        });
      }

      if (!canAssignRole(actorMembership.role, nextRole)) {
        return res.status(403).json({
          ok: false,
          message: "You do not have permission to assign that role.",
        });
      }
    }

    if (nextMembershipStatus !== undefined && !STATUS_ENUM.includes(nextMembershipStatus)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid status.",
      });
    }

    if (
      String(user._id) === String(actorUser._id) &&
      nextMembershipStatus &&
      ["disabled", "suspended"].includes(nextMembershipStatus)
    ) {
      return res.status(400).json({
        ok: false,
        message: "You cannot disable or suspend your own membership.",
      });
    }

    if (nextName !== undefined) {
      user.name = nextName;
    }

    if (nextEmail !== undefined) {
      user.email = nextEmail;
    }

    if (nextRole !== undefined) {
      membership.role = nextRole;

      if (String(user.activeWorkspace || "") === String(orgId)) {
        user.role = nextRole;
      }
    }

    if (nextMembershipStatus !== undefined) {
      membership.status = nextMembershipStatus;

      const workspaceIndex = Array.isArray(user.workspaces)
        ? user.workspaces.findIndex(
            (w) => String(w.workspace) === String(orgId)
          )
        : -1;

      if (workspaceIndex >= 0) {
        user.workspaces[workspaceIndex].status = nextMembershipStatus;
        if (nextRole !== undefined) {
          user.workspaces[workspaceIndex].role = nextRole;
        }
      }

      if (String(user.activeWorkspace || "") === String(orgId)) {
        if (["disabled", "suspended"].includes(nextMembershipStatus)) {
          user.status = nextMembershipStatus;
        } else if (user.status === "disabled" || user.status === "suspended") {
          user.status = "active";
        }
      }
    }

    membership.permissions = resolvePermissions(
      membership.role,
      req.body?.permissions ?? membership.permissions
    );

    user.markModified("workspaces");

    await membership.save();
    await user.save();

    await User.updateOne(
      { _id: user._id },
      {
        $unset: {
          password: "",
        },
      }
    );

    const refreshed = await User.findById(user._id).lean();

    return res.json({
      ok: true,
      member: {
        membershipId: String(membership._id),
        userId: String(refreshed._id),
        orgId: String(membership.orgId),
        workspaceId: String(membership.workspaceId || membership.orgId),
        name: refreshed.name,
        email: refreshed.email,
        role: membership.role,
        permissions: resolvePermissions(membership.role, membership.permissions),
        membershipStatus: membership.status,
        userStatus: refreshed.status,
        joinedAt: membership.joinedAt || null,
        lastLoginAt: refreshed.lastLoginAt || null,
        updatedAt: membership.updatedAt || refreshed.updatedAt || null,
      },
    });
  } catch (err) {
    console.error("PATCH /members/:membershipId error:", err);

    if (err?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message: "That email is already in use.",
      });
    }

    return res.status(500).json({
      ok: false,
      message: "Failed to update member.",
    });
  }
});

/* ------------------------------------------------ */
/* RESET MEMBER PASSWORD */
/* ------------------------------------------------ */
router.post("/:membershipId/reset-password", requireAuth, async (req, res) => {
  try {
    const ctx = await getRequestContext(req);
    if (ctx.error) {
      return res.status(ctx.error.status).json({
        ok: false,
        message: ctx.error.message,
      });
    }

    const { actorMembership, orgId } = ctx;
    const membershipId = req.params?.membershipId;
    const newPassword = String(req.body?.newPassword || "");

    if (!isObjectId(membershipId)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid membership id.",
      });
    }

    if (!canManageMembers(actorMembership.role)) {
      return res.status(403).json({
        ok: false,
        message: "Only owners and admins can reset member passwords.",
      });
    }

    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({
        ok: false,
        message: "New password must be at least 8 characters.",
      });
    }

    const membership = await Membership.findOne({
      _id: membershipId,
      orgId,
    }).lean();

    if (!membership) {
      return res.status(404).json({
        ok: false,
        message: "Member not found.",
      });
    }

    if (actorMembership.role === "admin" && membership.role === "owner") {
      return res.status(403).json({
        ok: false,
        message: "Admins cannot reset the owner password.",
      });
    }

    const hash = await bcrypt.hash(newPassword, 10);

    await User.updateOne(
      { _id: membership.userId },
      {
        $set: {
          passwordHash: hash,
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
    console.error("POST /members/:membershipId/reset-password error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to reset password.",
    });
  }
});

/* ------------------------------------------------ */
/* DELETE MEMBER */
/* ------------------------------------------------ */
router.delete("/:membershipId", requireAuth, async (req, res) => {
  try {
    const ctx = await getRequestContext(req);
    if (ctx.error) {
      return res.status(ctx.error.status).json({
        ok: false,
        message: ctx.error.message,
      });
    }

    const { actorUser, actorMembership, orgId } = ctx;
    const membershipId = req.params?.membershipId;

    if (!isObjectId(membershipId)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid membership id.",
      });
    }

    if (!canManageMembers(actorMembership.role)) {
      return res.status(403).json({
        ok: false,
        message: "Only owners and admins can remove members.",
      });
    }

    const membership = await Membership.findOne({
      _id: membershipId,
      orgId,
    });

    if (!membership) {
      return res.status(404).json({
        ok: false,
        message: "Member not found.",
      });
    }

    const user = await User.findById(membership.userId);
    if (!user) {
      await Membership.deleteOne({ _id: membership._id });
      return res.json({
        ok: true,
        message: "Member removed.",
      });
    }

    if (
      !canEditTarget(
        actorMembership.role,
        membership.role,
        actorUser._id,
        user._id
      )
    ) {
      return res.status(403).json({
        ok: false,
        message: "You do not have permission to remove this member.",
      });
    }

    if (String(actorUser._id) === String(user._id)) {
      return res.status(400).json({
        ok: false,
        message: "You cannot remove yourself from this workspace.",
      });
    }

    await Membership.deleteOne({ _id: membership._id });

    const nextWorkspaces = Array.isArray(user.workspaces)
      ? user.workspaces.filter(
          (w) => String(w.workspace) !== String(orgId)
        )
      : [];

    const remainingMemberships = await Membership.find({
      userId: user._id,
      status: { $nin: ["disabled", "suspended"] },
    })
      .sort({ createdAt: 1 })
      .lean();

    const nextPrimaryOrgId =
      remainingMemberships[0]?.orgId ? String(remainingMemberships[0].orgId) : null;
    const nextPrimaryRole = remainingMemberships[0]?.role || "member";

    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          workspaces: nextWorkspaces,
          orgId: nextPrimaryOrgId,
          activeWorkspace: nextPrimaryOrgId,
          role: nextPrimaryRole,
          status: nextPrimaryOrgId ? "active" : user.status,
        },
        $unset: {
          password: "",
        },
      }
    );

    return res.json({
      ok: true,
      message: "Member removed successfully.",
    });
  } catch (err) {
    console.error("DELETE /members/:membershipId error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to remove member.",
    });
  }
});

export default router;