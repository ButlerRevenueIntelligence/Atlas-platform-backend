import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import User from "../models/User.js";
import Organization from "../models/Organization.js";
import Membership from "../models/Membership.js";

import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/* ------------------------------------------------ */
/* Defaults */
/* ------------------------------------------------ */
const FULL_PERMS = [
  "overview.view",
  "revenue_intel.view",
  "command_center.view",
  "deal_room.view",
  "market_signals.view",
  "accounts.view",
  "partners.view",
  "admin.view",
];

/* ------------------------------------------------ */
/* Helpers */
/* ------------------------------------------------ */
function normalizeId(v) {
  return v ? String(v) : null;
}

function buildWorkspaceAccess(org, orgRole) {
  const accessStatus = String(
    org?.accessStatus ?? org?.status ?? "pending"
  ).toLowerCase();

  const paymentStatus = String(
    org?.paymentStatus ?? org?.billingStatus ?? "pending"
  ).toLowerCase();

  const approvedForAccess =
    typeof org?.approvedForAccess === "boolean"
      ? org.approvedForAccess
      : Boolean(org?.isActive);

  const demoCompleted =
    typeof org?.demoCompleted === "boolean"
      ? org.demoCompleted
      : true;

  const workspaceActive =
    accessStatus === "active" &&
    (paymentStatus === "paid" || paymentStatus === "active") &&
    approvedForAccess &&
    demoCompleted;

  const override = orgRole === "admin" || orgRole === "owner";

  return {
    workspaceActive,
    accessStatus,
    paymentStatus,
    approvedForAccess,
    demoCompleted,
    override,
  };
}

function resolvePermissions(membershipRole, membershipPermissions) {
  const role = String(membershipRole || "member").toLowerCase();

  let permissions = Array.isArray(membershipPermissions)
    ? membershipPermissions
    : [];

  if (role === "admin" || role === "owner") {
    permissions = FULL_PERMS;
  }

  return permissions;
}

/* ------------------------------------------------ */
/* JWT helper */
/* ------------------------------------------------ */
function signToken({ userId, email, role, orgId, activeWorkspace }) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("Missing JWT_SECRET");

  return jwt.sign(
    {
      userId: String(userId),
      id: String(userId),
      email,
      role: role || "user",
      orgId: orgId ? String(orgId) : null,
      activeWorkspace: activeWorkspace ? String(activeWorkspace) : null,
    },
    secret,
    { expiresIn: "7d" }
  );
}

/* ------------------------------------------------ */
/* Public signup disabled */
/* ------------------------------------------------ */
router.post("/signup", async (req, res) => {
  return res.status(403).json({
    ok: false,
    message:
      "Public signup is disabled. Atlas access is granted after a live demo, approved billing, and workspace invitation.",
  });
});

