// backend/scripts/demoSeed.js
import "dotenv/config";
import mongoose from "mongoose";

import Client from "../models/Client.js";
import Deal from "../models/Deal.js";

const toObjectId = (v) => {
  if (!v) return null;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
};

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function isoDay(d) {
  // YYYY-MM-DD
  return d.toISOString().slice(0, 10);
}

async function main() {
  const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!MONGO_URI) {
    console.error("❌ Missing MONGO_URI (or MONGODB_URI) in .env");
    process.exit(1);
  }

  const orgId = toObjectId(process.env.DEMO_ORG_ID);
  const userId = toObjectId(process.env.DEMO_USER_ID);

  if (!orgId) {
    console.error("❌ Missing/invalid DEMO_ORG_ID in .env");
    process.exit(1);
  }

  // userId is optional, but nice for createdBy fields
  const createdBy = userId || null;

  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection;

  console.log("✅ Connected");
  console.log("Org:", String(orgId));

  // Some projects accidentally saved orgId as STRING in collections.
  // We'll wipe both forms so you don't end up with split data.
  const orgIdStr = String(orgId);

  // Wipe demo data (scoped to this org only)
  await Promise.all([
    Deal.deleteMany({ orgId }),
    Deal.deleteMany({ orgId: orgIdStr }),
    Client.deleteMany({ orgId }),
    Client.deleteMany({ orgId: orgIdStr }),
    db.collection("integrations").deleteMany({ orgId }),
    db.collection("integrations").deleteMany({ orgId: orgIdStr }),
    db.collection("metrics_daily").deleteMany({ orgId }),
    db.collection("metrics_daily").deleteMany({ orgId: orgIdStr }),
  ]);

  // --- Create demo clients (NO emails to avoid unique collisions) ---
  const clients = await Client.insertMany([
    {
      orgId,
      name: "Demo Client — Butler & Co",
      industry: "B2B Services",
      website: "https://example.com",
      primaryContactName: "Demo Contact",
      primaryContactEmail: "",
      primaryContactPhone: "",
      status: "active",
      notes: "Seeded client for demo.",
      createdBy,
      updatedBy: createdBy,
    },
    {
      orgId,
      name: "Demo Client — Atlas Manufacturing",
      industry: "Manufacturing",
      website: "https://example.com",
      primaryContactName: "Ops Director",
      primaryContactEmail: "",
      primaryContactPhone: "",
      status: "prospect",
      notes: "Seeded client for demo.",
      createdBy,
      updatedBy: createdBy,
    },
    {
      orgId,
      name: "Demo Client — Summit SaaS",
      industry: "SaaS",
      website: "https://example.com",
      primaryContactName: "VP Growth",
      primaryContactEmail: "",
      primaryContactPhone: "",
      status: "prospect",
      notes: "Seeded client for demo.",
      createdBy,
      updatedBy: createdBy,
    },
  ]);

  // --- Create demo deals (match your enum stages exactly) ---
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
    {
      orgId,
      clientId: clients[2]._id,
      name: "Example Deal — GTM + Paid Search Pilot",
      stage: "Negotiation",
      amount: 32000,
      probability: 0.6,
      nextAction: "Finalize scope + procurement",
    },
  ]);

  // --- Integrations ---
  await db.collection("integrations").insertMany([
    { orgId, type: "google_ads", status: "disconnected", createdAt: new Date() },
    { orgId, type: "meta_ads", status: "disconnected", createdAt: new Date() },
    { orgId, type: "hubspot", status: "disconnected", createdAt: new Date() },
  ]);

  // --- Metrics (30 days) ---
  // We generate realistic curves so your charts look good in demos.
  const rand = mulberry32(1337);
  const days = 30;
  const metrics = [];

  // Trend controls
  let baseRevenue = 1400; // daily starting revenue
  let baseSpend = 520;    // daily spend
  let baseLeads = 18;     // daily leads

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);

    // gentle upward trend + weekly pattern + noise
    const weekly = Math.sin(((days - i) / 7) * Math.PI * 2) * 180; // +/-180 swing
    const noiseR = (rand() - 0.5) * 260;
    const noiseS = (rand() - 0.5) * 90;
    const noiseL = (rand() - 0.5) * 6;

    // small drift upward
    baseRevenue += 14 + rand() * 18;
    baseSpend += 4 + rand() * 8;
    baseLeads += 0.12 + rand() * 0.18;

    let revenue = Math.max(0, Math.round(baseRevenue + weekly + noiseR));
    let spend = Math.max(0, Math.round(baseSpend + weekly * 0.25 + noiseS));
    let leads = Math.max(0, Math.round(baseLeads + weekly * 0.01 + noiseL));

    // occasional low day (like weekends)
    if ((days - i) % 7 === 0) {
      revenue = Math.round(revenue * 0.55);
      spend = Math.round(spend * 0.75);
      leads = Math.round(leads * 0.7);
    }

    // IMPORTANT: store date as a Date (normalized to day)
    // using UTC midnight from YYYY-MM-DD string:
    const day = new Date(isoDay(d));

    metrics.push({
      orgId,
      date: day,
      revenue,
      spend,
      leads,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  await db.collection("metrics_daily").insertMany(metrics);

  console.log("✅ Seed complete");
  console.log(`Clients: ${clients.length}`);
  console.log("Deals: 4");
  console.log(`Metrics days: ${metrics.length}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ Seed failed:", e);
  process.exit(1);
});