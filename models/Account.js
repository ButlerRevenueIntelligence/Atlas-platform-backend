// backend/models/Account.js
import mongoose from "mongoose";

const { Schema } = mongoose;

const AccountSchema = new Schema(
  {
    // Tenant/workspace that owns this account
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    // Future-friendly alias for workspace-based architecture
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
      index: true,
    },

    // User who created / owns the record
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
      default: null,
    },

    // Client / company details
    name: {
      type: String,
      required: true,
      trim: true,
    },

    industry: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    website: {
      type: String,
      default: "",
      trim: true,
    },

    domain: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["Active", "Paused", "Inactive"],
      default: "Active",
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
  },
  { timestamps: true }
);

/**
 * Keep workspaceId aligned with orgId during transition
 */
AccountSchema.pre("save", function (next) {
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
 * Unique account name per org/workspace
 */
AccountSchema.index({ orgId: 1, name: 1 }, { unique: true });

/**
 * Helpful compound indexes for tenant filtering
 */
AccountSchema.index({ orgId: 1, status: 1, createdAt: -1 });
AccountSchema.index({ orgId: 1, industry: 1 });
AccountSchema.index({ orgId: 1, archivedAt: 1 });

const Account =
  mongoose.models.Account || mongoose.model("Account", AccountSchema);

export default Account;