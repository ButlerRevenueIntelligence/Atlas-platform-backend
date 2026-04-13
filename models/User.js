import mongoose from "mongoose";

const { Schema } = mongoose;

const ROLE_ENUM = ["owner", "admin", "manager", "analyst", "member", "viewer"];
const STATUS_ENUM = ["active", "invited", "disabled", "suspended"];

const WorkspaceMembershipSchema = new Schema(
  {
    workspace: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    role: {
      type: String,
      enum: ROLE_ENUM,
      default: "member",
    },
    status: {
      type: String,
      enum: STATUS_ENUM,
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

    // Single source of truth for authentication
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },

    resetToken: {
      type: String,
      default: null,
      select: false,
    },

    resetTokenExpiry: {
      type: Date,
      default: null,
      select: false,
    },

    // Legacy field kept only so old docs do not break reads.
    // Do not write to this field anywhere.
    password: {
      type: String,
      default: undefined,
      select: false,
    },

    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
      index: true,
    },

    activeWorkspace: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
      index: true,
    },

    role: {
      type: String,
      enum: ROLE_ENUM,
      default: "member",
      index: true,
    },

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
      enum: STATUS_ENUM,
      default: "active",
      index: true,
    },
  },
  { timestamps: true }
);

UserSchema.pre("save", function (next) {
  if (!this.activeWorkspace && this.orgId) {
    this.activeWorkspace = this.orgId;
  }

  if (!this.orgId && this.activeWorkspace) {
    this.orgId = this.activeWorkspace;
  }

  if (this.email) {
    this.email = String(this.email).trim().toLowerCase();
  }

  next();
});

UserSchema.index({ orgId: 1, email: 1 }, { unique: false });
UserSchema.index({ activeWorkspace: 1, status: 1 });

const User = mongoose.models.User || mongoose.model("User", UserSchema);

export default User;