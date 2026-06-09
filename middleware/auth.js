import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "../models/User.js";
import Organization from "../models/Organization.js";
import Membership from "../models/Membership.js";
import { computePermissions } from "../utils/permissions.js";

const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || "admin@butlerco.com")
  .trim()
  .toLowerCase();

const toStr = (v) => (v == null ? "" : String(v));
const isObjId = (v) => mongoose.Types.ObjectId.isValid(toStr(v));

function getToken(req) {
  const h = req.headers.authorization || req.headers.Authorization;
  if (!h) return null;

  const parts = String(h).split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
    return parts[1];
  }

  return null;
}

function normalizeRole(role) {
  return String(role || "").trim().toLowerCase();
}

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function resolveOrgId(req, decoded, user) {
  return (
    req.headers["x-org-id"] ||
    req.headers["x-workspace-id"] ||
    decoded?.activeWorkspace ||
    decoded?.orgId ||
    decoded?.organizationId ||
    user?.activeWorkspace ||
    user?.orgId ||
    null
  );
}

function isBillingSafeRoute(req) {
  const url = String(req.originalUrl || req.url || "").toLowerCase();

  return (
    url.includes("/stripe/create-checkout-session") ||
    url.includes("/stripe/create-portal-session") ||
    url.includes("/stripe/webhook") ||
    url.includes("/me") ||
    url.includes("/auth/workspaces") ||
    url.includes("/auth/switch-workspace")
  );
}

function hasPaidAccess(org) {
  const billingStatus = String(org?.billing?.status || "").toLowerCase();
  const paymentStatus = String(org?.paymentStatus || "").toLowerCase();

  return billingStatus === "active" || paymentStatus === "paid";
}

function trialIsExpired(org) {
  const trialStatus = String(org?.trial?.status || "").toLowerCase();
  const endsAt = org?.trial?.endsAt;

  if (trialStatus !== "trialing" || !endsAt) return false;

  return new Date() > new Date(endsAt);
}

async function findMembershipForOrg({ userId, orgId }) {
  if (!userId || !orgId) return null;

  const uid = isObjId(userId) ? new mongoose.Types.ObjectId(userId) : userId;
  const oid = isObjId(orgId) ? new mongoose.Types.ObjectId(orgId) : orgId;

  return Membership.findOne({ userId: uid, orgId: oid }).lean();
}

export async function requireUser(req, res, next) {
  try {
    const token = getToken(req);

    if (!token) {
      return res.status(401).json({ ok: false, error: "Missing auth token" });
    }

    const secret = process.env.JWT_SECRET;

    if (!secret) {
      return res.status(500).json({ ok: false, error: "JWT_SECRET not set" });
    }

    let decoded;

    try {
      decoded = jwt.verify(token, secret);
    } catch {
      return res.status(401).json({ ok: false, error: "Invalid or expired token" });
    }

    const userId = decoded?.userId || decoded?.id || decoded?._id;

    if (!userId) {
      return res.status(401).json({ ok: false, error: "Invalid token payload" });
    }

    const user = await User.findById(userId)
      .select("_id email name orgId activeWorkspace role status")
      .lean();

    if (!user) {
      return res.status(401).json({ ok: false, error: "User not found" });
    }

    const userStatus = normalizeStatus(user.status || "active");

    if (userStatus === "disabled" || userStatus === "suspended") {
      return res.status(403).json({ ok: false, error: "User account is inactive" });
    }

    req.user = {
      id: String(user._id),
      userId: String(user._id),
      email: user.email,
      name: user.name,
      role: normalizeRole(user.role) || null,
      tokenOrgId: decoded?.orgId || decoded?.organizationId || null,
      tokenActiveWorkspace: decoded?.activeWorkspace || null,
      defaultOrgId: user?.orgId ? String(user.orgId) : null,
      activeWorkspace: user?.activeWorkspace ? String(user.activeWorkspace) : null,
      status: userStatus,
    };

    return next();
  } catch (err) {
    console.error("requireUser error:", err);
    return res.status(500).json({ ok: false, error: "Auth middleware error" });
  }
}

