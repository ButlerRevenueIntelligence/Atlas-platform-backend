import express from "express"
import { calculateOperatorSignals } from "../services/operatorEngine.js"
import { requireAuth } from "../middleware/auth.js"
import Membership from "../models/Membership.js"
import { getUnifiedWorkspaceData } from "../services/workspaceData.js"

const router = express.Router()

router.get("/signals", requireAuth, async (req, res) => {

  try {

    const orgId =
      req.headers["x-org-id"] ||
      req.headers["x-workspace-id"] ||
      req.user?.orgId ||
      req.orgId

    const userId = req.user?.userId || req.user?.id || req.user?._id
    const membership = await Membership.findOne({
      userId,
      orgId,
      status: { $nin: ["disabled", "suspended"] },
    }).lean()

    if (!membership) {
      return res.status(403).json({ ok: false, message: "Workspace access denied" })
    }

    const unified = await getUnifiedWorkspaceData(orgId, { days: 30 })
    const revenue30 = unified.metrics.reduce(
      (sum, metric) => sum + Number(metric.revenue || 0),
      0
    )
    const metrics = { revenue30 }

    const signals = calculateOperatorSignals({
      deals: unified.deals,
      metrics,
    })

    res.json({
      ok: true,
      signals,
      dataSources: unified.dataSources,
    })

  } catch (err) {

    console.error(err)
    res.status(500).json({ error: "Operator signals failed" })

  }

})

export default router
