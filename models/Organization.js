import mongoose from "mongoose";

const integrationStateSchema = new mongoose.Schema(
  {
    connected: { type: Boolean, default: false },
    lastSync: { type: Date, default: null },
    connectedAt: { type: Date, default: null },
    mode: {
      type: String,
      enum: ["demo", "live"],
      default: "demo",
    },
  },
  { _id: false }
);

const usageSchema = new mongoose.Schema(
  {
    aiAnalyses: { type: Number, default: 0 },
    reportsGenerated: { type: Number, default: 0 },
    forecastsRun: { type: Number, default: 0 },
  },
  { _id: false }
);

const trialSchema = new mongoose.Schema(
  {
    startedAt: {
      type: Date,
      default: Date.now,
    },
    endsAt: {
      type: Date,
      default: () => {
        const d = new Date();
        d.setDate(d.getDate() + 7);
        return d;
      },
    },
    status: {
      type: String,
      enum: ["none", "trialing", "expired", "converted"],
      default: "trialing",
      index: true,
    },
  },
  { _id: false }
);

const billingSchema = new mongoose.Schema(
  {
    stripeCustomerId: { type: String, default: null, index: true },
    stripeSubscriptionId: { type: String, default: null, index: true },
    stripePriceId: { type: String, default: null },
    status: {
      type: String,
      enum: ["inactive", "active", "past_due", "canceled", "trialing"],
      default: "trialing",
      index: true,
    },
    currentPeriodEnd: { type: Date, default: null },
  },
  { _id: false }
);

const OrganizationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    type: {
      type: String,
      enum: ["agency", "client"],
      default: "client",
      index: true,
    },

    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },

    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    plan: {
      type: String,
      enum: ["SCALE", "GROWTH", "ENTERPRISE"],
      default: "SCALE",
      index: true,
    },

    trial: {
      type: trialSchema,
      default: () => ({}),
    },

    usage: {
      type: usageSchema,
      default: () => ({}),
    },

    demoCompleted: {
      type: Boolean,
      default: true,
      index: true,
    },

    approvedForAccess: {
      type: Boolean,
      default: true,
      index: true,
    },

    accessStatus: {
      type: String,
      enum: ["pending", "active", "suspended"],
      default: "active",
      index: true,
    },

    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "past_due", "canceled", "trialing"],
      default: "trialing",
      index: true,
    },

    integrations: {
      hubspot: {
        type: integrationStateSchema,
        default: () => ({}),
      },
      salesforce: {
        type: integrationStateSchema,
        default: () => ({}),
      },
      google_ads: {
        type: integrationStateSchema,
        default: () => ({}),
      },
      meta_ads: {
        type: integrationStateSchema,
        default: () => ({}),
      },
      linkedin_ads: {
        type: integrationStateSchema,
        default: () => ({}),
      },
      ga4: {
        type: integrationStateSchema,
        default: () => ({}),
      },
      stripe: {
        type: integrationStateSchema,
        default: () => ({}),
      },
      shopify: {
        type: integrationStateSchema,
        default: () => ({}),
      },
    },

    billing: {
      type: billingSchema,
      default: () => ({}),
    },
  },
  { timestamps: true }
);

/* -------------------------------- */
/* Auto-handle trial expiration     */
/* -------------------------------- */
OrganizationSchema.pre("save", function (next) {
  const now = new Date();

  const trialExpired =
    this.trial?.status === "trialing" &&
    this.trial?.endsAt &&
    now > new Date(this.trial.endsAt);

  const hasPaidAccess =
    this.billing?.status === "active" ||
    this.paymentStatus === "paid";

  if (trialExpired && !hasPaidAccess) {
    this.trial.status = "expired";

    if (this.billing?.status === "trialing") {
      this.billing.status = "inactive";
    }

    if (this.paymentStatus === "trialing") {
      this.paymentStatus = "pending";
    }

    this.accessStatus = "suspended";
    this.approvedForAccess = false;
  }

  if (hasPaidAccess && this.trial?.status !== "converted") {
    this.trial.status = "converted";
    this.paymentStatus = "paid";
    this.accessStatus = "active";
    this.approvedForAccess = true;
  }

  next();
});

const Organization =
  mongoose.models.Organization ||
  mongoose.model("Organization", OrganizationSchema, "organizations");

export default Organization;
