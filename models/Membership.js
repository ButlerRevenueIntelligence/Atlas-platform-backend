import mongoose from "mongoose";

const membershipSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
      index: true,
    },

    role: {
      type: String,
      default: "member",
      enum: ["owner", "admin", "manager", "analyst", "member", "viewer"],
      index: true,
    },

    permissions: {
      type: [String],
      default: [],
    },

    status: {
      type: String,
      default: "active",
      enum: ["active", "invited", "disabled", "suspended"],
      index: true,
    },

    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      default: null,
      index: true,
    },

    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    joinedAt: {
      type: Date,
      default: null,
    },

    lastActiveAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

membershipSchema.pre("save", function (next) {
  if (!this.workspaceId && this.orgId) {
    this.workspaceId = this.orgId;
  }

  if (this.status === "active" && !this.joinedAt) {
    this.joinedAt = new Date();
  }

  next();
});

membershipSchema.index({ userId: 1, orgId: 1 }, { unique: true });
membershipSchema.index({ orgId: 1, status: 1, role: 1 });
membershipSchema.index({ orgId: 1, accountId: 1 });
membershipSchema.index({ userId: 1, status: 1 });

const Membership =
  mongoose.models.Membership ||
  mongoose.model("Membership", membershipSchema, "memberships");

export default Membership;