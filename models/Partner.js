import mongoose from "mongoose";

const partnerSchema = new mongoose.Schema(
  {
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    companyName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
    },

    contactName: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "",
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 200,
      default: "",
    },

    partnershipType: {
      type: String,
      enum: [
        "referral",
        "reseller",
        "technology",
        "strategic",
        "affiliate",
        "agency",
        "other",
      ],
      default: "referral",
    },

    status: {
      type: String,
      enum: ["active", "prospective", "inactive", "archived"],
      default: "active",
      index: true,
    },

    referredOpportunities: {
      type: Number,
      default: 0,
      min: 0,
    },

    influencedPipeline: {
      type: Number,
      default: 0,
      min: 0,
    },

    revenueGenerated: {
      type: Number,
      default: 0,
      min: 0,
    },

    notes: {
      type: String,
      trim: true,
      maxlength: 3000,
      default: "",
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

partnerSchema.index({ orgId: 1, companyName: 1 });
partnerSchema.index({ orgId: 1, status: 1, createdAt: -1 });

const Partner =
  mongoose.models.Partner ||
  mongoose.model("Partner", partnerSchema);

export default Partner;
