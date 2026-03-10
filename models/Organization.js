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

    /* -------------------------------- */
    /* Atlas access control             */
    /* -------------------------------- */

    demoCompleted: {
      type: Boolean,
      default: false,
      index: true,
    },

    approvedForAccess: {
      type: Boolean,
      default: false,
      index: true,
    },

    accessStatus: {
      type: String,
      enum: ["pending", "active", "suspended"],
      default: "pending",
      index: true,
    },

    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "past_due", "canceled"],
      default: "pending",
      index: true,
    },

    /* -------------------------------- */
    /* Stripe billing                   */
    /* -------------------------------- */

    billing: {
      stripeCustomerId: { type: String, default: null, index: true },

      stripeSubscriptionId: { type: String, default: null, index: true },

      stripePriceId: { type: String, default: null },

      status: {
        type: String,
        enum: ["active", "past_due", "canceled", "trialing"],
        default: "active",
      },

      currentPeriodEnd: {
        type: Date,
        default: null,
      },
    },
  },
  { timestamps: true }
);

/* -------------------------------- */
/* Atlas collection name            */
/* -------------------------------- */

const Organization =
  mongoose.models.Organization ||
  mongoose.model("Organization", OrganizationSchema, "organizations");

export default Organization;