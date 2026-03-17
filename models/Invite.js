// backend/models/Invite.js
import mongoose from "mongoose";

const InviteSchema = new mongoose.Schema(
  {
    // Primary tenant reference
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    // Future workspace alias
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },

    role: {
      type: String,
      default: "analyst",
      enum: ["owner", "admin", "manager", "analyst", "member", "viewer"],
      index: true,
    },

    status: {
      type: String,
      default: "pending",
      enum: ["pending", "accepted", "expired", "revoked"],
      index: true,
    },

    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },

    acceptedAt: {
      type: Date,
      default: null,
    },

    acceptedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

/**
 * Bridge orgId -> workspaceId automatically
 */
InviteSchema.pre("save", function (next) {
  if (!this.workspaceId && this.orgId) {
    this.workspaceId = this.orgId;
  }
  next();
});

/**
 * Helpful indexes
 */

// prevent duplicate pending invites for same email + workspace
InviteSchema.index(
  { orgId: 1, email: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "pending" },
  }
);

// useful for cleanup jobs
InviteSchema.index({ expiresAt: 1 });

const Invite =
  mongoose.models.Invite || mongoose.model("Invite", InviteSchema);

export default Invite;