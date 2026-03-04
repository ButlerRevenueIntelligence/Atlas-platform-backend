import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

import MetricsDaily from "../models/MetricsDaily.js";
import User from "../models/User.js";

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const user = await User.findOne(); // uses the first user
  if (!user?.orgId) throw new Error("No user/orgId found. Create a user first.");

  await MetricsDaily.create({
    orgId: user.orgId,
    date: new Date(),
    revenue: 125000,
    pipeline: 320000,
    cac: 3200,
    topChannel: "Google Ads",
    bestLandingPage: "/enterprise-demo",
  });

  console.log("Seeded MetricsDaily ✅");
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
