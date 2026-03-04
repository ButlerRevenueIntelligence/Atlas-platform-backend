// backend/utils/permissions.js

const PLAN_PERMISSIONS = {
  SCALE: [
    "dashboard.view",
    "command_center.view",
    "market_signals.view",
    "forecast.view",
    "accounts.view",
    "clients.view",
  ],

  GROWTH: [
    "dashboard.view",
    "command_center.view",
    "market_signals.view",
    "forecast.view",
    "forecast.basic_ai",
    "accounts.view",
    "clients.view",
    "deal_room.view",
    "integrations.crm",
    "integrations.analytics",
    "insights.run",
    "kpi.live_summary",
  ],

  ENTERPRISE: [
    "dashboard.view",
    "command_center.view",
    "market_signals.view",
    "forecast.view",
    "forecast.ai",
    "accounts.view",
    "clients.view",
    "deal_room.view",
    "integrations.crm",
    "integrations.analytics",
    "integrations.google_ads",
    "integrations.meta_ads",
    "integrations.linkedin_ads",
    "insights.run",
    "kpi.live_summary",
    "partners.manage",
    "invites.send",
    "admin.audit",
  ],
};

// role-based removals (inside a plan)
const ROLE_RESTRICTIONS = {
  owner: [],
  admin: [],
  manager: ["admin.audit"], // can see most, but not audit
  analyst: ["partners.manage", "invites.send", "admin.audit"],
  sales: [
    "integrations.crm",
    "integrations.analytics",
    "integrations.google_ads",
    "integrations.meta_ads",
    "integrations.linkedin_ads",
    "admin.audit",
    "partners.manage",
  ],
};

export function computePermissions({ plan = "SCALE", role = "analyst", overrides = [] } = {}) {
  const p = String(plan || "SCALE").toUpperCase();
  const r = String(role || "analyst").toLowerCase();

  const base = PLAN_PERMISSIONS[p] || PLAN_PERMISSIONS.SCALE;
  const restricted = ROLE_RESTRICTIONS[r] || [];

  // base minus restrictions, plus overrides (overrides are extra perms to add)
  const filtered = base.filter((perm) => !restricted.includes(perm));
  return Array.from(new Set([...filtered, ...(Array.isArray(overrides) ? overrides : [])]));
}

export function hasPerm(perms = [], perm) {
  if (!perm) return false;
  if (perms.includes("*")) return true;
  return perms.includes(perm);
}