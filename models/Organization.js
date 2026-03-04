// backend/models/Organization.js
import mongoose from "mongoose";

const OrganizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    type: {
      type: String,
      enum: ["agency", "client"],
      default: "client",
      index: true,
    },

    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },

    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    plan: {
      type: String,
      enum: ["SCALE", "GROWTH", "ENTERPRISE"],
      default: "SCALE",
      index: true,
    },

    billing: {
      stripeCustomerId: { type: String, default: null },
      stripeSubscriptionId: { type: String, default: null },
      status: {
        type: String,
        enum: ["active", "past_due", "canceled", "trialing"],
        default: "active",
      },
    },
  },
  { timestamps: true }
);

// ✅ IMPORTANT: match Atlas collection name "organizations"
const Organization =
  mongoose.models.Organization ||
  mongoose.model("Organization", OrganizationSchema, "organizations");

export default Organization;