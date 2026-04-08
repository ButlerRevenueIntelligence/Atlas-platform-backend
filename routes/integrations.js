import express from "express";
import Organization from "../models/Organization.js";
import IntegrationConnection from "../models/IntegrationConnection.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

const INTEGRATIONS = [
  { id: "hubspot", name: "HubSpot CRM", category: "CRM", supportsLive: true },
  { id: "salesforce", name: "Salesforce", category: "CRM", supportsLive: false },
  { id: "google_ads", name: "Google Ads", category: "Advertising", supportsLive: true },
  { id: "meta_ads", name: "Meta Ads", category: "Advertising", supportsLive: true },
  { id: "linkedin_ads", name: "LinkedIn Ads", category: "Advertising", supportsLive: false },
  { id: "ga4", name: "Google Analytics 4", category: "Analytics", supportsLive: true },
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
  const base = String(
    process.env.BACKEND_PUBLIC_URL ||
      process.env.APP_BASE_URL ||
      ""
  )
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
  const base = String(
    process.env.BACKEND_PUBLIC_URL ||
      process.env.APP_BASE_URL ||
      ""
  )
    .trim()
    .replace(/\/+$/, "");

  if (!base) return null;

  return `${base}/api/integrations/google_ads/callback`;
}

function buildGoogleAdsAuthUrl(orgId) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const redirectUri = buildGoogleAdsRedirectUri();

  console.log("BUILD GOOGLE ADS AUTH URL DEBUG", {
    clientIdExists: !!clientId,
    redirectUri,
    orgId: orgId ? String(orgId) : "",
  });

  if (!clientId || !redirectUri || !orgId) return null;

  const scope = ["https://www.googleapis.com/auth/adwords"].join(" ");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "false",
    scope,
    state: JSON.stringify({ orgId: String(orgId), provider: "google_ads" }),
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeGoogleCodeForTokens(code, redirectUriOverride = null) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  const redirectUri =
    redirectUriOverride || buildGoogleAdsRedirectUri();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google OAuth is not fully configured");
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

async function getGoogleAdsAccessibleCustomers(accessToken) {
  const developerToken = String(
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN || ""
  ).trim();

  if (!developerToken) {
    throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN is missing");
  }

  const loginCustomerId = String(
    process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || ""
  )
    .trim()
    .replace(/-/g, "");

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": developerToken,
  };

  if (loginCustomerId) {
    headers["login-customer-id"] = loginCustomerId;
  }

  const res = await fetch(
    "https://googleads.googleapis.com/v14/customers:listAccessibleCustomers",
    {
      method: "GET",
      headers,
    }
  );

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error("Google Ads accessible customers error:", data);
    throw new Error(
      data?.error?.message || "Failed to fetch accessible Google Ads customers"
    );
  }

  return Array.isArray(data?.resourceNames) ? data.resourceNames : [];
}

/* -------------------------------- */
/* GA4 OAuth helpers                */
/* -------------------------------- */

function buildGA4RedirectUri() {
  const base = String(
    process.env.BACKEND_PUBLIC_URL ||
      process.env.APP_BASE_URL ||
      ""
  )
    .trim()
    .replace(/\/+$/, "");

  if (!base) return null;

  return `${base}/api/integrations/ga4/callback`;
}

function buildGA4AuthUrl(orgId) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const redirectUri = buildGA4RedirectUri();

  console.log("BUILD GA4 AUTH URL DEBUG", {
    clientIdExists: !!clientId,
    redirectUri,
    orgId: orgId ? String(orgId) : "",
  });

  if (!clientId || !redirectUri || !orgId) return null;

  const scope = [
    "https://www.googleapis.com/auth/analytics.readonly",
    "openid",
    "email",
    "profile",
  ].join(" ");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "false",
    scope,
    state: JSON.stringify({ orgId: String(orgId), provider: "ga4" }),
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeGA4CodeForTokens(code) {
  return exchangeGoogleCodeForTokens(code, buildGA4RedirectUri());
}

async function getGA4AccountSummaries(accessToken) {
  const res = await fetch(
    "https://analyticsadmin.googleapis.com/v1beta/accountSummaries",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error("GA4 account summaries error:", data);
    throw new Error(
      data?.error?.message || "Failed to fetch accessible GA4 properties"
    );
  }

  return Array.isArray(data?.accountSummaries) ? data.accountSummaries : [];
}

/* -------------------------------- */
/* Meta Ads OAuth helpers           */
/* -------------------------------- */

