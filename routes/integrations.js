import express from "express";
import Stripe from "stripe";
import Organization from "../models/Organization.js";
import IntegrationConnection from "../models/IntegrationConnection.js";
import StripeRevenueDaily from "../models/StripeRevenueDaily.js";
import { requireAuth } from "../middleware/auth.js";
import { syncStripeForOrg } from "../services/stripeSync.js";
import Account from "../models/Account.js";
import Client from "../models/Client.js";
import Deal from "../models/Deal.js";

const router = express.Router();

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const INTEGRATIONS = [
  { id: "hubspot", name: "HubSpot CRM", category: "CRM", supportsLive: true },
  { id: "salesforce", name: "Salesforce", category: "CRM", supportsLive: true },
  { id: "zoho_crm", name: "Zoho CRM", category: "CRM", supportsLive: true },
  { id: "pipedrive", name: "Pipedrive", category: "CRM", supportsLive: true },
  { id: "bitrix24", name: "Bitrix24", category: "CRM", supportsLive: true },
  { id: "google_ads", name: "Google Ads", category: "Advertising", supportsLive: true },
  { id: "meta_ads", name: "Meta Ads", category: "Advertising", supportsLive: true },
  { id: "linkedin_ads", name: "LinkedIn Ads", category: "Advertising", supportsLive: true },
  { id: "ga4", name: "Google Analytics 4", category: "Analytics", supportsLive: true },
  { id: "stripe", name: "Stripe", category: "Payments", supportsLive: true },
  { id: "shopify", name: "Shopify", category: "Commerce", supportsLive: true },
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

function buildBackendBaseUrl() {
  return String(
    process.env.BACKEND_PUBLIC_URL ||
    process.env.APP_BASE_URL ||
    `https://atlas-revenue-backend.onrender.com`
  )
    .trim()
    .replace(/\/+$/, "");
}

function getFrontendUrl() {
  return String(process.env.FRONTEND_URL || "https://app.atlasrevenueai.com")
    .trim()
    .replace(/\/+$/, "");
}

function safeStateString(payload) {
  return JSON.stringify(payload);
}

function normalizeShopDomain(shopDomain) {
  return String(shopDomain || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

function normalizeSalesforceInstanceUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function formatOauthErrorRedirect(provider, code = `${provider}_callback_failed`) {
  return `${getFrontendUrl()}/integrations?error=${encodeURIComponent(code)}`;
}

/* -------------------------------- */
/* HubSpot OAuth helpers            */
/* -------------------------------- */

function buildHubSpotRedirectUri() {
  const base = buildBackendBaseUrl();
  if (!base) return null;
  return `${base}/api/integrations/hubspot/callback`;
}

function buildHubSpotAuthUrl(orgId) {
  const clientId = String(process.env.HUBSPOT_CLIENT_ID || "").trim();
  const redirectUri = buildHubSpotRedirectUri();

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
    state: safeStateString({
      orgId: String(orgId),
      provider: "hubspot",
    }),
  });

  return `https://app.hubspot.com/oauth/authorize?${params.toString()}`;
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

  const res = await fetch(
    "https://api.hubapi.com/oauth/2026-03/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }
  );

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      data?.error_description ||
        data?.message ||
        data?.error ||
        "Failed to exchange HubSpot OAuth code"
    );
  }

  return data;
}

async function refreshHubSpotAccessToken(refreshToken) {
  const clientId = String(process.env.HUBSPOT_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.HUBSPOT_CLIENT_SECRET || "").trim();

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("HubSpot refresh token configuration is incomplete");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const res = await fetch(
    "https://api.hubapi.com/oauth/2026-03/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }
  );

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      data?.error_description ||
        data?.message ||
        data?.error ||
        "Failed to refresh HubSpot access token"
    );
  }

  if (!data?.access_token) {
    throw new Error("HubSpot refresh did not return an access token");
  }

  return data;
}

/* -------------------------------- */
/* HubSpot CRM sync helpers         */
/* -------------------------------- */

async function ensureHubSpotAccessToken(connection, forceRefresh = false) {
  if (!connection) {
    throw new Error("Missing HubSpot connection");
  }

  const expiresAt = connection.tokenExpiresAt
    ? new Date(connection.tokenExpiresAt).getTime()
    : 0;

  const refreshEarlyMs = 2 * 60 * 1000;

  const tokenStillValid =
    connection.accessToken &&
    expiresAt &&
    expiresAt > Date.now() + refreshEarlyMs;

  if (!forceRefresh && tokenStillValid) {
    return connection.accessToken;
  }

  if (!forceRefresh && connection.accessToken && !expiresAt) {
    return connection.accessToken;
  }

  if (!connection.refreshToken) {
    if (connection.accessToken && !forceRefresh) {
      return connection.accessToken;
    }

    throw new Error(
      "HubSpot access token expired and no refresh token is available"
    );
  }

  const tokenData = await refreshHubSpotAccessToken(
    connection.refreshToken
  );

  connection.accessToken = tokenData.access_token;

  // Preserve the existing refresh token unless HubSpot rotates it.
  if (tokenData.refresh_token) {
    connection.refreshToken = tokenData.refresh_token;
  }

  connection.tokenType =
    tokenData.token_type ||
    connection.tokenType ||
    "bearer";

  const expiresIn =
    Number(tokenData.expires_in || 0) || 0;

  connection.tokenExpiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000)
    : null;

  await connection.save();

  return connection.accessToken;
}

async function hubSpotApiRequest(
  connection,
  path,
  options = {},
  retryOnUnauthorized = true
) {
  let accessToken = await ensureHubSpotAccessToken(
    connection
  );

  const makeRequest = async (token) => {
    return fetch(`https://api.hubapi.com${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body
          ? { "Content-Type": "application/json" }
          : {}),
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });
  };

  let response = await makeRequest(accessToken);

  /*
   * A token can be invalidated before our stored expiry.
   * Refresh once and retry when HubSpot returns 401.
   */
  if (
    response.status === 401 &&
    retryOnUnauthorized &&
    connection.refreshToken
  ) {
    accessToken = await ensureHubSpotAccessToken(
      connection,
      true
    );

    response = await makeRequest(accessToken);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error_description ||
      data?.error ||
      `HubSpot API request failed with status ${response.status}`;

    throw new Error(message);
  }

  return data;
}

async function hubSpotGetAllObjects(
  connection,
  objectType,
  properties = [],
  associations = []
) {
  const allRecords = [];

  let after = null;

  do {
    const params = new URLSearchParams();

    params.set("limit", "100");

    if (properties.length) {
      params.set("properties", properties.join(","));
    }

    if (associations.length) {
      params.set(
        "associations",
        associations.join(",")
      );
    }

    if (after) {
      params.set("after", String(after));
    }

    const data = await hubSpotApiRequest(
      connection,
      `/crm/objects/2026-03/${objectType}?${params.toString()}`
    );

    const records = Array.isArray(data?.results)
      ? data.results
      : [];

    allRecords.push(...records);

    after = data?.paging?.next?.after || null;
  } while (after);

  return allRecords;
}

async function hubSpotGetDealPipelines(connection) {
  const data = await hubSpotApiRequest(
    connection,
    "/crm/pipelines/2026-03/deals"
  );

  return Array.isArray(data?.results)
    ? data.results
    : [];
}

function buildHubSpotStageMap(pipelines = []) {
  const map = new Map();

  for (const pipeline of pipelines) {
    const stages = Array.isArray(pipeline?.stages)
      ? pipeline.stages
      : [];

    for (const stage of stages) {
      if (!stage?.id) continue;

      const probability = Number(
        stage?.metadata?.probability
      );

      map.set(String(stage.id), {
        id: String(stage.id),
        label: String(stage?.label || ""),
        pipelineId: String(pipeline?.id || ""),
        pipelineLabel: String(
          pipeline?.label || ""
        ),
        probability: Number.isFinite(probability)
          ? probability
          : null,
      });
    }
  }

  return map;
}

function normalizeHubSpotStage(
  rawStageId,
  stageMap
) {
  const stageInfo = stageMap.get(
    String(rawStageId || "")
  );

  const stageLabel = String(
    stageInfo?.label ||
      rawStageId ||
      ""
  ).toLowerCase();

  if (
    stageLabel.includes("closed won") ||
    stageLabel.includes("closedwon") ||
    stageLabel.includes("won")
  ) {
    return "Closed Won";
  }

  if (
    stageLabel.includes("closed lost") ||
    stageLabel.includes("closedlost") ||
    stageLabel.includes("lost")
  ) {
    return "Closed Lost";
  }

  if (
    stageLabel.includes("negotiat") ||
    stageLabel.includes("contract") ||
    stageLabel.includes("decision") ||
    stageLabel.includes("review")
  ) {
    return "Negotiation";
  }

  if (
    stageLabel.includes("proposal") ||
    stageLabel.includes("quote") ||
    stageLabel.includes("presentation")
  ) {
    return "Proposal";
  }

  if (
    stageLabel.includes("follow") ||
    stageLabel.includes("nurture")
  ) {
    return "Follow-Up";
  }

  return "Discovery";
}

function getHubSpotDealProbability(
  rawStageId,
  stageMap,
  normalizedStage
) {
  const stageInfo = stageMap.get(
    String(rawStageId || "")
  );

  if (
    stageInfo &&
    Number.isFinite(stageInfo.probability)
  ) {
    return Math.min(
      1,
      Math.max(0, stageInfo.probability)
    );
  }

  switch (normalizedStage) {
    case "Closed Won":
      return 1;

    case "Closed Lost":
      return 0;

    case "Negotiation":
      return 0.75;

    case "Proposal":
      return 0.5;

    case "Follow-Up":
      return 0.35;

    default:
      return 0.2;
  }
}

function safeHubSpotNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safeHubSpotDate(value) {
  if (!value) return null;

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? null
    : date;
}

function normalizeHubSpotDomain(value) {
  let domain = String(value || "")
    .trim()
    .toLowerCase();

  domain = domain
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];

  return domain;
}
/* -------------------------------- */
/* Zoho CRM OAuth helpers           */
/* -------------------------------- */

function buildZohoRedirectUri() {
  const base = buildBackendBaseUrl();
  if (!base) return null;
  return `${base}/api/integrations/zoho_crm/callback`;
}

function getZohoAccountsBase() {
  return String(process.env.ZOHO_ACCOUNTS_BASE || "https://accounts.zoho.com")
    .trim()
    .replace(/\/+$/, "");
}

function buildZohoAuthUrl(orgId) {
  const clientId = String(process.env.ZOHO_CLIENT_ID || "").trim();
  const redirectUri = buildZohoRedirectUri();
  const accountsBase = getZohoAccountsBase();

  if (!clientId || !redirectUri || !orgId) return null;

  const scope = [
  "ZohoCRM.modules.ALL",
  "ZohoCRM.settings.ALL",
  "ZohoCRM.users.ALL",
  "ZohoCRM.org.READ",
].join(",");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    access_type: "offline",
    prompt: "consent",
    redirect_uri: redirectUri,
    scope,
    state: safeStateString({ orgId: String(orgId), provider: "zoho_crm" }),
  });

  return `${accountsBase}/oauth/v2/auth?${params.toString()}`;
}

async function exchangeZohoCodeForTokens(code) {
  const clientId = String(process.env.ZOHO_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.ZOHO_CLIENT_SECRET || "").trim();
  const redirectUri = buildZohoRedirectUri();
  const accountsBase = getZohoAccountsBase();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Zoho OAuth is not fully configured");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
  });

  const res = await fetch(`${accountsBase}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data?.error || data?.message || "Zoho token exchange failed");
  }

  return data;
}

