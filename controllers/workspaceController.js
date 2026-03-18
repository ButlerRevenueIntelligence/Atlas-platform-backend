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

/*
CREATE WORKSPACE
*/
export async function createWorkspace(req, res) {
  try {
    const { name, companyWebsite, industry } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        ok: false,
        message: "Workspace name is required",
      });
    }

    const slug = await uniqueOrgSlug(name);

    const org = await Organization.create({
      name: String(name).trim(),
      companyWebsite,
      industry,
      slug,
      ownerId: req.user.userId,
      type: "client",
      plan: "SCALE",
      demoCompleted: false,
      approvedForAccess: false,
      accessStatus: "pending",
      paymentStatus: "pending",
    });

    await Membership.create({
      userId: req.user.userId,
      orgId: org._id,
      workspaceId: org._id,
      role: "owner",
      status: "active",
      permissions: ["*"],
    });

    res.json({
      ok: true,
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

    res.status(500).json({
      ok: false,
      message: "Failed to create workspace",
    });
  }
}

/*
SWITCH WORKSPACE
*/
export async function switchWorkspace(req, res) {
  try {
    const { workspaceId } = req.body;

    if (!workspaceId) {
      return res.status(400).json({
        ok: false,
        message: "workspaceId is required",
      });
    }

    const membership = await Membership.findOne({
      userId: req.user.userId,
      orgId: workspaceId,
      status: { $ne: "disabled" },
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

    res.json({
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

    res.status(500).json({
      ok: false,
      message: "Failed to switch workspace",
    });
  }
}