function buildMetaAdsRedirectUri() {
  const base = String(
    process.env.BACKEND_PUBLIC_URL ||
      process.env.APP_BASE_URL ||
      ""
  )
    .trim()
    .replace(/\/+$/, "");

  if (!base) return null;

  return `${base}/api/integrations/meta_ads/callback`;
}

function buildMetaAdsAuthUrl(orgId) {
  const clientId = String(process.env.META_APP_ID || "").trim();
  const redirectUri = buildMetaAdsRedirectUri();

  console.log("BUILD META ADS AUTH URL DEBUG", {
    clientIdExists: !!clientId,
    redirectUri,
    orgId: orgId ? String(orgId) : "",
  });

  if (!clientId || !redirectUri || !orgId) return null;

  const scope = [
    "ads_read",
    "ads_management",
    "business_management",
  ].join(",");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state: JSON.stringify({ orgId: String(orgId), provider: "meta_ads" }),
    scope,
    response_type: "code",
  });

  return `https://www.facebook.com/v18.0/dialog/oauth?${params.toString()}`;
}

async function exchangeMetaCodeForTokens(code) {
  const clientId = String(process.env.META_APP_ID || "").trim();
  const clientSecret = String(process.env.META_APP_SECRET || "").trim();
  const redirectUri = buildMetaAdsRedirectUri();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Meta Ads OAuth is not fully configured");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
  });

  const res = await fetch(
    `https://graph.facebook.com/v18.0/oauth/access_token?${params.toString()}`
  );

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data?.error?.message || "Meta token exchange failed");
  }

  return data;
}

async function getMetaAdAccounts(accessToken) {
  const res = await fetch(
    `https://graph.facebook.com/v18.0/me/adaccounts?fields=id,name,account_status&access_token=${encodeURIComponent(accessToken)}`
  );

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error("Meta ad accounts error:", data);
    throw new Error(data?.error?.message || "Failed to fetch Meta ad accounts");
  }

  return Array.isArray(data?.data) ? data.data : [];
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
        accessibleCustomers: Array.isArray(live?.metadata?.accessibleCustomers)
          ? live.metadata.accessibleCustomers
          : [],
        properties: Array.isArray(live?.metadata?.properties)
          ? live.metadata.properties
          : [],
        metaAccounts: Array.isArray(live?.metadata?.accounts)
          ? live.metadata.accounts
          : [],
        needsSelection: !!live?.metadata?.needsSelection,
        selectedCustomer: live?.metadata?.selectedCustomer || null,
        selectedProperty: live?.metadata?.selectedProperty || null,
        selectedMetaAccount: live?.metadata?.selectedAccount || null,
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
      accessibleCustomers: [],
      properties: [],
      metaAccounts: [],
      needsSelection: false,
      selectedCustomer: null,
      selectedProperty: null,
      selectedMetaAccount: null,
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

    if (typeof connection.markConnected === "function") {
      connection.markConnected({ mode: "demo" });
      connection.externalAccountId = null;
      connection.externalAccountName = null;
      connection.syncCursor = null;
      connection.settings = connection.settings || {};
      connection.metadata = connection.metadata || {};
    } else {
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
    }

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

    if (typeof connection.markDisconnected === "function") {
      connection.markDisconnected();
    } else {
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
    }

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
      GOOGLE_ADS_DEVELOPER_TOKEN_EXISTS: !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      GOOGLE_ADS_LOGIN_CUSTOMER_ID: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "",
      META_APP_ID_EXISTS: !!process.env.META_APP_ID,
      META_APP_SECRET_EXISTS: !!process.env.META_APP_SECRET,
      BACKEND_PUBLIC_URL: process.env.BACKEND_PUBLIC_URL,
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

    if (provider === "ga4") {
      const url = buildGA4AuthUrl(orgId);

      if (!url) {
        return res.status(500).json({
          ok: false,
          message: "GA4 OAuth is not configured",
        });
      }

      return res.json({
        ok: true,
        provider,
        authUrl: url,
      });
    }

    if (provider === "meta_ads") {
      const url = buildMetaAdsAuthUrl(orgId);

      if (!url) {
        return res.status(500).json({
          ok: false,
          message: "Meta Ads OAuth is not configured",
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
      accessibleCustomers: Array.isArray(connection?.metadata?.accessibleCustomers)
        ? connection.metadata.accessibleCustomers
        : [],
      needsSelection: !!connection?.metadata?.needsSelection,
      selectedCustomer: connection?.metadata?.selectedCustomer || null,
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
/* GA4 STATUS                       */
/* -------------------------------- */

router.get("/ga4/status", requireAuth, async (req, res) => {
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
      provider: "ga4",
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
      properties: Array.isArray(connection?.metadata?.properties)
        ? connection.metadata.properties
        : [],
      needsSelection: !!connection?.metadata?.needsSelection,
      selectedProperty: connection?.metadata?.selectedProperty || null,
    });
  } catch (err) {
    console.error("GA4 status error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to load GA4 status",
      error: err.message,
    });
  }
});

