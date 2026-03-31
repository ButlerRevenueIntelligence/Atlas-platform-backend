// backend/routes/integrations.js
import express from "express";
import Organization from "../models/Organization.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/* -------------------------------- */
/* Integration catalog              */
/* -------------------------------- */

const INTEGRATIONS = [
  { id: "hubspot", name: "HubSpot CRM", category: "CRM" },
  { id: "salesforce", name: "Salesforce", category: "CRM" },
  { id: "google_ads", name: "Google Ads", category: "Advertising" },
  { id: "meta_ads", name: "Meta Ads", category: "Advertising" },
  { id: "linkedin_ads", name: "LinkedIn Ads", category: "Advertising" },
  { id: "ga4", name: "Google Analytics 4", category: "Analytics" },
  { id: "stripe", name: "Stripe", category: "Payments" },
  { id: "shopify", name: "Shopify", category: "Commerce" },
];

/* -------------------------------- */
/* Helpers                          */
/* -------------------------------- */

function getOrgId(req) {
  return (
    req.headers["x-org-id"] ||
    req.headers["X-Org-Id"] ||
    req.query.orgId ||
    req.body?.orgId ||
    ""
  );
}

function formatIntegrations(org) {
  const saved = org?.integrations || {};

  return INTEGRATIONS.map((item) => {
    const state = saved[item.id] || {};

    return {
      id: item.id,
      name: item.name,
      category: item.category,
      status: state.connected ? "connected" : "disconnected",
      connected: !!state.connected,
      lastSync: state.lastSync || null,
      connectedAt: state.connectedAt || null,
      mode: state.mode || "demo",
    };
  });
}

/* -------------------------------- */
/* GET INTEGRATIONS                 */
/* -------------------------------- */

router.get("/", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);

    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context",
      });
    }

    const org = await Organization.findById(orgId).lean();

    if (!org) {
      return res.status(404).json({
        ok: false,
        message: "Workspace not found",
      });
    }

    return res.json({
      ok: true,
      integrations: formatIntegrations(org),
    });
  } catch (err) {
    console.error("GET integrations error:", err);

    return res.status(500).json({
      ok: false,
      message: "Failed to load integrations",
      error: err.message,
    });
  }
});

/* -------------------------------- */
/* CONNECT INTEGRATION (DEMO MODE)  */
/* -------------------------------- */

router.post("/connect", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { id } = req.body;

    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context",
      });
    }

    if (!id) {
      return res.status(400).json({
        ok: false,
        message: "Integration id is required",
      });
    }

    const exists = INTEGRATIONS.find((x) => x.id === id);

    if (!exists) {
      return res.status(400).json({
        ok: false,
        message: "Unknown integration id",
      });
    }

    const update = {
      [`integrations.${id}.connected`]: true,
      [`integrations.${id}.connectedAt`]: new Date(),
      [`integrations.${id}.lastSync`]: new Date(),
      [`integrations.${id}.mode`]: "demo",
    };

    const org = await Organization.findByIdAndUpdate(orgId, update, {
      new: true,
    }).lean();

    return res.json({
      ok: true,
      message: `${exists.name} connected`,
      integrations: formatIntegrations(org),
    });
  } catch (err) {
    console.error("CONNECT integration error:", err);

    return res.status(500).json({
      ok: false,
      message: "Failed to connect integration",
      error: err.message,
    });
  }
});

/* -------------------------------- */
/* DISCONNECT INTEGRATION           */
/* -------------------------------- */

router.post("/disconnect", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { id } = req.body;

    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context",
      });
    }

    if (!id) {
      return res.status(400).json({
        ok: false,
        message: "Integration id is required",
      });
    }

    const exists = INTEGRATIONS.find((x) => x.id === id);

    if (!exists) {
      return res.status(400).json({
        ok: false,
        message: "Unknown integration id",
      });
    }

    const update = {
      [`integrations.${id}.connected`]: false,
      [`integrations.${id}.connectedAt`]: null,
      [`integrations.${id}.lastSync`]: null,
      [`integrations.${id}.mode`]: "demo",
    };

    const org = await Organization.findByIdAndUpdate(orgId, update, {
      new: true,
    }).lean();

    return res.json({
      ok: true,
      message: `${exists.name} disconnected`,
      integrations: formatIntegrations(org),
    });
  } catch (err) {
    console.error("DISCONNECT integration error:", err);

    return res.status(500).json({
      ok: false,
      message: "Failed to disconnect integration",
      error: err.message,
    });
  }
});

export default router;