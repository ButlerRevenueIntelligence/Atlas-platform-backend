// backend/routes/seed.js
import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";

import Membership from "../models/Membership.js";
import Client from "../models/Client.js";
import Deal from "../models/Deal.js";

const router = express.Router();

const toObjectId = (v) => {
  if (!v) return null;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
};

const now = () => new Date();

const slugify = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

async function ensureOrgAndMembership({ db, userId, headerOrgId, userOrgId }) {
  // 1) Prefer header org
  let orgId = headerOrgId || userOrgId;

  // 2) If missing, find first active membership
  if (!orgId) {
    const m = await Membership.findOne({ userId, status: { $ne: "disabled" } })
      .select("orgId")
      .lean();
    orgId = toObjectId(m?.orgId);
  }

  // 3) If still missing, create a new org in "orgs" collection
  if (!orgId) {
    const name = "Butler & Co Workspace";
    const slug = `${slugify(name)}-${String(userId).slice(-6)}`;
    const t = now();

    const ins = await db.collection("orgs").insertOne({
      name,
      slug,
      type: "agency",
      ownerId: userId,
      plan: "SCALE",
      createdAt: t,
      updatedAt: t,
    });

    orgId = ins.insertedId;

    await Membership.create({
      userId,
      orgId,
      role: "owner",
      status: "active",
      createdAt: t,
      updatedAt: t,
    });
  }

  // 4) Ensure membership exists for this org
  const membership = await Membership.findOne({
    userId,
    orgId,
    status: { $ne: "disabled" },
  })
    .select("_id")
    .lean();

  if (!membership) {
    const t = now();
    await Membership.create({
      userId,
      orgId,
      role: "owner",
      status: "active",
      createdAt: t,
      updatedAt: t,
    });
  }

  return orgId;
}

router.post("/refresh", requireAuth, async (req, res) => {
  try {
    // ✅ Use native Mongo DB handle
    const db = mongoose.connection?.db;
    if (!db) {
      return res.status(500).json({ ok: false, message: "DB not ready" });
    }

    const userId = toObjectId(req.user?.userId || req.user?._id);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const headerOrgId = toObjectId(req.headers["x-org-id"]);
    const userOrgId = toObjectId(req.user?.orgId);

    const orgId = await ensureOrgAndMembership({
      db,
      userId,
      headerOrgId,
      userOrgId,
    });

    // -------------------- Wipe existing demo data --------------------
    await Promise.all([
      Deal.deleteMany({ orgId }),
      Client.deleteMany({ orgId }),

      // Integrations: wipe by org + also remove any bad docs with null/missing key
      db.collection("integrations").deleteMany({ orgId }),
      db.collection("integrations").deleteMany({
        orgId,
        $or: [{ key: null }, { key: { $exists: false } }],
      }),

      db.collection("metrics_daily").deleteMany({ orgId }),
    ]);

    // -------------------- Seed Clients + Deals --------------------
const emailA = `demo-owner+${String(orgId)}@atlasrevenueai.com`;
const emailB = `ops-director+${String(orgId)}@atlasrevenueai.com`;

const clients = await Client.insertMany([
  {
    orgId,
    name: "Northstar Technology Group",
    industry: "Information Technology",
    website: "https://example.com",
    primaryContactName: "Michael Grant",
    primaryContactEmail: emailA,
    primaryContactPhone: "",
    status: "active",
    notes: "Enterprise technology prospect.",
    createdBy: userId,
    updatedBy: userId,
    createdAt: now(),
    updatedAt: now(),
  },
  {
    orgId,
    name: "Atlas Manufacturing",
    industry: "Manufacturing",
    website: "https://example.com",
    primaryContactName: "Sarah Mitchell",
    primaryContactEmail: emailB,
    primaryContactPhone: "",
    status: "prospect",
    notes: "Manufacturing revenue intelligence opportunity.",
    createdBy: userId,
    updatedBy: userId,
    createdAt: now(),
    updatedAt: now(),
  },
  {
    orgId,
    name: "Elevate Financial Partners",
    industry: "Financial Services",
    website: "https://example.com",
    primaryContactName: "David Brooks",
    primaryContactEmail: `finance+${String(orgId)}@atlasrevenueai.com`,
    primaryContactPhone: "",
    status: "active",
    notes: "Financial services expansion opportunity.",
    createdBy: userId,
    updatedBy: userId,
    createdAt: now(),
    updatedAt: now(),
  },
  {
    orgId,
    name: "Summit B2B Solutions",
    industry: "Professional Services",
    website: "https://example.com",
    primaryContactName: "Jessica Carter",
    primaryContactEmail: `summit+${String(orgId)}@atlasrevenueai.com`,
    primaryContactPhone: "",
    status: "prospect",
    notes: "B2B professional services prospect.",
    createdBy: userId,
    updatedBy: userId,
    createdAt: now(),
    updatedAt: now(),
  },
  {
    orgId,
    name: "Vertex Growth Agency",
    industry: "Marketing Agency",
    website: "https://example.com",
    primaryContactName: "Anthony Reed",
    primaryContactEmail: `vertex+${String(orgId)}@atlasrevenueai.com`,
    primaryContactPhone: "",
    status: "active",
    notes: "Agency Global HQ opportunity.",
    createdBy: userId,
    updatedBy: userId,
    createdAt: now(),
    updatedAt: now(),
  },
]);

const daysAgo = (days, hour = 12) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, 0, 0, 0);
  return d;
};

const daysFromNow = (days, hour = 12) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
};