/* -------------------------------- */
/* META ADS STATUS                  */
/* -------------------------------- */

router.get("/meta_ads/status", requireAuth, async (req, res) => {
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
      provider: "meta_ads",
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
      accounts: Array.isArray(connection?.metadata?.accounts)
        ? connection.metadata.accounts
        : [],
      needsSelection: !!connection?.metadata?.needsSelection,
      selectedAccount: connection?.metadata?.selectedAccount || null,
    });
  } catch (err) {
    console.error("META ADS status error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to load Meta Ads status",
      error: err.message,
    });
  }
});

/* -------------------------------- */
/* GOOGLE ADS SELECT ACCOUNT        */
/* -------------------------------- */

router.post("/google_ads/select-account", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { customerId } = req.body || {};

    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context",
      });
    }

    if (!customerId) {
      return res.status(400).json({
        ok: false,
        message: "customerId is required",
      });
    }

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "google_ads",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      return res.status(404).json({
        ok: false,
        message: "Google Ads connection not found",
      });
    }

    const accessibleCustomers = Array.isArray(connection?.metadata?.accessibleCustomers)
      ? connection.metadata.accessibleCustomers
      : [];

    const normalizedTarget = String(customerId).replace(/\D/g, "");

    const matched = accessibleCustomers.find((item) => {
      const normalizedItem = String(item)
        .replace("customers/", "")
        .replace(/\D/g, "");
      return normalizedItem === normalizedTarget;
    });

    if (!matched) {
      return res.status(400).json({
        ok: false,
        message: "Selected account is not in accessible customers list",
      });
    }

    const externalAccountId = String(matched).replace("customers/", "");
    const externalAccountName = `Google Ads ${externalAccountId}`;

    connection.externalAccountId = externalAccountId;
    connection.externalAccountName = externalAccountName;
    connection.mode = "live";
    connection.status = "connected";
    connection.lastSyncAt = new Date();
    connection.lastSyncStatus = "success";
    connection.lastError = null;
    connection.metadata = {
      ...(connection.metadata || {}),
      selectedCustomer: matched,
      needsSelection: false,
    };

    await connection.save();

    await updateOrgIntegrationSummary(orgId, "google_ads", {
      connected: true,
      connectedAt: connection.connectedAt || new Date(),
      lastSync: new Date(),
      mode: "live",
    });

    return res.json({
      ok: true,
      message: "Google Ads account selected",
      integration: {
        provider: "google_ads",
        externalAccountId,
        externalAccountName,
      },
      integrations: await formatIntegrations(orgId),
    });
  } catch (err) {
    console.error("GOOGLE ADS select account error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to select Google Ads account",
      error: err.message,
    });
  }
});

/* -------------------------------- */
/* GA4 SELECT PROPERTY              */
/* -------------------------------- */

router.post("/ga4/select-property", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { propertyId } = req.body || {};

    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context",
      });
    }

    if (!propertyId) {
      return res.status(400).json({
        ok: false,
        message: "propertyId is required",
      });
    }

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "ga4",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      return res.status(404).json({
        ok: false,
        message: "GA4 connection not found",
      });
    }

    const properties = Array.isArray(connection?.metadata?.properties)
      ? connection.metadata.properties
      : [];

    const matched = properties.find(
      (item) => String(item?.propertyId) === String(propertyId)
    );

    if (!matched) {
      return res.status(400).json({
        ok: false,
        message: "Selected property is not in available GA4 properties list",
      });
    }

    connection.externalAccountId = matched.propertyId;
    connection.externalAccountName = matched.property;
    connection.mode = "live";
    connection.status = "connected";
    connection.lastSyncAt = new Date();
    connection.lastSyncStatus = "success";
    connection.lastError = null;
    connection.metadata = {
      ...(connection.metadata || {}),
      selectedProperty: matched,
      needsSelection: false,
    };

    await connection.save();

    await updateOrgIntegrationSummary(orgId, "ga4", {
      connected: true,
      connectedAt: connection.connectedAt || new Date(),
      lastSync: new Date(),
      mode: "live",
    });

    return res.json({
      ok: true,
      message: "GA4 property selected",
      integration: {
        provider: "ga4",
        externalAccountId: matched.propertyId,
        externalAccountName: matched.property,
      },
      integrations: await formatIntegrations(orgId),
    });
  } catch (err) {
    console.error("GA4 select property error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to select GA4 property",
      error: err.message,
    });
  }
});

