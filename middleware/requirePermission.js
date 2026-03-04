const Organization = require("../models/Organization");
const Membership = require("../models/Membership");
const { computePermissions } = require("../utils/permissions");

module.exports = function requirePermission(permission) {
  return async function (req, res, next) {
    try {
      const userId = req.user.id; // from your auth middleware
      const orgId = req.headers["x-org-id"];

      if (!orgId) {
        return res.status(400).json({ error: "Missing organization" });
      }

      const org = await Organization.findById(orgId);
      const membership = await Membership.findOne({
        user: userId,
        organization: orgId
      });

      if (!org || !membership) {
        return res.status(403).json({ error: "Access denied" });
      }

      const permissions = computePermissions(org.plan, membership.role);

      if (!permissions.includes(permission)) {
        return res.status(403).json({ error: "Upgrade required" });
      }

      next();
    } catch (err) {
      res.status(500).json({ error: "Permission check failed" });
    }
  };
};