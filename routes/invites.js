// backend/routes/invites.js
import express from "express";
import mongoose from "mongoose";
import crypto from "crypto";
import bcrypt from "bcryptjs";

import { requireAuth } from "../middleware/auth.js";
import Membership from "../models/Membership.js";
import Invite from "../models/Invite.js";
import Organization from "../models/Organization.js";
import User from "../models/User.js";

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
  const headerOrgId =
    toObjectId(req.headers["x-org-id"]) ||
    toObjectId(req.headers["x-workspace-id"]) ||
    null;

  const defaultOrgId =
    toObjectId(req.user?.orgId) ||
    toObjectId(req.user?.organizationId) ||
    toObjectId(req.user?.org) ||
    toObjectId(req.user?.activeWorkspace) ||
    null;

  return headerOrgId || defaultOrgId || null;
}

async function requireMembership(req) {
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
      message: "No workspace selected",
      code: "ORG_CONTEXT_REQUIRED",
    };
  }

  const membership = await Membership.findOne({
    userId,
    orgId,
    status: { $ne: "disabled" },
  })
    .select("_id role status userId orgId")
    .lean();

  if (!membership) {
    return {
      ok: false,
      status: 403,
      message: "Not a member of this workspace",
      code: "ORG_ACCESS_DENIED",
    };
  }

  return { ok: true, userId, orgId, membership };
}

function canInvite(role) {
  const normalized = String(role || "").toLowerCase();
  return normalized === "owner" || normalized === "admin";
}

function workspaceIsActive(org) {
  if (!org) return false;

  const accessStatus = String(org?.accessStatus || "pending").toLowerCase();
  const paymentStatus = String(org?.paymentStatus || "pending").toLowerCase();
  const approvedForAccess = Boolean(org?.approvedForAccess);
  const demoCompleted = Boolean(org?.demoCompleted);

  return (
    accessStatus === "active" &&
    paymentStatus === "paid" &&
    approvedForAccess &&
    demoCompleted
  );
}

/**
 * GET /api/invites
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const ctx = await requireMembership(req);

    if (!ctx.ok) {
      return res.status(ctx.status).json({
        ok: false,
        message: ctx.message,
        code: ctx.code,
      });
    }

    const invites = await Invite.find({ orgId: ctx.orgId })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return res.status(200).json({
      ok: true,
      orgId: ctx.orgId,
      membership: {
        role: ctx.membership.role,
        status: ctx.membership.status,
      },
      invites,
    });
  } catch (err) {
    console.error("Invites list error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to list invites",
    });
  }
});

/**
 * POST /api/invites
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    const ctx = await requireMembership(req);

    if (!ctx.ok) {
      return res.status(ctx.status).json({
        ok: false,
        message: ctx.message,
        code: ctx.code,
      });
    }

    if (!canInvite(ctx.membership.role)) {
      return res.status(403).json({
        ok: false,
        message: "Only owners and admins can create invites",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }

    const org = await Organization.findById(ctx.orgId).lean();

    if (!org) {
      return res.status(404).json({
        ok: false,
        message: "Workspace not found",
        code: "WORKSPACE_NOT_FOUND",
      });
    }

    // Allow invites in development; enforce billing only in production
    if (
      org?.billing?.status !== "active" &&
      process.env.NODE_ENV === "production"
    ) {
      return res.status(403).json({
        ok: false,
        message:
          "Invites can only be created for active workspaces with approved billing.",
        code: "WORKSPACE_BILLING_INACTIVE",
      });
    }

    const email = String(req.body?.email || "").trim().toLowerCase();
    const role = String(req.body?.role || "analyst").trim().toLowerCase();

    if (!email) {
      return res.status(400).json({
        ok: false,
        message: "Email is required",
      });
    }

    const allowedRoles = ["owner", "admin", "manager", "analyst", "member", "viewer"];
    const finalRole = allowedRoles.includes(role) ? role : "analyst";

    const existingPending = await Invite.findOne({
      orgId: ctx.orgId,
      email,
      status: "pending",
      expiresAt: { $gt: new Date() },
    }).lean();

    if (existingPending) {
      return res.status(200).json({
        ok: true,
        invite: existingPending,
      });
    }

    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const invite = await Invite.create({
      orgId: ctx.orgId,
      workspaceId: ctx.orgId,
      createdBy: ctx.userId,
      email,
      role: finalRole,
      status: "pending",
      token,
      expiresAt,
    });

    return res.status(201).json({
      ok: true,
      invite,
    });
  } catch (err) {
    console.error("Invite create error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to create invite",
    });
  }
});

/**
 * GET /api/invites/:token
 * Public invite lookup for login/signup prefill
 */
