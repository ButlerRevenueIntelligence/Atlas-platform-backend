import express from "express";
import Organization from "../models/Organization.js";
import IntegrationConnection from "../models/IntegrationConnection.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

const INTEGRATIONS = [
  { id: "hubspot", name: "HubSpot CRM", category: "CRM", supportsLive: true },
  { id: "salesforce", name: "Salesforce", category: "CRM", supportsLive: false },
  { id: "google_ads", name: "Google Ads", category: "Advertising", supportsLive: true },
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

async function ensureOrg(orgId) {
  if (!orgId) return null;
  return Organization.findById(orgId);
}

/* -------------------------------- */
/* HubSpot OAuth helpers            */
/* -------------------------------- */

function buildHubSpotRedirectUri() {
  const base = String(process.env.APP_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");

  if (!base) return null;

  return `${base}/api/integrations/hubspot/callback`;
}

function buildHubSpotAuthUrl(orgId) {
  const clientId = String(process.env.HUBSPOT_CLIENT_ID || "").trim();
  const redirectUri = buildHubSpotRedirectUri();

  console.log("BUILD HUBSPOT AUTH URL DEBUG", {
    clientIdExists: !!clientId,
    redirectUri,
    orgId: orgId ? String(orgId) : "",
  });

  if (!clientId || !redirectUri || !orgId) return null;

  const scopes = [
    "crm.objects.contacts.read",
    "crm.objects.companies.read",
    "crm.objects.deals.read",
    "crm.schemas.deals.read",
  ].join(" ");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state: JSON.stringify({ orgId: String(orgId), provider: "hubspot" }),
  });

  return `https://app.hubspot.com/oauth/authorize?${params.toString()}`;
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
  const clientId = String(process.env.HUBSPOT_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.HUBSPOT_CLIENT_SECRET || "").trim();
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

/* -------------------------------- */
/* Google Ads OAuth helpers         */
/* -------------------------------- */

function buildGoogleAdsRedirectUri() {
  const base = String(process.env.APP_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");

  if (!base) return null;

  return `${base}/api/integrations/google_ads/callback`;
}

function buildGoogleAdsAuthUrl(orgId) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const redirectUri = buildGoogleAdsRedirectUri();

  if (!clientId || !redirectUri || !orgId) return null;

  const scopes = [
    "https://www.googleapis.com/auth/adwords",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "openid",
  ];

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: scopes.join(" "),
    state: JSON.stringify({ orgId: String(orgId), provider: "google_ads" }),
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeGoogleCodeForTokens(code) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  const redirectUri = buildGoogleAdsRedirectUri();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google Ads OAuth is not fully configured");
  }

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      data?.error_description ||
        data?.error ||
        "Failed to exchange Google OAuth code"
    );
  }

  return data;
}

async function getGoogleUserProfile(accessToken) {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data?.error?.message || "Failed to fetch Google profile");
  }

  return data;
}

/* -------------------------------- */
/* Shared helpers                   */
/* -------------------------------- */

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
    await Organization.findByIdAndUpdate(orgId, { $set: update }, { new: true });
  }
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
        status: live.status || "disconnected",
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

    const org = await ensureOrg(orgId);

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
    const { id } = req.body || {};

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

    const org = await ensureOrg(orgId);
    if (!org) {
      return res.status(404).json({
        ok: false,
        message: "Workspace not found",
      });
    }

    const exists = getCatalogItem(id);
    if (!exists) {
      return res.status(400).json({
        ok: false,
        message: "Unknown integration id",
      });
    }

    let connection = await IntegrationConnection.findOne({ orgId, provider: id });

    if (!connection) {
      connection = new IntegrationConnection({ orgId, provider: id });
    }

    connection.status = "connected";
    connection.mode = "demo";
    connection.connectedAt = new Date();
    connection.disconnectedAt = null;
    connection.lastSyncAt = new Date();
    connection.lastSyncStatus = "success";
    connection.lastError = null;
    connection.externalAccountId = null;
    connection.externalAccountName = null;
    connection.syncCursor = null;
    connection.settings = connection.settings || {};
    connection.metadata = connection.metadata || {};

    await connection.save();

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
    const { id } = req.body || {};

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

    const org = await ensureOrg(orgId);
    if (!org) {
      return res.status(404).json({
        ok: false,
        message: "Workspace not found",
      });
    }

    const exists = getCatalogItem(id);
    if (!exists) {
      return res.status(400).json({
        ok: false,
        message: "Unknown integration id",
      });
    }

    let connection = await IntegrationConnection.findOne({ orgId, provider: id });

    if (!connection) {
      connection = new IntegrationConnection({ orgId, provider: id });
    }

    connection.status = "disconnected";
    connection.mode = "demo";
    connection.connectedAt = null;
    connection.disconnectedAt = new Date();
    connection.lastSyncAt = null;
    connection.lastSyncStatus = "never";
    connection.lastError = null;
    connection.accessToken = null;
    connection.refreshToken = null;
    connection.tokenType = null;
    connection.tokenExpiresAt = null;
    connection.externalAccountId = null;
    connection.externalAccountName = null;
    connection.scopes = [];
    connection.syncCursor = null;
    connection.settings = {};
    connection.metadata = {};

    await connection.save();

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
/* LIVE AUTH URL                    */
/* -------------------------------- */

