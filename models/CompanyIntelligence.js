import mongoose from "mongoose";
const schema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  query: { type: mongoose.Schema.Types.Mixed, required: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true, collection: "company_intelligence" });
export default mongoose.models.CompanyIntelligence || mongoose.model("CompanyIntelligence", schema);
