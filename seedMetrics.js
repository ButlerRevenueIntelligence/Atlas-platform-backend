import mongoose from "mongoose";
import dotenv from "dotenv";
import MetricsDaily from "./models/MetricsDaily.js";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;

const ORG_ID = "65fa3d92f1e4c2b8a91a1234"; // <-- replace this

async function seed() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("Connected to MongoDB");

    // Remove old metrics for this org (optional)
    await MetricsDaily.deleteMany({ orgId: ORG_ID });

    const today = new Date();
    const rows = [];

    for (let i = 0; i < 30; i++) {
      const date = new Date();
      date.setDate(today.getDate() - i);

      rows.push({
        orgId: ORG_ID,
        date,
        revenue: 4000 + Math.floor(Math.random() * 3000),
        pipeline: 250000 + Math.floor(Math.random() * 100000),
        cac: 2800 + Math.floor(Math.random() * 800),
        topChannel: "Google Ads",
        bestLandingPage: "/enterprise-demo",
      });
    }

    await MetricsDaily.insertMany(rows);

    console.log("✅ 30 days of metrics inserted successfully");
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

seed();
