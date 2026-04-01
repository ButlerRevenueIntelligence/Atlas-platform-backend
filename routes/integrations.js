// backend/routes/integrations.js
import express from "express";
import Organization from "../models/Organization.js";
import IntegrationConnection from "../models/IntegrationConnection.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

const INTEGRATIONS = [
  { id: "hubspot", name: "HubSpot CRM", category: "CRM", supportsLive: true },
  { id: "salesforce", name: "Salesforce", category: "CRM", supportsLive: false },
  { id: "google_ads", name: "Google Ads", category: "Advertising", supportsLive: false },
  { id: "meta_ads", name: "Meta Ads", category: "Advertising", supportsLive: false },
  { id: "linkedin_ads", name: "LinkedIn Ads", category: "Advertising", supportsLive: false },
  { id: "ga4", name: "Google Analytics 4", category: "Analytics", supportsLive: false },
  { id: "stripe", name: "Stripe", category: "Payments", supportsLive: false },
  { id: "shopify", name: "Shopify", category: "Commerce", supportsLive: false },
];

/* -------------------------------- */
/* Helpers                          */
/* -------------------------------- */

function getOrgId(req) {
  return (
    req.headers["x-org-id"] ||
    req.query.orgId ||
    req.body?.orgId ||
    req.orgId ||
    req.org?._id ||
    ""
  );
}

function getCatalogItem(id) {
  return INTEGRATIONS.find((x) => x.id === id);
}

function buildHubSpotRedirectUri() {
  const base = String(process.env.APP_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/api/integrations/hubspot/callback`;
}

function buildHubSpotAuthUrl(orgId) {
  const clientId = process.env.HUBSPOT_CLIENT_ID;
  const redirectUri = buildHubSpotRedirectUri();

  if (!clientId || !redirectUri || !orgId) return null;

  const scopes = [
    "crm.objects.contacts.read",
    "crm.objects.companies.read",
    "crm.objects.deals.read",
    "oauth",
  ].join(" ");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state: JSON.stringify({ orgId: String(orgId), provider: "hubspot" }),
  });

  return `https://app.hubspot.com/oauth/authorize?${params.toString()}`;
}

async function updateOrgIntegrationSummary(orgId, provider, patch = {}) {
  const update = {};

  if ("connected" in patch) {
    update[`integrations.${provider}.connected`] = !!patch.connected;
  }

  if ("connectedAt" in patch) {
    update[`integrations.${provider}.connectedAt`] = patch.connectedAt;
  }

  if ("lastSync" in patch) {
    update[`integrations.${provider}.lastSync`] = patch.lastSync;
  }

  if ("mode" in patch) {
    update[`integrations.${provider}.mode`] = patch.mode;
  }

  if (Object.keys(update).length) {
    await Organization.findByIdAndUpdate(orgId, update, { new: true });
  }
}

async function getHubSpotAccountInfo(accessToken) {
  const res = await fetch(
    `https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`
  );

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data?.message || "Failed to fetch HubSpot account info");
  }

  return data;
}

async function exchangeHubSpotCodeForTokens(code) {
  const clientId = process.env.HUBSPOT_CLIENT_ID;
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
  const redirectUri = buildHubSpotRedirectUri();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("HubSpot OAuth is not fully configured");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
  });

  const res = await fetch("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data?.message || "Failed to exchange HubSpot OAuth code");
  }

  return data;
}

