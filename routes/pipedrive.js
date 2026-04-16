import express from "express";
import axios from "axios";

const router = express.Router();

const CLIENT_ID = process.env.PIPEDRIVE_CLIENT_ID;
const CLIENT_SECRET = process.env.PIPEDRIVE_CLIENT_SECRET;
const REDIRECT_URI = process.env.PIPEDRIVE_REDIRECT_URI;

// Step 1: Redirect user to Pipedrive OAuth
router.get("/connect", (req, res) => {
  const authUrl = `https://oauth.pipedrive.com/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code`;
  res.redirect(authUrl);
});

// Step 2: Callback after user connects
router.get("/callback", async (req, res) => {
  const { code } = req.query;

  try {
    const response = await axios.post("https://oauth.pipedrive.com/oauth/token", {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });

    const { access_token } = response.data;

    // Save token to DB (you’ll wire this later per org)
    console.log("Pipedrive Connected:", access_token);

    res.redirect("https://atlasrevenueai.com/integrations?success=pipedrive");
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.redirect("https://atlasrevenueai.com/integrations?error=pipedrive");
  }
});

export default router;