// backend/models/User.js
import mongoose from "mongoose";

const { Schema } = mongoose;

const WorkspaceMembershipSchema = new Schema(
  {
    workspace: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    role: {
      type: String,
      enum: ["owner", "admin", "manager", "analyst", "member", "viewer"],
      default: "member",
    },
    status: {
      type: String,
      enum: ["active", "invited", "suspended", "disabled"],
      default: "active",
    },
  },
  { _id: false }
);

const UserSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    // Current auth source of truth
    passwordHash: {
      type: String,
      default: "",
    },
     
    resetToken: {
      type: String,
      default: null,
    },
    resetTokenExpiry: {
      type: Date,
      default: null,
    },
    // Legacy compatibility in case older code still references password
    password: {
      type: String,
      default: "",
      select: false,
    },

    // Current tenant source of truth
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
      index: true,
    },

    // Future-friendly workspace alias
    activeWorkspace: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
      index: true,
    },

    role: {
      type: String,
      enum: ["owner", "admin", "manager", "analyst", "member", "viewer"],
      default: "member",
      index: true,
    },

    // Optional embedded compatibility layer for future workspace-first UX
    workspaces: {
      type: [WorkspaceMembershipSchema],
      default: [],
    },

    lastLoginAt: {
      type: Date,
      default: null,
      index: true,
    },

    status: {
      type: String,
      enum: ["active", "invited", "disabled", "suspended"],
      default: "active",
      index: true,
    },
  },
  { timestamps: true }
);

/**
 * Keep orgId and activeWorkspace aligned during transition
 */
UserSchema.pre("save", function (next) {
  if (!this.activeWorkspace && this.orgId) {
    this.activeWorkspace = this.orgId;
  }

  if (!this.orgId && this.activeWorkspace) {
    this.orgId = this.activeWorkspace;
  }

  // Keep password compatibility aligned
  if (this.passwordHash && !this.password) {
    this.password = this.passwordHash;
  }

  next();
});

/**
 * Helpful indexes
 */
UserSchema.index({ orgId: 1, email: 1 });
UserSchema.index({ activeWorkspace: 1, status: 1 });

const User = mongoose.models.User || mongoose.model("User", UserSchema);

export default User;