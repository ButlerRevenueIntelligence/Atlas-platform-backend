import crypto from "crypto";
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import IntegrationConnection from "../models/IntegrationConnection.js";
import Organization from "../models/Organization.js";
import QuickBooksSnapshot from "../models/QuickBooksSnapshot.js";

const router = express.Router();
const PROVIDER = "quickbooks";
const ACCOUNTING_SCOPE = "com.intuit.quickbooks.accounting";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

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

function backendBaseUrl() {
  return String(
    process.env.BACKEND_PUBLIC_URL ||
      process.env.APP_BASE_URL ||
      "https://atlas-revenue-backend.onrender.com"
  )
    .trim()
    .replace(/\/+$/, "");
}

function frontendUrl() {
  return String(process.env.FRONTEND_URL || "https://app.atlasrevenueai.com")
    .trim()
    .replace(/\/+$/, "");
}

function redirectUri() {
  return String(
    process.env.QUICKBOOKS_REDIRECT_URI ||
      `${backendBaseUrl()}/api/integrations/quickbooks/callback`
  ).trim();
}

function stateSecret() {
  const secret = String(process.env.OAUTH_STATE_SECRET || "").trim();
  if (!secret) throw new Error("OAUTH_STATE_SECRET is not configured");
  return secret;
}

function signState(payload) {
  const encoded = Buffer.from(
    JSON.stringify({
      ...payload,
      provider: PROVIDER,
      iat: Date.now(),
      exp: Date.now() + STATE_MAX_AGE_MS,
      nonce: crypto.randomBytes(24).toString("base64url"),
    }),
    "utf8"
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", stateSecret())
    .update(encoded)
    .digest("base64url");

  return `${encoded}.${signature}`;
}

function parseState(value) {
  const [encoded, suppliedSignature] = String(value || "").split(".");
  if (!encoded || !suppliedSignature) throw new Error("Invalid OAuth state");

  const expectedSignature = crypto
    .createHmac("sha256", stateSecret())
    .update(encoded)
    .digest("base64url");

  const supplied = Buffer.from(suppliedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");

  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw new Error("Invalid OAuth state signature");
  }

  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (payload.provider !== PROVIDER || !payload.orgId) {
    throw new Error("Invalid OAuth state payload");
  }
  if (!payload.exp || Date.now() > Number(payload.exp)) {
    throw new Error("OAuth state has expired");
  }
  return payload;
}

function requireQuickBooksConfig() {
  const clientId = String(process.env.QUICKBOOKS_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.QUICKBOOKS_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) {
    throw new Error("QuickBooks OAuth is not configured");
  }
  return { clientId, clientSecret };
}

function authUrl(orgId) {
  const { clientId } = requireQuickBooksConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    scope: ACCOUNTING_SCOPE,
    redirect_uri: redirectUri(),
    state: signState({ orgId: String(orgId) }),
  });
  return `https://appcenter.intuit.com/connect/oauth2?${params.toString()}`;
}

async function tokenRequest(params) {
  const { clientId, clientSecret } = requireQuickBooksConfig();
  const response = await fetch(
    "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params),
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.access_token) {
    throw new Error(
      data?.error_description || data?.error || "QuickBooks token request failed"
    );
  }
  return data;
}

function apiBaseUrl() {
  if (process.env.QUICKBOOKS_API_BASE_URL) {
    return String(process.env.QUICKBOOKS_API_BASE_URL).replace(/\/+$/, "");
  }
  return String(process.env.QUICKBOOKS_ENVIRONMENT || "production").toLowerCase() ===
    "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";
}

async function ensureAccessToken(connection) {
  const expiresAt = connection?.tokenExpiresAt
    ? new Date(connection.tokenExpiresAt).getTime()
    : 0;

  if (connection.accessToken && expiresAt > Date.now() + 2 * 60 * 1000) {
    return connection.accessToken;
  }

  if (!connection.refreshToken) {
    throw new Error("QuickBooks authorization expired. Reconnect QuickBooks.");
  }

  const tokens = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: connection.refreshToken,
  });

  connection.accessToken = tokens.access_token;
  if (tokens.refresh_token) connection.refreshToken = tokens.refresh_token;
  connection.tokenType = tokens.token_type || "bearer";
  connection.tokenExpiresAt = new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000);
  connection.scopes = String(tokens.scope || ACCOUNTING_SCOPE).split(/\s+/).filter(Boolean);
  connection.metadata = {
    ...(connection.metadata || {}),
    refreshTokenExpiresAt: tokens.x_refresh_token_expires_in
      ? new Date(Date.now() + Number(tokens.x_refresh_token_expires_in) * 1000)
      : connection.metadata?.refreshTokenExpiresAt || null,
  };
  await connection.save();
  return connection.accessToken;
}