router.get("/:provider/auth-url", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { provider } = req.params;

    console.log("CONNECTOR ENV DEBUG", {
      orgId,
      provider,
      HUBSPOT_CLIENT_ID_EXISTS: !!process.env.HUBSPOT_CLIENT_ID,
      HUBSPOT_CLIENT_SECRET_EXISTS: !!process.env.HUBSPOT_CLIENT_SECRET,
      GOOGLE_CLIENT_ID_EXISTS: !!process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET_EXISTS: !!process.env.GOOGLE_CLIENT_SECRET,
      APP_BASE_URL: process.env.APP_BASE_URL,
      FRONTEND_URL: process.env.FRONTEND_URL,
    });

    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context",
      });
    }

    const org = await ensureOrg(orgId);
    if (!org) {
      return res.status(404).json({
        ok: false,
        message: "Workspace not found",
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

    if (provider === "google_ads") {
      const url = buildGoogleAdsAuthUrl(orgId);

      if (!url) {
        return res.status(500).json({
          ok: false,
          message: "Google Ads OAuth is not configured",
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
      code: "LIVE_CONNECTOR_NOT_IMPLEMENTED",
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

    const org = await ensureOrg(orgId);
    if (!org) {
      return res.status(404).json({
        ok: false,
        message: "Workspace not found",
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
/* GOOGLE ADS STATUS                */
/* -------------------------------- */

router.get("/google_ads/status", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);

    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context",
      });
    }

    const org = await ensureOrg(orgId);
    if (!org) {
      return res.status(404).json({
        ok: false,
        message: "Workspace not found",
      });
    }

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "google_ads",
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
    console.error("GOOGLE ADS status error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to load Google Ads status",
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

    const org = await ensureOrg(orgId);
    if (!org) {
      return res.status(404).send("Workspace not found");
    }

    const tokenData = await exchangeHubSpotCodeForTokens(code);

    const accessToken = tokenData?.access_token || null;
    const refreshToken = tokenData?.refresh_token || null;
    const expiresIn = Number(tokenData?.expires_in || 0) || 0;
    const scopes = Array.isArray(tokenData?.scopes) ? tokenData.scopes : [];

    if (!accessToken) {
      throw new Error("HubSpot did not return an access token");
    }

    const accountData = await getHubSpotAccountInfo(accessToken);
    const accountId = accountData?.hub_id ? String(accountData.hub_id) : null;
    const accountName = accountId ? `HubSpot Account ${accountId}` : "HubSpot";

    let connection = await IntegrationConnection.findOne({
      orgId,
      provider: "hubspot",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      connection = new IntegrationConnection({ orgId, provider: "hubspot" });
    }

    connection.status = "connected";
    connection.mode = "live";
    connection.connectedAt = new Date();
    connection.disconnectedAt = null;
    connection.accessToken = accessToken;
    connection.refreshToken = refreshToken;
    connection.tokenType = tokenData?.token_type || null;
    connection.tokenExpiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000)
      : null;
    connection.externalAccountId = accountId;
    connection.externalAccountName = accountName;
    connection.scopes = scopes;
    connection.lastSyncAt = new Date();
    connection.lastSyncStatus = "success";
    connection.lastError = null;
    connection.metadata = {
      ...(connection.metadata || {}),
      hubId: accountId,
      scopes,
    };

    await connection.save();

    await updateOrgIntegrationSummary(orgId, "hubspot", {
      connected: true,
      connectedAt: new Date(),
      lastSync: new Date(),
      mode: "live",
    });

    const frontendUrl =
      process.env.FRONTEND_URL || "https://app.atlasrevenueai.com";

    return res.redirect(`${frontendUrl}/integrations?connected=hubspot&mode=live`);
  } catch (err) {
    console.error("HubSpot callback error:", err);

    const frontendUrl =
      process.env.FRONTEND_URL || "https://app.atlasrevenueai.com";

    return res.redirect(`${frontendUrl}/integrations?error=hubspot_callback_failed`);
  }
});

/* -------------------------------- */
/* GOOGLE ADS CALLBACK (LIVE)       */
/* -------------------------------- */

router.get("/google_ads/callback", async (req, res) => {
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

    const org = await ensureOrg(orgId);
    if (!org) {
      return res.status(404).send("Workspace not found");
    }

    const tokenData = await exchangeGoogleCodeForTokens(code);

    const accessToken = tokenData?.access_token || null;
    const refreshToken = tokenData?.refresh_token || null;
    const expiresIn = Number(tokenData?.expires_in || 0) || 0;
    const scopes = String(tokenData?.scope || "")
      .split(" ")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!accessToken) {
      throw new Error("Google did not return an access token");
    }

    const profile = await getGoogleUserProfile(accessToken);
    const externalAccountId = profile?.id ? String(profile.id) : null;
    const externalAccountName =
      profile?.email || profile?.name || "Google Ads Account";

    let connection = await IntegrationConnection.findOne({
      orgId,
      provider: "google_ads",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      connection = new IntegrationConnection({ orgId, provider: "google_ads" });
    }

    connection.markConnected({
      mode: "live",
      externalAccountId,
      externalAccountName,
      accessToken,
      refreshToken,
      tokenType: tokenData?.token_type || null,
      tokenExpiresAt: expiresIn
        ? new Date(Date.now() + expiresIn * 1000)
        : null,
      scopes,
      metadata: {
        googleUserEmail: profile?.email || null,
        googleUserName: profile?.name || null,
      },
    });

    await connection.save();

    await updateOrgIntegrationSummary(orgId, "google_ads", {
      connected: true,
      connectedAt: new Date(),
      lastSync: new Date(),
      mode: "live",
    });

    const frontendUrl =
      process.env.FRONTEND_URL || "https://app.atlasrevenueai.com";
    return res.redirect(`${frontendUrl}/integrations?connected=google_ads&mode=live`);
  } catch (err) {
    console.error("Google Ads callback error:", err);

    const frontendUrl =
      process.env.FRONTEND_URL || "https://app.atlasrevenueai.com";
    return res.redirect(`${frontendUrl}/integrations?error=google_ads_callback_failed`);
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

    const org = await ensureOrg(orgId);
    if (!org) {
      return res.status(404).json({
        ok: false,
        message: "Workspace not found",
      });
    }

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "hubspot",
      status: "connected",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      return res.status(404).json({
        ok: false,
        message: "HubSpot is not connected for this workspace",
      });
    }

    connection.status = "syncing";
    connection.lastSyncStatus = "running";
    connection.lastError = null;
    await connection.save();

    connection.status = "connected";
    connection.lastSyncAt = new Date();
    connection.lastSyncStatus = "success";
    connection.lastError = null;
    await connection.save();

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

    try {
      const orgId = getOrgId(req);
      if (orgId) {
        await IntegrationConnection.findOneAndUpdate(
          { orgId, provider: "hubspot" },
          {
            $set: {
              status: "error",
              lastSyncStatus: "failed",
              lastError: err.message || "HubSpot sync failed",
            },
          }
        );
      }
    } catch (innerErr) {
      console.error("Failed to mark HubSpot sync failure:", innerErr);
    }

    return res.status(500).json({
      ok: false,
      message: "Failed to sync HubSpot",
      error: err.message,
    });
  }
});

export default router;