/* -------------------------------- */
/* META ADS SELECT ACCOUNT          */
/* -------------------------------- */

router.post("/meta_ads/select-account", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { accountId } = req.body || {};

    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context",
      });
    }

    if (!accountId) {
      return res.status(400).json({
        ok: false,
        message: "accountId is required",
      });
    }

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "meta_ads",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      return res.status(404).json({
        ok: false,
        message: "Meta Ads connection not found",
      });
    }

    const accounts = Array.isArray(connection?.metadata?.accounts)
      ? connection.metadata.accounts
      : [];

    const normalizedTarget = String(accountId).replace(/^act_/, "");

    const matched = accounts.find((item) => {
      const normalizedItem = String(item?.id || "").replace(/^act_/, "");
      return normalizedItem === normalizedTarget;
    });

    if (!matched) {
      return res.status(400).json({
        ok: false,
        message: "Selected account is not in Meta ad accounts list",
      });
    }

    connection.externalAccountId = matched.id || null;
    connection.externalAccountName = matched.name || matched.id || "Meta Ads Account";
    connection.mode = "live";
    connection.status = "connected";
    connection.lastSyncAt = new Date();
    connection.lastSyncStatus = "success";
    connection.lastError = null;
    connection.metadata = {
      ...(connection.metadata || {}),
      selectedAccount: matched,
      needsSelection: false,
    };

    await connection.save();

    await updateOrgIntegrationSummary(orgId, "meta_ads", {
      connected: true,
      connectedAt: connection.connectedAt || new Date(),
      lastSync: new Date(),
      mode: "live",
    });

    return res.json({
      ok: true,
      message: "Meta Ads account selected",
      integration: {
        provider: "meta_ads",
        externalAccountId: matched.id || null,
        externalAccountName: matched.name || matched.id || "Meta Ads Account",
      },
      integrations: await formatIntegrations(orgId),
    });
  } catch (err) {
    console.error("META ADS select account error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to select Meta Ads account",
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

    if (typeof connection.markConnected === "function") {
      connection.markConnected({
        mode: "live",
        externalAccountId: accountId,
        externalAccountName: accountName,
        accessToken,
        refreshToken,
        tokenType: tokenData?.token_type || null,
        tokenExpiresAt: expiresIn
          ? new Date(Date.now() + expiresIn * 1000)
          : null,
        scopes,
        metadata: {
          hubId: accountId,
          scopes,
        },
      });
    } else {
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
    }

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

    console.log("GOOGLE ADS CALLBACK HIT", {
      hasCode: !!code,
      hasState: !!state,
      query: req.query,
    });

    if (!code || !state) {
      return res.status(400).send("Missing code or state");
    }

    let parsedState;
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
      throw new Error("No access token returned");
    }

    const profile = await getGoogleUserProfile(accessToken);
    const customers = await getGoogleAdsAccessibleCustomers(accessToken);

    if (!customers.length) {
      throw new Error(
        "No accessible Google Ads accounts were found for this Google login"
      );
    }

    const needsSelection = customers.length > 1;
    const selectedCustomer = customers.length === 1 ? customers[0] : null;

    const externalAccountId = selectedCustomer
      ? selectedCustomer.replace("customers/", "")
      : null;

    const externalAccountName = externalAccountId
      ? `Google Ads ${externalAccountId}`
      : null;

    console.log("GOOGLE ADS CONNECTED", {
      orgId: String(orgId),
      googleUserEmail: profile?.email || null,
      customers,
      selectedCustomer,
      externalAccountId,
      needsSelection,
    });

    let connection = await IntegrationConnection.findOne({
      orgId,
      provider: "google_ads",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      connection = new IntegrationConnection({ orgId, provider: "google_ads" });
    }

    if (typeof connection.markConnected === "function") {
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
          accessibleCustomers: customers,
          selectedCustomer,
          needsSelection,
        },
      });
    } else {
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
      connection.externalAccountId = externalAccountId;
      connection.externalAccountName = externalAccountName;
      connection.scopes = scopes;
      connection.lastSyncAt = new Date();
      connection.lastSyncStatus = "success";
      connection.lastError = null;
      connection.metadata = {
        ...(connection.metadata || {}),
        googleUserEmail: profile?.email || null,
        googleUserName: profile?.name || null,
        accessibleCustomers: customers,
        selectedCustomer,
        needsSelection,
      };
    }

    await connection.save();

    await updateOrgIntegrationSummary(orgId, "google_ads", {
      connected: true,
      connectedAt: new Date(),
      lastSync: new Date(),
      mode: "live",
    });

    const frontendUrl =
      process.env.FRONTEND_URL || "https://app.atlasrevenueai.com";

    return res.redirect(
      `${frontendUrl}/integrations?connected=google_ads&mode=live&needsSelection=${
        needsSelection ? "1" : "0"
      }`
    );
  } catch (err) {
    console.error("Google Ads callback error:", err);

    const frontendUrl =
      process.env.FRONTEND_URL || "https://app.atlasrevenueai.com";

    return res.redirect(
      `${frontendUrl}/integrations?error=google_ads_callback_failed`
    );
  }
});

