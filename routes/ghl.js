import express from "express";
import axios from "axios";
import IntegrationConnection from "../models/IntegrationConnection.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

function getOrgId(req) {
  return (
    req.headers["x-org-id"] ||
    req.query.orgId ||
    req.user?.orgId ||
    req.user?.organizationId ||
    null
  );
}

const GHL_CLIENT_ID = process.env.GHL_CLIENT_ID;
const GHL_CLIENT_SECRET = process.env.GHL_CLIENT_SECRET;
const BACKEND_PUBLIC_URL =
  process.env.BACKEND_PUBLIC_URL || "https://atlas-revenue-backend.onrender.com";

const GHL_REDIRECT_URI =
  process.env.GHL_REDIRECT_URI ||
  `${BACKEND_PUBLIC_URL}/api/integrations/ghl/callback`;

const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://app.atlasrevenueai.com";

const GHL_AUTHORIZE_URL =
  "https://marketplace.gohighlevel.com/oauth/chooselocation";

const GHL_TOKEN_URL =
  "https://services.leadconnectorhq.com/oauth/token";

const GHL_API_BASE =
  process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";

router.get("/connect", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);

    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context",
      });
    }

    if (!GHL_CLIENT_ID || !GHL_CLIENT_SECRET) {
      return res.status(500).json({
        ok: false,
        message: "GoHighLevel OAuth is not configured",
      });
    }

    const state = Buffer.from(
      JSON.stringify({
        orgId,
        userId: req.user?._id || req.user?.id || null,
        ts: Date.now(),
      })
    ).toString("base64url");

    const params = new URLSearchParams({
      response_type: "code",
      redirect_uri: GHL_REDIRECT_URI,
      client_id: GHL_CLIENT_ID,
      scope: "contacts.readonly opportunities.readonly",
      state,
    });

    const authUrl = `${GHL_AUTHORIZE_URL}?${params.toString()}`;

    return res.json({
      ok: true,
      provider: "ghl",
      authUrl,
    });
  } catch (err) {
    console.error("GHL connect error:", err?.response?.data || err.message);
    return res.status(500).json({
      ok: false,
      message: "Failed to build GoHighLevel auth URL",
    });
  }
});

router.get("/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.status(400).json({
        ok: false,
        message: "Missing authorization code",
      });
    }

    let parsedState = {};
    if (state) {
      try {
        parsedState = JSON.parse(
          Buffer.from(state, "base64url").toString("utf8")
        );
      } catch {
        parsedState = {};
      }
    }

    const orgId = parsedState.orgId || null;

    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing orgId in OAuth state",
      });
    }

    const tokenResp = await axios.post(
      GHL_TOKEN_URL,
      {
        client_id: GHL_CLIENT_ID,
        client_secret: GHL_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: GHL_REDIRECT_URI,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
    );

    const tokenData = tokenResp.data || {};

    const accessToken = tokenData.access_token || tokenData.accessToken;
    const refreshToken = tokenData.refresh_token || tokenData.refreshToken;
    const locationId = tokenData.locationId || tokenData.location_id || null;
    const companyId = tokenData.companyId || tokenData.company_id || null;
    const userType = tokenData.userType || null;

    if (!accessToken) {
      return res.status(500).json({
        ok: false,
        message: "Missing access token from GoHighLevel",
      });
    }

    const existing = await IntegrationConnection.findOne({
      orgId,
      provider: "ghl",
    });

    const doc = await IntegrationConnection.findOneAndUpdate(
      { orgId, provider: "ghl" },
      {
        $set: {
          orgId,
          provider: "ghl",
          status: "connected",
          accessToken,
          refreshToken: refreshToken || null,
          externalAccountId: locationId || companyId || null,
          meta: {
            locationId,
            companyId,
            userType,
            tokenData,
            connectedAt: new Date(),
          },
          lastSyncedAt: null,
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    const redirectUrl = new URL(`${FRONTEND_URL}/data-connectors`);
    redirectUrl.searchParams.set("provider", "ghl");
    redirectUrl.searchParams.set("status", "connected");
    redirectUrl.searchParams.set("orgId", orgId);
    redirectUrl.searchParams.set("integrationId", String(doc._id));

    return res.redirect(redirectUrl.toString());
  } catch (err) {
    console.error("GHL callback error:", err?.response?.data || err.message);

    const redirectUrl = new URL(`${FRONTEND_URL}/data-connectors`);
    redirectUrl.searchParams.set("provider", "ghl");
    redirectUrl.searchParams.set("status", "error");
    redirectUrl.searchParams.set(
      "message",
      err?.response?.data?.message || "GoHighLevel connection failed"
    );

    return res.redirect(redirectUrl.toString());
  }
});

router.get("/sync", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);

    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context",
      });
    }

    const integration = await IntegrationConnection.findOne({
      orgId,
      provider: "ghl",
      status: "connected",
    });

    if (!integration?.accessToken) {
      return res.status(404).json({
        ok: false,
        message: "GoHighLevel is not connected",
      });
    }

    const headers = {
      Authorization: `Bearer ${integration.accessToken}`,
      Version: "2021-07-28",
      Accept: "application/json",
    };

    const locationId =
      integration?.meta?.locationId || integration?.externalAccountId;

    const [contactsResp, oppsResp] = await Promise.allSettled([
      axios.get(`${GHL_API_BASE}/contacts/`, {
        headers,
        params: locationId ? { locationId, limit: 100 } : { limit: 100 },
      }),
      axios.get(`${GHL_API_BASE}/opportunities/search`, {
        headers,
        params: locationId ? { locationId, limit: 100 } : { limit: 100 },
      }),
    ]);

    const contacts =
      contactsResp.status === "fulfilled"
        ? contactsResp.value.data?.contacts || contactsResp.value.data?.data || []
        : [];

    const opportunities =
      oppsResp.status === "fulfilled"
        ? oppsResp.value.data?.opportunities || oppsResp.value.data?.data || []
        : [];

    integration.lastSyncedAt = new Date();
    integration.meta = {
      ...(integration.meta || {}),
      lastSyncSummary: {
        contacts: contacts.length,
        opportunities: opportunities.length,
      },
    };
    await integration.save();

    return res.json({
      ok: true,
      provider: "ghl",
      summary: {
        contacts: contacts.length,
        opportunities: opportunities.length,
      },
      contacts,
      opportunities,
    });
  } catch (err) {
    console.error("GHL sync error:", err?.response?.data || err.message);
    return res.status(500).json({
      ok: false,
      message: "Failed to sync GoHighLevel data",
    });
  }
});

export default router;