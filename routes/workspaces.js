import express from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  createWorkspace,
  switchWorkspace,
  deleteWorkspace
} from "../controllers/workspaceController.js";

const router = express.Router();

router.post("/", requireAuth, createWorkspace);
router.post("/switch", requireAuth, switchWorkspace);

// 👇 ADD THIS LINE
router.delete("/:workspaceId", requireAuth, deleteWorkspace);

export default router;