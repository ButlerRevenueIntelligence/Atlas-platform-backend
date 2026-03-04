import mongoose from "mongoose";

const MetricDailySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    date: { type: Date, index: true },
    sessions: { type: Number, default: 0 },
    leads: { type: Number, default: 0 },
    opportunities: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.model("MetricDaily", MetricDailySchema);