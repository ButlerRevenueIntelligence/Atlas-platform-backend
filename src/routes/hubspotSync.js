import express from "express";
import IntegrationConnection from "../models/IntegrationConnection.js";
import Deal from "../models/Deal.js";

const router = express.Router();

/* -------------------------------- */
/* SYNC DEALS FROM HUBSPOT          */
/* -------------------------------- */

router.post("/sync", async (req, res) => {
  try {
    const orgId =
      req.headers["x-org-id"] ||
      req.body?.orgId;

    if (!orgId) {
      return res.status(400).json({ ok: false, message: "Missing orgId" });
    }

    const connection = await IntegrationConnection.findOne({
      orgId,
      provider: "hubspot",
      status: "connected",
    });

    if (!connection || !connection.accessToken) {
      return res.status(400).json({
        ok: false,
        message: "HubSpot not connected",
      });
    }

    const accessToken = connection.accessToken;

    /* -------------------------------- */
    /* FETCH DEALS FROM HUBSPOT         */
    /* -------------------------------- */

    const response = await fetch(
      "https://api.hubapi.com/crm/v3/objects/deals?limit=100",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.message || "Failed to fetch deals");
    }

    const deals = data.results || [];

    /* -------------------------------- */
    /* SAVE INTO ATLAS                  */
    /* -------------------------------- */

    for (const d of deals) {
      await Deal.findOneAndUpdate(
        {
          orgId,
          externalId: d.id,
        },
        {
          $set: {
            orgId,
            name: d.properties.dealname || "Unnamed Deal",
            value: Number(d.properties.amount || 0),
            stage: d.properties.dealstage || "unknown",
            source: "hubspot",
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );
    }

    /* -------------------------------- */
    /* UPDATE CONNECTION STATUS         */
    /* -------------------------------- */

    await IntegrationConnection.findOneAndUpdate(
      { orgId, provider: "hubspot" },
      {
        $set: {
          lastSyncAt: new Date(),
          lastSyncStatus: "success",
          lastError: null,
        },
      }
    );

    return res.json({
      ok: true,
      message: `Synced ${deals.length} deals from HubSpot`,
    });
  } catch (err) {
    console.error("HubSpot sync error:", err);

    return res.status(500).json({
      ok: false,
      message: "Sync failed",
      error: err.message,
    });
  }
});

export default router;