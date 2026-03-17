// backend/models/Client.js
import mongoose from "mongoose";

const ClientSchema = new mongoose.Schema(
  {
    // Current tenant source of truth
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    // Future-friendly workspace alias
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    website: {
      type: String,
      trim: true,
      default: "",
    },

    domain: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },

    industry: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },

    primaryContactName: {
      type: String,
      trim: true,
      default: "",
    },

    primaryContactEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },

    primaryContactPhone: {
      type: String,
      trim: true,
      default: "",
    },

    status: {
      type: String,
      enum: ["active", "paused", "prospect", "archived"],
      default: "active",
      index: true,
    },

    notes: {
      type: String,
      default: "",
      trim: true,
    },

    archivedAt: {
      type: Date,
      default: null,
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

/**
 * Keep workspaceId aligned with orgId during transition
 * Also derive domain from website when possible
 */
ClientSchema.pre("save", function (next) {
  if (!this.workspaceId && this.orgId) {
    this.workspaceId = this.orgId;
  }

  if (!this.domain && this.website) {
    try {
      const normalized = this.website.startsWith("http")
        ? this.website
        : `https://${this.website}`;
      const url = new URL(normalized);
      this.domain = url.hostname.replace(/^www\./, "");
    } catch {
      this.domain = "";
    }
  }

  next();
});

/**
 * Helpful indexes
 */
ClientSchema.index({ orgId: 1, name: 1 });
ClientSchema.index({ orgId: 1, status: 1, createdAt: -1 });
ClientSchema.index({ orgId: 1, industry: 1 });
ClientSchema.index({ orgId: 1, domain: 1 });
ClientSchema.index({ orgId: 1, archivedAt: 1 });

/**
 * Only enforce unique primary contact email when non-empty
 */
ClientSchema.index(
  { orgId: 1, primaryContactEmail: 1 },
  {
    unique: true,
    partialFilterExpression: {
      primaryContactEmail: { $type: "string", $ne: "" },
    },
  }
);

const Client =
  mongoose.models.Client || mongoose.model("Client", ClientSchema);

export default Client;