import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { getUnifiedWorkspaceData } from "../services/workspaceData.js";
import { calculateDealMetrics } from "../services/dealMetrics.js";
const router = express.Router();
for (const endpoint of ["summary", "daily"]) {
  router.get(`/${endpoint}`, requireAuth, async (req, res) => {
    try {
      const days = Math.max(7, Math.min(365, parseInt(req.query.days || "30", 10) || 30));
      const data = await getUnifiedWorkspaceData(req.user.orgId, { days });
      const calculated = calculateDealMetrics(data.deals, days);
      return res.json({ ok: true, [endpoint === "summary" ? "summary" : "days"]: endpoint === "summary" ? calculated.summary : calculated.days,
        warnings: data.warnings, dataSources: data.dataSources });
    } catch (error) { return res.status(500).json({ ok: false, message: error.message }); }
  });
}
export default router;
