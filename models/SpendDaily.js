import mongoose from "mongoose";

const SpendDailySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    date: { type: Date, index: true },
    spend: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.model("SpendDaily", SpendDailySchema);