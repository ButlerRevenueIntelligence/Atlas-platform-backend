// backend/routes/me.js
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import Organization from "../models/Organization.js";
import Membership from "../models/Membership.js";
import enforceTrialStatus from "../utils/enforceTrialStatus.js";

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    const activeOrgId =
      req.headers["x-org-id"] ||
      req.headers["x-workspace-id"] ||
      req.user?.activeWorkspace ||
      req.user?.orgId ||
      req.user?.organizationId ||
      req.user?.org ||
      null;

    const memberships = userId
      ? await Membership.find({
          userId,
          status: { $nin: ["disabled", "suspended"] },
        }).lean()
      : [];

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

    if (activeOrgId) {
      activeOrganization =
        orgMap.get(String(activeOrgId)) ||
        (await Organization.findById(activeOrgId));

      if (activeOrganization) {
        await enforceTrialStatus(activeOrganization);
        activeOrganization =
          activeOrganization.toObject?.() || activeOrganization;
      }
    }

    const billing = activeOrganization?.billing || {
      status: activeOrganization?.paymentStatus || "inactive",
    };

    const plan = activeOrganization?.plan || null;
    const status =
      activeOrganization?.status ||
      activeOrganization?.accessStatus ||
      null;

    const trial = activeOrganization?.trial || {
      status: "none",
      startedAt: null,
      endsAt: null,
    };

    const workspaces = memberships
      .map((membership) => {
        const org = orgMap.get(String(membership.orgId));
        if (!org) return null;

        return {
          workspace: {
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
          },
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

    const activeMembership = memberships.find(
      (m) => String(m.orgId) === String(activeOrgId)
    );

    return res.json({
      ok: true,

      user: {
        ...req.user,
        activeWorkspace: activeOrganization?._id || null,
      },

      organization: activeOrganization || null,

      activeWorkspace: activeOrganization
        ? {
            _id: activeOrganization._id,
            id: activeOrganization._id,
            name:
              activeOrganization.name ||
              activeOrganization.companyName ||
              "Workspace",
            slug: activeOrganization.slug || null,
            plan,
            status,
            billing,
            trial,
          }
        : null,

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
      status,
      trial,
      accessStatus:
        activeOrganization?.accessStatus ||
        activeOrganization?.status ||
        null,
      paymentStatus: activeOrganization?.paymentStatus || null,
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