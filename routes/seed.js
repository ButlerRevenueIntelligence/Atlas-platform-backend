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
        name: "Demo Client — Butler & Co",
        industry: "B2B Services",
        website: "https://example.com",
        primaryContactName: "Demo Contact",
        primaryContactEmail: emailA,
        primaryContactPhone: "",
        status: "active",
        notes: "Seeded client for demo.",
        createdBy: userId,
        updatedBy: userId,
        createdAt: now(),
        updatedAt: now(),
      },
      {
        orgId,
        name: "Demo Client — Atlas Manufacturing",
        industry: "Manufacturing",
        website: "https://example.com",
        primaryContactName: "Ops Director",
        primaryContactEmail: emailB,
        primaryContactPhone: "",
        status: "prospect",
        notes: "Seeded client for demo.",
        createdBy: userId,
        updatedBy: userId,
        createdAt: now(),
        updatedAt: now(),
      },
    ]);

    await Deal.insertMany([
      {
        orgId,
        clientId: clients[0]._id,
        name: "Example Deal — Website + Ads",
        stage: "Discovery",
        amount: 15000,
        probability: 0.35,
        nextAction: "Schedule discovery call",
        createdAt: now(),
        updatedAt: now(),
      },
      {
        orgId,
        clientId: clients[0]._id,
        name: "Example Deal — Revenue Intel Rollout",
        stage: "Proposal",
        amount: 48000,
        probability: 0.55,
        nextAction: "Send proposal + confirm stakeholders",
        createdAt: now(),
        updatedAt: now(),
      },
      {
        orgId,
        clientId: clients[1]._id,
        name: "Example Deal — HubSpot + Attribution Setup",
        stage: "Follow-Up",
        amount: 22000,
        probability: 0.45,
        nextAction: "Book technical walkthrough",
        createdAt: now(),
        updatedAt: now(),
      },
    ]);

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
      dealsInserted: 3,
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