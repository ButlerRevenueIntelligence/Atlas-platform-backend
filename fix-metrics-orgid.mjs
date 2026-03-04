import "dotenv/config";
import mongoose from "mongoose";
import MetricsDaily from "./models/MetricsDaily.js";

const ORG_ID = "6999989424ae0c2d3a563dd7"; // <-- your orgId

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const ORG = new mongoose.Types.ObjectId(ORG_ID);

  // IMPORTANT: avoid duplicate key errors by removing any docs already using the target orgId
  const del = await MetricsDaily.deleteMany({ orgId: ORG });
  console.log("Deleted metricsdailies already on target org:", del.deletedCount);

  const upd = await MetricsDaily.updateMany({}, { $set: { orgId: ORG } });
  console.log("Updated metricsdailies to target org:", upd.modifiedCount);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});