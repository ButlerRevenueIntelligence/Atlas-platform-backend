import mongoose from "mongoose";

const MetricDailySchema = new mongoose.Schema(
  {
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    date: {
      type: Date,
      required: true,
      index: true,
    },
    revenue: {
      type: Number,
      default: 0,
    },
    spend: {
      type: Number,
      default: 0,
    },
    leads: {
      type: Number,
      default: 0,
    },
  },
  {
    collection: "metrics_daily",
  }
);

MetricDailySchema.index({ orgId: 1, date: 1 });

export default mongoose.model("MetricDaily", MetricDailySchema);