import "dotenv/config";
import mongoose from "mongoose";
import Account from "../models/Account.js";
import Deal from "../models/Deal.js";
import { clientForAccount } from "../services/accountLinks.js";

const apply = process.argv.includes("--apply");
const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) throw new Error("MONGO_URI or MONGODB_URI is required");
await mongoose.connect(uri);
try {
  let affected = 0;
  for await (const account of Account.find({ externalSource: { $ne: "" }, externalId: { $ne: "" } }).cursor()) {
    const filter = { orgId: account.orgId, externalSource: account.externalSource, clientId: account._id };
    const count = await Deal.countDocuments(filter);
    if (!count) continue;
    affected += count;
    if (apply) {
      const client = await clientForAccount(account.orgId, account);
      if (String(client._id) !== String(account._id)) await Deal.updateMany(filter, { $set: { clientId: client._id } });
    }
  }
  console.log(`${apply ? "Repaired" : "Would repair"} ${affected} imported deal links. ${apply ? "" : "Use --apply to write changes."}`);
} finally {
  await mongoose.disconnect();
}
