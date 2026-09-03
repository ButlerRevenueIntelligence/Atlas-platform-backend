// backend/routes/workspaces.js
import express from "express";
import mongoose from "mongoose";

import Organization from "../models/Organization.js";
import Membership from "../models/Membership.js";
import User from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

const OWNER_PERMISSIONS = [
  "dashboard.view",
  "command_center.view",
  "deal_room.view",
  "market_signals.view",
  "clients.view",
  "partners.manage",
  "admin.audit",
];

function toObjectId(value) {
  if (!value) return null;

  const stringValue = String(value);

  return mongoose.Types.ObjectId.isValid(stringValue)
    ? new mongoose.Types.ObjectId(stringValue)
    : null;
}

function cleanString(value, maxLength = 200) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function slugify(value = "") {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "")
    .slice(0, 80);
}

async function generateUniqueSlug(name) {
  const base = slugify(name) || "workspace";
  let slug = base;
  let counter = 1;

  while (await Organization.exists({ slug })) {
    counter += 1;
    slug = `${base}-${counter}`;
  }

  return slug;
}

function buildTrialWindow(days = 7) {
  const startedAt = new Date();
  const endsAt = new Date(startedAt);

  endsAt.setDate(endsAt.getDate() + days);

  return {
    startedAt,
    endsAt,
    status: "trialing",
  };
}

function serializeWorkspace(workspace, membership = null) {
  if (!workspace) return null;

  const org = workspace.toObject ? workspace.toObject() : workspace;
  const member = membership?.toObject
    ? membership.toObject()
    : membership || {};

  return {
    _id: String(org._id),
    id: String(org._id),
    name: org.name || "Workspace",
    slug: org.slug || "",
    type: org.type || "client",
    plan: org.plan || "SCALE",
    status: org.accessStatus || "pending",
    accessStatus: org.accessStatus || "pending",
    paymentStatus: org.paymentStatus || "pending",
    billing: org.billing || {
      status: org.paymentStatus || "inactive",
    },
    trial: org.trial || null,
    companyWebsite: org.companyWebsite || "",
    industry: org.industry || "",
    role: member.role || "member",
    membershipStatus: member.status || "active",
    permissions: Array.isArray(member.permissions)
      ? member.permissions
      : [],
    createdAt: org.createdAt || null,
    updatedAt: org.updatedAt || null,
  };
}

/**
 * POST /api/workspaces
 * Create a workspace and make the current user its owner.
 *
 * Plan and billing values are controlled by the server.
 */
router.post("/", requireAuth, async (req, res) => {
  let createdWorkspace = null;

  try {
    const userId = toObjectId(req.user?.userId || req.user?.id);

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized",
      });
    }

    const name = cleanString(req.body?.name, 120);
    const type = cleanString(req.body?.type || "client", 30).toLowerCase();
    const companyWebsite = cleanString(req.body?.companyWebsite, 300);
    const industry = cleanString(req.body?.industry, 120);

    if (!name) {
      return res.status(400).json({
        ok: false,
        message: "Workspace name is required.",
      });
    }

    if (name.length < 2) {
      return res.status(400).json({
        ok: false,
        message: "Workspace name must contain at least 2 characters.",
      });
    }

    if (!["agency", "client"].includes(type)) {
      return res.status(400).json({
        ok: false,
        message: "Workspace type must be agency or client.",
      });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        ok: false,
        message: "User not found.",
      });
    }

    const existingMemberships = await Membership.countDocuments({
      userId,
      status: { $nin: ["disabled", "suspended"] },
    });

    if (existingMemberships >= 25) {
      return res.status(403).json({
        ok: false,
        message:
          "You have reached the workspace limit. Contact support to create another workspace.",
      });
    }

    const slug = await generateUniqueSlug(name);
    const trial = buildTrialWindow(7);

    createdWorkspace = await Organization.create({
      name,
      type,
      slug,
      ownerId: user._id,
      companyWebsite,
      industry,

      // Billing-controlled values must never come directly from the client.
      plan: "SCALE",

      trial,

      usage: {
        aiAnalyses: 0,
        reportsGenerated: 0,
        forecastsRun: 0,
      },

      demoCompleted: true,
      approvedForAccess: true,
      accessStatus: "active",
      paymentStatus: "trialing",

      billing: {
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripePriceId: null,
        status: "trialing",
        currentPeriodEnd: trial.endsAt,
      },

      integrations: {
        hubspot: { connected: false, mode: "demo" },
        salesforce: { connected: false, mode: "demo" },
        google_ads: { connected: false, mode: "demo" },
        meta_ads: { connected: false, mode: "demo" },
        linkedin_ads: { connected: false, mode: "demo" },
        ga4: { connected: false, mode: "demo" },
        stripe: { connected: false, mode: "demo" },
        shopify: { connected: false, mode: "demo" },
      },
    });

    const membership = await Membership.create({
      userId: user._id,
      orgId: createdWorkspace._id,
      role: "owner",
      status: "active",
      permissions: OWNER_PERMISSIONS,
    });

    user.orgId = createdWorkspace._id;
    user.activeWorkspace = createdWorkspace._id;
    user.role = "owner";

    await user.save();

    return res.status(201).json({
      ok: true,
      workspace: serializeWorkspace(createdWorkspace, membership),
      membership: {
        role: membership.role,
        status: membership.status,
        permissions: membership.permissions,
      },
    });
  } catch (err) {
    console.error("CREATE WORKSPACE ERROR:", err);

    // Avoid leaving an organization without an owner membership.
    if (createdWorkspace?._id) {
      try {
        await Membership.deleteMany({
          orgId: createdWorkspace._id,
        });

        await Organization.deleteOne({
          _id: createdWorkspace._id,
        });
      } catch (rollbackError) {
        console.error("CREATE WORKSPACE ROLLBACK ERROR:", rollbackError);
      }
    }

    return res.status(500).json({
      ok: false,
      message: "Failed to create workspace.",
    });
  }
});