/* -------------------------------- */
/* GA4 CALLBACK (LIVE)              */
/* -------------------------------- */

router.get("/ga4/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    console.log("GA4 CALLBACK HIT", {
      hasCode: !!code,
      hasState: !!state,
      query: req.query,
    });

    if (!code || !state) {
      return res.status(400).send("Missing code or state");
    }

    let parsedState;
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

    const tokenData = await exchangeGA4CodeForTokens(code);

    const accessToken = tokenData?.access_token || null;
    const refreshToken = tokenData?.refresh_token || null;
    const expiresIn = Number(tokenData?.expires_in || 0) || 0;
    const scopes = String(tokenData?.scope || "")
      .split(" ")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!accessToken) {
      throw new Error("No access token returned");
    }

    const profile = await getGoogleUserProfile(accessToken);
    const accountSummaries = await getGA4AccountSummaries(accessToken);

    const properties = accountSummaries.flatMap((account) => {
      const accountName =
        account?.displayName ||
        String(account?.name || "").replace("accountSummaries/", "") ||
        "GA4 Account";

      const propertySummaries = Array.isArray(account?.propertySummaries)
        ? account.propertySummaries
        : [];

      return propertySummaries.map((prop) => ({
        account: accountName,
        property: prop?.displayName || prop?.property || "GA4 Property",
        propertyId: String(prop?.property || "").replace("properties/", ""),
        resourceName: prop?.property || "",
      }));
    });

    if (!properties.length) {
      throw new Error(
        "No accessible GA4 properties were found for this Google login"
      );
    }

    const needsSelection = properties.length > 1;
    const selectedProperty = properties.length === 1 ? properties[0] : null;

    const externalAccountId = selectedProperty?.propertyId || null;
    const externalAccountName = selectedProperty?.property || null;

    console.log("GA4 CONNECTED", {
      orgId: String(orgId),
      googleUserEmail: profile?.email || null,
      propertyCount: properties.length,
      selectedProperty,
      externalAccountId,
      needsSelection,
    });

    let connection = await IntegrationConnection.findOne({
      orgId,
      provider: "ga4",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      connection = new IntegrationConnection({ orgId, provider: "ga4" });
    }

    if (typeof connection.markConnected === "function") {
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
          properties,
          selectedProperty,
          needsSelection,
        },
      });
    } else {
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
      connection.externalAccountId = externalAccountId;
      connection.externalAccountName = externalAccountName;
      connection.scopes = scopes;
      connection.lastSyncAt = new Date();
      connection.lastSyncStatus = "success";
      connection.lastError = null;
      connection.metadata = {
        ...(connection.metadata || {}),
        googleUserEmail: profile?.email || null,
        googleUserName: profile?.name || null,
        properties,
        selectedProperty,
        needsSelection,
      };
    }

    await connection.save();

    await updateOrgIntegrationSummary(orgId, "ga4", {
      connected: true,
      connectedAt: new Date(),
      lastSync: new Date(),
      mode: "live",
    });

    const frontendUrl =
      process.env.FRONTEND_URL || "https://app.atlasrevenueai.com";

    return res.redirect(
      `${frontendUrl}/integrations?connected=ga4&mode=live&needsSelection=${
        needsSelection ? "1" : "0"
      }`
    );
  } catch (err) {
    console.error("GA4 callback error:", err);

    const frontendUrl =
      process.env.FRONTEND_URL || "https://app.atlasrevenueai.com";

    return res.redirect(`${frontendUrl}/integrations?error=ga4_callback_failed`);
  }
});

