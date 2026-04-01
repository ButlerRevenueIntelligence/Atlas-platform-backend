// backend/models/IntegrationConnection.js
import mongoose from "mongoose";

const IntegrationConnectionSchema = new mongoose.Schema(
  {
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    provider: {
      type: String,
      required: true,
      enum: [
        "hubspot",
        "salesforce",
        "google_ads",
        "meta_ads",
        "linkedin_ads",
        "ga4",
        "stripe",
        "shopify",
      ],
      index: true,
    },

    status: {
      type: String,
      enum: ["connected", "disconnected", "error", "syncing"],
      default: "disconnected",
      index: true,
    },

    mode: {
      type: String,
      enum: ["demo", "live"],
      default: "demo",
      index: true,
    },

    externalAccountId: {
      type: String,
      default: null,
    },

    externalAccountName: {
      type: String,
      default: null,
    },

    accessToken: {
      type: String,
      default: null,
    },

    refreshToken: {
      type: String,
      default: null,
    },

    tokenExpiresAt: {
      type: Date,
      default: null,
    },

    scopes: {
      type: [String],
      default: [],
    },

    connectedAt: {
      type: Date,
      default: null,
    },

    lastSyncAt: {
      type: Date,
      default: null,
    },

    lastSyncStatus: {
      type: String,
      enum: ["never", "success", "failed", "running"],
      default: "never",
    },

    lastError: {
      type: String,
      default: null,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

IntegrationConnectionSchema.index({ orgId: 1, provider: 1 }, { unique: true });

const IntegrationConnection =
  mongoose.models.IntegrationConnection ||
  mongoose.model(
    "IntegrationConnection",
    IntegrationConnectionSchema,
    "integration_connections"
  );

export default IntegrationConnection;