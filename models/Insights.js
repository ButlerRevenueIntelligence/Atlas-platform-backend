import mongoose from "mongoose";

const InsightSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true },

    scopeType: { type: String, enum: ["account", "client"], required: true, index: true },
    scopeId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    title: { type: String, default: "" },
    summary: { type: String, default: "" },
    bullets: [{ type: String }],
    actions: [{ type: String }],
    suggestedMessage: { type: String, default: "" },

    // optional raw data you used to generate it (helps debugging)
    context: { type: Object, default: {} },
    provider: { type: String, default: "placeholder" }, // "openai" or "placeholder"
  },
  { timestamps: true }
);

export default mongoose.model("Insight", InsightSchema);