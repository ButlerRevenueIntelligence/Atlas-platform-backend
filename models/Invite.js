// backend/models/Invite.js
import mongoose from "mongoose";

const InviteSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true },

    email: { type: String, required: true, trim: true, lowercase: true, index: true },
    role: { type: String, default: "analyst" }, // owner/admin/analyst/viewer
    status: { type: String, default: "pending" }, // pending/accepted/expired/revoked

    token: { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true, index: true },
    acceptedAt: { type: Date, default: null },
    acceptedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

InviteSchema.index({ orgId: 1, email: 1, status: 1 });

export default mongoose.model("Invite", InviteSchema);