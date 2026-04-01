// backend/middleware/requirePlan.js
import Organization from "../models/Organization.js";

function normalizePlan(plan) {
  const p = String(plan || "CORE").toUpperCase();
  if (p === "SCALE") return "CORE";
  return p;
}

function getPlanRank(plan) {
  const normalized = normalizePlan(plan);
  if (normalized === "ENTERPRISE") return 3;
  if (normalized === "GROWTH") return 2;
  return 1; // CORE
}

function getOrgId(req) {
  return (
    req.headers["x-org-id"] ||
    req.headers["x-workspace-id"] ||
    req.user?.orgId ||
    req.user?.organizationId ||
    req.user?.org ||
    req.user?.activeWorkspace ||
    null
  );
}

export function requirePlan(minPlan = "CORE") {
  return async function (req, res, next) {
    try {
      const orgId = getOrgId(req);

      if (!orgId) {
        return res.status(400).json({
          ok: false,
          message: "No workspace selected",
          code: "ORG_CONTEXT_REQUIRED",
        });
      }

      const org = await Organization.findById(orgId).lean();

      if (!org) {
        return res.status(404).json({
          ok: false,
          message: "Workspace not found",
          code: "WORKSPACE_NOT_FOUND",
        });
      }

      const currentPlan = normalizePlan(org.plan);
      const neededPlan = normalizePlan(minPlan);

      if (getPlanRank(currentPlan) < getPlanRank(neededPlan)) {
        return res.status(403).json({
          ok: false,
          message: `This feature requires the ${neededPlan} plan or higher.`,
          code: "PLAN_UPGRADE_REQUIRED",
          currentPlan,
          requiredPlan: neededPlan,
        });
      }

      req.org = org;
      req.orgId = String(org._id);
      req.currentPlan = currentPlan;

      return next();
    } catch (err) {
      console.error("requirePlan error:", err);

      return res.status(500).json({
        ok: false,
        message: err?.message || "Plan validation failed",
      });
    }
  };
}