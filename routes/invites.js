// backend/routes/invites.js
import express from "express";
import mongoose from "mongoose";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import { requireAuth } from "../middleware/auth.js";
import Membership from "../models/Membership.js";
import Invite from "../models/Invite.js";
import Organization from "../models/Organization.js";
import User from "../models/User.js";
import { sendInviteEmail } from "../utils/sendInviteEmail.js";

const router = express.Router();

const ALLOWED_INVITE_ROLES = [
  "admin",
  "manager",
  "analyst",
  "member",
  "viewer",
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const toObjectId = (value) => {
  if (!value) return null;

  const stringValue = String(value);

  return mongoose.Types.ObjectId.isValid(stringValue)
    ? new mongoose.Types.ObjectId(stringValue)
    : null;
};

const normalizeEmail = (value) =>
  String(value || "").trim().toLowerCase();

const normalizeRole = (value) =>
  String(value || "analyst").trim().toLowerCase();

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
      message: "No workspace selected",
      code: "ORG_CONTEXT_REQUIRED",
    };
  }

  const membership = await Membership.findOne({
    userId,
    orgId,
    status: { $nin: ["disabled", "suspended"] },
  })
    .select("_id role status userId orgId")
    .lean();

  if (!membership) {
    return {
      ok: false,
      status: 403,
      message: "Not an active member of this workspace",
      code: "ORG_ACCESS_DENIED",
    };
  }

  const role = String(
    membership.role || ""
  ).toLowerCase();

  return {
    ok: true,
    userId,
    orgId,
    membership,
    role,
    canManageInvites:
      role === "owner" || role === "admin",
  };
}

function sendContextError(res, ctx) {
  return res.status(ctx.status).json({
    ok: false,
    message: ctx.message,
    code: ctx.code,
  });
}

function sendPermissionError(res) {
  return res.status(403).json({
    ok: false,
    message:
      "Only workspace owners and administrators can manage invitations.",
    code: "INSUFFICIENT_PERMISSIONS",
  });
}

function validateInviteRole(role, requesterRole) {
  if (role === "owner") {
    return {
      ok: false,
      status: 403,
      message:
        "Workspace ownership cannot be assigned through an invitation.",
      code: "OWNER_INVITE_NOT_ALLOWED",
    };
  }

  if (!ALLOWED_INVITE_ROLES.includes(role)) {
    return {
      ok: false,
      status: 400,
      message: "Invalid invitation role.",
      code: "INVALID_ROLE",
    };
  }

  if (role === "admin" && requesterRole !== "owner") {
    return {
      ok: false,
      status: 403,
      message:
        "Only the workspace owner can invite an administrator.",
      code: "OWNER_ONLY_ACTION",
    };
  }

  return { ok: true };
}

async function markExpiredInvites(orgId) {
  await Invite.updateMany(
    {
      orgId,
      status: "pending",
      expiresAt: { $lte: new Date() },
    },
    {
      $set: {
        status: "expired",
      },
    }
  );
}

function serializeInvite(invite) {
  const status = String(
    invite?.status || "pending"
  ).toLowerCase();

  return {
    _id: String(invite?._id),
    id: String(invite?._id),
    email: invite?.email || "",
    role: invite?.role || "analyst",
    status,
    createdAt: invite?.createdAt || null,
    expiresAt: invite?.expiresAt || null,
    acceptedAt: invite?.acceptedAt || null,
    revokedAt: invite?.revokedAt || null,
    createdBy: invite?.createdBy || null,

    // Only pending invitations need the token for Copy Link.
    token:
      status === "pending"
        ? invite?.token || ""
        : "",
  };
}

async function sendInvitationEmail({
  invite,
  organization,
}) {
  await sendInviteEmail({
    to: invite.email,
    workspaceName:
      organization?.name || "Atlas Workspace",
    role: invite.role,
    inviteToken: invite.token,
  });
}

