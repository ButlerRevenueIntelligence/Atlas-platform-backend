import CompanyIntelligence from "../models/CompanyIntelligence.js";
import express from "express";

const router = express.Router();

const GRAPHIQ_BASE_URL = "https://app.graphiq.ai";

router.post("/organizations/search", async (req, res) => {
  try {
    const apiKey = process.env.GRAPHIQ_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        message: "GraphIQ API key is not configured",
      });
    }

    const { organization } = req.body;

    if (!organization || typeof organization !== "object") {
      return res.status(400).json({
        ok: false,
        message: "An organization search object is required",
      });
    }

    const response = await fetch(
      `${GRAPHIQ_BASE_URL}/api/v2/organizations/search`,
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          organization,
        }),
      }
    );

    const rawText = await response.text();

    let data;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = {
        message: rawText || "GraphIQ returned an unreadable response",
      };
    }

    if (!response.ok) {
      console.error("GraphIQ organization search failed:", {
        status: response.status,
        data,
      });

      return res.status(response.status).json({
        ok: false,
        message:
          data?.message ||
          data?.error ||
          "GraphIQ organization search failed",
        details: data,
      });
    }

    const snapshot = await CompanyIntelligence.create({ orgId: req.orgId || req.user.orgId, query: organization, data, expiresAt: new Date(Date.now() + 86400000) });
    return res.json({
      ok: true,
      snapshotId: String(snapshot._id),
      data,
    });
  } catch (error) {
    console.error("GraphIQ route error:", error);

    return res.status(500).json({
      ok: false,
      message: "Unable to connect to GraphIQ",
    });
  }
});

router.get("/context", async (req, res) => {
  try {
    const snapshot = await CompanyIntelligence.findOne({ orgId: req.orgId || req.user.orgId, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean();
    return res.json({ ok: true, data: snapshot?.data || [], query: snapshot?.query || null, snapshotId: snapshot?._id || null, asOf: snapshot?.createdAt || null });
  } catch (error) { return res.status(500).json({ ok: false, message: "Unable to load company intelligence" }); }
});
export default router;