async function getZohoOrgInfo(accessToken) {
  const res = await fetch("https://www.zohoapis.com/crm/v8/org", {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error("Failed to fetch Zoho org");
  }

  return Array.isArray(data?.org) ? data.org[0] : null;
}

/* -------------------------------- */
/* Pipedrive OAuth helpers          */
/* -------------------------------- */

function buildPipedriveRedirectUri() {
  const base = buildBackendBaseUrl();
  if (!base) return null;
  return `${base}/api/integrations/pipedrive/callback`;
}

function buildPipedriveAuthUrl(orgId) {
  const clientId = String(process.env.PIPEDRIVE_CLIENT_ID || "").trim();
  const redirectUri = buildPipedriveRedirectUri();

  if (!clientId || !redirectUri || !orgId) return null;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state: safeStateString({ orgId: String(orgId), provider: "pipedrive" }),
  });

  return `https://oauth.pipedrive.com/oauth/authorize?${params.toString()}`;
}

async function exchangePipedriveCodeForTokens(code) {
  const clientId = String(process.env.PIPEDRIVE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.PIPEDRIVE_CLIENT_SECRET || "").trim();
  const redirectUri = buildPipedriveRedirectUri();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Pipedrive OAuth is not fully configured");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch("https://oauth.pipedrive.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      data?.error || data?.error_description || "Pipedrive token exchange failed"
    );
  }

  return data;
}

async function getPipedriveUserInfo(accessToken) {
  const res = await fetch("https://api.pipedrive.com/v1/users/me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data?.success === false) {
    throw new Error("Failed to fetch Pipedrive user");
  }

  return data?.data || null;
}

/* -------------------------------- */
/* Google OAuth helpers             */
/* -------------------------------- */

function buildGoogleAdsRedirectUri() {
  const base = buildBackendBaseUrl();
  if (!base) return null;
  return `${base}/api/integrations/google_ads/callback`;
}

function buildGoogleAdsAuthUrl(orgId) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const redirectUri = buildGoogleAdsRedirectUri();

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
    state: safeStateString({ orgId: String(orgId), provider: "google_ads" }),
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeGoogleCodeForTokens(code, redirectUriOverride = null) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  const redirectUri = redirectUriOverride || buildGoogleAdsRedirectUri();

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
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
  const base = buildBackendBaseUrl();
  if (!base) return null;
  return `${base}/api/integrations/ga4/callback`;
}

function buildGA4AuthUrl(orgId) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const redirectUri = buildGA4RedirectUri();

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
    state: safeStateString({ orgId: String(orgId), provider: "ga4" }),
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
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
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
  const base = buildBackendBaseUrl();
  if (!base) return null;
  return `${base}/api/integrations/meta_ads/callback`;
}

function buildMetaAdsAuthUrl(orgId) {
  const clientId = String(process.env.META_APP_ID || "").trim();
  const redirectUri = buildMetaAdsRedirectUri();

  if (!clientId || !redirectUri || !orgId) return null;

  const scope = ["ads_read", "ads_management", "business_management"].join(",");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state: safeStateString({ orgId: String(orgId), provider: "meta_ads" }),
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
    "https://graph.facebook.com/v18.0/me/adaccounts?fields=id,name,account_status",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data?.error?.message || "Failed to fetch Meta ad accounts");
  }

  return Array.isArray(data?.data) ? data.data : [];
}

/* -------------------------------- */
/* Stripe Connect OAuth helpers     */
/* -------------------------------- */

function buildStripeRedirectUri() {
  const base = buildBackendBaseUrl();
  if (!base) return null;
  return `${base}/api/integrations/stripe/callback`;
}

function buildStripeAuthUrl(orgId) {
  const clientId = String(process.env.STRIPE_CONNECT_CLIENT_ID || "").trim();
  const redirectUri = buildStripeRedirectUri();

  if (!clientId || !redirectUri || !orgId) return null;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: "read_write",
    redirect_uri: redirectUri,
    state: safeStateString({ orgId: String(orgId), provider: "stripe" }),
  });

  return `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
}

async function exchangeStripeCodeForTokens(code) {
  const clientSecret = String(process.env.STRIPE_SECRET_KEY || "").trim();

  if (!clientSecret) {
    throw new Error("Stripe OAuth is not fully configured");
  }

  const redirectUri = buildStripeRedirectUri();

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_secret: clientSecret,
  });

  if (redirectUri) {
    body.set("redirect_uri", redirectUri);
  }

  const res = await fetch("https://connect.stripe.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      data?.error_description || data?.error || "Stripe token exchange failed"
    );
  }

  return data;
}

async function getStripeAccountInfo(accountId) {
  if (!stripe) throw new Error("Stripe is not configured");
  if (!accountId) throw new Error("Missing Stripe account id");
  return stripe.accounts.retrieve(accountId);
}

/* -------------------------------- */
/* Shopify OAuth helpers            */
/* -------------------------------- */

function buildShopifyRedirectUri() {
  const base = buildBackendBaseUrl();
  if (!base) return null;
  return `${base}/api/integrations/shopify/callback`;
}

function buildShopifyAuthUrl(shopDomain, orgId) {
  const clientId = String(process.env.SHOPIFY_CLIENT_ID || "").trim();
  const redirectUri = buildShopifyRedirectUri();
  const scopes = String(
    process.env.SHOPIFY_SCOPES || "read_products,read_customers,read_orders"
  ).trim();

  const cleanDomain = normalizeShopDomain(shopDomain);

  if (!clientId || !redirectUri || !cleanDomain || !orgId) return null;

  const params = new URLSearchParams({
    client_id: clientId,
    scope: scopes,
    redirect_uri: redirectUri,
    state: safeStateString({
      orgId: String(orgId),
      provider: "shopify",
      shopDomain: cleanDomain,
    }),
  });

  return `https://${cleanDomain}/admin/oauth/authorize?${params.toString()}`;
}

async function exchangeShopifyCodeForToken({ code, shopDomain }) {
  const clientId = String(process.env.SHOPIFY_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.SHOPIFY_CLIENT_SECRET || "").trim();
  const cleanDomain = normalizeShopDomain(shopDomain);

  if (!clientId || !clientSecret || !cleanDomain) {
    throw new Error("Shopify OAuth is not fully configured");
  }

  const res = await fetch(`https://${cleanDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      data?.error_description || data?.error || "Shopify token exchange failed"
    );
  }

  return data;
}

async function getShopifyShopInfo({ shopDomain, accessToken }) {
  const cleanDomain = normalizeShopDomain(shopDomain);

  const res = await fetch(`https://${cleanDomain}/admin/api/2024-10/shop.json`, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data?.errors || "Failed to fetch Shopify shop info");
  }

  return data?.shop || null;
}

/* -------------------------------- */
/* Salesforce OAuth helpers         */
/* -------------------------------- */

function buildSalesforceRedirectUri() {
  const base = buildBackendBaseUrl();
  if (!base) return null;
  return `${base}/api/integrations/salesforce/callback`;
}

function buildSalesforceAuthUrl(orgId) {
  const clientId = String(process.env.SALESFORCE_CLIENT_ID || "").trim();
  const redirectUri = buildSalesforceRedirectUri();
  const loginUrl = String(
    process.env.SALESFORCE_LOGIN_URL || "https://login.salesforce.com"
  )
    .trim()
    .replace(/\/+$/, "");

  if (!clientId || !redirectUri || !orgId) return null;

  const params = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: redirectUri,
  scope: "api refresh_token offline_access",
  state: safeStateString({
    orgId: String(orgId),
    provider: "salesforce",
  }),
});

  return `${loginUrl}/services/oauth2/authorize?${params.toString()}`;
}

async function exchangeSalesforceCodeForTokens(code) {
  const clientId = String(process.env.SALESFORCE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.SALESFORCE_CLIENT_SECRET || "").trim();
  const redirectUri = buildSalesforceRedirectUri();
  const loginUrl = String(
    process.env.SALESFORCE_LOGIN_URL || "https://login.salesforce.com"
  )
    .trim()
    .replace(/\/+$/, "");

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Salesforce OAuth is not fully configured");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
  });

  const res = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      data?.error_description || data?.error || "Salesforce token exchange failed"
    );
  }

  return data;
}
async function refreshSalesforceAccessToken(refreshToken) {
  const clientId = String(
    process.env.SALESFORCE_CLIENT_ID || ""
  ).trim();

  const clientSecret = String(
    process.env.SALESFORCE_CLIENT_SECRET || ""
  ).trim();

  const loginUrl = String(
    process.env.SALESFORCE_LOGIN_URL || "https://login.salesforce.com"
  )
    .trim()
    .replace(/\/+$/, "");

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Salesforce refresh token configuration is incomplete"
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const response = await fetch(
    `${loginUrl}/services/oauth2/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.error_description ||
        data?.error ||
        "Failed to refresh Salesforce access token"
    );
  }

  if (!data?.access_token) {
    throw new Error(
      "Salesforce refresh did not return an access token"
    );
  }

  return data;
}
async function getSalesforceIdentity(identityUrl, accessToken) {
  const res = await fetch(identityUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error("Failed to fetch Salesforce identity");
  }

  return data;
}
const SALESFORCE_API_VERSION = String(
  process.env.SALESFORCE_API_VERSION || "v65.0"
).trim();

async function salesforceApiRequest({
  instanceUrl,
  accessToken,
  path,
}) {
  const cleanInstanceUrl =
    normalizeSalesforceInstanceUrl(instanceUrl);

  if (!cleanInstanceUrl) {
    throw new Error("Missing Salesforce instance URL");
  }

  if (!accessToken) {
    throw new Error("Missing Salesforce access token");
  }

  const response = await fetch(
    `${cleanInstanceUrl}${path}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      Array.isArray(data) && data[0]?.message
        ? data[0].message
        : data?.message ||
          `Salesforce request failed with status ${response.status}`;

    const error = new Error(message);
    error.status = response.status;
    error.salesforceResponse = data;

    throw error;
  }

  return data;
}

async function salesforceQueryAll({
  instanceUrl,
  accessToken,
  soql,
}) {
  const records = [];

  let nextPath =
    `/services/data/${SALESFORCE_API_VERSION}/query` +
    `?q=${encodeURIComponent(soql)}`;

  while (nextPath) {
    const data = await salesforceApiRequest({
      instanceUrl,
      accessToken,
      path: nextPath,
    });

    if (Array.isArray(data?.records)) {
      records.push(...data.records);
    }

    nextPath = data?.nextRecordsUrl || null;
  }

  return records;
}
/* -------------------------------- */
/* LinkedIn Ads OAuth helpers       */
/* -------------------------------- */

function buildLinkedInAdsRedirectUri() {
  const explicit = String(process.env.LINKEDIN_REDIRECT_URI || "").trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  const base = buildBackendBaseUrl();
  if (!base) {
    throw new Error(
      "Missing BACKEND_PUBLIC_URL / APP_BASE_URL / LINKEDIN_REDIRECT_URI"
    );
  }

  return `${base}/api/integrations/linkedin_ads/callback`;
}

