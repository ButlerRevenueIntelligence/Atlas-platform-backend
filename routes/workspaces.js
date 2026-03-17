// backend/routes/workspaces.js
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { createWorkspace, switchWorkspace } from "../controllers/workspaceController.js";

const router = express.Router();

router.post("/", requireAuth, createWorkspace);
router.post("/switch", requireAuth, switchWorkspace);

export default router;