const dealTemplates = [
  {
    clientIndex: 0,
    name: "Enterprise Revenue Intelligence Rollout",
    stage: "Negotiation",
    amount: 120000,
    probability: 0.82,
    createdDaysAgo: 24,
    lastActivityDaysAgo: 1,
    closeDaysFromNow: 12,
    nextAction: "Finalize security review and commercial terms",
  },
  {
    clientIndex: 1,
    name: "Manufacturing Pipeline Visibility Program",
    stage: "Proposal",
    amount: 85000,
    probability: 0.65,
    createdDaysAgo: 21,
    lastActivityDaysAgo: 3,
    closeDaysFromNow: 18,
    nextAction: "Review proposal with VP of Sales",
  },
  {
    clientIndex: 2,
    name: "Executive Forecasting Expansion",
    stage: "Follow-Up",
    amount: 64000,
    probability: 0.48,
    createdDaysAgo: 18,
    lastActivityDaysAgo: 5,
    closeDaysFromNow: 25,
    nextAction: "Confirm finance and RevOps stakeholders",
  },
  {
    clientIndex: 3,
    name: "Revenue Operations Assessment",
    stage: "Discovery",
    amount: 42000,
    probability: 0.3,
    createdDaysAgo: 14,
    lastActivityDaysAgo: 2,
    closeDaysFromNow: 32,
    nextAction: "Complete discovery session",
  },
  {
    clientIndex: 4,
    name: "Agency Global HQ Deployment",
    stage: "Negotiation",
    amount: 96000,
    probability: 0.78,
    createdDaysAgo: 27,
    lastActivityDaysAgo: 2,
    closeDaysFromNow: 9,
    nextAction: "Confirm workspace requirements",
  },
  {
    clientIndex: 0,
    name: "CRM and Attribution Integration",
    stage: "Proposal",
    amount: 55000,
    probability: 0.6,
    createdDaysAgo: 11,
    lastActivityDaysAgo: 1,
    closeDaysFromNow: 20,
    nextAction: "Send integration scope",
  },
  {
    clientIndex: 1,
    name: "Sales Forecast Optimization",
    stage: "Follow-Up",
    amount: 38000,
    probability: 0.44,
    createdDaysAgo: 9,
    lastActivityDaysAgo: 4,
    closeDaysFromNow: 28,
    nextAction: "Schedule technical walkthrough",
  },
  {
    clientIndex: 2,
    name: "Account Intelligence Pilot",
    stage: "Discovery",
    amount: 28000,
    probability: 0.25,
    createdDaysAgo: 6,
    lastActivityDaysAgo: 1,
    closeDaysFromNow: 35,
    nextAction: "Identify pilot accounts",
  },

  // Stale opportunities
  {
    clientIndex: 3,
    name: "Pipeline Health Initiative",
    stage: "Proposal",
    amount: 73000,
    probability: 0.52,
    createdDaysAgo: 29,
    lastActivityDaysAgo: 19,
    closeDaysFromNow: 15,
    nextAction: "Re-engage executive sponsor",
  },
  {
    clientIndex: 4,
    name: "Multi-Client Reporting Expansion",
    stage: "Follow-Up",
    amount: 46000,
    probability: 0.4,
    createdDaysAgo: 26,
    lastActivityDaysAgo: 17,
    closeDaysFromNow: 22,
    nextAction: "Follow up on reporting requirements",
  },
  {
    clientIndex: 1,
    name: "Revenue Data Consolidation",
    stage: "Discovery",
    amount: 34000,
    probability: 0.2,
    createdDaysAgo: 23,
    lastActivityDaysAgo: 16,
    closeDaysFromNow: 30,
    nextAction: "Confirm project timeline",
  },

  // Closed Won
  {
    clientIndex: 0,
    name: "Revenue Command Center Launch",
    stage: "Closed Won",
    amount: 58000,
    probability: 1,
    createdDaysAgo: 28,
    lastActivityDaysAgo: 8,
    closeDaysAgo: 8,
    nextAction: "Begin onboarding",
    closedReason: "Strong executive alignment and clear ROI",
  },
  {
    clientIndex: 2,
    name: "Forecast Accuracy Pilot",
    stage: "Closed Won",
    amount: 36000,
    probability: 1,
    createdDaysAgo: 22,
    lastActivityDaysAgo: 6,
    closeDaysAgo: 6,
    nextAction: "Launch pilot workspace",
    closedReason: "Needed stronger forecast visibility",
  },
  {
    clientIndex: 4,
    name: "Agency Reporting Automation",
    stage: "Closed Won",
    amount: 49000,
    probability: 1,
    createdDaysAgo: 19,
    lastActivityDaysAgo: 4,
    closeDaysAgo: 4,
    nextAction: "Connect client data sources",
    closedReason: "Manual reporting was limiting growth",
  },
  {
    clientIndex: 1,
    name: "Pipeline Risk Detection",
    stage: "Closed Won",
    amount: 67000,
    probability: 1,
    createdDaysAgo: 16,
    lastActivityDaysAgo: 2,
    closeDaysAgo: 2,
    nextAction: "Start implementation",
    closedReason: "Leadership needed earlier risk detection",
  },

  // Closed Lost
  {
    clientIndex: 3,
    name: "Executive Analytics Modernization",
    stage: "Closed Lost",
    amount: 51000,
    probability: 0,
    createdDaysAgo: 25,
    lastActivityDaysAgo: 10,
    closeDaysAgo: 10,
    nextAction: "",
    closedReason: "Budget postponed until next quarter",
    reactivationDaysFromNow: 60,
  },
  {
    clientIndex: 2,
    name: "Customer Intelligence Expansion",
    stage: "Closed Lost",
    amount: 44000,
    probability: 0,
    createdDaysAgo: 20,
    lastActivityDaysAgo: 7,
    closeDaysAgo: 7,
    nextAction: "",
    closedReason: "Selected incumbent provider",
    competitor: "Legacy analytics vendor",
    reactivationDaysFromNow: 90,
  },
];