function buildLinkedInAdsAuthUrl(orgId) {
  const clientId = String(process.env.LINKEDIN_CLIENT_ID || "").trim();
  const redirectUri = buildLinkedInAdsRedirectUri();

  if (!clientId || !orgId || !redirectUri) {
    return null;
  }

  const scope = ["openid", "profile", "email"].join(" ");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state: safeStateString({
      orgId: String(orgId),
      provider: "linkedin_ads",
    }),
  });

  return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
}

async function exchangeLinkedInCodeForTokens(code) {
  const clientId = String(process.env.LINKEDIN_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.LINKEDIN_CLIENT_SECRET || "").trim();
  const redirectUri = buildLinkedInAdsRedirectUri();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("LinkedIn OAuth is not fully configured");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: String(code),
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });

  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      data?.error_description || data?.error || "LinkedIn token exchange failed"
    );
  }

  return data;
}

async function getLinkedInProfile(accessToken) {
  const res = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error("Failed to fetch LinkedIn profile");
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
        shopDomain: live?.metadata?.shopDomain || null,
        selectedSalesforceOrg: live?.metadata?.salesforceOrgId || null,
        selectedLinkedInAccount: live?.externalAccountName || null,
        bitrixWebhookUrl: live?.metadata?.webhookUrl || null,
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
      shopDomain: null,
      selectedSalesforceOrg: null,
      selectedLinkedInAccount: null,
      bitrixWebhookUrl: null,
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

    /*
     * Include hidden OAuth fields because HubSpot
     * requires an active OAuth access token in order
     * to uninstall the app from the customer's portal.
     */
    let connection =
      await IntegrationConnection.findOne({
        orgId,
        provider: id,
      }).select("+accessToken +refreshToken");

    if (!connection) {
      connection = new IntegrationConnection({
        orgId,
        provider: id,
      });
    }

    /*
     * --------------------------------
     * HUBSPOT UNINSTALL
     * --------------------------------
     *
     * HubSpot certification requires the public app
     * uninstall endpoint rather than only clearing
     * Atlas's local token storage.
     */
    if (
      id === "hubspot" &&
      connection.status === "connected"
    ) {
      try {
        /*
         * Make sure we have a current access token.
         * This can refresh the token first if needed.
         */
        const accessToken =
          await ensureHubSpotAccessToken(
            connection
          );

        const uninstallResponse = await fetch(
          "https://api.hubspot.com/appinstalls/v3/external-install",
          {
            method: "DELETE",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
          }
        );

        /*
         * HubSpot may return an empty body on success,
         * so don't assume JSON is always present.
         */
        let uninstallData = {};

        const responseText =
          await uninstallResponse.text();

        if (responseText) {
          try {
            uninstallData =
              JSON.parse(responseText);
          } catch {
            uninstallData = {
              message: responseText,
            };
          }
        }

        if (!uninstallResponse.ok) {
          throw new Error(
            uninstallData?.message ||
              uninstallData?.error_description ||
              uninstallData?.error ||
              `HubSpot uninstall failed with status ${uninstallResponse.status}`
          );
        }
      } catch (hubSpotErr) {
        console.error(
          "HubSpot uninstall error:",
          hubSpotErr
        );

        /*
         * Do NOT erase the local token if HubSpot
         * uninstall failed.
         *
         * Keeping the token lets us retry instead of
         * leaving Atlas disconnected locally while
         * the app is still installed in HubSpot.
         */
        connection.lastError =
          String(
            hubSpotErr?.message ||
              "HubSpot uninstall failed"
          );

        await connection.save();

        return res.status(502).json({
          ok: false,
          message:
            "HubSpot could not be fully disconnected. The HubSpot installation is still active.",
          error:
            hubSpotErr?.message ||
            "HubSpot uninstall failed",
        });
      }
    }

    /*
     * --------------------------------
     * LOCAL DISCONNECT
     * --------------------------------
     *
     * Only clear Atlas's stored credentials after
     * HubSpot uninstall succeeds.
     */
    if (
      typeof connection.markDisconnected ===
      "function"
    ) {
      connection.markDisconnected();
    } else {
      connection.status = "disconnected";
      connection.mode = "demo";
      connection.connectedAt = null;
      connection.disconnectedAt =
        new Date();
      connection.lastSyncAt = null;
      connection.lastSyncStatus =
        "never";
      connection.lastError = null;
      connection.accessToken = null;
      connection.refreshToken = null;
      connection.tokenType = null;
      connection.tokenExpiresAt = null;
      connection.externalAccountId =
        null;
      connection.externalAccountName =
        null;
      connection.scopes = [];
      connection.syncCursor = null;
      connection.settings = {};
      connection.metadata = {};
    }

    await connection.save();

    await updateOrgIntegrationSummary(
      orgId,
      id,
      {
        connected: false,
        connectedAt: null,
        lastSync: null,
        mode: "demo",
      }
    );

    return res.json({
      ok: true,
      message:
        `${exists.name} disconnected`,
      integrations:
        await formatIntegrations(orgId),
    });
  } catch (err) {
    console.error(
      "DISCONNECT integration error:",
      err
    );

    return res.status(500).json({
      ok: false,
      message:
        "Failed to disconnect integration",
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
        return res.status(500).json({ ok: false, message: "HubSpot OAuth is not configured" });
      }
      return res.json({ ok: true, provider, authUrl: url });
    }

    if (provider === "zoho_crm") {
      const url = buildZohoAuthUrl(orgId);
      if (!url) {
        return res.status(500).json({ ok: false, message: "Zoho CRM OAuth is not configured" });
      }
      return res.json({ ok: true, provider, authUrl: url });
    }

    if (provider === "pipedrive") {
      const url = buildPipedriveAuthUrl(orgId);
      if (!url) {
        return res.status(500).json({ ok: false, message: "Pipedrive OAuth is not configured" });
      }
      return res.json({ ok: true, provider, authUrl: url });
    }

    if (provider === "google_ads") {
      const url = buildGoogleAdsAuthUrl(orgId);
      if (!url) {
        return res.status(500).json({ ok: false, message: "Google Ads OAuth is not configured" });
      }
      return res.json({ ok: true, provider, authUrl: url });
    }

    if (provider === "ga4") {
      const url = buildGA4AuthUrl(orgId);
      if (!url) {
        return res.status(500).json({ ok: false, message: "GA4 OAuth is not configured" });
      }
      return res.json({ ok: true, provider, authUrl: url });
    }

    if (provider === "meta_ads") {
      const url = buildMetaAdsAuthUrl(orgId);
      if (!url) {
        return res.status(500).json({ ok: false, message: "Meta Ads OAuth is not configured" });
      }
      return res.json({ ok: true, provider, authUrl: url });
    }

    if (provider === "stripe") {
      const url = buildStripeAuthUrl(orgId);
      if (!url) {
        return res.status(500).json({ ok: false, message: "Stripe OAuth is not configured" });
      }
      return res.json({ ok: true, provider, authUrl: url });
    }

    if (provider === "shopify") {
      const { shopDomain } = req.query;

      if (!shopDomain) {
        return res.status(400).json({
          ok: false,
          message: "shopDomain is required for Shopify",
        });
      }

      const url = buildShopifyAuthUrl(shopDomain, orgId);

      if (!url) {
        return res.status(500).json({
          ok: false,
          message: "Shopify OAuth is not configured",
        });
      }

      return res.json({
        ok: true,
        provider,
        authUrl: url,
      });
    }

    if (provider === "salesforce") {
      const url = buildSalesforceAuthUrl(orgId);
      if (!url) {
        return res.status(500).json({
          ok: false,
          message: "Salesforce OAuth is not configured",
        });
      }
      return res.json({ ok: true, provider, authUrl: url });
    }

    if (provider === "linkedin_ads") {
      const url = buildLinkedInAdsAuthUrl(orgId);
      if (!url) {
        return res.status(500).json({
          ok: false,
          message: "LinkedIn Ads OAuth is not configured",
        });
      }
      return res.json({ ok: true, provider, authUrl: url });
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
/* STATUS ROUTES                    */
/* -------------------------------- */

router.get("/hubspot/status", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

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

router.get("/zoho_crm/status", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "zoho_crm",
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
    console.error("ZOHO CRM status error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to load Zoho CRM status",
      error: err.message,
    });
  }
});

router.get("/pipedrive/status", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "pipedrive",
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
    console.error("PIPEDRIVE status error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to load Pipedrive status",
      error: err.message,
    });
  }
});

router.get("/bitrix24/status", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "bitrix24",
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
      webhookUrl: connection?.metadata?.webhookUrl || null,
    });
  } catch (err) {
    console.error("BITRIX24 status error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to load Bitrix24 status",
      error: err.message,
    });
  }
});

router.get("/google_ads/status", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

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

router.get("/ga4/status", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

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

router.get("/meta_ads/status", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

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

router.get("/stripe/status", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "stripe",
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
    console.error("STRIPE status error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to load Stripe status",
      error: err.message,
    });
  }
});

router.get("/shopify/status", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "shopify",
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
      shopDomain: connection?.metadata?.shopDomain || null,
    });
  } catch (err) {
    console.error("SHOPIFY status error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to load Shopify status",
      error: err.message,
    });
  }
});

router.get("/salesforce/status", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "salesforce",
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
      instanceUrl: connection?.metadata?.instanceUrl || null,
      salesforceOrgId: connection?.metadata?.salesforceOrgId || null,
    });
  } catch (err) {
    console.error("SALESFORCE status error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to load Salesforce status",
      error: err.message,
    });
  }
});

router.get("/linkedin_ads/status", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "linkedin_ads",
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
      profileEmail: connection?.metadata?.email || null,
    });
  } catch (err) {
    console.error("LINKEDIN ADS status error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to load LinkedIn Ads status",
      error: err.message,
    });
  }
});

/* -------------------------------- */
/* BITRIX24 CONNECT WEBHOOK         */
/* -------------------------------- */

router.post("/bitrix24/connect-webhook", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { webhookUrl } = req.body || {};

    if (!orgId) {
      return res.status(400).json({ ok: false, message: "Missing org context" });
    }

    if (!webhookUrl) {
      return res.status(400).json({ ok: false, message: "webhookUrl is required" });
    }

    const cleanWebhook = String(webhookUrl).trim().replace(/\/+$/, "");

    if (!/^https:\/\/.+\/rest\/.+/i.test(cleanWebhook)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid Bitrix24 webhook URL",
      });
    }

    const testRes = await fetch(`${cleanWebhook}/crm.deal.list.json?start=0`, {
      method: "GET",
    });

    const testData = await testRes.json().catch(() => ({}));

    if (!testRes.ok || testData?.error) {
      throw new Error(
        testData?.error_description || testData?.error || "Bitrix24 webhook test failed"
      );
    }

    let connection = await IntegrationConnection.findOne({
      orgId,
      provider: "bitrix24",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      connection = new IntegrationConnection({ orgId, provider: "bitrix24" });
    }

    connection.markConnected({
      mode: "live",
      externalAccountId: cleanWebhook,
      externalAccountName: "Bitrix24 Webhook",
      accessToken: null,
      refreshToken: null,
      tokenType: "webhook",
      tokenExpiresAt: null,
      scopes: [],
      metadata: {
        webhookUrl: cleanWebhook,
      },
    });

    await connection.save();

    await updateOrgIntegrationSummary(orgId, "bitrix24", {
      connected: true,
      connectedAt: new Date(),
      lastSync: new Date(),
      mode: "live",
    });

    return res.json({
      ok: true,
      message: "Bitrix24 connected",
      integrations: await formatIntegrations(orgId),
    });
  } catch (err) {
    console.error("BITRIX24 connect webhook error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to connect Bitrix24",
      error: err.message,
    });
  }
});

