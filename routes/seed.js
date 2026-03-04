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

router.post("/refresh", requireAuth, async (req, res) => {
  try {
    const db = mongoose.connection;

    const userId = toObjectId(req.user?.userId || req.user?._id);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    // org from header first
    const headerOrgId = toObjectId(req.headers["x-org-id"]);
    const defaultOrgId = toObjectId(req.user?.orgId);
    let orgId = headerOrgId || defaultOrgId;

    // fallback membership lookup
    if (!orgId) {
      const m = await Membership.findOne({ userId, status: "active" })
        .select("orgId")
        .lean();
      orgId = toObjectId(m?.orgId);
    }

    if (!orgId)
      return res.status(400).json({ ok: false, message: "Missing org context" });

    // validate membership
    const membership = await Membership.findOne({
      userId,
      orgId,
      status: { $ne: "disabled" },
    })
      .select("_id")
      .lean();

    if (!membership) {
      return res
        .status(403)
        .json({ ok: false, message: "Not authorized for this workspace" });
    }

    // wipe existing demo data
    await Promise.all([
      Deal.deleteMany({ orgId }),
      Client.deleteMany({ orgId }),
      db.collection("integrations").deleteMany({ orgId }),
      db.collection("metrics_daily").deleteMany({ orgId }),
    ]);

    // generate unique demo emails per org
    const emailA = `demo-owner+${String(orgId)}@atlasrevenueai.com`;
    const emailB = `ops-director+${String(orgId)}@atlasrevenueai.com`;

    // create demo clients
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

    // create demo deals
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

    // integrations
    await db.collection("integrations").insertMany([
      { orgId, type: "google_ads", status: "disconnected", createdAt: new Date() },
      { orgId, type: "meta_ads", status: "disconnected", createdAt: new Date() },
      { orgId, type: "hubspot", status: "disconnected", createdAt: new Date() },
    ]);

    // metrics
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
    return res
      .status(500)
      .json({ ok: false, message: e?.message || "seed failed" });
  }
});

export default router;