import express from "express";
import axios from "axios";
import IntegrationConnection from "../models/IntegrationConnection.js";

const router = express.Router();

const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const REDIRECT_URI = process.env.LINKEDIN_REDIRECT_URI;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://app.atlasrevenueai.com";

function getOrgId(req) {
  return (
    req.query.orgId ||
    req.headers["x-org-id"] ||
    req.body?.orgId ||
    ""
  );
}

/**
 * STEP 1: Get LinkedIn OAuth URL
 */
router.get("/auth-url", (req, res) => {
  const orgId = getOrgId(req);

  if (!orgId) {
    return res.status(400).json({ ok: false, message: "Missing orgId" });
  }

  const state = encodeURIComponent(JSON.stringify({ orgId }));

  const authUrl = `https://www.linkedin.com/oauth/v2/authorization` +
    `?response_type=code` +
    `&client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=r_ads,r_ads_reporting` +
    `&state=${state}`;

  res.json({ ok: true, authUrl });
});

/**
 * STEP 2: Callback
 */
router.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.redirect(`${FRONTEND_URL}/integrations?error=linkedin_ads`);
  }

  let parsed;
  try {
    parsed = JSON.parse(state);
  } catch {
    return res.redirect(`${FRONTEND_URL}/integrations?error=linkedin_ads`);
  }

  const orgId = parsed.orgId;

  try {
    const tokenRes = await axios.post(
      "https://www.linkedin.com/oauth/v2/accessToken",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }).toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    const accessToken = tokenRes.data.access_token;

    await IntegrationConnection.findOneAndUpdate(
      { orgId, provider: "linkedin_ads" },
      {
        orgId,
        provider: "linkedin_ads",
        status: "connected",
        mode: "live",
        accessToken,
        connectedAt: new Date(),
      },
      { upsert: true }
    );

    return res.redirect(
      `${FRONTEND_URL}/integrations?connected=linkedin_ads`
    );
  } catch (err) {
    console.error(err.response?.data || err.message);

    return res.redirect(
      `${FRONTEND_URL}/integrations?error=linkedin_ads`
    );
  }
});

export default router;