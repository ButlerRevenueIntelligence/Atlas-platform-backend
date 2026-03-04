import mongoose from "mongoose";

const IntegrationSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true },              // e.g. HubSpot, Google Ads
    status: { type: String, default: "Disconnected" },   // Connected/Disconnected
    provider: { type: String, default: "" },             // optional
    meta: { type: Object, default: {} },                 // optional settings payload
  },
  { timestamps: true }
);

export default mongoose.model("Integration", IntegrationSchema);