/* -------------------------------- */
/* SELECT ACCOUNT / PROPERTY        */
/* -------------------------------- */

router.post("/google_ads/select-account", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { customerId } = req.body || {};

    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });
    if (!customerId) return res.status(400).json({ ok: false, message: "customerId is required" });

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "google_ads",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      return res.status(404).json({ ok: false, message: "Google Ads connection not found" });
    }

    const accessibleCustomers = Array.isArray(connection?.metadata?.accessibleCustomers)
      ? connection.metadata.accessibleCustomers
      : [];

    const normalizedTarget = String(customerId).replace(/\D/g, "");

    const matched = accessibleCustomers.find((item) => {
      const normalizedItem = String(item).replace("customers/", "").replace(/\D/g, "");
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

router.post("/ga4/select-property", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { propertyId } = req.body || {};

    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });
    if (!propertyId) return res.status(400).json({ ok: false, message: "propertyId is required" });

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "ga4",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      return res.status(404).json({ ok: false, message: "GA4 connection not found" });
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

router.post("/meta_ads/select-account", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { accountId } = req.body || {};

    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });
    if (!accountId) return res.status(400).json({ ok: false, message: "accountId is required" });

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "meta_ads",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      return res.status(404).json({ ok: false, message: "Meta Ads connection not found" });
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
/* CALLBACK ROUTES                  */
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
    const hubId = tokenData?.hub_id
      ? String(tokenData.hub_id)
      : null;

    const scopes = Array.isArray(tokenData?.scopes)
      ? tokenData.scopes
      : [];

    if (!accessToken) {
      throw new Error("HubSpot did not return an access token");
    }

    if (!hubId) {
      throw new Error("HubSpot did not return a hub ID");
    }

    let connection = await IntegrationConnection.findOne({
      orgId,
      provider: "hubspot",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      connection = new IntegrationConnection({
        orgId,
        provider: "hubspot",
      });
    }

    connection.status = "connected";
    connection.mode = "live";
    connection.connectedAt = new Date();
    connection.disconnectedAt = null;

    connection.accessToken = accessToken;

    // Preserve the existing refresh token if HubSpot
    // doesn't return a new one during a reconnect.
    connection.refreshToken =
      refreshToken || connection.refreshToken || null;

    connection.tokenType =
      tokenData?.token_type || "bearer";

    connection.tokenExpiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000)
      : null;

    connection.externalAccountId = hubId;
    connection.externalAccountName =
      `HubSpot Account ${hubId}`;

    connection.scopes = scopes;

    connection.lastSyncAt = new Date();
    connection.lastSyncStatus = "success";
    connection.lastError = null;

    connection.metadata = {
      ...(connection.metadata || {}),
      hubId,
      scopes,
    };

    await connection.save();

    await updateOrgIntegrationSummary(
      orgId,
      "hubspot",
      {
        connected: true,
        connectedAt: new Date(),
        lastSync: new Date(),
        mode: "live",
      }
    );

    return res.redirect(
      `${getFrontendUrl()}/integrations?connected=hubspot&mode=live`
    );
  } catch (err) {
    console.error("HubSpot callback error:", err);

    return res.redirect(
      formatOauthErrorRedirect("hubspot")
    );
  }
});

router.get("/zoho_crm/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code or state");

    let parsedState;
    try {
      parsedState = JSON.parse(state);
    } catch {
      return res.status(400).send("Invalid state");
    }

    const { orgId } = parsedState || {};
    if (!orgId) return res.status(400).send("Missing orgId in state");

    const org = await ensureOrg(orgId);
    if (!org) return res.status(404).send("Workspace not found");

    const tokenData = await exchangeZohoCodeForTokens(code);
    const accessToken = tokenData?.access_token || null;
    const refreshToken = tokenData?.refresh_token || null;
    const expiresIn = Number(tokenData?.expires_in || 0) || 0;

    if (!accessToken) throw new Error("Zoho did not return access token");

    const orgInfo = await getZohoOrgInfo(accessToken);

    let connection = await IntegrationConnection.findOne({
      orgId,
      provider: "zoho_crm",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      connection = new IntegrationConnection({ orgId, provider: "zoho_crm" });
    }

    connection.markConnected({
      mode: "live",
      externalAccountId: orgInfo?.id ? String(orgInfo.id) : null,
      externalAccountName: orgInfo?.company_name || "Zoho CRM",
      accessToken,
      refreshToken,
      tokenType: "Bearer",
      tokenExpiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
      scopes: [
  "ZohoCRM.modules.ALL",
  "ZohoCRM.settings.ALL",
  "ZohoCRM.users.ALL",
  "ZohoCRM.org.READ",
],
      metadata: {
        orgInfo,
      },
    });

    await connection.save();

    await updateOrgIntegrationSummary(orgId, "zoho_crm", {
      connected: true,
      connectedAt: new Date(),
      lastSync: new Date(),
      mode: "live",
    });

    return res.redirect(`${getFrontendUrl()}/integrations?connected=zoho_crm&mode=live`);
  } catch (err) {
    console.error("Zoho CRM callback error:", err);
    return res.redirect(formatOauthErrorRedirect("zoho_crm"));
  }
});

router.get("/pipedrive/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code or state");

    let parsedState;
    try {
      parsedState = JSON.parse(state);
    } catch {
      return res.status(400).send("Invalid state");
    }

    const { orgId } = parsedState || {};
    if (!orgId) return res.status(400).send("Missing orgId in state");

    const org = await ensureOrg(orgId);
    if (!org) return res.status(404).send("Workspace not found");

    const tokenData = await exchangePipedriveCodeForTokens(code);
    const accessToken = tokenData?.access_token || null;
    const refreshToken = tokenData?.refresh_token || null;
    const expiresIn = Number(tokenData?.expires_in || 0) || 0;

    if (!accessToken) throw new Error("Pipedrive did not return access token");

    const me = await getPipedriveUserInfo(accessToken);

    let connection = await IntegrationConnection.findOne({
      orgId,
      provider: "pipedrive",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      connection = new IntegrationConnection({ orgId, provider: "pipedrive" });
    }

    connection.markConnected({
      mode: "live",
      externalAccountId: me?.company_id ? String(me.company_id) : null,
      externalAccountName: me?.name || "Pipedrive",
      accessToken,
      refreshToken,
      tokenType: "Bearer",
      tokenExpiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
      scopes: [],
      metadata: {
        user: me,
      },
    });

    await connection.save();

    await updateOrgIntegrationSummary(orgId, "pipedrive", {
      connected: true,
      connectedAt: new Date(),
      lastSync: new Date(),
      mode: "live",
    });

    return res.redirect(`${getFrontendUrl()}/integrations?connected=pipedrive&mode=live`);
  } catch (err) {
    console.error("Pipedrive callback error:", err);
    return res.redirect(formatOauthErrorRedirect("pipedrive"));
  }
});

router.get("/google_ads/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code or state");

    let parsedState;
    try {
      parsedState = JSON.parse(state);
    } catch {
      return res.status(400).send("Invalid state");
    }

    const { orgId } = parsedState || {};
    if (!orgId) return res.status(400).send("Missing orgId in state");

    const org = await ensureOrg(orgId);
    if (!org) return res.status(404).send("Workspace not found");

    const tokenData = await exchangeGoogleCodeForTokens(code);
    const accessToken = tokenData?.access_token || null;
    const refreshToken = tokenData?.refresh_token || null;
    const expiresIn = Number(tokenData?.expires_in || 0) || 0;
    const scopes = String(tokenData?.scope || "")
      .split(" ")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!accessToken) throw new Error("No access token returned");

    const profile = await getGoogleUserProfile(accessToken);
    const customers = await getGoogleAdsAccessibleCustomers(accessToken);

    if (!customers.length) {
      throw new Error("No accessible Google Ads accounts were found for this Google login");
    }

    const needsSelection = customers.length > 1;
    const selectedCustomer = customers.length === 1 ? customers[0] : null;
    const externalAccountId = selectedCustomer ? selectedCustomer.replace("customers/", "") : null;
    const externalAccountName = externalAccountId ? `Google Ads ${externalAccountId}` : null;

    let connection = await IntegrationConnection.findOne({
      orgId,
      provider: "google_ads",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      connection = new IntegrationConnection({ orgId, provider: "google_ads" });
    }

    connection.status = "connected";
    connection.mode = "live";
    connection.connectedAt = new Date();
    connection.disconnectedAt = null;
    connection.accessToken = accessToken;
    connection.refreshToken = refreshToken;
    connection.tokenType = tokenData?.token_type || null;
    connection.tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
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

    await connection.save();

    await updateOrgIntegrationSummary(orgId, "google_ads", {
      connected: true,
      connectedAt: new Date(),
      lastSync: new Date(),
      mode: "live",
    });

    return res.redirect(
      `${getFrontendUrl()}/integrations?connected=google_ads&mode=live&needsSelection=${needsSelection ? "1" : "0"}`
    );
  } catch (err) {
    console.error("Google Ads callback error:", err);
    return res.redirect(formatOauthErrorRedirect("google_ads"));
  }
});

router.get("/stripe/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code or state");

    let parsedState;
    try {
      parsedState = JSON.parse(state);
    } catch {
      return res.status(400).send("Invalid state");
    }

    const { orgId } = parsedState || {};
    if (!orgId) return res.status(400).send("Missing orgId in state");

    const org = await ensureOrg(orgId);
    if (!org) return res.status(404).send("Workspace not found");

    const tokenData = await exchangeStripeCodeForTokens(code);

    const accessToken = tokenData?.access_token || null;
    const refreshToken = tokenData?.refresh_token || null;
    const stripeUserId = tokenData?.stripe_user_id || null;
    const scope = tokenData?.scope || null;
    const livemode = !!tokenData?.livemode;
    const tokenType = tokenData?.token_type || null;

    if (!stripeUserId) throw new Error("Stripe did not return a connected account id");

    const account = await getStripeAccountInfo(stripeUserId);
    const externalAccountId = stripeUserId;
    const externalAccountName =
      account?.business_profile?.name ||
      account?.settings?.dashboard?.display_name ||
      account?.email ||
      `Stripe Account ${stripeUserId}`;

    let connection = await IntegrationConnection.findOne({
      orgId,
      provider: "stripe",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      connection = new IntegrationConnection({ orgId, provider: "stripe" });
    }

    connection.status = "connected";
    connection.mode = "live";
    connection.connectedAt = new Date();
    connection.disconnectedAt = null;
    connection.accessToken = accessToken;
    connection.refreshToken = refreshToken;
    connection.tokenType = tokenType;
    connection.tokenExpiresAt = null;
    connection.externalAccountId = externalAccountId;
    connection.externalAccountName = externalAccountName;
    connection.scopes = scope ? [scope] : [];
    connection.lastSyncAt = new Date();
    connection.lastSyncStatus = "success";
    connection.lastError = null;
    connection.metadata = {
      ...(connection.metadata || {}),
      stripeUserId,
      scope,
      livemode,
      email: account?.email || null,
      country: account?.country || null,
      businessType: account?.business_type || null,
      chargesEnabled: !!account?.charges_enabled,
      payoutsEnabled: !!account?.payouts_enabled,
    };

    await connection.save();

    await updateOrgIntegrationSummary(orgId, "stripe", {
      connected: true,
      connectedAt: new Date(),
      lastSync: new Date(),
      mode: "live",
    });

    return res.redirect(`${getFrontendUrl()}/integrations?connected=stripe&mode=live`);
  } catch (err) {
    console.error("Stripe callback error:", err);
    return res.redirect(formatOauthErrorRedirect("stripe"));
  }
});