export async function requireAuth(req, res, next) {
  try {
    await requireUser(req, res, async () => {
      const resolvedOrgId = resolveOrgId(
        req,
        {
          orgId: req.user.tokenOrgId,
          activeWorkspace: req.user.tokenActiveWorkspace,
        },
        {
          orgId: req.user.defaultOrgId,
          activeWorkspace: req.user.activeWorkspace,
        }
      );

      if (String(req.user.email || "").trim().toLowerCase() === SUPER_ADMIN_EMAIL) {
        const orgId = resolvedOrgId ? String(resolvedOrgId) : null;

        let org = null;

        if (orgId && isObjId(orgId)) {
          org = await Organization.findById(orgId).select("_id name slug plan billing").lean();
        }

        req.user = {
          ...req.user,
          orgId,
          activeWorkspace: orgId,
          orgName: org?.name || "Butler & Co",
          workspaceName: org?.name || "Butler & Co",
          workspaceSlug: org?.slug || null,
          plan: String(org?.plan || "ENTERPRISE").toUpperCase(),
          orgRole: "owner",
          workspaceRole: "owner",
          perms: ["*"],
          permissions: ["*"],
          membership: {
            role: "owner",
            status: "active",
          },
        };

        return next();
      }

      if (!resolvedOrgId) {
        return res.status(400).json({
          ok: false,
          error: "Missing org context (x-org-id)",
          code: "ORG_CONTEXT_REQUIRED",
        });
      }

      const membership = await findMembershipForOrg({
        userId: req.user.userId,
        orgId: resolvedOrgId,
      });

      if (!membership) {
        return res.status(403).json({
          ok: false,
          error: "Not authorized for this org",
          code: "ORG_ACCESS_DENIED",
        });
      }

      const membershipStatus = normalizeStatus(membership.status || "active");

      if (membershipStatus === "disabled" || membershipStatus === "suspended") {
        return res.status(403).json({
          ok: false,
          error: "Membership inactive",
          code: "MEMBERSHIP_INACTIVE",
        });
      }

      const org = await Organization.findById(resolvedOrgId).select(
        "_id name slug plan status accessStatus billing paymentStatus trial approvedForAccess"
      );

      if (!org) {
        return res.status(404).json({
          ok: false,
          error: "Workspace not found",
          code: "WORKSPACE_NOT_FOUND",
        });
      }

      const paid = hasPaidAccess(org);
      const expiredTrial = trialIsExpired(org);

      if (expiredTrial && !paid) {
        org.trial.status = "expired";
        org.billing.status = "inactive";
        org.paymentStatus = "pending";
        org.accessStatus = "suspended";
        org.approvedForAccess = false;

        await org.save();
      }

      const suspended =
        String(org.accessStatus || "").toLowerCase() === "suspended" ||
        org.approvedForAccess === false;

      if (!paid && suspended && !isBillingSafeRoute(req)) {
        return res.status(402).json({
          ok: false,
          error: "Your free trial has ended. Please choose a plan to continue.",
          code: "TRIAL_EXPIRED",
          redirectTo: "/billing",
        });
      }

      const plan = String(org?.plan || "SCALE").toUpperCase();
      const orgRole = normalizeRole(membership?.role || "analyst");
      const overrides = Array.isArray(membership?.permissions) ? membership.permissions : [];
      const perms = computePermissions({ plan, role: orgRole, overrides });

      req.user = {
        ...req.user,
        orgId: String(resolvedOrgId),
        activeWorkspace: String(resolvedOrgId),
        orgName: org?.name || "",
        workspaceName: org?.name || "",
        workspaceSlug: org?.slug || null,
        plan,
        orgRole,
        workspaceRole: orgRole,
        perms,
        permissions: perms,
        membership,
        billing: org?.billing || {
          status: org?.paymentStatus || "inactive",
        },
        trial: org?.trial || null,
        paymentStatus: org?.paymentStatus || null,
        accessStatus: org?.accessStatus || null,
        approvedForAccess: org?.approvedForAccess,
        workspaceStatus: org?.status || org?.accessStatus || null,
      };

      return next();
    });
  } catch (err) {
    console.error("requireAuth error:", err);
    return res.status(500).json({ ok: false, error: "Auth middleware error" });
  }
}

export function requireOrgRole(minRole = "analyst") {
  const order = ["viewer", "member", "analyst", "manager", "admin", "owner"];
  const minIdx = order.indexOf(normalizeRole(minRole));

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const role = normalizeRole(req.user.orgRole || req.user.workspaceRole || "analyst");
    const idx = order.indexOf(role);

    if (idx === -1 || idx < minIdx) {
      return res.status(403).json({ ok: false, error: "Insufficient role" });
    }

    return next();
  };
}

export function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const perms = Array.isArray(req.user.permissions) ? req.user.permissions : [];

    if (perms.includes("*")) return next();

    if (!perm || !perms.includes(perm)) {
      return res.status(403).json({
        ok: false,
        error: "Insufficient permissions",
        perm,
      });
    }

    return next();
  };
}
