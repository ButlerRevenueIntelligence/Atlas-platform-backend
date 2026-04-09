// backend/routes/attribution.js
import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import Membership from "../models/Membership.js";
import Organization from "../models/Organization.js";

const router = express.Router();

const safeNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const toObjectId = (v) => {
  if (!v) return null;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
};

function pickUserId(req) {
  return (
    toObjectId(req.user?.userId) ||
    toObjectId(req.user?.id) ||
    toObjectId(req.user?._id) ||
    null
  );
}

function pickOrgId(req) {
  const header =
    req.headers["x-org-id"] ||
    req.headers["X-Org-Id"] ||
    req.headers["x-workspace-id"] ||
    req.headers["X-Workspace-Id"];

  const headerOrgId = toObjectId(header);
  const defaultOrgId =
    toObjectId(req.user?.orgId) ||
    toObjectId(req.user?.organizationId) ||
    toObjectId(req.user?.org) ||
    toObjectId(req.user?.activeWorkspace) ||
    null;

  return headerOrgId || defaultOrgId || null;
}

async function requireMembershipOr403({ userId, orgId }) {
  const membership = await Membership.findOne({
    userId,
    orgId,
    status: { $ne: "disabled" },
  })
    .select("_id role status userId orgId")
    .lean();

  return membership || null;
}

function detectWorkspaceMode(org) {
  const slug = String(org?.slug || "").toLowerCase();
  const name = String(org?.name || "").toLowerCase();
  const explicitMode = String(org?.workspaceMode || "").toLowerCase();

  const isAtlasDemoWorkspace =
    slug === "atlas-demo-company" ||
    name === "atlas demo company";

  if (isAtlasDemoWorkspace) return "demo";
  if (explicitMode === "demo") return "demo";

  return "live";
}

function buildFallback() {
  const rows = [
    { channel: "Google Ads", spend: 6200, leads: 210, revenue: 16200 },
    { channel: "Meta Ads", spend: 4300, leads: 180, revenue: 9800 },
    { channel: "LinkedIn Ads", spend: 2200, leads: 55, revenue: 7600 },
    { channel: "SEO", spend: 900, leads: 130, revenue: 11200 },
    { channel: "Email", spend: 250, leads: 60, revenue: 4200 },
  ];

  return rows.map((r) => {
    const spend = safeNum(r.spend);
    const revenue = safeNum(r.revenue);
    const roi = spend > 0 ? (revenue - spend) / spend : null;

    return {
      ...r,
      spend,
      revenue,
      leads: safeNum(r.leads),
      roi,
    };
  });
}

function buildEmptyChannels() {
  return [];
}

/**
 * GET /api/attribution/summary
 * Org-scoped (x-org-id) with membership validation.
 * Demo data is returned ONLY for the true Atlas demo workspace.
 * All live workspaces return empty data until real attribution exists.
 */
router.get("/summary", requireAuth, async (req, res) => {
  try {
    const userId = pickUserId(req);
    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized",
      });
    }

    const orgId = pickOrgId(req);
    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context (x-org-id).",
      });
    }

    const membership = await requireMembershipOr403({ userId, orgId });
    if (!membership) {
      return res.status(403).json({
        ok: false,
        message: "Not a member of this workspace",
      });
    }

    const org = await Organization.findById(orgId)
      .select("_id name slug workspaceMode isDemo")
      .lean();

    if (!org) {
      return res.status(404).json({
        ok: false,
        message: "Workspace not found",
      });
    }

    const workspaceMode = detectWorkspaceMode(org);

    const channels =
      workspaceMode === "demo" ? buildFallback() : buildEmptyChannels();

    const totals = channels.reduce(
      (acc, c) => {
        acc.spend += safeNum(c.spend);
        acc.leads += safeNum(c.leads);
        acc.revenue += safeNum(c.revenue);
        return acc;
      },
      { spend: 0, leads: 0, revenue: 0 }
    );

    const overallROI =
      totals.spend > 0 ? (totals.revenue - totals.spend) / totals.spend : null;

    return res.json({
      ok: true,
      dataAsOf: new Date().toISOString(),
      totals: {
        ...totals,
        roi: overallROI,
      },
      channels,
      source: workspaceMode === "demo" ? "demo-fallback" : "empty-live",
      workspaceMode,
    });
  } catch (err) {
    console.error("Attribution summary error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Attribution failed",
    });
  }
});

export default router;