router.get("/ga4/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code or state");

    let parsedState;
    try {
      parsedState = JSON.parse(state);
    } catch {
      return res.status(400).send("Invalid state");
    }

    const { orgId } = parsedState || {};
    if (!orgId) return res.status(400).send("Missing orgId in state");

    const org = await ensureOrg(orgId);
    if (!org) return res.status(404).send("Workspace not found");

    const tokenData = await exchangeGA4CodeForTokens(code);

    const accessToken = tokenData?.access_token || null;
    const refreshToken = tokenData?.refresh_token || null;
    const expiresIn = Number(tokenData?.expires_in || 0) || 0;
    const scopes = String(tokenData?.scope || "")
      .split(" ")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!accessToken) throw new Error("No access token returned");

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
      throw new Error("No accessible GA4 properties were found for this Google login");
    }

    const needsSelection = properties.length > 1;
    const selectedProperty = properties.length === 1 ? properties[0] : null;
    const externalAccountId = selectedProperty?.propertyId || null;
    const externalAccountName = selectedProperty?.property || null;

    let connection = await IntegrationConnection.findOne({
      orgId,
      provider: "ga4",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      connection = new IntegrationConnection({ orgId, provider: "ga4" });
    }

    connection.status = "connected";
    connection.mode = "live";
    connection.connectedAt = new Date();
    connection.disconnectedAt = null;
    connection.accessToken = accessToken;
    connection.refreshToken = refreshToken;
    connection.tokenType = tokenData?.token_type || null;
    connection.tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
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

    await connection.save();

    await updateOrgIntegrationSummary(orgId, "ga4", {
      connected: true,
      connectedAt: new Date(),
      lastSync: new Date(),
      mode: "live",
    });

    return res.redirect(
      `${getFrontendUrl()}/integrations?connected=ga4&mode=live&needsSelection=${needsSelection ? "1" : "0"}`
    );
  } catch (err) {
    console.error("GA4 callback error:", err);
    return res.redirect(formatOauthErrorRedirect("ga4"));
  }
});

router.get("/meta_ads/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code or state");

    let parsedState;
    try {
      parsedState = JSON.parse(state);
    } catch {
      return res.status(400).send("Invalid state");
    }

    const { orgId } = parsedState || {};
    if (!orgId) return res.status(400).send("Missing orgId in state");

    const org = await ensureOrg(orgId);
    if (!org) return res.status(404).send("Workspace not found");

    const tokenData = await exchangeMetaCodeForTokens(code);
    const accessToken = tokenData?.access_token || null;

    if (!accessToken) throw new Error("No Meta access token returned");

    const accounts = await getMetaAdAccounts(accessToken);

    if (!accounts.length) {
      throw new Error("No Meta ad accounts found for this login");
    }

    const needsSelection = accounts.length > 1;
    const selectedAccount = accounts.length === 1 ? accounts[0] : null;

    const externalAccountId = selectedAccount?.id || null;
    const externalAccountName = selectedAccount?.name || null;

    let connection = await IntegrationConnection.findOne({
      orgId,
      provider: "meta_ads",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      connection = new IntegrationConnection({ orgId, provider: "meta_ads" });
    }

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

    await connection.save();

    await updateOrgIntegrationSummary(orgId, "meta_ads", {
      connected: true,
      connectedAt: new Date(),
      lastSync: new Date(),
      mode: "live",
    });

    return res.redirect(
      `${getFrontendUrl()}/integrations?connected=meta_ads&mode=live&needsSelection=${needsSelection ? "1" : "0"}`
    );
  } catch (err) {
    console.error("Meta Ads callback error:", err);
    return res.redirect(formatOauthErrorRedirect("meta_ads"));
  }
});

router.get("/shopify/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code || !state) {
      return res.status(400).send("Missing code or state");
    }

    let parsedState;
    try {
      parsedState = JSON.parse(state);
    } catch {
      return res.status(400).send("Invalid state");
    }

    const { orgId, shopDomain } = parsedState || {};

    if (!orgId || !shopDomain) {
      return res.status(400).send("Missing orgId or shopDomain in state");
    }

    const org = await ensureOrg(orgId);
    if (!org) {
      return res.status(404).send("Workspace not found");
    }

    const tokenData = await exchangeShopifyCodeForToken({
      code,
      shopDomain,
    });

    const accessToken = tokenData?.access_token || null;
    const scopes = String(tokenData?.scope || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!accessToken) {
      throw new Error("Shopify did not return an access token");
    }

    const shop = await getShopifyShopInfo({
      shopDomain,
      accessToken,
    });

    let connection = await IntegrationConnection.findOne({
      orgId,
      provider: "shopify",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      connection = new IntegrationConnection({ orgId, provider: "shopify" });
    }

    connection.status = "connected";
    connection.mode = "live";
    connection.connectedAt = new Date();
    connection.disconnectedAt = null;
    connection.accessToken = accessToken;
    connection.refreshToken = null;
    connection.tokenType = "bearer";
    connection.tokenExpiresAt = null;
    connection.externalAccountId = shop?.id ? String(shop.id) : shopDomain;
    connection.externalAccountName = shop?.name || shopDomain;
    connection.scopes = scopes;
    connection.lastSyncAt = new Date();
    connection.lastSyncStatus = "success";
    connection.lastError = null;
    connection.metadata = {
      ...(connection.metadata || {}),
      shopDomain,
      shopName: shop?.name || null,
      shopEmail: shop?.email || null,
      currency: shop?.currency || null,
      planName: shop?.plan_name || null,
    };

    await connection.save();

    await updateOrgIntegrationSummary(orgId, "shopify", {
      connected: true,
      connectedAt: new Date(),
      lastSync: new Date(),
      mode: "live",
    });

    return res.redirect(`${getFrontendUrl()}/integrations?connected=shopify&mode=live`);
  } catch (err) {
    console.error("Shopify callback error:", err);
    return res.redirect(formatOauthErrorRedirect("shopify"));
  }
});

router.get("/salesforce/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

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

    const tokenData = await exchangeSalesforceCodeForTokens(code);

    const accessToken = tokenData?.access_token || null;
    const refreshToken = tokenData?.refresh_token || null;
    const instanceUrl = normalizeSalesforceInstanceUrl(tokenData?.instance_url || "");
    const identityUrl = tokenData?.id || null;
    const tokenType = tokenData?.token_type || "Bearer";

    if (!accessToken || !instanceUrl) {
      throw new Error("Salesforce did not return the required tokens");
    }

    let identity = null;
    if (identityUrl) {
      identity = await getSalesforceIdentity(identityUrl, accessToken);
    }

    let connection = await IntegrationConnection.findOne({
      orgId,
      provider: "salesforce",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      connection = new IntegrationConnection({ orgId, provider: "salesforce" });
    }

    connection.status = "connected";
    connection.mode = "live";
    connection.connectedAt = new Date();
    connection.disconnectedAt = null;
    connection.accessToken = accessToken;
    connection.refreshToken = refreshToken;
    connection.tokenType = tokenType;
    connection.refreshToken =
      refreshToken || connection.refreshToken || null;
    connection.externalAccountId = identity?.organization_id || instanceUrl;
    connection.externalAccountName = identity?.organization_id || "Salesforce";
    connection.scopes = [];
    connection.lastSyncAt = new Date();
    connection.lastSyncStatus = "success";
    connection.lastError = null;
    connection.metadata = {
      ...(connection.metadata || {}),
      instanceUrl,
      identityUrl,
      salesforceOrgId: identity?.organization_id || null,
      username: identity?.username || null,
      displayName: identity?.display_name || null,
      email: identity?.email || null,
    };

    await connection.save();

    await updateOrgIntegrationSummary(orgId, "salesforce", {
      connected: true,
      connectedAt: new Date(),
      lastSync: new Date(),
      mode: "live",
    });

    return res.redirect(`${getFrontendUrl()}/integrations?connected=salesforce&mode=live`);
  } catch (err) {
    console.error("Salesforce callback error:", err);
    return res.redirect(formatOauthErrorRedirect("salesforce"));
  }
});

router.get("/linkedin_ads/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

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

    const tokenData = await exchangeLinkedInCodeForTokens(code);

    const accessToken = tokenData?.access_token || null;
    const expiresIn = Number(tokenData?.expires_in || 0) || 0;

    if (!accessToken) {
      throw new Error("LinkedIn did not return an access token");
    }

    const profile = await getLinkedInProfile(accessToken);

    let connection = await IntegrationConnection.findOne({
      orgId,
      provider: "linkedin_ads",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      connection = new IntegrationConnection({ orgId, provider: "linkedin_ads" });
    }

    connection.status = "connected";
    connection.mode = "live";
    connection.connectedAt = new Date();
    connection.disconnectedAt = null;
    connection.accessToken = accessToken;
    connection.refreshToken = null;
    connection.tokenType = "Bearer";
    connection.tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
    connection.externalAccountId = profile?.sub || null;
    connection.externalAccountName = profile?.name || profile?.email || "LinkedIn";
    connection.scopes = ["openid", "profile", "email", "r_ads", "r_ads_reporting"];
    connection.lastSyncAt = new Date();
    connection.lastSyncStatus = "success";
    connection.lastError = null;
    connection.metadata = {
      ...(connection.metadata || {}),
      email: profile?.email || null,
      name: profile?.name || null,
      sub: profile?.sub || null,
    };

    await connection.save();

    await updateOrgIntegrationSummary(orgId, "linkedin_ads", {
      connected: true,
      connectedAt: new Date(),
      lastSync: new Date(),
      mode: "live",
    });

    return res.redirect(`${getFrontendUrl()}/integrations?connected=linkedin_ads&mode=live`);
  } catch (err) {
    console.error("LinkedIn Ads callback error:", err);
    return res.redirect(formatOauthErrorRedirect("linkedin_ads"));
  }
});

/* -------------------------------- */
/* MANUAL SYNC ROUTES               */
/* -------------------------------- */

