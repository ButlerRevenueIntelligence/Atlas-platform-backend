import express from "express";

const router = express.Router();

/**
 * Example integrations list
 * Later this will come from database
 */
router.get("/", async (req, res) => {

  const integrations = [
    {
      id: "google_ads",
      name: "Google Ads",
      status: "disconnected",
      lastSync: null
    },
    {
      id: "meta_ads",
      name: "Meta Ads",
      status: "disconnected",
      lastSync: null
    },
    {
      id: "hubspot",
      name: "HubSpot",
      status: "disconnected",
      lastSync: null
    },
    {
      id: "stripe",
      name: "Stripe",
      status: "disconnected",
      lastSync: null
    }
  ];

  res.json({
    integrations
  });

});

export default router;