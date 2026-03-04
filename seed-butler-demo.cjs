/**
 * backend/seed-butler-demo.cjs
 *
 * Seeds demo data for Butler & Co Revenue Intelligence so the dashboard
 * doesn't show $0 / empty states.
 *
 * Run:
 *   cd backend
 *   node seed-butler-demo.cjs
 */

require("dotenv").config();
const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("❌ Missing MONGO_URI in backend/.env");
  process.exit(1);
}

function isoDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDay(d);
}

function round(n) {
  return Math.round(n);
}

(async () => {
  try {
    console.log("🔌 Connecting to MongoDB...");
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected");

    const db = mongoose.connection;

    // Collections (create if they don't exist)
    const colUsers = db.collection("users");
    const colOrgs = db.collection("orgs"); // optional (some projects use this)
    const colOrganizations = db.collection("organizations"); // optional fallback
    const colIntegrations = db.collection("integrations");
    const colDeals = db.collection("deals");
    const colMetricsDaily = db.collection("metrics_daily"); // common naming
    const colMetricsDailyAlt = db.collection("metricsDaily"); // fallback naming
    const colAlerts = db.collection("alerts");

    // -----------------------------
    // 1) Find or create admin user
    // -----------------------------
    const adminEmail = "admin@butlerco.com";
    let adminUser = await colUsers.findOne({ email: adminEmail });

    if (!adminUser) {
      // Minimal user if none exists (won't break most dashboards)
      const _id = new mongoose.Types.ObjectId();
      const now = new Date();
      const newUser = {
        _id,
        name: "Butler & Co.",
        email: adminEmail,
        role: "user",
        company: "",
        createdAt: now,
        updatedAt: now,
      };
      await colUsers.insertOne(newUser);
      adminUser = newUser;
      console.log("👤 Created admin user:", adminUser._id.toString());
    } else {
      console.log("👤 Found admin user:", adminUser._id.toString());
    }

    const userId = adminUser._id;

    // ----------------------------------------
    // 2) Ensure we have a NON-NULL orgId
    // ----------------------------------------
    let orgId = adminUser.orgId;

    if (!orgId) {
      orgId = new mongoose.Types.ObjectId();

      // Attach orgId to the user so the app can match it later
      await colUsers.updateOne(
        { _id: userId },
        { $set: { orgId, updatedAt: new Date() } }
      );

      // Optional org records (safe even if your app never reads them)
      const orgDoc = {
        _id: orgId,
        name: "Butler & Co",
        ownerUserId: userId,
        demo: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      try {
        await colOrgs.updateOne({ _id: orgId }, { $setOnInsert: orgDoc }, { upsert: true });
      } catch (_) {}

      try {
        await colOrganizations.updateOne(
          { _id: orgId },
          { $setOnInsert: orgDoc },
          { upsert: true }
        );
      } catch (_) {}

      console.log("🏢 Created/assigned orgId:", orgId.toString());
    } else {
      console.log("🏢 Using existing orgId:", orgId.toString());
    }

    console.log("🧩 Seeding data for user:", userId.toString());

    // -------------------------------------------------------
    // 3) Clean old demo docs (IMPORTANT for unique indexes)
    // -------------------------------------------------------
    const demoFilter = { demo: true };
    const demoOrgFilter = { demo: true, orgId };

    // If earlier runs inserted integrations with orgId:null, remove them too
    await colIntegrations.deleteMany({ demo: true, orgId: null });

    await Promise.all([
      colIntegrations.deleteMany(demoOrgFilter),
      colDeals.deleteMany(demoOrgFilter),
      colMetricsDaily.deleteMany(demoOrgFilter),
      colMetricsDailyAlt.deleteMany(demoOrgFilter),
      colAlerts.deleteMany(demoOrgFilter),
    ]);

    // -----------------------------
    // 4) Integrations
    // -----------------------------
    const now = new Date();
    const integrations = [
      {
        demo: true,
        orgId,
        userId,
        name: "HubSpot CRM",
        key: "hubspot",
        status: "Connected",
        connectedAt: daysAgo(14),
        lastSyncAt: daysAgo(0),
        notes: "Contacts, deals, pipeline stages, win rate.",
        createdAt: now,
        updatedAt: now,
      },
      {
        demo: true,
        orgId,
        userId,
        name: "Google Ads",
        key: "google_ads",
        status: "Connected",
        connectedAt: daysAgo(12),
        lastSyncAt: daysAgo(0),
        notes: "Spend, conversions, CAC, ROAS.",
        createdAt: now,
        updatedAt: now,
      },
      {
        demo: true,
        orgId,
        userId,
        name: "Meta Ads",
        key: "meta_ads",
        status: "Connected",
        connectedAt: daysAgo(11),
        lastSyncAt: daysAgo(0),
        notes: "Spend, CPL, lead quality signals.",
        createdAt: now,
        updatedAt: now,
      },
      {
        demo: true,
        orgId,
        userId,
        name: "Google Analytics",
        key: "ga4",
        status: "Connected",
        connectedAt: daysAgo(10),
        lastSyncAt: daysAgo(0),
        notes: "Sessions, engagement, top pages.",
        createdAt: now,
        updatedAt: now,
      },
      {
        demo: true,
        orgId,
        userId,
        name: "Search Console",
        key: "gsc",
        status: "Connected",
        connectedAt: daysAgo(9),
        lastSyncAt: daysAgo(1),
        notes: "Queries, impressions, clicks, rankings.",
        createdAt: now,
        updatedAt: now,
      },
    ];

    await colIntegrations.insertMany(integrations);

    // -----------------------------
    // 5) Deals (pipeline)
    // -----------------------------
    const deals = [
      {
        demo: true,
        orgId,
        userId,
        name: "Apex Bank – Revenue Intelligence Rollout",
        stage: "Proposal",
        value: 45000,
        probability: 0.65,
        owner: "Armon Butler",
        source: "Referral",
        expectedCloseDate: daysAgo(-12),
        createdAt: daysAgo(18),
        updatedAt: now,
      },
      {
        demo: true,
        orgId,
        userId,
        name: "Zone24/7 – Attribution + Dashboard",
        stage: "Negotiation",
        value: 60000,
        probability: 0.7,
        owner: "Armon Butler",
        source: "LinkedIn",
        expectedCloseDate: daysAgo(-9),
        createdAt: daysAgo(22),
        updatedAt: now,
      },
      {
        demo: true,
        orgId,
        userId,
        name: "Commerce Law Partners – SEO + Revenue Ops",
        stage: "Discovery",
        value: 25000,
        probability: 0.45,
        owner: "Armon Butler",
        source: "Inbound",
        expectedCloseDate: daysAgo(-21),
        createdAt: daysAgo(8),
        updatedAt: now,
      },
      {
        demo: true,
        orgId,
        userId,
        name: "Free Fly Apparel – Brazil Expansion (Pilot)",
        stage: "Proposal",
        value: 75000,
        probability: 0.6,
        owner: "Armon Butler",
        source: "Outbound",
        expectedCloseDate: daysAgo(-16),
        createdAt: daysAgo(6),
        updatedAt: now,
      },
      {
        demo: true,
        orgId,
        userId,
        name: "Pro-Tech Staffing – Lead Gen + HubSpot Build",
        stage: "Follow-Up",
        value: 18000,
        probability: 0.35,
        owner: "Armon Butler",
        source: "Email",
        expectedCloseDate: daysAgo(-28),
        createdAt: daysAgo(15),
        updatedAt: now,
      },
    ];

    await colDeals.insertMany(deals);

    // Weighted pipeline value
    const pipelineValue = deals.reduce((sum, d) => sum + d.value * d.probability, 0);

    // -----------------------------
    // 6) Daily metrics (last 30 days)
    // -----------------------------
    const daily = [];
    const sessionsBase = 850;
    const leadsBase = 22;
    const spendBase = 420;
    const revenueBase = 900;

    const rand = (min, max) => Math.random() * (max - min) + min;

    for (let i = 29; i >= 0; i--) {
      const date = daysAgo(i);

      // trend + randomness
      const trend = (29 - i) / 29; // 0 -> 1

      const sessions = round(sessionsBase * (1 + trend * 0.35) + rand(-60, 80));
      const leads = round(leadsBase * (1 + trend * 0.25) + rand(-4, 6));
      const opportunities = Math.max(3, round(leads * rand(0.18, 0.28)));
      const closes = Math.max(1, round(opportunities * rand(0.18, 0.33)));

      const spend = round(spendBase * (1 + trend * 0.15) + rand(-40, 60));
      const revenue = round(revenueBase * (1 + trend * 0.5) + rand(-120, 220));

      daily.push({
        demo: true,
        orgId,
        userId,
        date,
        sessions,
        leads,
        opportunities,
        closes,
        spend,
        revenue,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Insert into BOTH naming styles so whichever your backend uses will work
    await colMetricsDaily.insertMany(daily);
    await colMetricsDailyAlt.insertMany(daily);

    // -----------------------------
    // 7) Alerts (optional but makes it look smart)
    // -----------------------------
    const alerts = [
      {
        demo: true,
        orgId,
        userId,
        type: "spend_spike",
        severity: "medium",
        title: "Spend increased 18% WoW",
        description:
          "Paid spend rose without a matching lift in opportunities. Review campaigns + landing pages.",
        createdAt: now,
        updatedAt: now,
      },
      {
        demo: true,
        orgId,
        userId,
        type: "conversion_drop",
        severity: "high",
        title: "Landing page CVR down",
        description:
          "Lead conversion rate dipped over the last 7 days. Recommend A/B test headline + CTA.",
        createdAt: now,
        updatedAt: now,
      },
      {
        demo: true,
        orgId,
        userId,
        type: "pipeline_signal",
        severity: "medium",
        title: "Pipeline velocity improving",
        description:
          "Negotiation-stage deals are moving faster. Consider pushing close plans this week.",
        createdAt: now,
        updatedAt: now,
      },
    ];

    await colAlerts.insertMany(alerts);

    // -----------------------------
    // 8) Helpful summary
    // -----------------------------
    const revenue30d = daily.reduce((sum, d) => sum + d.revenue, 0);
    const spend30d = daily.reduce((sum, d) => sum + d.spend, 0);
    const leads30d = daily.reduce((sum, d) => sum + d.leads, 0);
    const cac = leads30d ? spend30d / leads30d : 0;

    const avgDailyRevenue = revenue30d / 30;
    const forecast90d = avgDailyRevenue * 90;

    console.log("\n✅ Seed complete. Demo numbers:");
    console.log("Revenue (30d):", round(revenue30d));
    console.log("Spend (30d):", round(spend30d));
    console.log("Leads (30d):", round(leads30d));
    console.log("CAC (approx):", round(cac));
    console.log("Pipeline (weighted):", round(pipelineValue));
    console.log("Forecast (90d):", round(forecast90d));
    console.log("\nNow refresh your dashboard.");

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("❌ Seed failed:", err);
    try {
      await mongoose.disconnect();
    } catch (_) {}
    process.exit(1);
  }
})();