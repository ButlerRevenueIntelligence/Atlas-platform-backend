// backend/models/StripeRevenueDaily.js
import mongoose from "mongoose";

const StripeRevenueDailySchema = new mongoose.Schema(
  {
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    provider: {
      type: String,
      default: "stripe",
      index: true,
    },
    date: {
      type: String,
      required: true,
      index: true, // YYYY-MM-DD
    },
    currency: {
      type: String,
      default: "usd",
    },
    grossRevenue: {
      type: Number,
      default: 0,
    },
    netRevenue: {
      type: Number,
      default: 0,
    },
    refunds: {
      type: Number,
      default: 0,
    },
    transactionCount: {
      type: Number,
      default: 0,
    },
    customerCount: {
      type: Number,
      default: 0,
    },
    source: {
      type: String,
      default: "stripe_sync",
    },
  },
  { timestamps: true }
);

StripeRevenueDailySchema.index(
  { orgId: 1, provider: 1, date: 1 },
  { unique: true }
);

export default mongoose.model("StripeRevenueDaily", StripeRevenueDailySchema);