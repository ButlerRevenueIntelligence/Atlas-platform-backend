// backend/middleware/permissions.js
import Membership from "../models/Membership.js";
import { computePermissions } from "../utils/permissions.js";

export function requirePerm(perm) {
  return async function (req, res, next) {
    try {
      const userId = req.user?.userId || req.user?._id;
      const orgId = req.headers["x-org-id"] || req.user?.orgId;

      if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });
      if (!orgId) return res.status(400).json({ ok: false, message: "No org selected" });

      // Load membership for plan/role
      const membership = await Membership.findOne({
        userId,
        orgId,
        status: { $ne: "disabled" },
      }).lean();

      const plan = String(membership?.plan || membership?.tier || req.user?.plan || "GROWTH").toUpperCase();
      const role = String(membership?.role || req.user?.role || "ANALYST").toUpperCase();

      const perms = computePermissions(plan, role);

      // attach to req.user for downstream
      req.user.plan = plan;
      req.user.role = role;
      req.user.perms = perms;

      if (!perms.includes(perm)) {
        return res.status(403).json({
          ok: false,
          code: "PERMISSION_DENIED",
          message: `Upgrade required: missing permission ${perm}`,
          perm,
          plan,
        });
      }

      return next();
    } catch (e) {
      console.error("requirePerm error:", e);
      return res.status(500).json({ ok: false, message: "Permission check failed" });
    }
  };
}