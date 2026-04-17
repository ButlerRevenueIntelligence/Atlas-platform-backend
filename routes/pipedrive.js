import express from "express";
import axios from "axios";

const router = express.Router();

const CLIENT_ID = process.env.PIPEDRIVE_CLIENT_ID;
const CLIENT_SECRET = process.env.PIPEDRIVE_CLIENT_SECRET;
const REDIRECT_URI = process.env.PIPEDRIVE_REDIRECT_URI;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://app.atlasrevenueai.com";

/**
 * STEP 1: Redirect user to Pipedrive OAuth
 */
router.get("/connect", (req, res) => {
  const orgId =
    req.headers["x-org-id"] ||
    req.query.orgId ||
    req.body?.orgId ||
    req.orgId ||
    req.org?._id ||
    "";

  if (!orgId) {
    return res.status(400).json({
      ok: false,
      message: "Missing orgId",
    });
  }

  const state = encodeURIComponent(
    JSON.stringify({ orgId, provider: "pipedrive" })
  );

  const authUrl = `https://oauth.pipedrive.com/oauth/authorize?client_id=${encodeURIComponent(
    CLIENT_ID
  )}&redirect_uri=${encodeURIComponent(
    REDIRECT_URI
  )}&response_type=code&state=${state}`;

  return res.redirect(authUrl);
});

/**
 * STEP 2: Callback after user connects
 */
router.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.status(400).json({
      ok: false,
      message: "Missing code or state",
    });
  }

  let parsedState;
  try {
    parsedState = JSON.parse(state);
  } catch {
    return res.status(400).json({
      ok: false,
      message: "Invalid OAuth state",
    });
  }

  const orgId = parsedState?.orgId;

  if (!orgId) {
    return res.status(400).json({
      ok: false,
      message: "No orgId returned from OAuth",
    });
  }

  try {
    const response = await axios.post(
      "https://oauth.pipedrive.com/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
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

    const { access_token, refresh_token, expires_in } = response.data;

    console.log("✅ Pipedrive Connected");
    console.log("Org:", orgId);
    console.log("Access token exists:", !!access_token);

    // TODO: Save to DB here later
    // await IntegrationConnection.findOneAndUpdate(
    //   { orgId, provider: "pipedrive" },
    //   {
    //     orgId,
    //     provider: "pipedrive",
    //     status: "connected",
    //     mode: "live",
    //     accessToken: access_token,
    //     refreshToken: refresh_token || null,
    //     tokenExpiresAt: expires_in ? new Date(Date.now() + expires_in * 1000) : null,
    //     connectedAt: new Date(),
    //     lastSyncAt: new Date(),
    //     lastSyncStatus: "success",
    //   },
    //   { upsert: true, new: true }
    // );

    return res.redirect(
      `${FRONTEND_URL}/integrations?connected=pipedrive&mode=live`
    );
  } catch (err) {
    console.error(err.response?.data || err.message);

    return res.redirect(
      `${FRONTEND_URL}/integrations?error=pipedrive`
    );
  }
});

export default router;