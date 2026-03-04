import mongoose from "mongoose";

const dashboardSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },
    name: { type: String, default: "Main Dashboard" },
    widgets: { type: Array, default: [] },
  },
  { timestamps: true }
);

export default mongoose.model("Dashboard", dashboardSchema);