const seededDeals = dealTemplates.map((deal, index) => {
  const createdAt = daysAgo(deal.createdDaysAgo, 9 + (index % 7));
  const lastActivityAt = daysAgo(
    deal.lastActivityDaysAgo,
    10 + (index % 6)
  );

  const isClosed =
    deal.stage === "Closed Won" || deal.stage === "Closed Lost";

  const closedAt =
    deal.closeDaysAgo != null
      ? daysAgo(deal.closeDaysAgo, 15)
      : null;

  const closeDate =
    deal.closeDaysAgo != null
      ? daysAgo(deal.closeDaysAgo, 15)
      : daysFromNow(deal.closeDaysFromNow || 30, 15);

  return {
    orgId,
    workspaceId: orgId,
    clientId: clients[deal.clientIndex]._id,
    name: deal.name,
    stage: deal.stage,
    amount: deal.amount,
    probability: deal.probability,
    closeDate,
    nextAction: deal.nextAction || "",
    nextActionDueAt: isClosed ? null : daysFromNow((index % 7) + 1, 10),
    lastActivityAt,
    lastActivityType: isClosed ? "stage_move" : "meeting",
    lastActivityNote: isClosed
      ? `Deal moved to ${deal.stage}`
      : "Stakeholder follow-up completed",
    activities: [
      {
        type: "system",
        note: `Deal created in stage: ${deal.stage}`,
        nextAction: deal.nextAction || "",
        createdAt,
        createdBy: userId,
      },
      {
        type: isClosed ? "stage_move" : "meeting",
        note: isClosed
          ? `Deal moved to ${deal.stage}`
          : "Stakeholder follow-up completed",
        nextAction: deal.nextAction || "",
        createdAt: lastActivityAt,
        createdBy: userId,
      },
    ],
    closedAt,
    closedReason: deal.closedReason || "",
    competitor: deal.competitor || "",
    reactivationAt:
      deal.reactivationDaysFromNow != null
        ? daysFromNow(deal.reactivationDaysFromNow)
        : null,
    archivedAt: null,
    createdAt,
    updatedAt: lastActivityAt,
  };
});

