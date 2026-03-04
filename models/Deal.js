// backend/models/Deal.js
import mongoose from "mongoose";

const activitySchema = new mongoose.Schema(
  {
    type: { type: String, default: "note" }, // note/call/email/meeting/task/stage_move/system
    note: { type: String, default: "" },
    nextAction: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { _id: false }
);

const STAGES = ["Discovery", "Proposal", "Follow-Up", "Negotiation", "Closed Won", "Closed Lost"];

const dealSchema = new mongoose.Schema(
  {
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    stage: {
      type: String,
      required: true,
      enum: STAGES,
      default: "Discovery",
      index: true,
    },

    amount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    probability: {
      type: Number,
      default: 0.5,
      min: 0,
      max: 1,
    },

    closeDate: { type: Date },

    // ✅ Execution layer
    nextAction: { type: String, default: "" },
    nextActionDueAt: { type: Date, default: null, index: true },

    // ✅ Activity timeline
    lastActivityAt: { type: Date, default: null, index: true },
    lastActivityType: { type: String, default: "" },
    lastActivityNote: { type: String, default: "" },
    activities: { type: [activitySchema], default: [] },

    // ✅ Win/Loss / Reactivation intel
    closedAt: { type: Date, default: null, index: true },
    closedReason: { type: String, default: "" },
    competitor: { type: String, default: "" },
    reactivationAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

// Helpful compound indexes
dealSchema.index({ orgId: 1, stage: 1, createdAt: -1 });
dealSchema.index({ orgId: 1, clientId: 1, createdAt: -1 });

// extra “work queue” indexes
dealSchema.index({ orgId: 1, nextActionDueAt: 1 });
dealSchema.index({ orgId: 1, reactivationAt: 1 });

export default mongoose.model("Deal", dealSchema);