/* -------------------------------- */
/* META ADS CALLBACK (LIVE)         */
/* -------------------------------- */

router.get("/meta_ads/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    console.log("META ADS CALLBACK HIT", {
      hasCode: !!code,
      hasState: !!state,
      query: req.query,
    });

    if (!code || !state) {
      return res.status(400).send("Missing code or state");
    }

    let parsedState;
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

    const tokenData = await exchangeMetaCodeForTokens(code);
    const accessToken = tokenData?.access_token || null;

    if (!accessToken) {
      throw new Error("No Meta access token returned");
    }

    const accounts = await getMetaAdAccounts(accessToken);

    if (!accounts.length) {
      throw new Error("No Meta ad accounts found for this login");
    }

    const needsSelection = accounts.length > 1;
    const selectedAccount = accounts.length === 1 ? accounts[0] : null;

    const externalAccountId = selectedAccount?.id || null;
    const externalAccountName = selectedAccount?.name || null;

    console.log("META ADS CONNECTED", {
      orgId: String(orgId),
      accountCount: accounts.length,
      selectedAccount,
      externalAccountId,
      needsSelection,
    });

    let connection = await IntegrationConnection.findOne({
      orgId,
      provider: "meta_ads",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      connection = new IntegrationConnection({ orgId, provider: "meta_ads" });
    }

    if (typeof connection.markConnected === "function") {
      connection.markConnected({
        mode: "live",
        externalAccountId,
        externalAccountName,
        accessToken,
        refreshToken: null,
        tokenType: tokenData?.token_type || null,
        tokenExpiresAt: tokenData?.expires_in
          ? new Date(Date.now() + Number(tokenData.expires_in) * 1000)
          : null,
        scopes: ["ads_read", "ads_management", "business_management"],
        metadata: {
          accounts,
          selectedAccount,
          needsSelection,
        },
      });
    } else {
      connection.status = "connected";
      connection.mode = "live";
      connection.connectedAt = new Date();
      connection.disconnectedAt = null;
      connection.accessToken = accessToken;
      connection.refreshToken = null;
      connection.tokenType = tokenData?.token_type || null;
      connection.tokenExpiresAt = tokenData?.expires_in
        ? new Date(Date.now() + Number(tokenData.expires_in) * 1000)
        : null;
      connection.externalAccountId = externalAccountId;
      connection.externalAccountName = externalAccountName;
      connection.scopes = ["ads_read", "ads_management", "business_management"];
      connection.lastSyncAt = new Date();
      connection.lastSyncStatus = "success";
      connection.lastError = null;
      connection.metadata = {
        ...(connection.metadata || {}),
        accounts,
        selectedAccount,
        needsSelection,
      };
    }

    await connection.save();

    await updateOrgIntegrationSummary(orgId, "meta_ads", {
      connected: true,
      connectedAt: new Date(),
      lastSync: new Date(),
      mode: "live",
    });

    const frontendUrl =
      process.env.FRONTEND_URL || "https://app.atlasrevenueai.com";

    return res.redirect(
      `${frontendUrl}/integrations?connected=meta_ads&mode=live&needsSelection=${
        needsSelection ? "1" : "0"
      }`
    );
  } catch (err) {
    console.error("Meta Ads callback error:", err);

    const frontendUrl =
      process.env.FRONTEND_URL || "https://app.atlasrevenueai.com";

    return res.redirect(
      `${frontendUrl}/integrations?error=meta_ads_callback_failed`
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

    if (typeof connection.markSyncRunning === "function") {
      connection.markSyncRunning();
    } else {
      connection.status = "syncing";
      connection.lastSyncStatus = "running";
      connection.lastError = null;
    }
    await connection.save();

    if (typeof connection.markSyncSuccess === "function") {
      connection.markSyncSuccess();
    } else {
      connection.status = "connected";
      connection.lastSyncAt = new Date();
      connection.lastSyncStatus = "success";
      connection.lastError = null;
    }
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
        const failedConnection = await IntegrationConnection.findOne({
          orgId,
          provider: "hubspot",
        }).select("+accessToken +refreshToken");

        if (failedConnection) {
          if (typeof failedConnection.markSyncFailed === "function") {
            failedConnection.markSyncFailed(err.message || "HubSpot sync failed");
            await failedConnection.save();
          } else {
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
        }
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