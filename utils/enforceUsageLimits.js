import { PLAN_LIMITS } from "../config/limits.js";

export default function enforceUsageLimits(org, key) {
  const plan = String(org.plan || "SCALE").toUpperCase();
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.SCALE;

  const currentUsage = org.usage?.[key] || 0;
  const limit = limits[key];

  if (limit !== Infinity && currentUsage >= limit) {
    return {
      blocked: true,
      message: `Limit reached for ${key}. Upgrade to continue.`,
    };
  }

  return { blocked: false };
}