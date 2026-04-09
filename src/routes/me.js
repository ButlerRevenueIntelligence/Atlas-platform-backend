// backend/routes/me.js
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import Organization from "../models/Organization.js";
import Membership from "../models/Membership.js";
import enforceTrialStatus from "../utils/enforceTrialStatus.js";

const router = express.Router();

function normalizeWorkspace(org) {
  if (!org) return null;

  return {
    _id: org._id,
    id: org._id,
    name: org.name || org.companyName || "Workspace",
    slug: org.slug || null,
    plan: org.plan || null,
    status: org.status || org.accessStatus || null,
    billing: org.billing || {
      status: org.paymentStatus || "inactive",
    },
    trial: org.trial || {
      status: "none",
      startedAt: null,
      endsAt: null,
    },
  };
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;

    if (!userId) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized",
      });
    }

    const requestedOrgId =
      req.headers["x-org-id"] ||
      req.headers["x-workspace-id"] ||
      req.user?.activeWorkspace ||
      req.user?.orgId ||
      req.user?.organizationId ||
      req.user?.org ||
      null;

    const memberships = await Membership.find({
      userId,
      status: { $nin: ["disabled", "suspended"] },
    }).lean();

    const orgIds = memberships.map((m) => m.orgId).filter(Boolean);

    const organizations = orgIds.length
      ? await Organization.find({ _id: { $in: orgIds } })
      : [];

    for (const org of organizations) {
      await enforceTrialStatus(org);
    }

    const orgMap = new Map(
      organizations.map((org) => [String(org._id), org.toObject?.() || org])
    );

    let activeOrganization = null;

    if (requestedOrgId) {
      activeOrganization =
        orgMap.get(String(requestedOrgId)) ||
        (await Organization.findById(requestedOrgId));

      if (activeOrganization) {
        await enforceTrialStatus(activeOrganization);
        activeOrganization =
          activeOrganization.toObject?.() || activeOrganization;
      }
    }

    if (!activeOrganization && memberships.length) {
      const firstOrgId = memberships[0]?.orgId;
      activeOrganization =
        orgMap.get(String(firstOrgId)) || (await Organization.findById(firstOrgId));

      if (activeOrganization) {
        await enforceTrialStatus(activeOrganization);
        activeOrganization =
          activeOrganization.toObject?.() || activeOrganization;
      }
    }

    const billing = activeOrganization?.billing || {
      status: activeOrganization?.paymentStatus || "inactive",
    };

    const trial = activeOrganization?.trial || {
      status: "none",
      startedAt: null,
      endsAt: null,
    };

    const plan = activeOrganization?.plan || null;
    const accessStatus =
      activeOrganization?.accessStatus ||
      activeOrganization?.status ||
      null;
    const paymentStatus = activeOrganization?.paymentStatus || null;

    const activeWorkspace = normalizeWorkspace(activeOrganization);

    const activeMembership = activeOrganization
      ? memberships.find((m) => String(m.orgId) === String(activeOrganization._id))
      : null;

    const workspaces = memberships
      .map((membership) => {
        const org = orgMap.get(String(membership.orgId));
        if (!org) return null;

        return {
          workspace: normalizeWorkspace(org),
          role:
            membership.role ||
            req.user?.workspaceRole ||
            req.user?.orgRole ||
            req.user?.role ||
            "member",
          status: membership.status || "active",
          permissions: membership.permissions || [],
        };
      })
      .filter(Boolean);

    const effectiveAccessAllowed =
      accessStatus === "active" &&
      (
        billing?.status === "active" ||
        billing?.status === "trialing" ||
        paymentStatus === "paid" ||
        paymentStatus === "trialing"
      ) &&
      trial.status !== "expired";

    return res.json({
      ok: true,

      user: {
        ...req.user,
        activeWorkspace: activeOrganization?._id || null,
      },

      organization: activeOrganization || null,
      activeWorkspace,
      workspaces,

      role:
        activeMembership?.role ||
        req.user?.workspaceRole ||
        req.user?.orgRole ||
        req.user?.role ||
        "member",

      membership: activeMembership
        ? {
            role: activeMembership.role || "member",
            status: activeMembership.status || "active",
            permissions: activeMembership.permissions || [],
          }
        : null,

      billing,
      plan,
      status: accessStatus,
      trial,
      accessStatus,
      paymentStatus,
      workspaceActive: effectiveAccessAllowed,
      trialExpired: trial.status === "expired",
    });
  } catch (err) {
    console.error("ME route error:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to load user profile",
    });
  }
});

export default router;