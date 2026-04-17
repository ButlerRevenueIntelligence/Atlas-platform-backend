import express from "express";
import axios from "axios";
import IntegrationConnection from "../models/IntegrationConnection.js";
import Organization from "../models/Organization.js";

const router = express.Router();

const CLIENT_ID = String(process.env.PIPEDRIVE_CLIENT_ID || "").trim();
const CLIENT_SECRET = String(process.env.PIPEDRIVE_CLIENT_SECRET || "").trim();
const REDIRECT_URI = String(process.env.PIPEDRIVE_REDIRECT_URI || "").trim();
const FRONTEND_URL = String(
  process.env.FRONTEND_URL || "https://app.atlasrevenueai.com"
)
  .trim()
  .replace(/\/+$/, "");

function getOrgId(req) {
  return (
    req.query.orgId ||
    req.headers["x-org-id"] ||
    req.body?.orgId ||
    req.orgId ||
    req.org?._id ||
    ""
  );
}

async function ensureOrg(orgId) {
  if (!orgId) return null;
  return Organization.findById(orgId);
}

async function getPipedriveUserInfo(accessToken) {
  const res = await axios.get("https://api.pipedrive.com/v1/users/me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res?.data || res.data.success === false) {
    throw new Error("Failed to fetch Pipedrive user");
  }

  return res.data.data || null;
}

/**
 * STEP 1: Redirect user to Pipedrive OAuth
 */
router.get("/connect", async (req, res) => {
  try {
    const orgId = getOrgId(req);

    if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
      return res.status(500).json({
        ok: false,
        message: "Pipedrive OAuth is not fully configured",
      });
    }

    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing orgId",
      });
    }

    const org = await ensureOrg(orgId);
    if (!org) {
      return res.status(404).json({
        ok: false,
        message: "Workspace not found",
      });
    }

    const state = JSON.stringify({
      orgId: String(orgId),
      provider: "pipedrive",
    });

    const authUrl =
      `https://oauth.pipedrive.com/oauth/authorize` +
      `?client_id=${encodeURIComponent(CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&response_type=code` +
      `&state=${encodeURIComponent(state)}`;

    return res.redirect(authUrl);
  } catch (err) {
    console.error("Pipedrive connect error:", err?.response?.data || err.message);

    return res.status(500).json({
      ok: false,
      message: "Failed to start Pipedrive OAuth",
      error: err.message,
    });
  }
});

/**
 * STEP 2: Callback after user connects
 */
router.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.redirect(`${FRONTEND_URL}/integrations?error=pipedrive`);
  }

  let parsedState;
  try {
    parsedState = JSON.parse(state);
  } catch {
    return res.redirect(`${FRONTEND_URL}/integrations?error=pipedrive`);
  }

  const orgId = parsedState?.orgId;

  if (!orgId) {
    return res.redirect(`${FRONTEND_URL}/integrations?error=pipedrive`);
  }

  try {
    const org = await ensureOrg(orgId);
    if (!org) {
      return res.redirect(`${FRONTEND_URL}/integrations?error=pipedrive`);
    }

    const tokenResponse = await axios.post(
      "https://oauth.pipedrive.com/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const tokenData = tokenResponse.data || {};
    const accessToken = tokenData.access_token || null;
    const refreshToken = tokenData.refresh_token || null;
    const expiresIn = Number(tokenData.expires_in || 0) || 0;
    const tokenType = tokenData.token_type || "Bearer";

    if (!accessToken) {
      throw new Error("Pipedrive did not return an access token");
    }

    const me = await getPipedriveUserInfo(accessToken);

    let connection = await IntegrationConnection.findOne({
      orgId,
      provider: "pipedrive",
    }).select("+accessToken +refreshToken");

    if (!connection) {
      connection = new IntegrationConnection({
        orgId,
        provider: "pipedrive",
      });
    }

    if (typeof connection.markConnected === "function") {
      connection.markConnected({
        mode: "live",
        externalAccountId: me?.company_id ? String(me.company_id) : null,
        externalAccountName: me?.name || "Pipedrive",
        accessToken,
        refreshToken,
        tokenType,
        tokenExpiresAt: expiresIn
          ? new Date(Date.now() + expiresIn * 1000)
          : null,
        scopes: [],
        metadata: {
          user: me,
        },
      });
    } else {
      connection.status = "connected";
      connection.mode = "live";
      connection.connectedAt = new Date();
      connection.disconnectedAt = null;
      connection.accessToken = accessToken;
      connection.refreshToken = refreshToken;
      connection.tokenType = tokenType;
      connection.tokenExpiresAt = expiresIn
        ? new Date(Date.now() + expiresIn * 1000)
        : null;
      connection.externalAccountId = me?.company_id
        ? String(me.company_id)
        : null;
      connection.externalAccountName = me?.name || "Pipedrive";
      connection.scopes = [];
      connection.lastSyncAt = new Date();
      connection.lastSyncStatus = "success";
      connection.lastError = null;
      connection.metadata = {
        ...(connection.metadata || {}),
        user: me,
      };
    }

    await connection.save();

    await Organization.findByIdAndUpdate(
      orgId,
      {
        $set: {
          "integrations.pipedrive.connected": true,
          "integrations.pipedrive.connectedAt": new Date(),
          "integrations.pipedrive.lastSync": new Date(),
          "integrations.pipedrive.mode": "live",
        },
      },
      { new: true }
    );

    console.log("✅ Pipedrive Connected");
    console.log("Org:", orgId);
    console.log("Access token exists:", !!accessToken);

    return res.redirect(
      `${FRONTEND_URL}/integrations?connected=pipedrive&mode=live`
    );
  } catch (err) {
    console.error(
      "Pipedrive callback error:",
      err?.response?.data || err.message
    );

    return res.redirect(`${FRONTEND_URL}/integrations?error=pipedrive`);
  }
});

export default router;