const insertedDeals = await Deal.insertMany(seededDeals);

    // -------------------- Seed Integrations (FIX: never key:null) --------------------
    // DB has unique index: { orgId: 1, key: 1 }
    const integrations = [
      { type: "google_ads", key: "google_ads", status: "disconnected" },
      { type: "meta_ads", key: "meta_ads", status: "disconnected" },
      { type: "hubspot", key: "hubspot", status: "disconnected" },
    ];

    await db.collection("integrations").bulkWrite(
      integrations.map((i) => ({
        updateOne: {
          filter: { orgId, key: i.key },
          update: {
            $set: {
              orgId,
              type: i.type,
              key: i.key,
              status: i.status,
              updatedAt: now(),
            },
            $setOnInsert: { createdAt: now() },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );

    // -------------------- Seed Metrics (30 days) --------------------
    const days = 30;
    const metrics = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);

      // normalize to date-only
      const dateOnly = new Date(d.toISOString().slice(0, 10));

      metrics.push({
        orgId,
        date: dateOnly,
        revenue: i % 7 === 0 ? 0 : Math.round(800 + Math.random() * 1200),
        spend: Math.round(200 + Math.random() * 400),
        leads: Math.round(2 + Math.random() * 8),
        createdAt: now(),
        updatedAt: now(),
      });
    }
    if (metrics.length) {
      await db.collection("metrics_daily").insertMany(metrics, { ordered: false });
    }

    return res.json({
      ok: true,
      orgId: String(orgId),
      clientsInserted: clients.length,
      dealsInserted: insertedDeals.length,
      integrationsUpserted: integrations.length,
      metricsInserted: metrics.length,
    });
  } catch (e) {
    console.error("seed/refresh error:", e);
    return res.status(500).json({
      ok: false,
      message: e?.message || "seed failed",
    });
  }
});

export default router;
