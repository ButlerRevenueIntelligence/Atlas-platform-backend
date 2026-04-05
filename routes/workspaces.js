// backend/routes/workspaces.js
import express from "express";
import mongoose from "mongoose";

import Organization from "../models/Organization.js";
import Membership from "../models/Membership.js";
import User from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

function slugify(value = "") {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
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

router.post("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized",
      });
    }

    const name = String(req.body?.name || "").trim();
    const type = String(req.body?.type || "client").trim().toLowerCase();

    if (!name) {
      return res.status(400).json({
        ok: false,
        message: "Workspace name is required.",
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

    const slug = await generateUniqueSlug(name);
    const trial = buildTrialWindow(7);

    const workspace = await Organization.create({
      name,
      type,
      slug,
      ownerId: user._id,

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

    await Membership.create({
      userId: user._id,
      orgId: workspace._id,
      role: "owner",
      status: "active",
      permissions: [
        "dashboard.view",
        "command_center.view",
        "deal_room.view",
        "market_signals.view",
        "clients.view",
        "partners.manage",
        "admin.audit",
      ],
    });

    user.orgId = workspace._id;
    user.activeWorkspace = workspace._id;
    user.role = "owner";
    await user.save();

    return res.status(201).json({
      ok: true,
      workspace: {
        _id: String(workspace._id),
        id: String(workspace._id),
        name: workspace.name,
        slug: workspace.slug,
        type: workspace.type,
        plan: workspace.plan,
        status: workspace.accessStatus,
        paymentStatus: workspace.paymentStatus,
        trial: workspace.trial,
        billing: workspace.billing,
      },
      membership: {
        role: "owner",
        status: "active",
        permissions: [
          "dashboard.view",
          "command_center.view",
          "deal_room.view",
          "market_signals.view",
          "clients.view",
          "partners.manage",
          "admin.audit",
        ],
      },
    });
  } catch (err) {
    console.error("CREATE WORKSPACE ERROR:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to create workspace.",
    });
  }
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;

    const memberships = await Membership.find({
      userId,
      status: { $nin: ["disabled", "suspended"] },
    }).lean();

    const orgIds = memberships.map((m) => m.orgId).filter(Boolean);

    const orgs = await Organization.find({
      _id: { $in: orgIds },
    }).lean();

    return res.json({
      ok: true,
      workspaces: orgs.map((org) => ({
        _id: String(org._id),
        id: String(org._id),
        name: org.name,
        slug: org.slug,
        plan: org.plan || "SCALE",
        status: org.accessStatus || "pending",
        paymentStatus: org.paymentStatus || "pending",
        billing: org.billing || { status: "inactive" },
        trial: org.trial || null,
      })),
    });
  } catch (err) {
    console.error("GET WORKSPACES ERROR:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to load workspaces.",
    });
  }
});

router.post("/switch", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const workspaceId =
      req.body?.workspaceId || req.body?.orgId || req.headers["x-org-id"];

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized",
      });
    }

    if (!workspaceId || !mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({
        ok: false,
        message: "Valid workspaceId is required.",
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

    await User.updateOne(
      { _id: userId },
      {
        $set: {
          orgId: workspace._id,
          activeWorkspace: workspace._id,
          role: membership.role || "member",
        },
      }
    );

    return res.json({
      ok: true,
      activeWorkspace: {
        _id: String(workspace._id),
        id: String(workspace._id),
        name: workspace.name,
        slug: workspace.slug,
        plan: workspace.plan || "SCALE",
        status: workspace.accessStatus || "pending",
        paymentStatus: workspace.paymentStatus || "pending",
        billing: workspace.billing || { status: "inactive" },
        trial: workspace.trial || null,
      },
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

router.delete("/:workspaceId", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const { workspaceId } = req.params;

    if (!workspaceId || !mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({
        ok: false,
        message: "Valid workspaceId is required.",
      });
    }

    const membership = await Membership.findOne({
      userId,
      orgId: workspaceId,
      role: { $in: ["owner", "admin"] },
      status: { $nin: ["disabled", "suspended"] },
    }).lean();

    if (!membership) {
      return res.status(403).json({
        ok: false,
        message: "You do not have permission to delete this workspace.",
      });
    }

    await Membership.deleteMany({ orgId: workspaceId });
    await Organization.deleteOne({ _id: workspaceId });

    return res.json({
      ok: true,
      message: "Workspace deleted successfully.",
    });
  } catch (err) {
    console.error("DELETE WORKSPACE ERROR:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to delete workspace.",
    });
  }
});

export default router;