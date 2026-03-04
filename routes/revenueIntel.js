// backend/routes/revenueIntel.js
import express from "express";
import { requireAuth, requirePerm } from "../middleware/auth.js";

const router = express.Router();

/**
 * GET /api/revenue-intel/board
 * Permission: command_center.view (or use a more specific perm if you want)
 */
router.get("/board", requireAuth, requirePerm("command_center.view"), async (req, res) => {
  // If you already have logic here, paste it in this handler
  // I'm keeping this safe and simple as a locked example
  return res.json({
    ok: true,
    scope: {
      orgId: req.user.orgId,
      plan: req.user.plan,
      orgRole: req.user.orgRole,
    },
    board: [],
    message: "Revenue Intel board is locked behind permissions.",
  });
});

/**
 * GET /api/revenue-intel/health
 * Permission: dashboard.view (or remove requirePerm if you want it public)
 */
router.get("/health", requireAuth, requirePerm("dashboard.view"), (req, res) => {
  res.json({ ok: true, orgId: req.user.orgId });
});

export default router;