/* ------------------------------------------------ */
/* LOGIN */
/* ------------------------------------------------ */
router.post("/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    console.log("LOGIN ATTEMPT EMAIL:", email);

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        message: "Email + password required",
      });
    }

    const user = await User.findOne({ email })
      .select("+password passwordHash")
      .lean();

    console.log("LOGIN USER FOUND:", !!user);

    if (user) {
      console.log("LOGIN USER ID:", String(user._id));
      console.log("LOGIN USER EMAIL:", user.email);
      console.log("LOGIN USER HAS password:", !!user.password);
      console.log("LOGIN USER HAS passwordHash:", !!user.passwordHash);
      console.log("LOGIN USER orgId:", user.orgId ? String(user.orgId) : null);
      console.log(
        "LOGIN USER activeWorkspace:",
        user.activeWorkspace ? String(user.activeWorkspace) : null
      );
    }

    if (!user) {
      return res.status(401).json({
        ok: false,
        message: "Invalid credentials",
      });
    }

    const passwordHash = user.passwordHash || user.password;

    console.log("LOGIN HASH DEBUG", {
      email,
      hasResolvedPasswordHash: !!passwordHash,
      usingField: user.passwordHash ? "passwordHash" : "password",
    });

    if (!passwordHash) {
      return res.status(401).json({
        ok: false,
        message: "Invalid credentials",
      });
    }

    const match = await bcrypt.compare(password, passwordHash);

    console.log("BCRYPT MATCH:", {
      email,
      match,
    });

    if (!match) {
      return res.status(401).json({
        ok: false,
        message: "Invalid credentials",
      });
    }

    const memberships = await Membership.find({
      userId: user._id,
      status: { $nin: ["disabled", "suspended"] },
    })
      .sort({ createdAt: 1 })
      .lean();

    console.log("LOGIN MEMBERSHIP DEBUG", {
      email,
      membershipCount: memberships.length,
      membershipOrgIds: memberships.map((m) => String(m.orgId)),
    });

    if (!memberships.length) {
      return res.status(403).json({
        ok: false,
        message: "No workspace is attached to this account.",
        code: "NO_WORKSPACE",
      });
    }

    const requestedOrgId =
      req.headers["x-org-id"] ||
      req.headers["x-workspace-id"] ||
      req.body?.orgId ||
      req.body?.workspaceId ||
      null;

    let activeMembership = null;

    if (requestedOrgId) {
      activeMembership = memberships.find(
        (m) => String(m.orgId) === String(requestedOrgId)
      );
    }

    if (!activeMembership && user.activeWorkspace) {
      activeMembership = memberships.find(
        (m) => String(m.orgId) === String(user.activeWorkspace)
      );
    }

    if (!activeMembership && user.orgId) {
      activeMembership = memberships.find(
        (m) => String(m.orgId) === String(user.orgId)
      );
    }

    if (!activeMembership) {
      activeMembership = memberships[0];
    }

    const orgIds = memberships.map((m) => normalizeId(m.orgId)).filter(Boolean);

    const orgs = await Organization.find({ _id: { $in: orgIds } }).lean();
    const orgMap = new Map(orgs.map((o) => [String(o._id), o]));

    const activeOrg = orgMap.get(String(activeMembership.orgId)) || null;

    console.log("LOGIN ORG DEBUG", {
      email,
      requestedOrgId: requestedOrgId ? String(requestedOrgId) : null,
      activeMembershipOrgId: activeMembership?.orgId
        ? String(activeMembership.orgId)
        : null,
      foundActiveOrg: !!activeOrg,
      activeOrgName: activeOrg?.name || null,
    });

    if (!activeOrg) {
      return res.status(403).json({
        ok: false,
        message: "No workspace is attached to this account.",
        code: "NO_WORKSPACE",
      });
    }

    const orgRole = activeMembership?.role || user.role || "member";
    const permissions = resolvePermissions(
      orgRole,
      activeMembership?.permissions
    );

    const access = buildWorkspaceAccess(activeOrg, orgRole);

    console.log("LOGIN ACCESS DEBUG", {
      email,
      orgRole,
      workspaceActive: access.workspaceActive,
      accessStatus: access.accessStatus,
      paymentStatus: access.paymentStatus,
      approvedForAccess: access.approvedForAccess,
      demoCompleted: access.demoCompleted,
      override: access.override,
    });

    if (!access.workspaceActive && !access.override) {
      return res.status(403).json({
        ok: false,
        message:
          "Your workspace is not active yet. Atlas access is enabled after demo completion, approved billing, and workspace activation.",
        code: "WORKSPACE_NOT_ACTIVE",
      });
    }

    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          orgId: activeMembership.orgId,
          activeWorkspace: activeMembership.orgId,
          role: orgRole,
        },
      }
    );

    const token = signToken({
      userId: user._id,
      email: user.email,
      role: orgRole,
      orgId: activeMembership.orgId,
      activeWorkspace: activeMembership.orgId,
    });

    const workspacePayload = memberships
      .map((m) => {
        const org = orgMap.get(String(m.orgId));
        if (!org) return null;

        const role = m.role || "member";
        const perms = resolvePermissions(role, m.permissions);

        return {
          workspace: {
            _id: String(org._id),
            id: String(org._id),
            name: org.name || "Workspace",
            slug: org.slug || null,
            plan: org.plan || null,
            status: org.status || org.accessStatus || null,
            billing: org.billing || {
              status: org.paymentStatus || "inactive",
            },
          },
          role,
          status: m.status || "active",
          permissions: perms,
        };
      })
      .filter(Boolean);

    return res.json({
      ok: true,
      token,
      user: {
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: orgRole,
        orgId: String(activeMembership.orgId),
        orgName: activeOrg?.name || "",
        plan: activeOrg?.plan || "SCALE",
        permissions,
      },

      activeWorkspace: {
        _id: String(activeOrg._id),
        id: String(activeOrg._id),
        name: activeOrg?.name || "Workspace",
        slug: activeOrg?.slug || null,
        plan: activeOrg?.plan || null,
        status: activeOrg?.status || activeOrg?.accessStatus || null,
        billing: activeOrg?.billing || {
          status: activeOrg?.paymentStatus || "inactive",
        },
      },

      workspaces: workspacePayload,

      membership: {
        role: orgRole,
        status: activeMembership?.status || "active",
        permissions,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({
      ok: false,
      message: "Server error",
    });
  }
});

