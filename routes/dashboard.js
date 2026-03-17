// backend/routes/dashboard.js
import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import Organization from "../models/Organization.js";
import Membership from "../models/Membership.js";
import MetricDaily from "../models/MetricDaily.js";

const router = express.Router();

const toObjectId = (v) => {
  if (!v) return null;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s)
    ? new mongoose.Types.ObjectId(s)
    : null;
};

const coerceNumber = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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
  const headerOrgId =
    toObjectId(req.headers["x-org-id"]) ||
    toObjectId(req.headers["x-workspace-id"]) ||
    null;

  const defaultOrgId =
    toObjectId(req.user?.orgId) ||
    toObjectId(req.user?.organizationId) ||
    toObjectId(req.user?.org) ||
    toObjectId(req.user?.activeWorkspace) ||
    null;

  return headerOrgId || defaultOrgId || null;
}

// Supports older records where orgId may have been stored as string
const orgIdMatch = (orgId) => ({
  $or: [{ orgId }, { orgId: String(orgId) }],
});

const normalizeMetric = (m) => {
  const d = m?.date ? new Date(m.date) : null;
  const valid = d && !Number.isNaN(d.getTime());

  return {
    date: valid ? d.toISOString().slice(0, 10) : null,
    dateISO: valid ? d.toISOString() : null,
    revenue: coerceNumber(m?.revenue, 0),
    spend: coerceNumber(m?.spend, 0),
    leads: coerceNumber(m?.leads, 0),
  };
};

async function getOrgContext(req) {
  const userId = pickUserId(req);
  if (!userId) {
    return {
      ok: false,
      status: 401,
      message: "Unauthorized",
      code: "UNAUTHORIZED",
    };
  }

  const orgId = pickOrgId(req);
  if (!orgId) {
    return {
      ok: false,
      status: 400,
      message: "Missing org context (x-org-id).",
      code: "ORG_CONTEXT_REQUIRED",
      userId,
      orgId: null,
    };
  }

  const membership = await Membership.findOne({
    userId,
    orgId,
    status: { $ne: "disabled" },
  })
    .select("_id role status userId orgId")
    .lean();

  if (!membership) {
    return {
      ok: false,
      status: 403,
      message: "Not a member of this workspace",
      code: "ORG_ACCESS_DENIED",
    };
  }

  return {
    ok: true,
    userId,
    orgId,
    membership,
  };
}

/**
 * GET /api/dashboard
 * Workspace-aware / org-scoped dashboard
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx.ok) {
      return res.status(ctx.status).json({
        ok: false,
        message: ctx.message,
        code: ctx.code,
      });
    }

    const db = mongoose.connection;

    const org = await Organization.findById(ctx.orgId)
      .select("_id name slug plan status billing")
      .lean();

    // Pull tenant-scoped data
    const integrations = await db
      .collection("integrations")
      .find(orgIdMatch(ctx.orgId))
      .toArray();

    const deals = await db
      .collection("deals")
      .find(orgIdMatch(ctx.orgId))
      .toArray();

    let metricsRaw = [];
    try {
      metricsRaw = await MetricDaily.find(orgIdMatch(ctx.orgId))
        .sort({ date: -1 })
        .limit(30)
        .lean();
    } catch (e) {
      metricsRaw = await db
        .collection("metrics_daily")
        .find(orgIdMatch(ctx.orgId))
        .sort({ date: -1 })
        .limit(30)
        .toArray();
    }

    const metrics = (metricsRaw || [])
      .map(normalizeMetric)
      .filter((m) => !!m.date)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const dataAsOf =
      metrics.length && metrics[metrics.length - 1]?.dateISO
        ? metrics[metrics.length - 1].dateISO
        : new Date().toISOString();

    const lastUpdated = new Date().toISOString();

    // KPI calculations
    const revenue30d = metrics.reduce(
      (sum, m) => sum + coerceNumber(m.revenue, 0),
      0
    );

    const spend30d = metrics.reduce(
      (sum, m) => sum + coerceNumber(m.spend, 0),
      0
    );

    const leads30d = metrics.reduce(
      (sum, m) => sum + coerceNumber(m.leads, 0),
      0
    );

    const cac = leads30d > 0 ? spend30d / leads30d : 0;

    const pipelineValue = (deals || []).reduce((sum, d) => {
      const v =
        coerceNumber(d?.amount, 0) ||
        coerceNumber(d?.value, 0) ||
        coerceNumber(d?.pipelineValue, 0);
      return sum + v;
    }, 0);

    const openDeals = (deals || []).filter(
      (d) => !["Closed Won", "Closed Lost"].includes(String(d?.stage || ""))
    ).length;

    const wonDeals = (deals || []).filter(
      (d) => String(d?.stage || "") === "Closed Won"
    ).length;

    const lostDeals = (deals || []).filter(
      (d) => String(d?.stage || "") === "Closed Lost"
    ).length;

    const avgDailyRevenue = metrics.length ? revenue30d / metrics.length : 0;
    const forecast90d = avgDailyRevenue * 90;

    let revenueHealth = 70;
    if (pipelineValue > 0) revenueHealth += 10;
    if (cac > 0 && cac < 300) revenueHealth += 10;
    if (revenue30d > 0) revenueHealth += 10;
    revenueHealth = Math.min(100, revenueHealth);

    return res.json({
      ok: true,
      lastUpdated,
      dataAsOf,

      org,
      activeWorkspace: org
        ? {
            _id: org._id,
            id: org._id,
            name: org.name || "Workspace",
            slug: org.slug || null,
            plan: org.plan || null,
            status: org.status || null,
            billing: org.billing || null,
          }
        : null,

      membership: {
        role: String(ctx.membership.role || "analyst"),
        status: String(ctx.membership.status || "active"),
      },

      summary: {
        revenue: Math.round(revenue30d),
        pipelineValue: Math.round(pipelineValue),
        cac: Math.round(cac),
        forecast90d: Math.round(forecast90d),
        revenueHealth,
        openDeals,
        wonDeals,
        lostDeals,
        integrationsCount: integrations.length,
      },

      // Keep legacy top-level fields for compatibility
      revenue: Math.round(revenue30d),
      pipelineValue: Math.round(pipelineValue),
      cac: Math.round(cac),
      forecast90d: Math.round(forecast90d),
      revenueHealth,

      integrations,
      deals,
      metrics,
    });
  } catch (err) {
    console.error("Dashboard route error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Server error",
    });
  }
});

export default router;