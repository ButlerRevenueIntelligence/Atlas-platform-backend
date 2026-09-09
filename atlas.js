import express from "express";
import { buildResponse } from "../services/atlasBrain.js";
import { requireAuth } from "../middleware/auth.js";
import Membership from "../models/Membership.js";
import { getUnifiedWorkspaceData } from "../services/workspaceData.js";

const router = express.Router();

router.post("/ask", requireAuth, async (req, res) => {
  try {
    const orgId =
      req.headers["x-org-id"] ||
      req.headers["x-workspace-id"] ||
      req.orgId;
    const userId = req.user?.userId || req.user?.id || req.user?._id;
    const membership = await Membership.findOne({
      userId,
      orgId,
      status: { $nin: ["disabled", "suspended"] },
    }).lean();

    if (!membership) {
      return res.status(403).json({
        ok: false,
        message: "Workspace access denied",
      });
    }

    const { question } = req.body;
    const unified = await getUnifiedWorkspaceData(orgId, { days: 30 });
    const openDeals = unified.deals.filter(
      (deal) => !["closed won", "closed lost"].includes(
        String(deal.stage || "").toLowerCase()
      )
    );
    const revenue30 = unified.metrics.reduce(
      (sum, row) => sum + Number(row.revenue || 0),
      0
    );
    const pipelineValue = openDeals.reduce(
      (sum, deal) => sum + Number(deal.amount || 0),
      0
    );
    const metrics = {
      revenue30,
      pipelineValue,
      coverage: revenue30 > 0 ? pipelineValue / revenue30 : 0,
      openDeals: openDeals.length,
      revenueSource: unified.dataSources.revenue,
    };

    const answer = buildResponse(question, metrics);

    res.json({
      answer,
      confidence: 0.86,
      generatedBy: "Atlas AI Operator",
      dataSources: unified.dataSources,
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: "Atlas AI failed to analyze request"
    });

  }
});

export default router;