async function syncUserWorkspace({
  userId,
  orgId,
  role,
  status = "active",
}) {
  await User.updateOne(
    { _id: userId },
    {
      $pull: {
        workspaces: {
          workspace: orgId,
        },
      },
    }
  );

  await User.updateOne(
    { _id: userId },
    {
      $push: {
        workspaces: {
          workspace: orgId,
          role,
          status,
        },
      },
    }
  );
}

/**
 * GET /api/invites
 *
 * Lists invitations for the active workspace.
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx.ok) {
      return sendContextError(res, ctx);
    }

    if (!ctx.canManageInvites) {
      return sendPermissionError(res);
    }

    await markExpiredInvites(ctx.orgId);

    const invites = await Invite.find({
      orgId: ctx.orgId,
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return res.json({
      ok: true,
      orgId: String(ctx.orgId),

      membership: {
        userId: String(ctx.userId),
        role: ctx.role,
        status: ctx.membership.status,
        canManageInvites: true,
      },

      invites: invites.map(serializeInvite),
    });
  } catch (err) {
    console.error("GET /api/invites error:", err);

    return res.status(500).json({
      ok: false,
      message:
        err?.message || "Failed to list invitations",
    });
  }
});

/**
 * POST /api/invites
 *
 * Creates and emails a new workspace invitation.
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx.ok) {
      return sendContextError(res, ctx);
    }

    if (!ctx.canManageInvites) {
      return sendPermissionError(res);
    }

    const email = normalizeEmail(req.body?.email);
    const role = normalizeRole(req.body?.role);

    if (!email || !EMAIL_PATTERN.test(email)) {
      return res.status(400).json({
        ok: false,
        message: "Enter a valid email address.",
        code: "INVALID_EMAIL",
      });
    }

    const roleValidation = validateInviteRole(
      role,
      ctx.role
    );

    if (!roleValidation.ok) {
      return res
        .status(roleValidation.status)
        .json(roleValidation);
    }

    const organization = await Organization.findById(
      ctx.orgId
    ).lean();

    if (!organization) {
      return res.status(404).json({
        ok: false,
        message: "Workspace not found.",
        code: "WORKSPACE_NOT_FOUND",
      });
    }

    const existingUser = await User.findOne({
      email,
    })
      .select("_id email")
      .lean();

    if (existingUser) {
      const existingMembership =
        await Membership.findOne({
          userId: existingUser._id,
          orgId: ctx.orgId,
        })
          .select("_id status")
          .lean();

      if (existingMembership) {
        return res.status(409).json({
          ok: false,
          message:
            "This person already has a membership in the workspace. Manage their access from the Members page.",
          code: "MEMBER_ALREADY_EXISTS",
        });
      }
    }

    await markExpiredInvites(ctx.orgId);

    const existingPending = await Invite.findOne({
      orgId: ctx.orgId,
      email,
      status: "pending",
      expiresAt: { $gt: new Date() },
    });

    if (existingPending) {
      return res.status(409).json({
        ok: false,
        message:
          "A pending invitation already exists for this email. Use Resend instead.",
        code: "PENDING_INVITE_EXISTS",
        invite: serializeInvite(
          existingPending.toObject()
        ),
      });
    }

    const token = crypto
      .randomBytes(32)
      .toString("hex");

    const expiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000
    );

    const invite = await Invite.create({
      orgId: ctx.orgId,
      workspaceId: ctx.orgId,
      createdBy: ctx.userId,
      email,
      role,
      status: "pending",
      token,
      expiresAt,
    });

    try {
      await sendInvitationEmail({
        invite,
        organization,
      });
    } catch (emailError) {
      console.error(
        "Invite email delivery error:",
        emailError
      );

      return res.status(502).json({
        ok: false,
        message:
          "The invitation was created, but the email could not be delivered. You can copy the invitation link or try Resend.",
        code: "INVITE_EMAIL_FAILED",
        invite: serializeInvite(
          invite.toObject()
        ),
      });
    }

    return res.status(201).json({
      ok: true,
      message: `Invitation sent to ${email}.`,
      invite: serializeInvite(
        invite.toObject()
      ),
    });
  } catch (err) {
    console.error("POST /api/invites error:", err);

    if (err?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message:
          "An invitation already exists for this email.",
        code: "DUPLICATE_INVITE",
      });
    }

    return res.status(500).json({
      ok: false,
      message:
        err?.message || "Failed to create invitation",
    });
  }
});

/**
 * POST /api/invites/:inviteId/resend
 *
 * Rotates the token, extends expiration, and resends a
 * pending or expired invitation.
 */
