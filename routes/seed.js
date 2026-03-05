// backend/routes/seed.js
import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";

import Membership from "../models/Membership.js";
import Client from "../models/Client.js";
import Deal from "../models/Deal.js";

// ⚠️ You need an Org model/collection. If you already have one, import it here.
// If your project uses a different name (Workspace/Org), change this import.
import Org from "../models/Org.js";

const router = express.Router();

const toObjectId = (v) => {
  if (!v) return null;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
};

router.post("/refresh", requireAuth, async (req, res) => {
  try {
    const db = mongoose.connection;

    const userId = toObjectId(req.user?.userId || req.user?._id);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    // 1) Try to resolve orgId from header or user payload
    const headerOrgId = toObjectId(req.headers["x-org-id"]);
    const defaultOrgId = toObjectId(req.user?.orgId);
    let orgId = headerOrgId || defaultOrgId;

    // 2) If still missing, try membership lookup
    if (!orgId) {
      const m = await Membership.findOne({ userId, status: { $ne: "disabled" } })
        .select("orgId")
        .lean();
      orgId = toObjectId(m?.orgId);
    }

    // 3) If STILL missing, create a brand new org + membership
    if (!orgId) {
      const org = await Org.create({
        name: "Butler & Co (Demo Workspace)",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      orgId = toObjectId(org?._id);

      await Membership.create({
        userId,
        orgId,
        role: "owner",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    // 4) Ensure membership exists (if orgId exists but membership doesn't)
    const membership = await Membership.findOne({
      userId,
      orgId,
      status: { $ne: "disabled" },
    })
      .select("_id status role")
      .lean();

    if (!membership) {
      await Membership.create({
        userId,
        orgId,
        role: "owner",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    // 5) Wipe existing demo data
    await Promise.all([
      Deal.deleteMany({ orgId }),
      Client.deleteMany({ orgId }),
      db.collection("integrations").deleteMany({ orgId }),
      db.collection("metrics_daily").deleteMany({ orgId }),
    ]);

    // 6) Seed demo data
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
      },
      {
        orgId,
        clientId: clients[0]._id,
        name: "Example Deal — Revenue Intel Rollout",
        stage: "Proposal",
        amount: 48000,
        probability: 0.55,
        nextAction: "Send proposal + confirm stakeholders",
      },
      {
        orgId,
        clientId: clients[1]._id,
        name: "Example Deal — HubSpot + Attribution Setup",
        stage: "Follow-Up",
        amount: 22000,
        probability: 0.45,
        nextAction: "Book technical walkthrough",
      },
    ]);

    await db.collection("integrations").insertMany([
      { orgId, type: "google_ads", status: "disconnected", createdAt: new Date() },
      { orgId, type: "meta_ads", status: "disconnected", createdAt: new Date() },
      { orgId, type: "hubspot", status: "disconnected", createdAt: new Date() },
    ]);

    const days = 30;
    const metrics = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      metrics.push({
        orgId,
        date: new Date(d.toISOString().slice(0, 10)),
        revenue: i % 7 === 0 ? 0 : Math.round(800 + Math.random() * 1200),
        spend: Math.round(200 + Math.random() * 400),
        leads: Math.round(2 + Math.random() * 8),
      });
    }
    await db.collection("metrics_daily").insertMany(metrics);

    return res.json({
      ok: true,
      orgId: String(orgId),
      clientsInserted: clients.length,
      dealsInserted: 3,
    });
  } catch (e) {
    console.error("seed/refresh error:", e);
    return res.status(500).json({ ok: false, message: e?.message || "seed failed" });
  }
});

export default router;