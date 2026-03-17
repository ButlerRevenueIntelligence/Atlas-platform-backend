// backend/models/Deal.js
import mongoose from "mongoose";

const activitySchema = new mongoose.Schema(
  {
    type: {
      type: String,
      default: "note",
      trim: true,
    }, // note/call/email/meeting/task/stage_move/system
    note: {
      type: String,
      default: "",
      trim: true,
    },
    nextAction: {
      type: String,
      default: "",
      trim: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { _id: false }
);

const STAGES = [
  "Discovery",
  "Proposal",
  "Follow-Up",
  "Negotiation",
  "Closed Won",
  "Closed Lost",
];

const dealSchema = new mongoose.Schema(
  {
    // Current tenant source of truth
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    // Future-friendly workspace alias
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
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

    closeDate: {
      type: Date,
      default: null,
    },

    // Execution layer
    nextAction: {
      type: String,
      default: "",
      trim: true,
    },

    nextActionDueAt: {
      type: Date,
      default: null,
      index: true,
    },

    // Activity timeline
    lastActivityAt: {
      type: Date,
      default: null,
      index: true,
    },

    lastActivityType: {
      type: String,
      default: "",
      trim: true,
    },

    lastActivityNote: {
      type: String,
      default: "",
      trim: true,
    },

    activities: {
      type: [activitySchema],
      default: [],
    },

    // Outcome / win-loss / reactivation intel
    closedAt: {
      type: Date,
      default: null,
      index: true,
    },

    closedReason: {
      type: String,
      default: "",
      trim: true,
    },

    competitor: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    reactivationAt: {
      type: Date,
      default: null,
      index: true,
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
dealSchema.pre("save", function (next) {
  if (!this.workspaceId && this.orgId) {
    this.workspaceId = this.orgId;
  }
  next();
});

/**
 * Helpful compound indexes
 */
dealSchema.index({ orgId: 1, stage: 1, createdAt: -1 });
dealSchema.index({ orgId: 1, clientId: 1, createdAt: -1 });
dealSchema.index({ orgId: 1, nextActionDueAt: 1 });
dealSchema.index({ orgId: 1, reactivationAt: 1 });
dealSchema.index({ orgId: 1, closedAt: 1 });
dealSchema.index({ orgId: 1, archivedAt: 1 });
dealSchema.index({ orgId: 1, competitor: 1 });

const Deal = mongoose.models.Deal || mongoose.model("Deal", dealSchema);

export default Deal;