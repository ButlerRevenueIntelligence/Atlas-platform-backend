import "dotenv/config";
import mongoose from "mongoose";
import MetricsDaily from "../models/MetricsDaily.js";

const MONGO = process.env.MONGO_URI;

function rnd(min, max) {
  return Math.round(min + Math.random() * (max - min));
}

function dayISO(d) {
  const x = new Date(d);
  x.setHours(0,0,0,0);
  return x.toISOString().slice(0,10);
}

async function run() {
  if (!MONGO) throw new Error("Missing MONGO_URI in backend .env");

  await mongoose.connect(MONGO);

  const orgId = process.argv[2]; // pass in orgId
  if (!orgId) {
    console.log("Usage: node scripts/seedDemo.js <orgId>");
    process.exit(1);
  }

  // delete last 30 days for this org to avoid duplicates
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);
  await MetricsDaily.deleteMany({ orgId, createdAt: { $gte: cutoff } });

  const start = new Date();
  start.setDate(start.getDate() - 29);

  let baseRevenue = rnd(4000, 12000);
  let basePipeline = rnd(150000, 450000);
  let baseCAC = rnd(180, 420);

  const channels = ["Google Ads", "Meta Ads", "LinkedIn Ads", "SEO", "Email"];
  const pages = ["/ai-demo", "/book-a-call", "/case-studies", "/pricing", "/demo"];

  const docs = [];

  for (let i = 0; i < 30; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);

    // gentle trend upward with noise
    baseRevenue += rnd(-500, 1200);
    basePipeline += rnd(-10000, 25000);
    baseCAC += rnd(-10, 12);

    docs.push({
      orgId,
      date: dayISO(d),
      revenue: Math.max(0, baseRevenue),
      pipeline: Math.max(0, basePipeline),
      cac: Math.max(50, baseCAC),
      topChannel: channels[rnd(0, channels.length - 1)],
      bestLandingPage: pages[rnd(0, pages.length - 1)],
      createdAt: d,
      updatedAt: d,
    });
  }

  await MetricsDaily.insertMany(docs);

  console.log("✅ Seeded 30 days of demo MetricsDaily for orgId:", orgId);
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
