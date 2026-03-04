import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

// Adjust this path if your User model is in a different folder
import User from "../models/User.js";

const email = process.argv[2] || "admin@butlerco.com";
const newPassword = process.argv[3] || "Admin123!";

async function run() {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI is missing in backend/.env");
    }

    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ MongoDB connected");

    const user = await User.findOne({ email });
    if (!user) {
      throw new Error(`User not found for email: ${email}`);
    }

    const hash = await bcrypt.hash(newPassword, 10);

    // IMPORTANT: your project uses passwordHash (based on your Atlas screenshot)
    user.passwordHash = hash;

    // If your schema has any required fields that might block save, this keeps it safe
    await user.save({ validateBeforeSave: false });

    console.log("✅ Password reset successful");
    console.log(`Email: ${email}`);
    console.log(`New password: ${newPassword}`);

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("❌ Password reset failed:", err.message);
    try {
      await mongoose.disconnect();
    } catch {}
    process.exit(1);
  }
}

run();