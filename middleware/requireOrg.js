// backend/middleware/requireOrg.js
import Membership from "../models/Membership.js";
import Organization from "../models/Organization.js";

export const requireOrg = async (req, res, next) => {
  try {
    const userId = req.user?._id || req.user?.id || req.userId;
    const orgId = req.headers["x-org-id"];

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!orgId) {
      return res.status(403).json({ error: "Missing x-org-id header" });
    }

    // Check membership for THIS org
    const membership = await Membership.findOne({
      userId,
      orgId,
      status: "active",
    });

    if (!membership) {
      return res.status(403).json({ error: "Not authorized for this org" });
    }

    const org = await Organization.findById(orgId);

    if (!org) {
      return res.status(403).json({ error: "Organization not found" });
    }

    req.orgId = org._id;
    req.org = org;
    req.membership = membership;

    next();
  } catch (err) {
    console.error("requireOrg error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};