router.post(
  "/:inviteId/resend",
  requireAuth,
  async (req, res) => {
    try {
      const ctx = await getOrgContext(req);

      if (!ctx.ok) {
        return sendContextError(res, ctx);
      }

      if (!ctx.canManageInvites) {
        return sendPermissionError(res);
      }

      const inviteId = toObjectId(
        req.params.inviteId
      );

      if (!inviteId) {
        return res.status(400).json({
          ok: false,
          message: "Invalid invitation ID.",
          code: "INVALID_INVITE_ID",
        });
      }

      const invite = await Invite.findOne({
        _id: inviteId,
        orgId: ctx.orgId,
      });

      if (!invite) {
        return res.status(404).json({
          ok: false,
          message: "Invitation not found.",
          code: "INVITE_NOT_FOUND",
        });
      }

      if (invite.status === "accepted") {
        return res.status(409).json({
          ok: false,
          message:
            "An accepted invitation cannot be resent.",
          code: "INVITE_ALREADY_ACCEPTED",
        });
      }

      if (invite.status === "revoked") {
        return res.status(409).json({
          ok: false,
          message:
            "A revoked invitation cannot be resent. Create a new invitation instead.",
          code: "INVITE_REVOKED",
        });
      }

      const organization =
        await Organization.findById(
          ctx.orgId
        ).lean();

      if (!organization) {
        return res.status(404).json({
          ok: false,
          message: "Workspace not found.",
          code: "WORKSPACE_NOT_FOUND",
        });
      }

      invite.token = crypto
        .randomBytes(32)
        .toString("hex");

      invite.status = "pending";
      invite.expiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000
      );

      invite.acceptedAt = null;
      invite.acceptedBy = null;
      invite.revokedAt = null;

      await invite.save();

      try {
        await sendInvitationEmail({
          invite,
          organization,
        });
      } catch (emailError) {
        console.error(
          "Invite resend delivery error:",
          emailError
        );

        return res.status(502).json({
          ok: false,
          message:
            "The invitation was renewed, but the email could not be delivered. Copy the invitation link or try again.",
          code: "INVITE_EMAIL_FAILED",
          invite: serializeInvite(
            invite.toObject()
          ),
        });
      }

      return res.json({
        ok: true,
        message: `Invitation resent to ${invite.email}.`,
        invite: serializeInvite(
          invite.toObject()
        ),
      });
    } catch (err) {
      console.error(
        "POST /api/invites/:inviteId/resend error:",
        err
      );

      return res.status(500).json({
        ok: false,
        message:
          err?.message || "Failed to resend invitation",
      });
    }
  }
);

/**
 * PATCH /api/invites/:inviteId/revoke
 *
 * Revokes a pending or expired invitation.
 */