router.post(
  "/hubspot/sync",
  requireAuth,
  async (req, res) => {
    let connection = null;

    try {
      const orgId = getOrgId(req);

      if (!orgId) {
        return res.status(400).json({
          ok: false,
          message: "Missing org context",
        });
      }

      connection =
        await IntegrationConnection.findOne({
          orgId,
          provider: "hubspot",
          status: "connected",
        }).select("+accessToken +refreshToken");

      if (!connection) {
        return res.status(404).json({
          ok: false,
          message:
            "HubSpot is not connected for this workspace",
        });
      }

      if (
        !connection.accessToken &&
        !connection.refreshToken
      ) {
        return res.status(401).json({
          ok: false,
          message:
            "HubSpot connection does not have valid OAuth credentials",
        });
      }

      /*
       * Pull companies, deals and deal pipeline metadata.
       */
      /*
 * Refresh/validate the HubSpot token once before
 * starting the CRM requests.
 *
 * Run these sequentially so multiple requests do not
 * try to save the same IntegrationConnection document
 * at the same time during token refresh.
 */
await ensureHubSpotAccessToken(connection);

const hubSpotCompanies =
  await hubSpotGetAllObjects(
    connection,
    "companies",
    [
      "name",
      "domain",
      "website",
      "industry",
      "phone",
      "city",
      "state",
      "country",
      "annualrevenue",
      "numberofemployees",
      "lifecyclestage",
      "hs_lastmodifieddate",
    ]
  );

const hubSpotDeals =
  await hubSpotGetAllObjects(
    connection,
    "deals",
    [
      "dealname",
      "amount",
      "dealstage",
      "pipeline",
      "closedate",
      "createdate",
      "hs_lastmodifieddate",
    ],
    ["companies"]
  );

const hubSpotPipelines =
  await hubSpotGetDealPipelines(
    connection
  );

      const stageMap =
        buildHubSpotStageMap(
          hubSpotPipelines
        );

      /*
       * Maps HubSpot company ID -> Atlas Client.
       * Deals must reference Client._id.
       */
      const clientMap = new Map();

      let companiesFetched =
        hubSpotCompanies.length;

      let clientsUpserted = 0;
      let accountsUpserted = 0;
      let dealsFetched =
        hubSpotDeals.length;
      let dealsUpserted = 0;
      let unassignedDeals = 0;

      /*
       * --------------------------------
       * HUBSPOT COMPANIES
       * --------------------------------
       */
      for (const company of hubSpotCompanies) {
        const externalId = company?.id
          ? String(company.id)
          : "";

        if (!externalId) continue;

        const properties =
          company?.properties || {};

        const companyName =
          String(
            properties?.name || ""
          ).trim() ||
          `HubSpot Company ${externalId}`;

        const domain =
          normalizeHubSpotDomain(
            properties?.domain
          );

        const website =
          String(
            properties?.website || ""
          ).trim() ||
          (domain
            ? `https://${domain}`
            : "");

        /*
         * Client is the canonical company reference
         * required by Deal.clientId.
         */
        const atlasClient =
          await Client.findOneAndUpdate(
            {
              orgId,
              externalSource: "hubspot",
              externalId,
            },
            {
              $set: {
                orgId,
                workspaceId: orgId,
                name: companyName,
                website,
                domain,
                industry:
                  properties?.industry ||
                  "",
                primaryContactPhone:
                  properties?.phone ||
                  "",
                status: "active",
                archivedAt: null,
                externalSource:
                  "hubspot",
                externalId,
                sourcePayload:
                  company,
              },
            },
            {
              upsert: true,
              new: true,
              setDefaultsOnInsert: true,
              runValidators: true,
            }
          );

        clientMap.set(
          externalId,
          atlasClient
        );

        clientsUpserted += 1;

        /*
         * Account powers Atlas account-level
         * intelligence and account views.
         *
         * Account has a unique orgId + name index,
         * so first try HubSpot identity, then safely
         * reuse a same-name account if one already
         * exists in the workspace.
         */
        let atlasAccount =
          await Account.findOne({
            orgId,
            externalSource:
              "hubspot",
            externalId,
          });

        if (!atlasAccount) {
          atlasAccount =
            await Account.findOne({
              orgId,
              name: companyName,
            });
        }

        if (!atlasAccount) {
          atlasAccount = new Account({
            orgId,
            workspaceId: orgId,
            name: companyName,
            website,
            domain,
            industry:
              properties?.industry ||
              "",
            phone:
              properties?.phone ||
              "",
            status: "Active",
            archivedAt: null,
            externalSource:
              "hubspot",
            externalId,
            sourcePayload: company,
          });
        } else {
          atlasAccount.workspaceId =
            atlasAccount.workspaceId ||
            orgId;

          atlasAccount.name =
            companyName;

          atlasAccount.website =
            website;

          atlasAccount.domain =
            domain;

          atlasAccount.industry =
            properties?.industry ||
            "";

          atlasAccount.phone =
            properties?.phone ||
            "";

          atlasAccount.status =
            "Active";

          atlasAccount.archivedAt =
            null;

          /*
           * Only claim the external identity
           * if this account is not already owned
           * by another provider.
           */
          if (
            !atlasAccount.externalSource ||
            atlasAccount.externalSource ===
              "hubspot"
          ) {
            atlasAccount.externalSource =
              "hubspot";

            atlasAccount.externalId =
              externalId;
          }

          atlasAccount.sourcePayload =
            company;
        }

        await atlasAccount.save();

        accountsUpserted += 1;
      }

      /*
       * Some HubSpot deals may not be associated
       * with a company.
       *
       * Deal.clientId is required in Atlas, so use
       * one explicit "HubSpot Unassigned" Client
       * instead of dropping those deals.
       */
      let unassignedClient = null;

      async function getUnassignedClient() {
        if (unassignedClient) {
          return unassignedClient;
        }

        unassignedClient =
          await Client.findOneAndUpdate(
            {
              orgId,
              externalSource:
                "hubspot",
              externalId:
                "__unassigned__",
            },
            {
              $set: {
                orgId,
                workspaceId: orgId,
                name:
                  "HubSpot Unassigned",
                status: "prospect",
                externalSource:
                  "hubspot",
                externalId:
                  "__unassigned__",
                notes:
                  "HubSpot deals that do not currently have an associated company.",
              },
            },
            {
              upsert: true,
              new: true,
              setDefaultsOnInsert: true,
              runValidators: true,
            }
          );

        return unassignedClient;
      }

      /*
       * --------------------------------
       * HUBSPOT DEALS
       * --------------------------------
       */
      for (const deal of hubSpotDeals) {
        const externalId = deal?.id
          ? String(deal.id)
          : "";

        if (!externalId) continue;

        const properties =
          deal?.properties || {};

        const associatedCompanies =
          deal?.associations
            ?.companies?.results;

        const associatedCompanyId =
          Array.isArray(
            associatedCompanies
          ) &&
          associatedCompanies.length
            ? String(
                associatedCompanies[0]
                  ?.id || ""
              )
            : "";

        let atlasClient =
          associatedCompanyId
            ? clientMap.get(
                associatedCompanyId
              )
            : null;

        /*
         * Association may reference a company
         * we did not have in the in-memory map.
         */
        if (
          !atlasClient &&
          associatedCompanyId
        ) {
          atlasClient =
            await Client.findOne({
              orgId,
              externalSource:
                "hubspot",
              externalId:
                associatedCompanyId,
            });
        }

        if (!atlasClient) {
          atlasClient =
            await getUnassignedClient();

          unassignedDeals += 1;
        }

        const dealName =
          String(
            properties?.dealname ||
              ""
          ).trim() ||
          `HubSpot Deal ${externalId}`;

        const rawStage =
          properties?.dealstage ||
          "";

        const normalizedStage =
          normalizeHubSpotStage(
            rawStage,
            stageMap
          );

        const probability =
          getHubSpotDealProbability(
            rawStage,
            stageMap,
            normalizedStage
          );

        const closeDate =
          safeHubSpotDate(
            properties?.closedate
          );

        const isClosed =
          normalizedStage ===
            "Closed Won" ||
          normalizedStage ===
            "Closed Lost";

        await Deal.findOneAndUpdate(
          {
            orgId,
            externalSource:
              "hubspot",
            externalId,
          },
          {
            $set: {
              orgId,
              workspaceId: orgId,
              clientId:
                atlasClient._id,
              name: dealName,
              amount:
                safeHubSpotNumber(
                  properties?.amount
                ),
              stage:
                normalizedStage,
              probability,
              closeDate,
              closedAt: isClosed
                ? closeDate ||
                  safeHubSpotDate(
                    properties?.hs_lastmodifieddate
                  ) ||
                  new Date()
                : null,
              archivedAt: null,
              externalSource:
                "hubspot",
              externalId,
              sourcePayload:
                deal,
            },
          },
          {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
            runValidators: true,
          }
        );

        dealsUpserted += 1;
      }

      const syncedAt = new Date();

      connection.status =
        "connected";

      connection.mode =
        "live";

      connection.lastSyncAt =
        syncedAt;

      connection.lastSyncStatus =
        "success";

      connection.lastError =
        null;

      connection.syncCursor =
        syncedAt.toISOString();

      connection.metadata = {
        ...(connection.metadata || {}),

        lastHubSpotSync: {
          companiesFetched,
          clientsUpserted,
          accountsUpserted,
          dealsFetched,
          dealsUpserted,
          unassignedDeals,
          pipelinesFetched:
            hubSpotPipelines.length,
          syncedAt,
        },
      };

      await connection.save();

      await updateOrgIntegrationSummary(
        orgId,
        "hubspot",
        {
          connected: true,
          lastSync: syncedAt,
          mode: "live",
        }
      );

      return res.json({
        ok: true,
        message:
          "HubSpot sync completed",
        provider: "hubspot",
        mode: "live",

        sync: {
          companiesFetched,
          clientsUpserted,
          accountsUpserted,
          dealsFetched,
          dealsUpserted,
          unassignedDeals,
          pipelinesFetched:
            hubSpotPipelines.length,
          syncedAt,
        },
      });
    } catch (err) {
      console.error(
        "HubSpot sync error:",
        err
      );

      /*
       * Record the failed sync so Atlas does not
       * incorrectly continue showing success.
       */
      if (connection) {
        try {
          connection.lastSyncAt =
            new Date();

          connection.lastSyncStatus =
            "error";

          connection.lastError =
            String(
              err?.message ||
                "HubSpot sync failed"
            );

          await connection.save();
        } catch (saveErr) {
          console.error(
            "Failed to record HubSpot sync error:",
            saveErr
          );
        }
      }

      return res.status(500).json({
        ok: false,
        message:
          "Failed to sync HubSpot",
        error:
          err?.message ||
          "Unknown HubSpot sync error",
      });
    }
  }
);

