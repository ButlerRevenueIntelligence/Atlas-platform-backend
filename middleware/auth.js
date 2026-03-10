// backend/middleware/auth.js
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "../models/User.js";
import Organization from "../models/Organization.js";
import Membership from "../models/Membership.js";
import { computePermissions } from "../utils/permissions.js";

// SUPER ADMIN CONFIG
const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || "admin@butlerco.com")
  .trim()
  .toLowerCase();

function isSuperAdminEmail(email) {
  return String(email || "").trim().toLowerCase() === SUPER_ADMIN_EMAIL;
}

const toStr = (v) => (v == null ? "" : String(v));
const isObjId = (v) => mongoose.Types.ObjectId.isValid(toStr(v));

function getToken(req) {
  const h = req.headers.authorization || req.headers.Authorization;
  if (!h) return null;
  const parts = String(h).split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") return parts[1];
  return null;
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
    if (!token) return res.status(401).json({ ok: false, error: "Missing auth token" });

    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ ok: false, error: "JWT_SECRET not set" });

    let decoded;
    try {
      decoded = jwt.verify(token, secret);
    } catch {
      return res.status(401).json({ ok: false, error: "Invalid or expired token" });
    }

    const userId = decoded?.userId || decoded?.id || decoded?._id;
    if (!userId) return res.status(401).json({ ok: false, error: "Invalid token payload" });

    const user = await User.findById(userId).select("_id email name orgId role").lean();
    if (!user) return res.status(401).json({ ok: false, error: "User not found" });

    req.user = {
      id: String(user._id),
      userId: String(user._id),
      email: user.email,
      name: user.name,
      role: toStr(user?.role || "").toLowerCase() || null,
      tokenOrgId: decoded?.orgId || decoded?.organizationId || null,
      defaultOrgId: user?.orgId ? String(user.orgId) : null,
    };

    next();
  } catch (err) {
    console.error("requireUser error:", err);
    return res.status(500).json({ ok: false, error: "Auth middleware error" });
  }
}

export async function requireAuth(req, res, next) {
  try {
    await new Promise((resolve) => requireUser(req, res, resolve));
    if (!req.user) return;

    const headerOrgId = req.headers["x-org-id"] || req.headers["X-Org-Id"];
    const resolvedOrgId = headerOrgId || req.user.tokenOrgId || req.user.defaultOrgId || null;

    // ✅ SUPER ADMIN OVERRIDE (fix: provide plan + perms + permissions)
    if (req.user.email === SUPER_ADMIN_EMAIL) {
      const orgId = resolvedOrgId;

      req.user = {
        ...req.user,
        orgId: orgId ? String(orgId) : null,
        orgName: "Butler & Co",
        plan: "ENTERPRISE",
        orgRole: "owner",
        perms: ["*"],        // <-- THIS is what /auth/me reads
        permissions: ["*"],  // <-- keep compatibility with requirePerm()
      };

      return next();
    }

    if (!resolvedOrgId) {
      return res.status(400).json({ ok: false, error: "Missing org context (x-org-id)" });
    }

    const membership = await findMembershipForOrg({ userId: req.user.userId, orgId: resolvedOrgId });
    if (!membership) return res.status(403).json({ ok: false, error: "Not authorized for this org" });
    if (membership.status && membership.status !== "active") {
      return res.status(403).json({ ok: false, error: "Membership inactive" });
    }

    const org = await Organization.findById(resolvedOrgId).select("_id name plan").lean();
    const plan = String(org?.plan || "SCALE").toUpperCase();

    const orgRole = String(membership?.role || "analyst").toLowerCase();
    const overrides = Array.isArray(membership?.permissions) ? membership.permissions : [];
    const perms = computePermissions({ plan, role: orgRole, overrides });

    req.user = {
      ...req.user,
      orgId: String(resolvedOrgId),
      orgName: org?.name || "",
      plan,
      orgRole,
      perms,          // <-- /auth/me expects this
      permissions: perms, // <-- requirePerm() expects this
      membership,
    };

    next();
  } catch (err) {
    console.error("requireAuth error:", err);
    return res.status(500).json({ ok: false, error: "Auth middleware error" });
  }
}

export function requireOrgRole(minRole = "analyst") {
  const order = ["sales", "analyst", "manager", "admin", "owner"];
  const minIdx = order.indexOf(String(minRole).toLowerCase());

  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const role = String(req.user.orgRole || "analyst").toLowerCase();
    const idx = order.indexOf(role);

    if (idx === -1 || idx < minIdx) {
      return res.status(403).json({ ok: false, error: "Insufficient role" });
    }

    next();
  };
}

export function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const perms = Array.isArray(req.user.permissions) ? req.user.permissions : [];
    if (perms.includes("*")) return next();

    if (!perm || !perms.includes(perm)) {
      return res.status(403).json({ ok: false, error: "Insufficient permissions", perm });
    }

    next();
  };
}