// backend/middleware/requirePlan.js
import Organization from "../models/Organization.js";
import enforceTrialStatus from "../utils/enforceTrialStatus.js";

function normalizePlan(plan) {
  const p = String(plan || "CORE").toUpperCase().trim();
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

function isWorkspaceActive(org) {
  const accessStatus = String(org?.accessStatus || org?.status || "").toLowerCase();
  const billingStatus = String(org?.billing?.status || "").toLowerCase();
  const paymentStatus = String(org?.paymentStatus || "").toLowerCase();
  const trialStatus = String(org?.trial?.status || "").toLowerCase();

  if (trialStatus === "expired") return false;
  if (accessStatus !== "active") return false;

  return (
    billingStatus === "active" ||
    billingStatus === "trialing" ||
    paymentStatus === "paid" ||
    paymentStatus === "trialing"
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

      let org = await Organization.findById(orgId);

      if (!org) {
        return res.status(404).json({
          ok: false,
          message: "Workspace not found",
          code: "WORKSPACE_NOT_FOUND",
        });
      }

      org = await enforceTrialStatus(org);

      const currentPlan = normalizePlan(org.plan);
      const neededPlan = normalizePlan(minPlan);

      if (!isWorkspaceActive(org)) {
        return res.status(403).json({
          ok: false,
          message:
            org?.trial?.status === "expired"
              ? "Your trial has expired. Upgrade your workspace to continue."
              : "This workspace is not active.",
          code:
            org?.trial?.status === "expired"
              ? "TRIAL_EXPIRED"
              : "WORKSPACE_NOT_ACTIVE",
          currentPlan,
          requiredPlan: neededPlan,
          billingStatus: org?.billing?.status || null,
          paymentStatus: org?.paymentStatus || null,
          trialStatus: org?.trial?.status || "none",
          accessStatus: org?.accessStatus || org?.status || null,
        });
      }

      if (getPlanRank(currentPlan) < getPlanRank(neededPlan)) {
        return res.status(403).json({
          ok: false,
          message: `This feature requires the ${neededPlan} plan or higher.`,
          code: "PLAN_UPGRADE_REQUIRED",
          currentPlan,
          requiredPlan: neededPlan,
          billingStatus: org?.billing?.status || null,
          paymentStatus: org?.paymentStatus || null,
          trialStatus: org?.trial?.status || "none",
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