router.patch(
  "/:inviteId/revoke",
  requireAuth,
  async (req, res) => {
    try {
      const ctx = await getOrgContext(req);

      if (!ctx.ok) {
        return sendContextError(res, ctx);
      }

      if (!ctx.canManageInvites) {
        return sendPermissionError(res);
      }

      const inviteId = toObjectId(
        req.params.inviteId
      );

      if (!inviteId) {
        return res.status(400).json({
          ok: false,
          message: "Invalid invitation ID.",
          code: "INVALID_INVITE_ID",
        });
      }

      const invite = await Invite.findOne({
        _id: inviteId,
        orgId: ctx.orgId,
      });

      if (!invite) {
        return res.status(404).json({
          ok: false,
          message: "Invitation not found.",
          code: "INVITE_NOT_FOUND",
        });
      }

      if (invite.status === "accepted") {
        return res.status(409).json({
          ok: false,
          message:
            "An accepted invitation cannot be revoked. Manage the member from the Members page.",
          code: "INVITE_ALREADY_ACCEPTED",
        });
      }

      if (invite.status === "revoked") {
        return res.json({
          ok: true,
          message:
            "The invitation is already revoked.",
          invite: serializeInvite(
            invite.toObject()
          ),
        });
      }

      invite.status = "revoked";
      invite.revokedAt = new Date();
      invite.token = "";

      await invite.save();

      return res.json({
        ok: true,
        message: "Invitation revoked.",
        invite: serializeInvite(
          invite.toObject()
        ),
      });
    } catch (err) {
      console.error(
        "PATCH /api/invites/:inviteId/revoke error:",
        err
      );

      return res.status(500).json({
        ok: false,
        message:
          err?.message || "Failed to revoke invitation",
      });
    }
  }
);

/**
 * GET /api/invites/:token
 *
 * Public invitation lookup for login/signup prefill.
 */
router.get("/:token", async (req, res) => {
  try {
    const token = String(
      req.params.token || ""
    ).trim();

    if (!token) {
      return res.status(400).json({
        ok: false,
        message: "Missing invitation token.",
        code: "TOKEN_REQUIRED",
      });
    }

    const invite = await Invite.findOne({
      token,
    }).lean();

    if (!invite) {
      return res.status(404).json({
        ok: false,
        message: "Invitation not found.",
        code: "INVITE_NOT_FOUND",
      });
    }

    if (
      invite.expiresAt &&
      new Date(invite.expiresAt).getTime() <=
        Date.now()
    ) {
      await Invite.updateOne(
        { _id: invite._id },
        { $set: { status: "expired" } }
      );

      return res.status(410).json({
        ok: false,
        message: "This invitation has expired.",
        code: "INVITE_EXPIRED",
      });
    }

    if (invite.status !== "pending") {
      return res.status(409).json({
        ok: false,
        message: `This invitation is ${invite.status}.`,
        code: "INVITE_NOT_PENDING",
      });
    }

    if (
      !ALLOWED_INVITE_ROLES.includes(
        normalizeRole(invite.role)
      )
    ) {
      return res.status(403).json({
        ok: false,
        message:
          "This invitation contains an unsupported role.",
        code: "INVALID_INVITE_ROLE",
      });
    }

    const organization =
      await Organization.findById(
        invite.orgId
      )
        .select("_id name slug")
        .lean();

    if (!organization) {
      return res.status(404).json({
        ok: false,
        message: "Workspace not found.",
        code: "WORKSPACE_NOT_FOUND",
      });
    }

    const existingUser = await User.findOne({
      email: normalizeEmail(invite.email),
    })
      .select("_id")
      .lean();

    return res.json({
      ok: true,

      invite: {
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt,
        orgId: String(invite.orgId),
        workspaceId: String(invite.orgId),
        orgName: organization.name || "",
        workspaceName: organization.name || "",
        status: invite.status,
        existingAccount: Boolean(existingUser),
      },
    });
  } catch (err) {
    console.error("GET /api/invites/:token error:", err);

    return res.status(500).json({
      ok: false,
      message:
        err?.message || "Failed to load invitation",
    });
  }
});

/**
 * POST /api/invites/:token/accept
 *
 * New users create an account.
 * Existing users confirm their current password.
 */