router.post("/zoho_crm/sync", requireAuth, async (req, res) => {
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
      provider: "zoho_crm",
      status: "connected",
    }).select("+accessToken +refreshToken");

    if (!connection || !connection.accessToken) {
      return res.status(404).json({
        ok: false,
        message: "Zoho CRM is not connected for this workspace",
      });
    }

    const accessToken = connection.accessToken;

    async function zohoGetAll(moduleName) {
      let page = 1;
      let more = true;
      const allRecords = [];

      while (more) {
        const response = await fetch(
          `https://www.zohoapis.com/crm/v8/${moduleName}?page=${page}&per_page=200`,
          {
            method: "GET",
            headers: {
              Authorization: `Zoho-oauthtoken ${accessToken}`,
            },
          }
        );

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(
            data?.message || `Failed to fetch Zoho ${moduleName}`
          );
        }

        const rows = Array.isArray(data?.data) ? data.data : [];
        allRecords.push(...rows);

        const info = data?.info || {};
        more = !!info.more_records;
        page += 1;
      }

      return allRecords;
    }

    const [zohoAccounts, zohoDeals] = await Promise.all([
      zohoGetAll("Accounts"),
      zohoGetAll("Deals"),
    ]);

    let accountsUpserted = 0;
    let dealsUpserted = 0;

    for (const acc of zohoAccounts) {
      const zohoAccountId = acc?.id ? String(acc.id) : null;
      const name = acc?.Account_Name || acc?.name || "Unnamed Account";

      if (!zohoAccountId || !name) continue;

      await Account.findOneAndUpdate(
        {
          orgId,
          externalSource: "zoho_crm",
          externalId: zohoAccountId,
        },
        {
          $set: {
            orgId,
            name,
            website: acc?.Website || "",
            industry: acc?.Industry || "",
            phone: acc?.Phone || "",
            status: "Active",
            externalSource: "zoho_crm",
            externalId: zohoAccountId,
            sourcePayload: acc,
          },
        },
        {
          upsert: true,
          new: true,
        }
      );

      accountsUpserted += 1;
    }

    for (const deal of zohoDeals) {
      const zohoDealId = deal?.id ? String(deal.id) : null;
      const dealName = deal?.Deal_Name || deal?.name || "Unnamed Deal";

      if (!zohoDealId || !dealName) continue;

      const accountRef =
        deal?.Account_Name?.id ? String(deal.Account_Name.id) : null;

      let matchedAccount = null;

      if (accountRef) {
        matchedAccount = await Account.findOne({
          orgId,
          externalSource: "zoho_crm",
          externalId: accountRef,
        });
      }

      const rawStage = String(deal?.Stage || "").toLowerCase();

      let normalizedStage = "Discovery";
      if (rawStage.includes("proposal")) normalizedStage = "Proposal";
      else if (rawStage.includes("negotiation")) normalizedStage = "Negotiation";
      else if (rawStage.includes("closed won")) normalizedStage = "Closed Won";
      else if (rawStage.includes("closed lost")) normalizedStage = "Closed Lost";
      else if (rawStage.includes("follow")) normalizedStage = "Follow-Up";

      await Deal.findOneAndUpdate(
        {
          orgId,
          externalSource: "zoho_crm",
          externalId: zohoDealId,
        },
        {
          $set: {
            orgId,
            name: dealName,
            clientId: matchedAccount?._id || null,
            amount: Number(deal?.Amount || 0),
            stage: normalizedStage,
            closeDate: deal?.Closing_Date || null,
            externalSource: "zoho_crm",
            externalId: zohoDealId,
            sourcePayload: deal,
          },
        },
        {
          upsert: true,
          new: true,
        }
      );

      dealsUpserted += 1;
    }

    connection.lastSyncAt = new Date();
    connection.lastSyncStatus = "success";
    connection.lastError = null;
    await connection.save();

    await updateOrgIntegrationSummary(orgId, "zoho_crm", {
      connected: true,
      lastSync: new Date(),
      mode: "live",
    });

    return res.json({
      ok: true,
      message: "Zoho CRM sync completed",
      provider: "zoho_crm",
      mode: "live",
      summary: {
        accountsFetched: zohoAccounts.length,
        dealsFetched: zohoDeals.length,
        accountsUpserted,
        dealsUpserted,
      },
    });
  } catch (err) {
    console.error("Zoho CRM sync error:", err);

    return res.status(500).json({
      ok: false,
      message: "Failed to sync Zoho CRM",
      error: err.message,
    });
  }
});

router.post("/pipedrive/sync", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "pipedrive",
      status: "connected",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      return res.status(404).json({
        ok: false,
        message: "Pipedrive is not connected for this workspace",
      });
    }

    connection.markSyncSuccess();
    await connection.save();

    await updateOrgIntegrationSummary(orgId, "pipedrive", {
      connected: true,
      lastSync: new Date(),
      mode: "live",
    });

    return res.json({
      ok: true,
      message: "Pipedrive sync completed",
      provider: "pipedrive",
      mode: "live",
    });
  } catch (err) {
    console.error("Pipedrive sync error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to sync Pipedrive",
      error: err.message,
    });
  }
});

router.post("/bitrix24/sync", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "bitrix24",
      status: "connected",
    });

    if (!connection) {
      return res.status(404).json({
        ok: false,
        message: "Bitrix24 is not connected for this workspace",
      });
    }

    connection.markSyncSuccess();
    await connection.save();

    await updateOrgIntegrationSummary(orgId, "bitrix24", {
      connected: true,
      lastSync: new Date(),
      mode: "live",
    });

    return res.json({
      ok: true,
      message: "Bitrix24 sync completed",
      provider: "bitrix24",
      mode: "live",
    });
  } catch (err) {
    console.error("Bitrix24 sync error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to sync Bitrix24",
      error: err.message,
    });
  }
});

router.post("/stripe/sync", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);

    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context",
      });
    }

    const result = await syncStripeForOrg(orgId);

    await updateOrgIntegrationSummary(orgId, "stripe", {
      connected: true,
      connectedAt: new Date(),
      lastSync: new Date(),
      mode: "live",
    });

    return res.json({
      ok: true,
      message: "Stripe sync completed",
      provider: "stripe",
      mode: "live",
      summary: result,
    });
  } catch (err) {
    console.error("Stripe sync error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to sync Stripe",
      error: err.message,
    });
  }
});

router.post("/shopify/sync", requireAuth, async (req, res) => {
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
      provider: "shopify",
      status: "connected",
    }).select("+accessToken");

    if (!connection || !connection.accessToken) {
      return res.status(404).json({
        ok: false,
        message: "Shopify is not connected for this workspace",
      });
    }

    const shopDomain =
      connection?.metadata?.shopDomain || connection?.externalAccountName || "";

    if (!shopDomain) {
      return res.status(400).json({
        ok: false,
        message: "Missing Shopify shop domain on this connection",
      });
    }

    const accessToken = connection.accessToken;
    const cleanDomain = String(shopDomain)
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "");

    async function shopifyGet(path, query = {}) {
      const qs = new URLSearchParams(query).toString();
      const url = `https://${cleanDomain}/admin/api/2024-10/${path}${qs ? `?${qs}` : ""}`;

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data?.errors ||
            data?.error ||
            `Failed Shopify request for ${path}`
        );
      }

      return data;
    }

    const [ordersRes, customersRes, productsRes] = await Promise.all([
      shopifyGet("orders.json", {
        status: "any",
        limit: "250",
      }),
      shopifyGet("customers.json", {
        limit: "250",
      }),
      shopifyGet("products.json", {
        limit: "250",
      }),
    ]);

    const orders = Array.isArray(ordersRes?.orders) ? ordersRes.orders : [];
    const customers = Array.isArray(customersRes?.customers)
      ? customersRes.customers
      : [];
    const products = Array.isArray(productsRes?.products)
      ? productsRes.products
      : [];

    let accountsUpserted = 0;
    let dealsUpserted = 0;

    for (const customer of customers) {
      const shopifyCustomerId =
        customer?.id != null ? String(customer.id) : null;

      if (!shopifyCustomerId) continue;

      const firstName = String(customer?.first_name || "").trim();
      const lastName = String(customer?.last_name || "").trim();
      const fullName = `${firstName} ${lastName}`.trim();
      const email = String(customer?.email || "").trim();
      const phone = String(customer?.phone || "").trim();

      const name =
        fullName ||
        email ||
        phone ||
        `Shopify Customer ${shopifyCustomerId}`;

      await Account.findOneAndUpdate(
        {
          orgId,
          externalSource: "shopify",
          externalId: shopifyCustomerId,
        },
        {
          $set: {
            orgId,
            name,
            website: "",
            industry: "",
            phone,
            status: "Active",
            externalSource: "shopify",
            externalId: shopifyCustomerId,
            sourcePayload: customer,
          },
        },
        {
          upsert: true,
          new: true,
        }
      );

      accountsUpserted += 1;
    }

    for (const order of orders) {
      const shopifyOrderId = order?.id != null ? String(order.id) : null;
      if (!shopifyOrderId) continue;

      const customerId =
        order?.customer?.id != null ? String(order.customer.id) : null;

      let matchedAccount = null;
      if (customerId) {
        matchedAccount = await Account.findOne({
          orgId,
          externalSource: "shopify",
          externalId: customerId,
        });
      }

      const financialStatus = String(order?.financial_status || "").toLowerCase();
      const fulfillmentStatus = String(order?.fulfillment_status || "").toLowerCase();
      const cancelledAt = order?.cancelled_at || null;

      let normalizedStage = "Discovery";
      if (cancelledAt || financialStatus === "voided" || financialStatus === "refunded") {
        normalizedStage = "Closed Lost";
      } else if (
        financialStatus === "paid" ||
        fulfillmentStatus === "fulfilled" ||
        fulfillmentStatus === "partial"
      ) {
        normalizedStage = "Closed Won";
      } else if (
        financialStatus === "pending" ||
        financialStatus === "authorized"
      ) {
        normalizedStage = "Negotiation";
      }

      const orderName =
        order?.name ||
        order?.order_number != null
          ? `Order ${order.name || `#${order.order_number}`}`
          : `Shopify Order ${shopifyOrderId}`;

      await Deal.findOneAndUpdate(
        {
          orgId,
          externalSource: "shopify",
          externalId: shopifyOrderId,
        },
        {
          $set: {
            orgId,
            name: orderName,
            clientId: matchedAccount?._id || null,
            amount: Number(order?.current_total_price || order?.total_price || 0),
            stage: normalizedStage,
            closeDate: order?.processed_at || order?.created_at || null,
            externalSource: "shopify",
            externalId: shopifyOrderId,
            sourcePayload: order,
          },
        },
        {
          upsert: true,
          new: true,
        }
      );

      dealsUpserted += 1;
    }

    connection.lastSyncAt = new Date();
    connection.lastSyncStatus = "success";
    connection.lastError = null;
    connection.metadata = {
      ...(connection.metadata || {}),
      ordersCount: orders.length,
      customersCount: customers.length,
      productsCount: products.length,
      lastOrdersSample: orders.slice(0, 5).map((o) => ({
        id: o?.id || null,
        name: o?.name || null,
        total: o?.current_total_price || o?.total_price || null,
      })),
      syncedAt: new Date(),
    };

    await connection.save();

    await updateOrgIntegrationSummary(orgId, "shopify", {
      connected: true,
      lastSync: new Date(),
      mode: "live",
    });

    return res.json({
      ok: true,
      message: "Shopify sync completed",
      provider: "shopify",
      mode: "live",
      summary: {
        customersFetched: customers.length,
        ordersFetched: orders.length,
        productsFetched: products.length,
        accountsUpserted,
        dealsUpserted,
      },
    });
  } catch (err) {
    console.error("Shopify sync error:", err);

    return res.status(500).json({
      ok: false,
      message: "Failed to sync Shopify",
      error: err.message,
    });
  }
});

