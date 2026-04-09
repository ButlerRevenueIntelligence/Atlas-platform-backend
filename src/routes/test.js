import express from "express";
import { requireAuth } from "../middleware/authMiddleware.js";

const router = express.Router();

router.get("/ping", (req, res) => {
  res.json({ ok: true, route: "test ping works" });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({
    ok: true,
    userId: req.userId,
    orgId: req.orgId,
    role: req.role,
    user: req.user,
  });
});

export default router;