/**
 * GET /api/workspaces
 * Return every workspace the current user can access.
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = toObjectId(req.user?.userId || req.user?.id);

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized",
      });
    }

    const memberships = await Membership.find({
      userId,
      status: { $nin: ["disabled", "suspended"] },
    })
      .select("orgId role status permissions createdAt updatedAt")
      .lean();

    const orgIds = memberships
      .map((membership) => membership.orgId)
      .filter(Boolean);

    const organizations = await Organization.find({
      _id: { $in: orgIds },
    })
      .sort({ updatedAt: -1 })
      .lean();

    const organizationMap = new Map(
      organizations.map((organization) => [
        String(organization._id),
        organization,
      ])
    );

    const workspaces = memberships
      .map((membership) => {
        const organization = organizationMap.get(
          String(membership.orgId)
        );

        if (!organization) return null;

        return serializeWorkspace(organization, membership);
      })
      .filter(Boolean);

    return res.json({
      ok: true,

      // Current response name.
      workspaces,

      // Compatibility with frontend versions that read `orgs`.
      orgs: workspaces,
    });
  } catch (err) {
    console.error("GET WORKSPACES ERROR:", err);

    return res.status(500).json({
      ok: false,
      message: "Failed to load workspaces.",
    });
  }
});

/**
 * POST /api/workspaces/switch
 * Switch to another workspace the current user can access.
 */
router.post("/switch", requireAuth, async (req, res) => {
  try {
    const userId = toObjectId(req.user?.userId || req.user?.id);
    const workspaceId = toObjectId(
      req.body?.workspaceId || req.body?.orgId
    );

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized",
      });
    }

    if (!workspaceId) {
      return res.status(400).json({
        ok: false,
        message: "A valid workspace ID is required.",
      });
    }

    const membership = await Membership.findOne({
      userId,
      orgId: workspaceId,
      status: { $nin: ["disabled", "suspended"] },
    }).lean();

    if (!membership) {
      return res.status(403).json({
        ok: false,
        message: "You do not have access to this workspace.",
      });
    }

    const workspace = await Organization.findById(workspaceId).lean();

    if (!workspace) {
      return res.status(404).json({
        ok: false,
        message: "Workspace not found.",
      });
    }

    const accessStatus = String(
      workspace.accessStatus || ""
    ).toLowerCase();

    if (["disabled", "suspended", "archived"].includes(accessStatus)) {
      return res.status(403).json({
        ok: false,
        message: "This workspace is currently unavailable.",
      });
    }

    await User.updateOne(
      { _id: userId },
      {
        $set: {
          orgId: workspace._id,
          activeWorkspace: workspace._id,

          // Kept for compatibility with existing authorization middleware.
          role: membership.role || "member",
        },
      }
    );

    return res.json({
      ok: true,
      activeWorkspace: serializeWorkspace(workspace, membership),
      membership: {
        role: membership.role || "member",
        status: membership.status || "active",
        permissions: Array.isArray(membership.permissions)
          ? membership.permissions
          : [],
      },
    });
  } catch (err) {
    console.error("SWITCH WORKSPACE ERROR:", err);

    return res.status(500).json({
      ok: false,
      message: "Failed to switch workspace.",
    });
  }
});

/**
 * DELETE /api/workspaces/:workspaceId
 *
 * Permanent deletion is intentionally disabled. Deleting only the
 * organization and memberships would leave deals, metrics, clients,
 * partners, reports, and integration data orphaned.
 */
router.delete("/:workspaceId", requireAuth, async (req, res) => {
  try {
    const userId = toObjectId(req.user?.userId || req.user?.id);
    const workspaceId = toObjectId(req.params.workspaceId);

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized",
      });
    }

    if (!workspaceId) {
      return res.status(400).json({
        ok: false,
        message: "A valid workspace ID is required.",
      });
    }

    const membership = await Membership.findOne({
      userId,
      orgId: workspaceId,
      role: "owner",
      status: { $nin: ["disabled", "suspended"] },
    })
      .select("_id")
      .lean();

    if (!membership) {
      return res.status(403).json({
        ok: false,
        message: "Only the workspace owner can manage workspace removal.",
      });
    }

    return res.status(409).json({
      ok: false,
      code: "WORKSPACE_DELETION_DISABLED",
      message:
        "Permanent workspace deletion is disabled to protect connected revenue data. Contact support if this workspace needs to be closed.",
    });
  } catch (err) {
    console.error("DELETE WORKSPACE ERROR:", err);

    return res.status(500).json({
      ok: false,
      message: "Failed to process the workspace request.",
    });
  }
});

export default router;
