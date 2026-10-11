import { requireAuth } from "./auth.js";

// Authenticate before using a caller-supplied workspace in provider requests.
export function integrationWorkspace(req, res, next) {
  return requireAuth(req, res, () => {
    const orgId = String(req.user?.orgId || "");
    if (!orgId) return res.status(400).json({ ok: false, message: "Missing workspace" });
    for (const supplied of [req.query?.orgId, req.body?.orgId]) {
      if (supplied && String(supplied) !== orgId) {
        return res.status(403).json({ ok: false, message: "Workspace does not match authenticated context" });
      }
    }
    req.orgId = orgId;
    req.headers["x-org-id"] = orgId;
    return next();
  });
}