/* ------------------------------------------------ */
/* SWITCH ACTIVE WORKSPACE */
/* ------------------------------------------------ */
router.post("/switch-workspace", requireAuth, async (req, res) => {
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

    if (!workspaceId) {
      return res.status(400).json({
        ok: false,
        message: "workspaceId is required",
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
        message: "No access to this workspace",
        code: "ORG_ACCESS_DENIED",
      });
    }

    const org = await Organization.findById(workspaceId).lean();
    if (!org) {
      return res.status(404).json({
        ok: false,
        message: "Workspace not found",
        code: "WORKSPACE_NOT_FOUND",
      });
    }

    const role = membership.role || "member";
    const permissions = resolvePermissions(role, membership.permissions);
    const access = buildWorkspaceAccess(org, role);

    if (!access.workspaceActive && !access.override) {
      return res.status(403).json({
        ok: false,
        message: "This workspace is not active yet.",
        code: "WORKSPACE_NOT_ACTIVE",
      });
    }

    await User.updateOne(
      { _id: userId },
      {
        $set: {
          orgId: org._id,
          activeWorkspace: org._id,
          role,
        },
      }
    );

    const user = await User.findById(userId).lean();

    const token = signToken({
      userId: user._id,
      email: user.email,
      role,
      orgId: org._id,
      activeWorkspace: org._id,
    });

    return res.json({
      ok: true,
      token,
      activeWorkspace: {
        _id: String(org._id),
        id: String(org._id),
        name: org.name || "Workspace",
        slug: org.slug || null,
        plan: org.plan || null,
        status: org.status || org.accessStatus || null,
        billing: org.billing || {
          status: org.paymentStatus || "inactive",
        },
      },
      membership: {
        role,
        status: membership.status || "active",
        permissions,
      },
    });
  } catch (err) {
    console.error("Switch workspace error:", err);
    return res.status(500).json({
      ok: false,
      message: "Server error",
    });
  }
});