async function qboRequest({ realmId, accessToken, path, query = {} }) {
  const params = new URLSearchParams(query);
  const minorVersion = String(process.env.QUICKBOOKS_MINOR_VERSION || "").trim();
  if (minorVersion) params.set("minorversion", minorVersion);

  const response = await fetch(
    `${apiBaseUrl()}/v3/company/${encodeURIComponent(realmId)}/${path}${
      params.size ? `?${params.toString()}` : ""
    }`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.Fault?.Error?.[0]?.Detail || data?.Fault?.Error?.[0]?.Message;
    throw new Error(detail || `QuickBooks request failed (${response.status})`);
  }
  return data;
}

function dateOnly(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function reportRows(report) {
  const rows = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    const header = Array.isArray(node?.Header?.ColData) ? node.Header.ColData : [];
    const summary = Array.isArray(node?.Summary?.ColData) ? node.Summary.ColData : [];
    if (header.length) rows.push(header.map((x) => x?.value ?? ""));
    if (summary.length) rows.push(summary.map((x) => x?.value ?? ""));
    const children = node?.Rows?.Row || node?.Row || [];
    (Array.isArray(children) ? children : [children]).forEach(visit);
  }
  visit(report?.Rows || report);
  return rows;
}

function findReportAmount(report, patterns) {
  const matchers = patterns.map((pattern) => new RegExp(pattern, "i"));
  for (const columns of reportRows(report)) {
    const label = String(columns[0] || "").trim();
    if (!matchers.some((matcher) => matcher.test(label))) continue;
    for (let index = columns.length - 1; index >= 1; index -= 1) {
      const numeric = Number(String(columns[index] || "").replace(/[$,()]/g, (m) => (m === "(" ? "-" : "")));
      if (Number.isFinite(numeric)) return numeric;
    }
  }
  return 0;
}

async function updateOrgSummary(orgId, patch) {
  const update = {};
  Object.entries(patch).forEach(([key, value]) => {
    update[`integrations.${PROVIDER}.${key}`] = value;
  });
  await Organization.findByIdAndUpdate(orgId, { $set: update });
}