router.post("/salesforce/sync", requireAuth, async (req, res) => {
  let connection = null;

  try {
    const orgId = getOrgId(req);

    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context",
      });
    }

    connection = await IntegrationConnection.findOne({
      orgId,
      provider: "salesforce",
      status: "connected",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      return res.status(404).json({
        ok: false,
        message: "Salesforce is not connected for this workspace",
      });
    }

    if (!connection.accessToken) {
      return res.status(401).json({
        ok: false,
        message:
          "Salesforce access token is missing. Please reconnect Salesforce.",
      });
    }

    let accessToken = connection.accessToken;

    let instanceUrl = normalizeSalesforceInstanceUrl(
      connection?.metadata?.instanceUrl || ""
    );

    if (!instanceUrl) {
      return res.status(400).json({
        ok: false,
        message:
          "Salesforce instance URL is missing. Please reconnect Salesforce.",
      });
    }

    const accountQuery = [
      "SELECT",
      "Id,",
      "Name,",
      "Website,",
      "Industry,",
      "Phone,",
      "Type,",
      "BillingCity,",
      "BillingState,",
      "BillingCountry,",
      "AnnualRevenue,",
      "NumberOfEmployees,",
      "OwnerId,",
      "CreatedDate,",
      "LastModifiedDate",
      "FROM Account",
      "ORDER BY LastModifiedDate DESC",
    ].join(" ");

    const opportunityQuery = [
      "SELECT",
      "Id,",
      "Name,",
      "AccountId,",
      "Amount,",
      "StageName,",
      "Probability,",
      "CloseDate,",
      "IsClosed,",
      "IsWon,",
      "Type,",
      "LeadSource,",
      "ForecastCategoryName,",
      "NextStep,",
      "OwnerId,",
      "CreatedDate,",
      "LastModifiedDate",
      "FROM Opportunity",
      "ORDER BY LastModifiedDate DESC",
    ].join(" ");

    async function fetchSalesforceRecords() {
      return Promise.all([
        salesforceQueryAll({
          instanceUrl,
          accessToken,
          soql: accountQuery,
        }),
        salesforceQueryAll({
          instanceUrl,
          accessToken,
          soql: opportunityQuery,
        }),
      ]);
    }

    let salesforceAccounts;
    let salesforceOpportunities;

    try {
      [salesforceAccounts, salesforceOpportunities] =
        await fetchSalesforceRecords();
    } catch (queryError) {
      const authorizationExpired =
        queryError?.status === 401 ||
        String(queryError?.message || "")
          .toLowerCase()
          .includes("session expired");

      if (!authorizationExpired || !connection.refreshToken) {
        throw queryError;
      }

      const refreshedTokenData =
        await refreshSalesforceAccessToken(
          connection.refreshToken
        );

      accessToken = refreshedTokenData.access_token;

      if (refreshedTokenData.instance_url) {
        instanceUrl = normalizeSalesforceInstanceUrl(
          refreshedTokenData.instance_url
        );
      }

      connection.accessToken = accessToken;
      connection.tokenType =
        refreshedTokenData.token_type ||
        connection.tokenType ||
        "Bearer";

      connection.metadata = {
        ...(connection.metadata || {}),
        instanceUrl,
        tokenRefreshedAt: new Date(),
      };

      await connection.save();

      [salesforceAccounts, salesforceOpportunities] =
        await fetchSalesforceRecords();
    }

    const accountMap = new Map();

    let accountsUpserted = 0;
    let opportunitiesUpserted = 0;

    for (const salesforceAccount of salesforceAccounts) {
      const externalId = salesforceAccount?.Id
        ? String(salesforceAccount.Id)
        : null;

      if (!externalId) continue;

      const accountName =
        String(salesforceAccount?.Name || "").trim() ||
        "Unnamed Salesforce Account";

      const atlasAccount = await Account.findOneAndUpdate(
        {
          orgId,
          externalSource: "salesforce",
          externalId,
        },
        {
          $set: {
            orgId,
            name: accountName,
            website: salesforceAccount?.Website || "",
            industry: salesforceAccount?.Industry || "",
            phone: salesforceAccount?.Phone || "",
            status: "Active",
            externalSource: "salesforce",
            externalId,
            sourcePayload: salesforceAccount,
          },
        },
        {
          upsert: true,
          new: true,
        }
      );

      accountMap.set(externalId, atlasAccount);
      accountsUpserted += 1;
    }

    function normalizeSalesforceStage(opportunity) {
      if (opportunity?.IsWon === true) {
        return "Closed Won";
      }

      if (opportunity?.IsClosed === true) {
        return "Closed Lost";
      }

      const rawStage = String(
        opportunity?.StageName || ""
      ).toLowerCase();

      if (
        rawStage.includes("proposal") ||
        rawStage.includes("quote") ||
        rawStage.includes("value proposition")
      ) {
        return "Proposal";
      }

      if (
        rawStage.includes("negotiation") ||
        rawStage.includes("review")
      ) {
        return "Negotiation";
      }

      if (
        rawStage.includes("follow") ||
        rawStage.includes("nurture")
      ) {
        return "Follow-Up";
      }

      return "Discovery";
    }

    for (const opportunity of salesforceOpportunities) {
      const externalId = opportunity?.Id
        ? String(opportunity.Id)
        : null;

      if (!externalId) continue;

      const accountExternalId = opportunity?.AccountId
        ? String(opportunity.AccountId)
        : null;

      let matchedAccount = accountExternalId
        ? accountMap.get(accountExternalId)
        : null;

      if (!matchedAccount && accountExternalId) {
        matchedAccount = await Account.findOne({
          orgId,
          externalSource: "salesforce",
          externalId: accountExternalId,
        });
      }

      const opportunityName =
        String(opportunity?.Name || "").trim() ||
        "Unnamed Salesforce Opportunity";

      await Deal.findOneAndUpdate(
        {
          orgId,
          externalSource: "salesforce",
          externalId,
        },
        {
          $set: {
            orgId,
            name: opportunityName,
            clientId: matchedAccount?._id || null,
            amount: Number(opportunity?.Amount || 0),
            stage: normalizeSalesforceStage(opportunity),
            closeDate: opportunity?.CloseDate || null,
            externalSource: "salesforce",
            externalId,
            sourcePayload: opportunity,
          },
        },
        {
          upsert: true,
          new: true,
        }
      );

      opportunitiesUpserted += 1;
    }

    const syncedAt = new Date();

    connection.status = "connected";
    connection.mode = "live";
    connection.lastSyncAt = syncedAt;
    connection.lastSyncStatus = "success";
    connection.lastError = null;
    connection.syncCursor = syncedAt.toISOString();

    connection.metadata = {
      ...(connection.metadata || {}),
      instanceUrl,
      lastSalesforceSync: {
        accountsFetched: salesforceAccounts.length,
        opportunitiesFetched:
          salesforceOpportunities.length,
        accountsUpserted,
        opportunitiesUpserted,
        syncedAt,
      },
    };

    await connection.save();

    await updateOrgIntegrationSummary(
      orgId,
      "salesforce",
      {
        connected: true,
        lastSync: syncedAt,
        mode: "live",
      }
    );

    return res.json({
      ok: true,
      message: "Salesforce sync completed",
      provider: "salesforce",
      mode: "live",
      summary: {
        accountsFetched: salesforceAccounts.length,
        opportunitiesFetched:
          salesforceOpportunities.length,
        accountsUpserted,
        opportunitiesUpserted,
      },
    });
  } catch (err) {
    console.error(
      "Salesforce sync error:",
      err?.salesforceResponse || err
    );

    if (connection) {
      connection.lastSyncAt = new Date();
      connection.lastSyncStatus = "failed";
      connection.lastError =
        err?.message || "Salesforce sync failed";

      await connection.save().catch((saveError) => {
        console.error(
          "Failed to save Salesforce sync error:",
          saveError
        );
      });
    }

    const authorizationError =
      err?.status === 401 ||
      String(err?.message || "")
        .toLowerCase()
        .includes("session expired");

    return res
      .status(authorizationError ? 401 : 500)
      .json({
        ok: false,
        message: authorizationError
          ? "Salesforce authorization expired. Please reconnect Salesforce."
          : "Failed to sync Salesforce",
        error: err.message,
      });
  }
});

router.post("/linkedin_ads/sync", requireAuth, async (req, res) => {
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
      provider: "linkedin_ads",
      status: "connected",
    }).select("+accessToken +refreshToken");

    if (!connection || !connection.accessToken) {
      return res.status(404).json({
        ok: false,
        message: "LinkedIn Ads is not connected for this workspace",
      });
    }

    const accessToken = connection.accessToken;

    async function linkedInGet(url) {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "LinkedIn-Version": "202404",
          "X-Restli-Protocol-Version": "2.0.0",
        },
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data?.message ||
            data?.serviceErrorCode ||
            "LinkedIn API request failed"
        );
      }

      return data;
    }

    let adAccounts = [];

    try {
      const adAccountsResponse = await linkedInGet(
        "https://api.linkedin.com/rest/adAccounts?q=search&search=(status:(values:List(ACTIVE)))"
      );

      adAccounts = Array.isArray(adAccountsResponse?.elements)
        ? adAccountsResponse.elements
        : [];
    } catch (err) {
      const msg = String(err?.message || "").toLowerCase();

      if (
        msg.includes("no virtual resource found") ||
        msg.includes("not enough permissions") ||
        msg.includes("access denied") ||
        msg.includes("forbidden")
      ) {
        adAccounts = [];
      } else {
        throw err;
      }
    }

    const primaryAccount = adAccounts[0] || null;

    const externalAccountId =
      primaryAccount?.id != null ? String(primaryAccount.id) : null;

    const externalAccountName =
      primaryAccount?.name ||
      connection?.externalAccountName ||
      "LinkedIn Ads";

    let campaigns = [];

    if (externalAccountId) {
      try {
        const campaignsResponse = await linkedInGet(
          `https://api.linkedin.com/rest/adCampaigns?q=search&search=(account:(values:List(urn%3Ali%3AsponsoredAccount%3A${encodeURIComponent(
            externalAccountId
          )})))`
        );

        campaigns = Array.isArray(campaignsResponse?.elements)
          ? campaignsResponse.elements
          : [];
      } catch (err) {
        const msg = String(err?.message || "").toLowerCase();

        if (
          msg.includes("no virtual resource found") ||
          msg.includes("not enough permissions") ||
          msg.includes("access denied") ||
          msg.includes("forbidden")
        ) {
          campaigns = [];
        } else {
          throw err;
        }
      }
    }

    connection.externalAccountId = externalAccountId;
    connection.externalAccountName = externalAccountName;
    connection.mode = "live";
    connection.status = "connected";
    connection.lastSyncAt = new Date();
    connection.lastSyncStatus = "success";
    connection.lastError = null;
    connection.metadata = {
      ...(connection.metadata || {}),
      adAccounts,
      campaigns,
      syncedAt: new Date(),
      hasAdAccounts: adAccounts.length > 0,
    };

    await connection.save();

    await updateOrgIntegrationSummary(orgId, "linkedin_ads", {
      connected: true,
      lastSync: new Date(),
      mode: "live",
    });

    return res.json({
      ok: true,
      message: adAccounts.length
        ? "LinkedIn Ads sync completed"
        : "LinkedIn connected successfully. No ad accounts found yet.",
      provider: "linkedin_ads",
      mode: "live",
      summary: {
        adAccountsFound: adAccounts.length,
        campaignsFound: campaigns.length,
        primaryAccount: externalAccountName,
      },
    });
  } catch (err) {
    console.error("LinkedIn Ads sync error:", err);

    return res.status(500).json({
      ok: false,
      message: "Failed to sync LinkedIn Ads",
      error: err.message,
    });
  }
});

/* -------------------------------- */
/* STRIPE REVENUE DAILY             */
/* -------------------------------- */

router.get("/stripe/revenue-daily", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);

    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context",
      });
    }

    const rows = await StripeRevenueDaily.find({ orgId, provider: "stripe" })
      .sort({ date: 1 })
      .lean();

    const totalRevenue = rows.reduce((sum, r) => sum + Number(r.netRevenue || 0), 0);
    const totalGross = rows.reduce((sum, r) => sum + Number(r.grossRevenue || 0), 0);
    const totalRefunds = rows.reduce((sum, r) => sum + Number(r.refunds || 0), 0);
    const totalTransactions = rows.reduce(
      (sum, r) => sum + Number(r.transactionCount || 0),
      0
    );

    return res.json({
      ok: true,
      summary: {
        totalRevenue: Number(totalRevenue.toFixed(2)),
        totalGross: Number(totalGross.toFixed(2)),
        totalRefunds: Number(totalRefunds.toFixed(2)),
        totalTransactions,
      },
      rows,
    });
  } catch (err) {
    console.error("Stripe revenue daily error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to load Stripe revenue data",
      error: err.message,
    });
  }
});

export default router;
