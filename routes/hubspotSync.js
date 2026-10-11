import express from "express";
import { integrationWorkspace } from "../middleware/integrationWorkspace.js";
import { runRegisteredSync } from "../services/providerSyncRegistry.js";
const router = express.Router();
router.post("/sync", integrationWorkspace, async (req, res) => {
  try { return res.json(await runRegisteredSync("hubspot", req.orgId)); }
  catch (error) { return res.status(error.status || 500).json({ ok: false, message: error.message }); }
});
export default router;