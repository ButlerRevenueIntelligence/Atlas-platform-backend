const mongoose = require("mongoose");

const WorkspaceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    companyWebsite: {
      type: String,
      default: "",
      trim: true,
    },
    industry: {
      type: String,
      default: "",
      trim: true,
    },
    logoUrl: {
      type: String,
      default: "",
      trim: true,
    },

    plan: {
      type: String,
      enum: ["trial", "growth", "scale", "enterprise"],
      default: "trial",
    },
    status: {
      type: String,
      enum: ["active", "trialing", "past_due", "suspended", "cancelled"],
      default: "trialing",
    },

    settings: {
      timezone: { type: String, default: "America/Chicago" },
      currency: { type: String, default: "USD" },
      dateFormat: { type: String, default: "MM/DD/YYYY" },
      theme: { type: String, default: "dark" },
    },

    billing: {
      stripeCustomerId: { type: String, default: "" },
      stripeSubscriptionId: { type: String, default: "" },
      currentPeriodEnd: { type: Date, default: null },
      trialEndsAt: { type: Date, default: null },
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Workspace", WorkspaceSchema);