router.get("/auth-url", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });
    const org = await Organization.findById(orgId).select("_id").lean();
    if (!org) return res.status(404).json({ ok: false, message: "Workspace not found" });
    return res.json({ ok: true, provider: PROVIDER, authUrl: authUrl(orgId) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.get("/callback", async (req, res) => {
  const failure = (code) =>
    res.redirect(`${frontendUrl()}/integrations?error=${encodeURIComponent(code)}`);

  try {
    if (req.query.error) return failure(String(req.query.error));
    const { code, state, realmId } = req.query;
    if (!code || !state || !realmId) return failure("quickbooks_callback_missing_fields");

    const payload = parseState(state);
    const tokens = await tokenRequest({
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: redirectUri(),
    });

    const companyResponse = await qboRequest({
      realmId: String(realmId),
      accessToken: tokens.access_token,
      path: `companyinfo/${encodeURIComponent(realmId)}`,
    });
    const company = companyResponse?.CompanyInfo || {};

    let connection = await IntegrationConnection.findOne({
      orgId: payload.orgId,
      provider: PROVIDER,
    }).select("+accessToken +refreshToken");

    if (!connection) {
      connection = new IntegrationConnection({ orgId: payload.orgId, provider: PROVIDER });
    }

    connection.markConnected({
      mode: "live",
      externalAccountId: String(realmId),
      externalAccountName: company.CompanyName || company.LegalName || "QuickBooks Online",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenType: tokens.token_type || "bearer",
      tokenExpiresAt: new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000),
      scopes: String(tokens.scope || ACCOUNTING_SCOPE).split(/\s+/).filter(Boolean),
      metadata: {
        environment: process.env.QUICKBOOKS_ENVIRONMENT || "production",
        country: company.Country || null,
        legalName: company.LegalName || null,
        refreshTokenExpiresAt: tokens.x_refresh_token_expires_in
          ? new Date(Date.now() + Number(tokens.x_refresh_token_expires_in) * 1000)
          : null,
      },
    });
    await connection.save();

    const now = new Date();
    await updateOrgSummary(payload.orgId, {
      connected: true,
      connectedAt: now,
      lastSync: null,
      mode: "live",
    });

    return res.redirect(`${frontendUrl()}/integrations?connected=quickbooks`);
  } catch (error) {
    console.error("QuickBooks callback error:", error);
    return failure("quickbooks_callback_failed");
  }
});

router.get("/status", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

    const [connection, snapshot] = await Promise.all([
      IntegrationConnection.findOne({ orgId, provider: PROVIDER }).lean(),
      QuickBooksSnapshot.findOne({ orgId }).sort({ syncedAt: -1 }).lean(),
    ]);

    return res.json({
      ok: true,
      connected: connection?.status === "connected",
      mode: connection?.mode || "demo",
      externalAccountId: connection?.externalAccountId || null,
      externalAccountName: connection?.externalAccountName || null,
      lastSyncAt: connection?.lastSyncAt || null,
      lastSyncStatus: connection?.lastSyncStatus || "never",
      lastError: connection?.lastError || null,
      financialSummary: snapshot?.metrics || null,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Failed to load QuickBooks status", error: error.message });
  }
});

router.post("/sync", requireAuth, async (req, res) => {
  let connection;
  try {
    const orgId = getOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });

    connection = await IntegrationConnection.findOne({
      orgId,
      provider: PROVIDER,
      status: "connected",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      return res.status(404).json({ ok: false, message: "QuickBooks is not connected for this workspace" });
    }

    connection.lastSyncStatus = "running";
    connection.lastError = null;
    await connection.save();

    const accessToken = await ensureAccessToken(connection);
    const realmId = String(connection.externalAccountId || "");
    if (!realmId) throw new Error("QuickBooks company ID is missing");

    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const reportQuery = { start_date: dateOnly(start), end_date: dateOnly(now) };

    const [companyResponse, profitAndLoss, balanceSheet, cashFlow, agedReceivables, agedPayables] =
      await Promise.all([
        qboRequest({ realmId, accessToken, path: `companyinfo/${encodeURIComponent(realmId)}` }),
        qboRequest({ realmId, accessToken, path: "reports/ProfitAndLoss", query: reportQuery }),
        qboRequest({ realmId, accessToken, path: "reports/BalanceSheet", query: reportQuery }),
        qboRequest({ realmId, accessToken, path: "reports/CashFlow", query: reportQuery }),
        qboRequest({ realmId, accessToken, path: "reports/AgedReceivables", query: { report_date: dateOnly(now) } }),
        qboRequest({ realmId, accessToken, path: "reports/AgedPayables", query: { report_date: dateOnly(now) } }),
      ]);

    const company = companyResponse?.CompanyInfo || {};
    const metrics = {
      revenue: findReportAmount(profitAndLoss, ["^Total Income$", "^Total Revenue$"]),
      expenses: findReportAmount(profitAndLoss, ["^Total Expenses$"]),
      netIncome: findReportAmount(profitAndLoss, ["^Net Income$"]),
      cash: findReportAmount(balanceSheet, ["^Total Bank Accounts$", "^Cash and Cash Equivalents$"]),
      accountsReceivable: findReportAmount(agedReceivables, ["^TOTAL$", "^Total Accounts Receivable$"]),
      accountsPayable: findReportAmount(agedPayables, ["^TOTAL$", "^Total Accounts Payable$"]),
    };

    const snapshot = await QuickBooksSnapshot.create({
      orgId,
      realmId,
      companyName: company.CompanyName || connection.externalAccountName || null,
      periodStart: start,
      periodEnd: now,
      currency: profitAndLoss?.Header?.Currency || balanceSheet?.Header?.Currency || "USD",
      metrics,
      reports: { profitAndLoss, balanceSheet, cashFlow, agedReceivables, agedPayables },
      syncedAt: now,
    });

    connection.externalAccountName = company.CompanyName || connection.externalAccountName;
    connection.lastSyncAt = now;
    connection.lastSyncStatus = "success";
    connection.lastError = null;
    connection.metadata = { ...(connection.metadata || {}), financialSummary: metrics, latestSnapshotId: snapshot._id };
    await connection.save();

    await updateOrgSummary(orgId, { connected: true, lastSync: now, mode: "live" });

    return res.json({
      ok: true,
      message: "QuickBooks sync completed",
      provider: PROVIDER,
      mode: "live",
      summary: { companyName: snapshot.companyName, currency: snapshot.currency, periodStart: snapshot.periodStart, periodEnd: snapshot.periodEnd, ...metrics },
    });
  } catch (error) {
    console.error("QuickBooks sync error:", error);
    if (connection) {
      connection.lastSyncStatus = "failed";
      connection.lastError = error.message;
      await connection.save().catch(() => {});
    }
    return res.status(500).json({ ok: false, message: "Failed to sync QuickBooks", error: error.message });
  }
});

router.get("/summary", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing org context" });
    const snapshot = await QuickBooksSnapshot.findOne({ orgId }).sort({ syncedAt: -1 }).lean();
    return res.json({ ok: true, summary: snapshot || null });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Failed to load QuickBooks summary", error: error.message });
  }
});

export default router;