async function formatIntegrations(orgId) {
  const org = await Organization.findById(orgId).lean();
  const savedSummary = org?.integrations || {};

  const liveConnections = await IntegrationConnection.find({ orgId }).lean();
  const liveMap = new Map(liveConnections.map((c) => [c.provider, c]));

  return INTEGRATIONS.map((item) => {
    const live = liveMap.get(item.id);
    const summary = savedSummary[item.id] || {};

    if (live) {
      return {
        id: item.id,
        name: item.name,
        category: item.category,
        status:
          live.status === "connected"
            ? "connected"
            : live.status || "disconnected",
        connected: live.status === "connected",
        lastSync: live.lastSyncAt || summary.lastSync || null,
        connectedAt: live.connectedAt || summary.connectedAt || null,
        mode: live.mode || summary.mode || "demo",
        externalAccountId: live.externalAccountId || null,
        externalAccountName: live.externalAccountName || null,
        lastSyncStatus: live.lastSyncStatus || "never",
        lastError: live.lastError || null,
        supportsLive: item.supportsLive,
      };
    }

    return {
      id: item.id,
      name: item.name,
      category: item.category,
      status: summary.connected ? "connected" : "disconnected",
      connected: !!summary.connected,
      lastSync: summary.lastSync || null,
      connectedAt: summary.connectedAt || null,
      mode: summary.mode || "demo",
      externalAccountId: null,
      externalAccountName: null,
      lastSyncStatus: "never",
      lastError: null,
      supportsLive: item.supportsLive,
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
      integrations: await formatIntegrations(orgId),
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
/* DEMO CONNECT                     */
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

    const exists = getCatalogItem(id);

    if (!exists) {
      return res.status(400).json({
        ok: false,
        message: "Unknown integration id",
      });
    }

    await IntegrationConnection.findOneAndUpdate(
      { orgId, provider: id },
      {
        $set: {
          status: "connected",
          mode: "demo",
          connectedAt: new Date(),
          lastSyncAt: new Date(),
          lastSyncStatus: "success",
          lastError: null,
        },
      },
      { upsert: true, new: true }
    );

    await updateOrgIntegrationSummary(orgId, id, {
      connected: true,
      connectedAt: new Date(),
      lastSync: new Date(),
      mode: "demo",
    });

    return res.json({
      ok: true,
      message: `${exists.name} connected`,
      integrations: await formatIntegrations(orgId),
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
/* DISCONNECT                       */
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

    const exists = getCatalogItem(id);

    if (!exists) {
      return res.status(400).json({
        ok: false,
        message: "Unknown integration id",
      });
    }

    await IntegrationConnection.findOneAndUpdate(
      { orgId, provider: id },
      {
        $set: {
          status: "disconnected",
          connectedAt: null,
          lastSyncAt: null,
          lastSyncStatus: "never",
          lastError: null,
          accessToken: null,
          refreshToken: null,
          tokenExpiresAt: null,
          externalAccountId: null,
          externalAccountName: null,
          mode: "demo",
          metadata: {},
        },
      },
      { upsert: true, new: true }
    );

    await updateOrgIntegrationSummary(orgId, id, {
      connected: false,
      connectedAt: null,
      lastSync: null,
      mode: "demo",
    });

    return res.json({
      ok: true,
      message: `${exists.name} disconnected`,
      integrations: await formatIntegrations(orgId),
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

/* -------------------------------- */
/* LIVE AUTH URL (HUBSPOT FIRST)    */
/* -------------------------------- */

router.get("/:provider/auth-url", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { provider } = req.params;

    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context",
      });
    }

    const item = getCatalogItem(provider);

    if (!item) {
      return res.status(400).json({
        ok: false,
        message: "Unknown provider",
      });
    }

    if (provider === "hubspot") {
      const url = buildHubSpotAuthUrl(orgId);

      if (!url) {
        return res.status(500).json({
          ok: false,
          message: "HubSpot OAuth is not configured",
        });
      }

      return res.json({
        ok: true,
        provider,
        authUrl: url,
      });
    }

    return res.status(400).json({
      ok: false,
      message: `${provider} live auth not implemented yet`,
    });
  } catch (err) {
    console.error("AUTH URL error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to create auth url",
      error: err.message,
    });
  }
});

/* -------------------------------- */
/* HUBSPOT STATUS                   */
/* -------------------------------- */

router.get("/hubspot/status", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);

    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context",
      });
    }

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "hubspot",
    }).lean();

    return res.json({
      ok: true,
      connected: connection?.status === "connected",
      mode: connection?.mode || "demo",
      externalAccountId: connection?.externalAccountId || null,
      externalAccountName: connection?.externalAccountName || null,
      lastSyncAt: connection?.lastSyncAt || null,
      lastSyncStatus: connection?.lastSyncStatus || "never",
      lastError: connection?.lastError || null,
    });
  } catch (err) {
    console.error("HUBSPOT status error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to load HubSpot status",
      error: err.message,
    });
  }
});

