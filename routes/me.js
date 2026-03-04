import express from "express";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/**
 * GET /api/me
 * Requires Authorization: Bearer <token>
 * Returns the decoded JWT payload (whatever you signed on login)
 */
router.get("/", requireAuth, (req, res) => {
  return res.json({ ok: true, user: req.user });
});

export default router;