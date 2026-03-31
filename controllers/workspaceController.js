// backend/controllers/workspaceController.js
import Organization from "../models/Organization.js";
import Membership from "../models/Membership.js";

function slugify(value = "") {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function uniqueOrgSlug(baseName = "") {
  const base = slugify(baseName) || `workspace-${Date.now()}`;
  let slug = base;
  let i = 1;

  while (true) {
    const exists = await Organization.findOne({ slug }).lean();
    if (!exists) return slug;
    slug = `${base}-${i++}`;
  }
}

/* -------------------------------- */
/* CREATE WORKSPACE                 */
/* -------------------------------- */
export async function createWorkspace(req, res) {
  try {
    const userId = req.user?.userId || req.user?._id || req.user?.id;

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized",
      });
    }

    const {
      name,
      companyWebsite = "",
      industry = "",
      type = "client",
      plan = "ENTERPRISE",
    } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        ok: false,
        message: "Workspace name is required",
      });
    }

    const trimmedName = String(name).trim();
    const slug = await uniqueOrgSlug(trimmedName);

    const orgPayload = {
      name: trimmedName,
      slug,
      ownerId: userId,
      type,
      plan,
      demoCompleted: false,
      approvedForAccess: true,
      accessStatus: "active",
      paymentStatus: "pending",
      trial: {
        startedAt: null,
        endsAt: null,
        status: "none",
      },
      usage: {
        aiAnalyses: 0,
        reportsGenerated: 0,
        forecastsRun: 0,
      },
      billing: {
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripePriceId: null,
        status: "active",
        currentPeriodEnd: null,
      },
    };

    // Only include these if your Organization schema supports them
    if (companyWebsite) orgPayload.companyWebsite = companyWebsite;
    if (industry) orgPayload.industry = industry;

    const org = await Organization.create(orgPayload);

    await Membership.create({
      userId,
      orgId: org._id,
      workspaceId: org._id,
      role: "owner",
      status: "active",
      permissions: ["*"],
      invitedBy: userId,
      joinedAt: new Date(),
    });

    return res.status(201).json({
      ok: true,
      message: "Workspace created successfully",
      workspace: {
        _id: org._id,
        name: org.name,
        slug: org.slug,
        plan: org.plan,
        type: org.type,
        accessStatus: org.accessStatus,
        paymentStatus: org.paymentStatus,
      },
    });
  } catch (err) {
    console.error("Create workspace error:", err);

    return res.status(500).json({
      ok: false,
      message: "Failed to create workspace",
      error: err.message,
    });
  }
}

/* -------------------------------- */
/* SWITCH WORKSPACE                 */
/* -------------------------------- */
export async function switchWorkspace(req, res) {
  try {
    const userId = req.user?.userId || req.user?._id || req.user?.id;
    const { workspaceId } = req.body;

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized",
      });
    }

    if (!workspaceId) {
      return res.status(400).json({
        ok: false,
        message: "workspaceId is required",
      });
    }

    const membership = await Membership.findOne({
      userId,
      orgId: workspaceId,
      status: { $in: ["active", "invited"] },
    }).lean();

    if (!membership) {
      return res.status(403).json({
        ok: false,
        message: "You do not have access to that workspace",
      });
    }

    const organization = await Organization.findById(workspaceId).lean();

    if (!organization) {
      return res.status(404).json({
        ok: false,
        message: "Workspace not found",
      });
    }

    return res.json({
      ok: true,
      activeWorkspace: {
        _id: organization._id,
        name: organization.name,
        slug: organization.slug,
        plan: organization.plan,
        type: organization.type,
        accessStatus: organization.accessStatus,
        paymentStatus: organization.paymentStatus,
      },
      membership,
    });
  } catch (err) {
    console.error("Switch workspace error:", err);

    return res.status(500).json({
      ok: false,
      message: "Failed to switch workspace",
      error: err.message,
    });
  }
}