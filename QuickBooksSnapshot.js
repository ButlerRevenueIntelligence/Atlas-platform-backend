import mongoose from "mongoose";

const QuickBooksSnapshotSchema = new mongoose.Schema(
  {
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    realmId: {
      type: String,
      required: true,
      index: true,
    },
    companyName: {
      type: String,
      default: null,
    },
    periodStart: {
      type: Date,
      required: true,
    },
    periodEnd: {
      type: Date,
      required: true,
    },
    currency: {
      type: String,
      default: "USD",
    },
    metrics: {
      revenue: { type: Number, default: 0 },
      expenses: { type: Number, default: 0 },
      netIncome: { type: Number, default: 0 },
      cash: { type: Number, default: 0 },
      accountsReceivable: { type: Number, default: 0 },
      accountsPayable: { type: Number, default: 0 },
    },
    reports: {
      profitAndLoss: { type: mongoose.Schema.Types.Mixed, default: null },
      balanceSheet: { type: mongoose.Schema.Types.Mixed, default: null },
      cashFlow: { type: mongoose.Schema.Types.Mixed, default: null },
      agedReceivables: { type: mongoose.Schema.Types.Mixed, default: null },
      agedPayables: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    syncedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
);

QuickBooksSnapshotSchema.index({ orgId: 1, syncedAt: -1 });

export default mongoose.models.QuickBooksSnapshot ||
  mongoose.model("QuickBooksSnapshot", QuickBooksSnapshotSchema);
