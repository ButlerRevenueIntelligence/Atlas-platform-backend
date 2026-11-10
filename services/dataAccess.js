import crypto from "node:crypto";
import Acceptance from "../models/DataAccessAcceptance.js";
import Attempt from "../models/DataAccessOAuthAttempt.js";
import Membership from "../models/Membership.js";
import User from "../models/User.js";
import {
  dataAccessMode,
  policySnapshot,
  dataAccessError,
} from "./dataAccessPolicy.js";
export const agreementDigest = (snapshot) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        ...Object.fromEntries(
          [
            "version",
            "legalEntity",
            "documents",
            "purpose",
            "aiProcessing",
            "otherProviders",
            "saleAndTraining",
            "storageAndAccess",
            "retentionAndDeletion",
            "contact",
          ].map((k) => [k, snapshot[k]]),
        ),
      }),
    )
    .digest("hex");
export async function requireDataAccess(orgId, provider, { userId } = {}) {
  if (dataAccessMode() !== "enforce") return null;
  if (!orgId)
    throw dataAccessError("DATA_ACCESS_REQUIRED", "A workspace is required.");
  const policy = policySnapshot(provider);
  if (!policy.ready)
    throw dataAccessError(
      "DATA_ACCESS_NOT_PUBLISHED",
      "The data-use disclosure for this source is awaiting publication. Contact your Atlas administrator.",
      503,
    );
  const receipt = await Acceptance.findOne({
    orgId,
    provider,
    digest: policy.digest,
    ...(userId ? { userId } : {}),
  })
    .sort({ acceptedAt: -1 })
    .lean();
  if (!receipt)
    throw dataAccessError(
      "DATA_ACCESS_REQUIRED",
      "Review data access in Integrations before continuing.",
    );
  return receipt;
}
export async function requireAIDataAccess(orgId) {
  if (dataAccessMode() !== "enforce") return;
  const receipts = await Acceptance.find({ orgId })
    .sort({ acceptedAt: -1 })
    .limit(100)
    .lean();
  const current = receipts.some((r) => {
    const p = policySnapshot(r.provider);
    return p.ready && r.digest === p.digest;
  });
  if (!current)
    throw dataAccessError(
      "DATA_ACCESS_REQUIRED",
      "An authorized administrator must review data access in Integrations before AI analysis.",
    );
}
export function signedState(payload) {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) throw new Error("OAUTH_STATE_SECRET is not configured");
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${crypto.createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}
export function verifiedState(state, provider, now = Date.now()) {
  const parts = String(state || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1])
    throw dataAccessError(
      "DATA_ACCESS_STATE_INVALID",
      "Invalid authorization state.",
      400,
    );
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) throw new Error("OAUTH_STATE_SECRET is not configured");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(parts[0])
    .digest("base64url");
  const a = Buffer.from(parts[1]),
    b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
    throw dataAccessError(
      "DATA_ACCESS_STATE_INVALID",
      "Invalid authorization state.",
      400,
    );
  let p;
  try {
    p = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  } catch {
    throw dataAccessError(
      "DATA_ACCESS_STATE_INVALID",
      "Invalid authorization state.",
      400,
    );
  }
  if (
    p.provider !== provider ||
    !p.orgId ||
    !Number.isFinite(p.exp) ||
    p.exp <= now ||
    !Number.isFinite(p.iat) ||
    p.iat > now + 60000 ||
    p.exp - p.iat > 600000
  )
    throw dataAccessError(
      "DATA_ACCESS_STATE_INVALID",
      "Invalid or expired authorization state.",
      400,
    );
  return p;
}
export async function prepareOAuthReview(req, provider) {
  const receipt = await requireDataAccess(req.user.orgId, provider, {
    userId: req.user.userId || req.user.id,
  });
  if (!receipt) return;
  const attempt = await Attempt.create({
    orgId: req.user.orgId,
    userId: req.user.userId || req.user.id,
    provider,
    acceptanceId: receipt._id,
    digest: receipt.digest,
    expiresAt: new Date(Date.now() + 600000),
  });
  const original = req.res.json.bind(req.res);
  req.res.json = (body) => {
    if (body?.authUrl) {
      const url = new URL(body.authUrl);
      const payload = verifiedState(url.searchParams.get("state"), provider);
      if (String(payload.orgId) !== String(req.user.orgId))
        throw dataAccessError(
          "DATA_ACCESS_STATE_INVALID",
          "Workspace mismatch.",
          400,
        );
      payload.dataAccessAttempt = String(attempt._id);
      payload.dataAccessUser = String(attempt.userId);
      url.searchParams.set("state", signedState(payload));
      return original({ ...body, authUrl: url.toString() });
    }
    return original(body);
  };
}
export async function validateOAuthReview(req, res, next) {
  try {
    if (dataAccessMode() !== "enforce") return next();
    const provider = req.path.split("/").filter(Boolean)[0];
    // Provider denial starts no processing and needs no successful acceptance callback.
    if (req.query.error && !req.query.code) return next();
    const state = verifiedState(req.query.state, provider);
    if (
      !/^[a-f0-9]{24}$/i.test(state.dataAccessAttempt || "") ||
      !/^[a-f0-9]{24}$/i.test(state.dataAccessUser || "")
    )
      throw dataAccessError(
        "DATA_ACCESS_STATE_INVALID",
        "Start a new connection after reviewing data access.",
        400,
      );
    const receipt = await requireDataAccess(state.orgId, provider, {
      userId: state.dataAccessUser,
    });
    const member = await Membership.findOne({
      orgId: state.orgId,
      userId: state.dataAccessUser,
      status: "active",
      role: { $in: ["owner", "admin"] },
    }).lean();
    const user = await User.findById(state.dataAccessUser)
      .select("_id status")
      .lean();
    if (!member || !user || ["disabled", "suspended"].includes(user.status))
      throw dataAccessError(
        "DATA_ACCESS_FORBIDDEN",
        "An active workspace administrator must restart this connection.",
        403,
      );
    const used = await Attempt.findOneAndUpdate(
      {
        _id: state.dataAccessAttempt,
        orgId: state.orgId,
        userId: state.dataAccessUser,
        provider,
        acceptanceId: receipt._id,
        digest: receipt.digest,
        consumedAt: null,
        expiresAt: { $gt: new Date() },
      },
      { $set: { consumedAt: new Date() } },
      { new: true },
    ).lean();
    if (!used)
      throw dataAccessError(
        "DATA_ACCESS_STATE_INVALID",
        "Authorization expired or was already used. Start a new connection.",
        400,
      );
    return next();
  } catch (error) {
    return res
      .status(error.status || 500)
      .json({
        ok: false,
        code: error.code || "DATA_ACCESS_FAILED",
        message: error.status ? error.message : "Unable to verify data access.",
      });
  }
}
export async function mayProcessData(orgId, provider) {
  try {
    await requireDataAccess(orgId, provider);
    return true;
  } catch (error) {
    if (
      ["DATA_ACCESS_REQUIRED", "DATA_ACCESS_NOT_PUBLISHED"].includes(error.code)
    )
      return false;
    throw error;
  }
}