/* ------------------------------------------------ */
/* ME */
/* ------------------------------------------------ */
router.get("/me", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized",
      });
    }

    const user = await User.findById(userId).lean();
    if (!user) {
      return res.status(404).json({
        ok: false,
        message: "User not found",
      });
    }

    const memberships = await Membership.find({
      userId: user._id,
      status: { $nin: ["disabled", "suspended"] },
    }).lean();

    const orgIds = memberships.map((m) => m.orgId).filter(Boolean);
    const orgs = await Organization.find({ _id: { $in: orgIds } }).lean();
    const orgMap = new Map(orgs.map((o) => [String(o._id), o]));

    const activeOrgId =
      req.headers["x-org-id"] ||
      req.headers["x-workspace-id"] ||
      user.activeWorkspace ||
      user.orgId ||
      memberships[0]?.orgId ||
      null;

    const activeMembership = memberships.find(
      (m) => String(m.orgId) === String(activeOrgId)
    );

    const activeOrg = activeMembership
      ? orgMap.get(String(activeMembership.orgId))
      : null;

    const role = activeMembership?.role || user.role || "member";
    const permissions = resolvePermissions(
      role,
      activeMembership?.permissions
    );

    return res.json({
      ok: true,
      user: {
        id: String(user._id),
        name: user.name,
        email: user.email,
        orgId: activeOrg ? String(activeOrg._id) : "",
        orgName: activeOrg?.name || "",
        role,
        plan: activeOrg?.plan || "SCALE",
        perms: permissions,
        permissions,
      },

      activeWorkspace: activeOrg
        ? {
            _id: String(activeOrg._id),
            id: String(activeOrg._id),
            name: activeOrg.name || "Workspace",
            slug: activeOrg.slug || null,
            plan: activeOrg.plan || null,
            status: activeOrg.status || activeOrg.accessStatus || null,
            billing: activeOrg.billing || {
              status: activeOrg.paymentStatus || "inactive",
            },
          }
        : null,

      workspaces: memberships
        .map((m) => {
          const org = orgMap.get(String(m.orgId));
          if (!org) return null;

          const role = m.role || "member";
          const perms = resolvePermissions(role, m.permissions);

          return {
            workspace: {
              _id: String(org._id),
              id: String(org._id),
              name: org.name || "Workspace",
              slug: org.slug || null,
              plan: org.plan || null,
              status: org.status || org.accessStatus || null,
              billing: org.billing || {
                status: org.paymentStatus || "inactive",
              },
            },
            role,
            status: m.status || "active",
            permissions: perms,
          };
        })
        .filter(Boolean),

      membership: activeMembership
        ? {
            role,
            status: activeMembership.status || "active",
            permissions,
          }
        : null,

      billing: activeOrg?.billing || {
        status: activeOrg?.paymentStatus || "inactive",
      },
      plan: activeOrg?.plan || null,
      status: activeOrg?.status || activeOrg?.accessStatus || null,
    });
  } catch (err) {
    console.error("ME error:", err);
    return res.status(500).json({
      ok: false,
      message: "Server error",
    });
  }
});

/* ------------------------------------------------ */
router.get("/health", (req, res) => {
  res.json({ ok: true });
});

router.get("/force-create-user", async (req, res) => {
  const bcrypt = await import("bcryptjs");

  const hash = await bcrypt.default.hash("Atlas123!", 10);

  const user = await User.findOneAndUpdate(
    { email: "cd@drccompany.com" },
    {
      name: "GEMM",
      email: "cd@drccompany.com",
      passwordHash: hash,
      password: hash,
      role: "owner",
      status: "active",
    },
    { upsert: true, new: true }
  );

  res.json({ ok: true, user });
});

router.get("/force-create-membership", async (req, res) => {
  try {
    const user = await User.findOne({ email: "cd@drccompany.com" });

    if (!user) {
      return res.status(404).json({
        ok: false,
        message: "User not found",
      });
    }

    const existing = await Membership.findOne({
      userId: user._id,
      orgId: user.orgId,
    }).lean();

    if (existing) {
      return res.json({
        ok: true,
        membership: existing,
        alreadyExisted: true,
      });
    }

    const membership = await Membership.create({
      userId: user._id,
      orgId: user.orgId,
      role: "owner",
      status: "active",
    });

    return res.json({
      ok: true,
      membership,
      alreadyExisted: false,
    });
  } catch (err) {
    console.error("force-create-membership error:", err);
    return res.status(500).json({
      ok: false,
      message: err.message || "Failed to create membership",
    });
  }
});
export default router;