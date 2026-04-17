import express from "express";
import axios from "axios";
import IntegrationConnection from "../models/IntegrationConnection.js";
import Organization from "../models/Organization.js";
import Deal from "../models/Deal.js";
import Account from "../models/Account.js";

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

function normalizeAtlasStage(stageName) {
  const s = String(stageName || "").toLowerCase();

  if (s.includes("discover")) return "Discovery";
  if (s.includes("proposal")) return "Proposal";
  if (s.includes("follow")) return "Follow-Up";
  if (s.includes("negotiat")) return "Negotiation";
  if (s.includes("won") || s.includes("closed won")) return "Closed Won";
  if (s.includes("lost") || s.includes("closed lost")) return "Closed Lost";

  return "Discovery";
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

async function getPipedriveStages(accessToken) {
  const res = await axios.get("https://api.pipedrive.com/v1/stages", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res?.data || res.data.success === false) {
    throw new Error("Failed to fetch Pipedrive stages");
  }

  return Array.isArray(res.data.data) ? res.data.data : [];
}

async function getPipedriveDeals(accessToken) {
  const res = await axios.get("https://api.pipedrive.com/v1/deals", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    params: {
      limit: 500,
      start: 0,
      status: "all_not_deleted",
    },
  });

  if (!res?.data || res.data.success === false) {
    throw new Error("Failed to fetch Pipedrive deals");
  }

  return Array.isArray(res.data.data) ? res.data.data : [];
}

async function getPipedriveOrganizations(accessToken) {
  const res = await axios.get("https://api.pipedrive.com/v1/organizations", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    params: {
      limit: 500,
      start: 0,
    },
  });

  if (!res?.data || res.data.success === false) {
    throw new Error("Failed to fetch Pipedrive organizations");
  }

  return Array.isArray(res.data.data) ? res.data.data : [];
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

/**
 * STEP 3: Sync data from Pipedrive into Atlas
 */
router.post("/sync", async (req, res) => {
  try {
    const orgId = getOrgId(req);

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

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "pipedrive",
      status: "connected",
    }).select("+accessToken +refreshToken");

    if (!connection || !connection.accessToken) {
      return res.status(400).json({
        ok: false,
        message: "Pipedrive not connected",
      });
    }

    const accessToken = connection.accessToken;

    const [stages, organizations, deals] = await Promise.all([
      getPipedriveStages(accessToken),
      getPipedriveOrganizations(accessToken),
      getPipedriveDeals(accessToken),
    ]);

    const stageMap = new Map(
      stages.map((s) => [String(s.id), s.name || "Discovery"])
    );

    let accountsSynced = 0;
    let dealsSynced = 0;

    for (const orgItem of organizations) {
      const externalId = String(orgItem.id);

      await Account.findOneAndUpdate(
        { orgId, externalId },
        {
          $set: {
            orgId,
            externalId,
            name: orgItem.name || "Pipedrive Organization",
            status: "Active",
          },
        },
        { upsert: true, new: true }
      );

      accountsSynced += 1;
    }

    for (const deal of deals) {
      const externalId = String(deal.id);
      const stageName = stageMap.get(String(deal.stage_id)) || "Discovery";
      const mappedStage = normalizeAtlasStage(stageName);

      let accountDoc = null;
      const orgValue = deal.org_id;

      if (orgValue && typeof orgValue === "object" && orgValue.value) {
        accountDoc = await Account.findOne({
          orgId,
          externalId: String(orgValue.value),
        });
      } else if (orgValue) {
        accountDoc = await Account.findOne({
          orgId,
          externalId: String(orgValue),
        });
      }

      await Deal.findOneAndUpdate(
        { orgId, externalId },
        {
          $set: {
            orgId,
            externalId,
            name: deal.title || "Pipedrive Deal",
            amount: Number(deal.value || 0),
            stage: mappedStage,
            status: deal.status === "won"
              ? "Closed Won"
              : deal.status === "lost"
              ? "Closed Lost"
              : mappedStage,
            clientId: accountDoc?._id || null,
            closeDate: deal.expected_close_date
              ? new Date(deal.expected_close_date)
              : null,
            probability:
              typeof deal.probability === "number"
                ? deal.probability / 100
                : 0.5,
          },
        },
        { upsert: true, new: true }
      );

      dealsSynced += 1;
    }

    connection.lastSyncAt = new Date();
    connection.lastSyncStatus = "success";
    connection.lastError = null;
    await connection.save();

    await Organization.findByIdAndUpdate(
      orgId,
      {
        $set: {
          "integrations.pipedrive.connected": true,
          "integrations.pipedrive.lastSync": new Date(),
          "integrations.pipedrive.mode": "live",
        },
      },
      { new: true }
    );

    return res.json({
      ok: true,
      message: "Pipedrive sync completed",
      accountsSynced,
      dealsSynced,
    });
  } catch (err) {
    console.error("Pipedrive sync error:", err?.response?.data || err.message);

    return res.status(500).json({
      ok: false,
      message: "Sync failed",
      error: err.message,
    });
  }
});

export default router;