router.get("/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();

    if (!token) {
      return res.status(400).json({
        ok: false,
        message: "Missing token",
      });
    }

    const invite = await Invite.findOne({ token }).lean();

    if (!invite) {
      return res.status(404).json({
        ok: false,
        message: "Invite not found",
      });
    }

    if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
      return res.status(410).json({
        ok: false,
        message: "Invite expired",
        code: "INVITE_EXPIRED",
      });
    }

    if (invite.status && invite.status !== "pending") {
      return res.status(409).json({
        ok: false,
        message: `Invite is ${invite.status}`,
        code: "INVITE_NOT_PENDING",
      });
    }

    const org = await Organization.findById(invite.orgId).lean();

    if (!org) {
      return res.status(404).json({
        ok: false,
        message: "Workspace not found",
        code: "WORKSPACE_NOT_FOUND",
      });
    }

    if (!workspaceIsActive(org)) {
      return res.status(403).json({
        ok: false,
        message: "This workspace is not active yet.",
        code: "WORKSPACE_NOT_ACTIVE",
      });
    }

    return res.status(200).json({
      ok: true,
      invite: {
        _id: invite._id,
        email: invite.email,
        role: invite.role,
        token: invite.token,
        expiresAt: invite.expiresAt,
        orgId: String(invite.orgId),
        workspaceId: String(invite.orgId),
        orgName: org?.name || "",
        workspaceName: org?.name || "",
        status: invite.status,
      },
    });
  } catch (err) {
    console.error("Invite get error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to get invite",
    });
  }
});

/**
 * POST /api/invites/:token/accept
 * Public invite acceptance from signup page
 */
router.post("/:token/accept", async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    const name = String(req.body?.name || "").trim();
    const password = String(req.body?.password || "");

    if (!token) {
      return res.status(400).json({
        ok: false,
        message: "Missing token",
      });
    }

    if (!name) {
      return res.status(400).json({
        ok: false,
        message: "Name is required",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        ok: false,
        message: "Password must be at least 8 characters.",
      });
    }

    const invite = await Invite.findOne({ token });

    if (!invite) {
      return res.status(404).json({
        ok: false,
        message: "Invite not found",
      });
    }

    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
      invite.status = "expired";
      await invite.save();

      return res.status(410).json({
        ok: false,
        message: "Invite expired",
        code: "INVITE_EXPIRED",
      });
    }

    if (invite.status === "accepted") {
      return res.status(409).json({
        ok: false,
        message: "Invite has already been accepted.",
        code: "INVITE_ALREADY_ACCEPTED",
      });
    }

    const org = await Organization.findById(invite.orgId);

    if (!org) {
      return res.status(404).json({
        ok: false,
        message: "Workspace not found.",
        code: "WORKSPACE_NOT_FOUND",
      });
    }

    if (!workspaceIsActive(org)) {
      return res.status(403).json({
        ok: false,
        message: "This workspace is not active yet.",
        code: "WORKSPACE_NOT_ACTIVE",
      });
    }

    const email = String(invite.email || "").trim().toLowerCase();

    if (!email) {
      return res.status(400).json({
        ok: false,
        message: "Invite email is missing.",
      });
    }

    let user = await User.findOne({ email });

    if (user) {
      if (user.passwordHash) {
        return res.status(409).json({
          ok: false,
          message: "An account already exists for this email. Please log in.",
          code: "ACCOUNT_ALREADY_EXISTS",
        });
      }

      user.name = name;
      user.passwordHash = await bcrypt.hash(password, 12);
      user.orgId = invite.orgId;
      user.activeWorkspace = invite.orgId;
      user.role = invite.role || user.role || "member";
      await user.save();
    } else {
      user = await User.create({
        name,
        email,
        passwordHash: await bcrypt.hash(password, 12),
        role: invite.role || "member",
        orgId: invite.orgId,
        activeWorkspace: invite.orgId,
      });
    }

    const existingMembership = await Membership.findOne({
      userId: user._id,
      orgId: invite.orgId,
    });

    if (!existingMembership) {
      await Membership.create({
        userId: user._id,
        orgId: invite.orgId,
        workspaceId: invite.orgId,
        role: invite.role || "analyst",
        status: "active",
        permissions: [],
      });
    } else if (existingMembership.status === "disabled") {
      existingMembership.status = "active";
      existingMembership.role = invite.role || existingMembership.role || "analyst";
      if (existingMembership.workspaceId == null) {
        existingMembership.workspaceId = invite.orgId;
      }
      await existingMembership.save();
    }

    invite.status = "accepted";
    invite.acceptedAt = new Date();
    invite.acceptedBy = user._id;
    await invite.save();

    return res.status(200).json({
      ok: true,
      message: "Invite accepted successfully. You can now log in.",
    });
  } catch (err) {
    console.error("Invite accept error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to accept invite",
    });
  }
});

export default router;