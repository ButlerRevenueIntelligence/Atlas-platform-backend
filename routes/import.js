import express from "express";
import { requireAuth } from "../middleware/authMiddleware.js";
import MetricsDaily from "../models/MetricsDaily.js";

const router = express.Router();

/**
 * POST /api/import/metricsdaily
 * Body: { rows: [{date, revenue, pipeline, cac, topChannel, bestLandingPage}, ...] }
 */
router.post("/metricsdaily", requireAuth, async (req, res) => {
  try {
    const rows = req.body?.rows || [];
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "rows[] is required" });
    }

    const docs = rows.map((r) => ({
      orgId: req.orgId,
      date: new Date(r.date),
      revenue: Number(r.revenue || 0),
      pipeline: Number(r.pipeline || 0),
      cac: Number(r.cac || 0),
      topChannel: (r.topChannel ?? "-").toString(),
      bestLandingPage: (r.bestLandingPage ?? "-").toString(),
    }));

    await MetricsDaily.insertMany(docs);
    res.json({ ok: true, inserted: docs.length });
  } catch (err) {
    console.error("import metricsdaily error:", err);
    res.status(500).json({ error: "Import failed" });
  }
});

export default router;
