// backend/models/Client.js
import mongoose from "mongoose";

const ClientSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    name: { type: String, required: true, trim: true },
    website: { type: String, trim: true, default: "" },
    industry: { type: String, trim: true, default: "" },

    primaryContactName: { type: String, trim: true, default: "" },
    primaryContactEmail: { type: String, trim: true, lowercase: true, default: "" },
    primaryContactPhone: { type: String, trim: true, default: "" },

    status: {
      type: String,
      enum: ["active", "paused", "prospect", "archived"],
      default: "active",
      index: true,
    },

    notes: { type: String, default: "" },

    createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

// Keep this (helps prevent duplicate client names per org if you want it later)
// (not unique right now)
ClientSchema.index({ orgId: 1, name: 1 });

// ✅ Correct email uniqueness: ONLY enforce when primaryContactEmail is non-empty
ClientSchema.index(
  { orgId: 1, primaryContactEmail: 1 },
  {
    unique: true,
    partialFilterExpression: { primaryContactEmail: { $type: "string", $ne: "" } },
  }
);

export default mongoose.model("Client", ClientSchema);