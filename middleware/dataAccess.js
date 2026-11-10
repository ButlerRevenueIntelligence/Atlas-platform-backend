import Membership from "../models/Membership.js";
import { dataAccessMode } from "../services/dataAccessPolicy.js";
import {
  requireDataAccess,
  requireAIDataAccess,
  prepareOAuthReview,
} from "../services/dataAccess.js";
export async function dataAccessAdmin(req) {
  // Do not accept global roles or super-admin overrides as customer authorization.
  return Membership.findOne({
    orgId: req.user?.orgId,
    userId: req.user?.userId || req.user?.id,
    status: "active",
    role: { $in: ["owner", "admin"] },
  }).lean();
}
export function accessFailure(res, error) {
  return res
    .status(error.status || 500)
    .json({
      ok: false,
      code: error.code || "DATA_ACCESS_FAILED",
      message: error.status
        ? error.message
        : "Unable to verify data access. Please try again.",
    });
}
export async function integrationDataAccess(req, res, next) {
  try {
    if (dataAccessMode() !== "enforce") return next();
    const parts = req.path.split("/").filter(Boolean);
    const [provider, action] = parts;
    const authorizing =
      action === "auth-url" ||
      (provider === "ghl" && action === "connect") ||
      action === "connect-webhook";
    // Inventory, statuses, disconnection, and local demo connectors remain accessible.
    const imports =
      (!["GET", "HEAD", "OPTIONS"].includes(req.method) &&
        parts.length > 1 &&
        !["test", "disconnect"].includes(action)) ||
      (provider === "ghl" && action === "sync");
    if (!authorizing && !imports) return next();
    if (authorizing && !(await dataAccessAdmin(req)))
      return res
        .status(403)
        .json({
          ok: false,
          message:
            "An active workspace owner or administrator must authorize data access.",
        });
    await requireDataAccess(
      req.user.orgId,
      provider,
      authorizing ? { userId: req.user.userId || req.user.id } : {},
    );
    if (action === "auth-url") await prepareOAuthReview(req, provider);
    // Legacy GHL uses unsigned state. Keep it unavailable under enforcement until repaired.
    if (provider === "ghl" && authorizing)
      return res
        .status(503)
        .json({
          ok: false,
          message:
            "GoHighLevel authorization requires an updated connection flow.",
        });
    return next();
  } catch (error) {
    return accessFailure(res, error);
  }
}
export async function spreadsheetDataAccess(req, res, next) {
  try {
    await requireDataAccess(req.user.orgId, "excel_csv");
    return next();
  } catch (error) {
    return accessFailure(res, error);
  }
}
export async function aiDataAccess(req, res, next) {
  try {
    await requireAIDataAccess(req.user.orgId);
    return next();
  } catch (error) {
    return accessFailure(res, error);
  }
}
