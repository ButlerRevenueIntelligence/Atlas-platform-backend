// backend/controllers/workspaceController.js
import Organization from "../models/Organization.js";
import Membership from "../models/Membership.js";

/* -------------------------------- */
/* HELPERS                          */
/* -------------------------------- */

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
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const {
      name,
      slug: requestedSlug,
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
    const baseSlug = requestedSlug
      ? slugify(requestedSlug)
      : slugify(trimmedName);

    /* -------------------------------- */
    /* PREVENT DUPLICATES (SAME OWNER)  */
    /* -------------------------------- */

    const existingForOwner = await Organization.findOne({
      slug: baseSlug,
      ownerId: userId,
    }).lean();

    if (existingForOwner) {
      return res.status(409).json({
        ok: false,
        message: "Workspace already exists",
        existingWorkspace: {
          _id: existingForOwner._id,
          name: existingForOwner.name,
          slug: existingForOwner.slug,
        },
      });
    }

    /* -------------------------------- */
    /* ENSURE GLOBAL UNIQUE SLUG        */
    /* -------------------------------- */

    const existingGlobal = await Organization.findOne({
      slug: baseSlug,
    }).lean();

    const slug = existingGlobal
      ? await uniqueOrgSlug(trimmedName)
      : baseSlug;

    /* -------------------------------- */
    /* CREATE ORG                       */
    /* -------------------------------- */

    const org = await Organization.create({
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
      ...(companyWebsite && { companyWebsite }),
      ...(industry && { industry }),
    });

    /* -------------------------------- */
    /* CREATE MEMBERSHIP                */
    /* -------------------------------- */

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
      message: "Workspace created",
      workspace: {
        _id: org._id,
        name: org.name,
        slug: org.slug,
        plan: org.plan,
        type: org.type,
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
      return res.status(401).json({ ok: false, message: "Unauthorized" });
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
        message: "No access to workspace",
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
      },
    });
  } catch (err) {
    console.error("Switch workspace error:", err);

    return res.status(500).json({
      ok: false,
      message: "Failed to switch workspace",
    });
  }
}

/* -------------------------------- */
/* LIST WORKSPACES                  */
/* -------------------------------- */

export async function listWorkspaces(req, res) {
  try {
    const userId = req.user?.userId || req.user?._id || req.user?.id;

    const memberships = await Membership.find({
      userId,
      status: { $in: ["active", "invited"] },
    }).lean();

    const orgIds = memberships.map((m) => m.orgId);

    const orgs = await Organization.find({
      _id: { $in: orgIds },
    })
      .sort({ createdAt: 1 })
      .lean();

    const workspaces = orgs.map((org) => {
      const membership = memberships.find(
        (m) => String(m.orgId) === String(org._id)
      );

      return {
        _id: org._id,
        name: org.name,
        slug: org.slug,
        plan: org.plan,
        type: org.type,
        role: membership?.role,
      };
    });

    return res.json({ ok: true, workspaces });
  } catch (err) {
    console.error("List workspaces error:", err);

    return res.status(500).json({
      ok: false,
      message: "Failed to load workspaces",
    });
  }
}

/* -------------------------------- */
/* DELETE WORKSPACE                 */
/* -------------------------------- */

export async function deleteWorkspace(req, res) {
  try {
    const userId = req.user?.userId || req.user?._id || req.user?.id;
    const { workspaceId } = req.params;

    const org = await Organization.findById(workspaceId);

    if (!org) {
      return res.status(404).json({
        ok: false,
        message: "Workspace not found",
      });
    }

    if (String(org.ownerId) !== String(userId)) {
      return res.status(403).json({
        ok: false,
        message: "Only owner can delete workspace",
      });
    }

    /* -------------------------------- */
    /* PREVENT DELETING LAST WORKSPACE  */
    /* -------------------------------- */

    const owned = await Membership.find({
      userId,
      role: "owner",
      status: { $in: ["active", "invited"] },
    });

    if (owned.length <= 1) {
      return res.status(400).json({
        ok: false,
        message: "Cannot delete your only workspace",
      });
    }

    await Membership.deleteMany({ orgId: workspaceId });
    await Organization.findByIdAndDelete(workspaceId);

    return res.json({
      ok: true,
      message: "Workspace deleted",
    });
  } catch (err) {
    console.error("Delete workspace error:", err);

    return res.status(500).json({
      ok: false,
      message: "Failed to delete workspace",
    });
  }
}