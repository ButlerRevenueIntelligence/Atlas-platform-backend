import mongoose from "mongoose";

const schema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  provider: { type: String, required: true },
  accountId: { type: String, required: true },
  date: { type: String, required: true },
  currency: { type: String, default: "USD" },
  spend: { type: Number, default: 0 },
  leads: { type: Number, default: 0 },
  conversions: { type: Number, default: 0 },
  sessions: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  impressions: { type: Number, default: 0 },
}, { timestamps: true, collection: "source_metrics_daily" });
schema.index({ orgId: 1, provider: 1, accountId: 1, date: 1 }, { unique: true });
export default mongoose.models.SourceMetricDaily || mongoose.model("SourceMetricDaily", schema);