/* -------------------------------- */
/* HUBSPOT CALLBACK (LIVE)          */
/* -------------------------------- */

router.get("/hubspot/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code || !state) {
      return res.status(400).send("Missing code or state");
    }

    let parsedState = null;

    try {
      parsedState = JSON.parse(state);
    } catch {
      return res.status(400).send("Invalid state");
    }

    const { orgId } = parsedState || {};

    if (!orgId) {
      return res.status(400).send("Missing orgId in state");
    }

    const tokenData = await exchangeHubSpotCodeForTokens(code);

    const accessToken = tokenData?.access_token || null;
    const refreshToken = tokenData?.refresh_token || null;
    const expiresIn = Number(tokenData?.expires_in || 0) || 0;

    if (!accessToken) {
      throw new Error("HubSpot did not return an access token");
    }

    const accountData = await getHubSpotAccountInfo(accessToken);
    const accountId = accountData?.hub_id ? String(accountData.hub_id) : null;
    const accountName = accountId ? `HubSpot Account ${accountId}` : "HubSpot";

    await IntegrationConnection.findOneAndUpdate(
      { orgId, provider: "hubspot" },
      {
        $set: {
          status: "connected",
          mode: "live",
          connectedAt: new Date(),
          accessToken,
          refreshToken,
          tokenExpiresAt: expiresIn
            ? new Date(Date.now() + expiresIn * 1000)
            : null,
          externalAccountId: accountId,
          externalAccountName: accountName,
          lastSyncAt: new Date(),
          lastSyncStatus: "success",
          lastError: null,
          metadata: {
            hubId: accountId,
            tokenType: tokenData?.token_type || null,
            scopes: tokenData?.scopes || [],
          },
        },
      },
      { upsert: true, new: true }
    );

    await updateOrgIntegrationSummary(orgId, "hubspot", {
      connected: true,
      connectedAt: new Date(),
      lastSync: new Date(),
      mode: "live",
    });

    const frontendUrl =
      process.env.FRONTEND_URL ||
      "https://app.atlasrevenueai.com";

    return res.redirect(`${frontendUrl}/integrations?connected=hubspot&mode=live`);
  } catch (err) {
    console.error("HubSpot callback error:", err);

    const frontendUrl =
      process.env.FRONTEND_URL ||
      "https://app.atlasrevenueai.com";

    return res.redirect(
      `${frontendUrl}/integrations?error=hubspot_callback_failed`
    );
  }
});

/* -------------------------------- */
/* HUBSPOT MANUAL SYNC (SCAFFOLD)   */
/* -------------------------------- */

router.post("/hubspot/sync", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);

    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context",
      });
    }

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "hubspot",
      status: "connected",
    });

    if (!connection) {
      return res.status(404).json({
        ok: false,
        message: "HubSpot is not connected for this workspace",
      });
    }

    await IntegrationConnection.findOneAndUpdate(
      { orgId, provider: "hubspot" },
      {
        $set: {
          lastSyncAt: new Date(),
          lastSyncStatus: "success",
          lastError: null,
        },
      }
    );

    await updateOrgIntegrationSummary(orgId, "hubspot", {
      connected: true,
      lastSync: new Date(),
      mode: connection.mode || "live",
    });

    return res.json({
      ok: true,
      message: "HubSpot sync completed",
      provider: "hubspot",
      mode: connection.mode || "live",
    });
  } catch (err) {
    console.error("HubSpot sync error:", err);

    return res.status(500).json({
      ok: false,
      message: "Failed to sync HubSpot",
      error: err.message,
    });
  }
});

export default router;