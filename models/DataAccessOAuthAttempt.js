import mongoose from "mongoose";
const schema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    provider: { type: String, required: true },
    acceptanceId: { type: mongoose.Schema.Types.ObjectId, required: true },
    digest: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
  },
  { versionKey: false },
);
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.models.DataAccessOAuthAttempt ||
  mongoose.model("DataAccessOAuthAttempt", schema);
