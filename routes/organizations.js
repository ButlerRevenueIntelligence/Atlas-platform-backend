import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { getCurrentOrganization } from "../controllers/organizationsController.js";

const router = express.Router();

router.get("/current", requireAuth, getCurrentOrganization);

export default router;
