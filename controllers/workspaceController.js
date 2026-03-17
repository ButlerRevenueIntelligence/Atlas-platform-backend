import Organization from "../models/Organization.js";
import Membership from "../models/Membership.js";

/*
CREATE WORKSPACE
*/
export async function createWorkspace(req, res) {
  try {
    const { name, companyWebsite, industry } = req.body;

    const org = await Organization.create({
      name,
      companyWebsite,
      industry,
      owner: req.user.userId,
    });

    await Membership.create({
      userId: req.user.userId,
      orgId: org._id,
      role: "owner",
      status: "active",
    });

    res.json({
      ok: true,
      workspace: org,
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

    const membership = await Membership.findOne({
      userId: req.user.userId,
      orgId: workspaceId,
    });

    if (!membership) {
      return res.status(403).json({
        ok: false,
        message: "You do not have access to that workspace",
      });
    }

    const organization = await Organization.findById(workspaceId).lean();

    res.json({
      ok: true,
      activeWorkspace: organization,
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