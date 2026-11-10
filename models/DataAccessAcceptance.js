import mongoose from "mongoose";
const schema = new mongoose.Schema(
  {
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
      immutable: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    email: { type: String, required: true, immutable: true },
    provider: { type: String, required: true, immutable: true },
    digest: { type: String, required: true, immutable: true },
    agreementDigest: { type: String, required: true, immutable: true },
    snapshot: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      immutable: true,
    },
    acknowledgments: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      immutable: true,
    },
    acceptedAt: { type: Date, default: Date.now, immutable: true },
  },
  { versionKey: false },
);
schema.index({ orgId: 1, provider: 1, digest: 1, acceptedAt: -1 });
// Application routes expose create/read only. No update or deletion endpoints.
export default mongoose.models.DataAccessAcceptance ||
  mongoose.model("DataAccessAcceptance", schema);
