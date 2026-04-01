import express from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  getCurrentOrganization,
  getMyOrganizations,
} from "../controllers/organizationsController.js";

const router = express.Router();

router.get("/current", requireAuth, getCurrentOrganization);
router.get("/mine", requireAuth, getMyOrganizations);

export default router;