router.post("/:token/accept", async (req, res) => {
  try {
    const token = String(
      req.params.token || ""
    ).trim();

    const name = String(
      req.body?.name || ""
    ).trim();

    const password = String(
      req.body?.password || ""
    );

    if (!token) {
      return res.status(400).json({
        ok: false,
        message: "Missing invitation token.",
        code: "TOKEN_REQUIRED",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        ok: false,
        message:
          "Password must be at least 8 characters.",
        code: "PASSWORD_TOO_SHORT",
      });
    }

    const invite = await Invite.findOne({
      token,
    });

    if (!invite) {
      return res.status(404).json({
        ok: false,
        message: "Invitation not found.",
        code: "INVITE_NOT_FOUND",
      });
    }

    if (
      invite.expiresAt &&
      invite.expiresAt.getTime() <= Date.now()
    ) {
      invite.status = "expired";
      await invite.save();

      return res.status(410).json({
        ok: false,
        message: "This invitation has expired.",
        code: "INVITE_EXPIRED",
      });
    }

    if (invite.status !== "pending") {
      return res.status(409).json({
        ok: false,
        message: `This invitation is ${invite.status}.`,
        code: "INVITE_NOT_PENDING",
      });
    }

    const inviteRole = normalizeRole(invite.role);

    if (!ALLOWED_INVITE_ROLES.includes(inviteRole)) {
      return res.status(403).json({
        ok: false,
        message:
          "This invitation contains an unsupported role.",
        code: "INVALID_INVITE_ROLE",
      });
    }

    const organization =
      await Organization.findById(invite.orgId)
        .select("_id name")
        .lean();

    if (!organization) {
      return res.status(404).json({
        ok: false,
        message: "Workspace not found.",
        code: "WORKSPACE_NOT_FOUND",
      });
    }

    const email = normalizeEmail(invite.email);

    let user = await User.findOne({ email });

    if (user) {
      if (!user.passwordHash) {
        user.passwordHash = await bcrypt.hash(
          password,
          12
        );

        if (name && !user.name) {
          user.name = name;
        }

        await user.save();
      } else {
        const passwordMatches =
          await bcrypt.compare(
            password,
            user.passwordHash
          );

        if (!passwordMatches) {
          return res.status(401).json({
            ok: false,
            message:
              "The password does not match the existing Atlas account for this email.",
            code: "INVALID_ACCOUNT_PASSWORD",
          });
        }
      }
    } else {
      if (!name) {
        return res.status(400).json({
          ok: false,
          message: "Name is required.",
          code: "NAME_REQUIRED",
        });
      }

      user = await User.create({
        name,
        email,
        passwordHash: await bcrypt.hash(
          password,
          12
        ),
        role: inviteRole,
        orgId: invite.orgId,
        activeWorkspace: invite.orgId,
        status: "active",
        workspaces: [],
      });
    }

    const existingMembership =
      await Membership.findOne({
        userId: user._id,
        orgId: invite.orgId,
      });

    if (existingMembership) {
      return res.status(409).json({
        ok: false,
        message:
          "This account already belongs to the workspace.",
        code: "MEMBER_ALREADY_EXISTS",
      });
    }

    const membership = await Membership.create({
      userId: user._id,
      orgId: invite.orgId,
      workspaceId: invite.orgId,
      role: inviteRole,
      status: "active",
      permissions: [],
      invitedBy: invite.createdBy || null,
      joinedAt: new Date(),
    });

    await syncUserWorkspace({
      userId: user._id,
      orgId: invite.orgId,
      role: inviteRole,
      status: "active",
    });

    invite.status = "accepted";
    invite.acceptedAt = new Date();
    invite.acceptedBy = user._id;

    await invite.save();

    const authToken = jwt.sign(
      {
        userId: user._id,
        email: user.email,
        orgId: invite.orgId,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d",
      }
    );

    return res.json({
      ok: true,
      token: authToken,

      user: {
        id: String(user._id),
        email: user.email,
        name: user.name,
        orgId: String(invite.orgId),
      },

      activeWorkspace: {
        _id: String(invite.orgId),
        id: String(invite.orgId),
        name:
          organization.name || "Workspace",
      },

      membership: {
        membershipId: String(membership._id),
        role: membership.role,
        status: membership.status,
      },
    });
  } catch (err) {
    console.error(
      "POST /api/invites/:token/accept error:",
      err
    );

    if (err?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message:
          "This invitation has already been accepted or the membership already exists.",
        code: "DUPLICATE_MEMBERSHIP",
      });
    }

    return res.status(500).json({
      ok: false,
      message:
        err?.message || "Failed to accept invitation",
    });
  }
});

export default router;
