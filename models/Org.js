import mongoose from "mongoose";

const OrgSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, trim: true, index: true },
  },
  { timestamps: true }
);

export default mongoose.model("Org", OrgSchema);
