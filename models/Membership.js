// backend/models/Membership.js
import mongoose from "mongoose";

const membershipSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },

    role: { type: String, default: "member" },
    permissions: { type: [String], default: [] },
    status: { type: String, default: "active" },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null },
  },
  { timestamps: true }
);

membershipSchema.index({ userId: 1, orgId: 1 }, { unique: true });

export default mongoose.models.Membership ||
  mongoose.model("Membership", membershipSchema, "memberships");