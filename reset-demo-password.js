// reset-demo-password.js (ES Module version)

import dotenv from "dotenv";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

dotenv.config();

async function main() {
  const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

  if (!MONGO_URI) {
    console.error("❌ Missing MONGO_URI in .env");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log("✅ Mongo connected");

  const db = mongoose.connection.db;
  const users = db.collection("users");

  const email = "admin@butlerco.com";
  const newPassword = "demo123";

  const passwordHash = await bcrypt.hash(newPassword, 10);

  const result = await users.updateOne(
    { email },
    { $set: { passwordHash, isActive: true, updatedAt: new Date() } }
  );

  console.log(`✅ Password reset for ${email}`);
  console.log("Matched:", result.matchedCount);
  console.log("Modified:", result.modifiedCount);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
