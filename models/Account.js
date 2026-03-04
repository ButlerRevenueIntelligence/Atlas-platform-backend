// backend/models/Account.js
import mongoose from "mongoose";

const { Schema } = mongoose;

const AccountSchema = new Schema(
  {
    // Tenant/workspace (the agency org that "owns" this client record)
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    // Who created/owns the record (optional but useful)
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
      default: null,
    },

    // Client company details
    name: { type: String, required: true, trim: true },
    industry: { type: String, default: "", trim: true },
    website: { type: String, default: "", trim: true },

    status: {
      type: String,
      enum: ["Active", "Paused", "Inactive"],
      default: "Active",
      index: true,
    },

    notes: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

// Prevent duplicate client names per org (optional but recommended)
AccountSchema.index({ orgId: 1, name: 1 }, { unique: true });

// Prevent OverwriteModelError in dev/hot reload
const Account = mongoose.models.Account || mongoose.model("Account", AccountSchema);

export default Account;