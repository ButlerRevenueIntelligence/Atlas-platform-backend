// backend/seed-demo.js
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("❌ Missing MONGO_URI in backend/.env");
  process.exit(1);
}

const today = new Date();
const dayMs = 24 * 60 * 60 * 1000;

// ---------- Minimal Schemas that match your collection names ----------
const User = mongoose.model(
  "User",
  new mongoose.Schema(
    {
      company: String,
      name: String,
      email: { type: String, unique: true },
      passwordHash: String,
      orgId: mongoose.Schema.Types.ObjectId,
      role: String,
      isActive: Boolean,
    },
    { timestamps: true, collection: "users" }
  )
);

const Organization = mongoose.model(
  "Organization",
  new mongoose.Schema(
    {
      name: String,
      slug: String,
      ownerUserId: mongoose.Schema.Types.ObjectId,
    },
    { timestamps: true, collection: "organizations" }
  )
);

// metricsdailies collection (you already have it)
const MetricsDaily = mongoose.model(
  "MetricsDaily",
  new mongoose.Schema(
    {
      orgId: mongoose.Schema.Types.ObjectId,
      date: Date,
      revenue: Number,
      spend: Number,
      leads: Number,
      customers: Number,
      cac: Number,
    },
    { timestamps: true, collection: "metricsdailies" }
  )
);

// pipeline deals
const PipelineDeal = mongoose.model(
  "PipelineDeal",
  new mongoose.Schema(
    {
      orgId: mongoose.Schema.Types.ObjectId,
      name: String,
      stage: String,
      amount: Number,
      probability: Number,
      closeDate: Date,
      source: String,
    },
    { timestamps: true, collection: "pipelinedeals" } // (new collection; totally fine)
  )
);

// dashboardmetrics collection (you already have it)
const DashboardMetrics = mongoose.model(
  "DashboardMetrics",
  new mongoose.Schema(
    {
      orgId: mongoose.Schema.Types.ObjectId,
      revenue30d: Number,
      pipelineTotal: Number,
      cac: Number,
      forecast90d: Number,
      topChannel: String,
      bestLandingPage: String,
      alerts: [{ message: String, createdAt: Date }],
    },
    { timestamps: true, collection: "dashboardmetrics" }
  )
);

// integrations collection (you already have it)
const Integration = mongoose.model(
  "Integration",
  new mongoose.Schema(
    {
      orgId: mongoose.Schema.Types.ObjectId,
      key: String, // "google-ads", "meta", etc.
      name: String,
      status: String, // "connected" | "disconnected"
      lastSyncAt: Date,
    },
    { timestamps: true, collection: "integrations" }
  )
);

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log("✅ MongoDB connected");

  // 1) Create / find org
  const orgName = "Butler & Co Demo Org";
  let org = await Organization.findOne({ name: orgName });
  if (!org) {
    org = await Organization.create({
      name: orgName,
      slug: "butler-demo",
    });
    console.log("✅ Created org:", org._id.toString());
  } else {
    console.log("✅ Found org:", org._id.toString());
  }

  // 2) Create / find demo user
  // IMPORTANT: your auth route expects passwordHash (bcrypt hash) normally.
  // For demo mode, we are not changing auth here. Use your signup screen to create the user,
  // OR paste your real user's email below so it links to the org.
  const demoEmail = "admin@butlerco.com";

  let user = await User.findOne({ email: demoEmail });
  if (!user) {
    // If you already use signup to create users, do that instead.
    // Here we create a "placeholder" user record so orgId ties correctly.
    user = await User.create({
      company: "Butler & Co",
      name: "Admin",
      email: demoEmail,
      passwordHash: "DEMO_ONLY", // auth may ignore this if user created via signup elsewhere
      orgId: org._id,
      role: "owner",
      isActive: true,
    });
    console.log("✅ Created demo user:", user._id.toString());
  } else {
    user.orgId = org._id;
    user.role = user.role || "owner";
    user.isActive = true;
    await user.save();
    console.log("✅ Updated demo user orgId:", user._id.toString());
  }

  // 3) Seed 30 days of metrics
  await MetricsDaily.deleteMany({ orgId: org._id });
  const dailyDocs = [];
  let baseRevenue = 1200;

  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getTime() - i * dayMs);
    const spend = rand(200, 650);
    const revenue = Math.max(0, baseRevenue + rand(-250, 500));
    const leads = rand(6, 24);
    const customers = rand(1, 6);
    const cac = customers ? Math.round(spend / customers) : spend;

    dailyDocs.push({
      orgId: org._id,
      date: d,
      revenue,
      spend,
      leads,
      customers,
      cac,
    });

    baseRevenue += rand(-50, 120);
  }

  await MetricsDaily.insertMany(dailyDocs);
  console.log("✅ Inserted metricsdailies:", dailyDocs.length);

  // 4) Seed pipeline deals
  await PipelineDeal.deleteMany({ orgId: org._id });

  const deals = [
    { name: "Free Fly Apparel - Expansion", stage: "Negotiation", amount: 25000, probability: 0.7, source: "Referral" },
    { name: "Manufacturing Lead - HubSpot", stage: "Proposal Sent", amount: 18000, probability: 0.5, source: "Outbound" },
    { name: "IT Services - Retainer", stage: "Discovery", amount: 12000, probability: 0.35, source: "LinkedIn" },
    { name: "B2B SaaS - Revenue Platform", stage: "Qualified", amount: 30000, probability: 0.55, source: "Inbound" },
  ].map((x) => ({
    ...x,
    orgId: org._id,
    closeDate: new Date(today.getTime() + rand(10, 90) * dayMs),
  }));

  await PipelineDeal.insertMany(deals);
  console.log("✅ Inserted pipeline deals:", deals.length);

  // 5) Dashboard summary (the top cards + “what changed this week”)
  const last30 = await MetricsDaily.find({ orgId: org._id });
  const revenue30d = last30.reduce((sum, x) => sum + (x.revenue || 0), 0);
  const spend30d = last30.reduce((sum, x) => sum + (x.spend || 0), 0);
  const customers30d = last30.reduce((sum, x) => sum + (x.customers || 0), 0);
  const cac = customers30d ? Math.round(spend30d / customers30d) : 0;

  const pipelineTotal = deals.reduce((sum, d) => sum + d.amount, 0);
  const forecast90d = Math.round(pipelineTotal * 0.55); // simple demo forecast

  const alerts = [
    { message: "Spend increased 12% week-over-week (Meta Ads).", createdAt: new Date() },
    { message: "Pipeline grew by $18K from inbound lead activity.", createdAt: new Date() },
  ];

  await DashboardMetrics.deleteMany({ orgId: org._id });
await DashboardMetrics.create({
  orgId: org._id,
  revenue30d,
  pipeline: pipelineTotal,
  forecast90d,
  cac,
  alerts,
});

  console.log("✅ Created dashboardmetrics summary");

  // 6) Integrations list
  await Integration.deleteMany({ orgId: org._id });

  const integrations = [
    { key: "google-ads", name: "Google Ads", status: "disconnected" },
    { key: "meta", name: "Meta Ads", status: "connected", lastSyncAt: new Date() },
    { key: "hubspot", name: "HubSpot", status: "connected", lastSyncAt: new Date() },
  ].map((x) => ({ ...x, orgId: org._id }));

  await Integration.insertMany(integrations);
  console.log("✅ Seeded integrations");

  console.log("\n🎉 DEMO DATA SEEDED SUCCESSFULLY");
  console.log("Org:", org._id.toString());
  console.log("User:", demoEmail);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
