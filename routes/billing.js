import dotenv from "dotenv";
dotenv.config();

import express from "express";
import Stripe from "stripe";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

import Organization from "../models/Organization.js";
import User from "../models/User.js";
import Membership from "../models/Membership.js";

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const FULL_PERMS = [
  "overview.view",
  "revenue_intel.view",
  "command_center.view",
  "deal_room.view",
  "market_signals.view",
  "accounts.view",
  "partners.view",
  "admin.view",
];

const STRIPE_PLANS = {
  CORE: process.env.STRIPE_PRICE_CORE || "price_1T9ElhKK5ZvMP3dusIFTijQg",
  GROWTH: process.env.STRIPE_PRICE_GROWTH || "price_1T9EoiKK5ZvMP3du6LNA5PDk",
  ENTERPRISE: process.env.STRIPE_PRICE_ENTERPRISE || "price_1T9EpWKK5ZvMP3duGAsFkUyP",
};

const PRICE_TO_PLAN = {
  [STRIPE_PLANS.CORE]: "CORE",
  [STRIPE_PLANS.GROWTH]: "GROWTH",
  [STRIPE_PLANS.ENTERPRISE]: "ENTERPRISE",
};

function normalizePlan(plan = "") {
  const p = String(plan || "").toUpperCase().trim();
  if (p === "SCALE") return "CORE";
  if (p === "GROWTH") return "GROWTH";
  if (p === "ENTERPRISE") return "ENTERPRISE";
  return "CORE";
}

function slugify(value = "") {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function uniqueOrgSlug(baseName) {
  const base = slugify(baseName) || `org-${Date.now()}`;
  let slug = base;
  let i = 1;

  while (true) {
    const exists = await Organization.findOne({ slug }).lean();
    if (!exists) return slug;
    slug = `${base}-${i++}`;
  }
}

function randomTempPassword(length = 12) {
  return Math.random().toString(36).slice(-length) + "A1!";
}

router.post("/checkout", async (req, res) => {
  try {
    const { email, orgId, plan } = req.body;

    const normalizedPlan = normalizePlan(plan);
    const priceId = STRIPE_PLANS[normalizedPlan];

    if (!priceId) {
      return res.status(400).json({ error: "Invalid plan selected" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.APP_BASE_URL}/login?payment=success`,
      cancel_url: `${process.env.APP_BASE_URL}/login?payment=cancelled`,
      metadata: {
        orgId: orgId || "",
        plan: normalizedPlan,
        email: email || "",
      },
      subscription_data: {
        metadata: {
          orgId: orgId || "",
          plan: normalizedPlan,
          email: email || "",
        },
      },
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    return res.status(500).json({
      error: "Checkout session failed",
      message: err?.message || "Unknown Stripe error",
    });
  }
});

async function findExistingUserByEmail(email) {
  if (!email) return null;
  return User.findOne({ email: String(email).toLowerCase().trim() });
}

async function findTargetOrgId({ orgId, email }) {
  if (orgId && mongoose.isValidObjectId(orgId)) {
    return String(orgId);
  }

  if (email) {
    const user = await User.findOne({
      email: String(email).toLowerCase().trim(),
    }).lean();

    if (user?.orgId && mongoose.isValidObjectId(user.orgId)) {
      return String(user.orgId);
    }
  }

  return null;
}

async function createClientWorkspaceAndUser({
  email,
  plan,
  customerId,
  subscriptionId,
  priceId,
  currentPeriodEnd,
}) {
  if (!email) {
    console.log("Cannot auto-create workspace without email");
    return null;
  }

  const normalizedEmail = String(email).toLowerCase().trim();
  const emailName = normalizedEmail.split("@")[0] || "Atlas User";
  const inferredCompany = emailName.replace(/[._-]+/g, " ").trim();
  const orgName =
    inferredCompany.length > 1
      ? inferredCompany.replace(/\b\w/g, (c) => c.toUpperCase())
      : "Atlas Client";

  const tempPassword = randomTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  let createdUser = null;
  let createdOrg = null;
  let createdMembership = null;

  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      createdUser = await User.create(
        [
          {
            name: orgName,
            email: normalizedEmail,
            passwordHash,
            company: orgName,
            role: "owner",
          },
        ],
        { session }
      ).then((docs) => docs[0]);

      const slug = await uniqueOrgSlug(orgName);

      createdOrg = await Organization.create(
        [
          {
            name: orgName,
            type: "client",
            slug,
            ownerId: createdUser._id,
            plan: normalizePlan(plan),
            demoCompleted: true,
            approvedForAccess: true,
            accessStatus: "active",
            paymentStatus: "paid",
            billing: {
              stripeCustomerId: customerId || null,
              stripeSubscriptionId: subscriptionId || null,
              stripePriceId: priceId || null,
              status: "active",
              currentPeriodEnd: currentPeriodEnd || null,
            },
          },
        ],
        { session }
      ).then((docs) => docs[0]);

      createdUser.orgId = createdOrg._id;
      createdUser.activeWorkspace = createdOrg._id;
      await createdUser.save({ session });

      createdMembership = await Membership.create(
        [
          {
            userId: createdUser._id,
            orgId: createdOrg._id,
            workspaceId: createdOrg._id,
            role: "owner",
            permissions: FULL_PERMS,
            status: "active",
          },
        ],
        { session }
      ).then((docs) => docs[0]);
    });
  } finally {
    await session.endSession();
  }

  console.log("Created new Atlas client workspace:", {
    email: normalizedEmail,
    orgId: String(createdOrg?._id || ""),
    plan: normalizePlan(plan),
    tempPassword,
  });

  return {
    user: createdUser,
    org: createdOrg,
    membership: createdMembership,
    tempPassword,
  };
}

async function activateExistingOrganization({
  orgId,
  email,
  plan,
  customerId,
  subscriptionId,
  priceId,
  currentPeriodEnd,
}) {
  const targetOrgId = await findTargetOrgId({ orgId, email });

  if (!targetOrgId) {
    return false;
  }

  await Organization.findByIdAndUpdate(targetOrgId, {
    plan: normalizePlan(plan),
    demoCompleted: true,
    approvedForAccess: true,
    accessStatus: "active",
    paymentStatus: "paid",
    "billing.stripeCustomerId": customerId || null,
    "billing.stripeSubscriptionId": subscriptionId || null,
    "billing.stripePriceId": priceId || null,
    "billing.status": "active",
    "billing.currentPeriodEnd": currentPeriodEnd || null,
  });

  console.log("Activated existing Atlas organization:", targetOrgId);
  return true;
}

async function ensurePaidClientAccess({
  orgId,
  email,
  plan,
  customerId,
  subscriptionId,
  priceId,
  currentPeriodEnd,
}) {
  const normalizedPlan = normalizePlan(plan);

  const activatedExisting = await activateExistingOrganization({
    orgId,
    email,
    plan: normalizedPlan,
    customerId,
    subscriptionId,
    priceId,
    currentPeriodEnd,
  });

  if (activatedExisting) {
    return { mode: "existing" };
  }

  const existingUser = await findExistingUserByEmail(email);

  if (existingUser?.orgId) {
    await activateExistingOrganization({
      orgId: String(existingUser.orgId),
      email,
      plan: normalizedPlan,
      customerId,
      subscriptionId,
      priceId,
      currentPeriodEnd,
    });
    return { mode: "existing-user-org" };
  }

  const created = await createClientWorkspaceAndUser({
    email,
    plan: normalizedPlan,
    customerId,
    subscriptionId,
    priceId,
    currentPeriodEnd,
  });

  if (created) {
    return {
      mode: "created",
      tempPassword: created.tempPassword,
      email,
      orgId: String(created.org._id),
      plan: normalizedPlan,
    };
  }

  return { mode: "none" };
}

router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      const eventType = event.type;
      const data = event.data.object;

      console.log("Stripe webhook received:", eventType);

      if (eventType === "checkout.session.completed") {
        const metadataOrgId = data.metadata?.orgId || "";
        const metadataPlan = normalizePlan(data.metadata?.plan || "");
        const metadataEmail = data.metadata?.email || "";

        const email =
          metadataEmail ||
          data.customer_details?.email ||
          data.customer_email ||
          "";

        let plan = metadataPlan;
        let priceId = null;

        const fullSession = await stripe.checkout.sessions.retrieve(data.id, {
          expand: ["line_items.data.price", "subscription"],
        });

        priceId = fullSession?.line_items?.data?.[0]?.price?.id || null;

        if (!plan && priceId) {
          plan = normalizePlan(PRICE_TO_PLAN[priceId] || "");
        }

        const currentPeriodEndUnix =
          fullSession?.subscription?.current_period_end || null;

        const result = await ensurePaidClientAccess({
          orgId: metadataOrgId,
          email,
          plan,
          customerId: data.customer || null,
          subscriptionId: data.subscription || null,
          priceId,
          currentPeriodEnd: currentPeriodEndUnix
            ? new Date(currentPeriodEndUnix * 1000)
            : null,
        });

        console.log("checkout.session.completed result:", result);
      }

      if (eventType === "invoice.payment_succeeded") {
        const subscriptionId = data.subscription;
        const customerId = data.customer;
        const priceId = data.lines?.data?.[0]?.price?.id || null;
        const plan = normalizePlan(priceId ? PRICE_TO_PLAN[priceId] || "" : "");
        const periodEndUnix = data.lines?.data?.[0]?.period?.end || null;
        const email = data.customer_email || "";

        if (subscriptionId) {
          const updated = await Organization.findOneAndUpdate(
            { "billing.stripeSubscriptionId": subscriptionId },
            {
              paymentStatus: "paid",
              accessStatus: "active",
              approvedForAccess: true,
              demoCompleted: true,
              plan,
              "billing.stripeCustomerId": customerId || null,
              "billing.stripePriceId": priceId || null,
              "billing.status": "active",
              "billing.currentPeriodEnd": periodEndUnix
                ? new Date(periodEndUnix * 1000)
                : null,
            }
          );

          if (!updated) {
            const result = await ensurePaidClientAccess({
              orgId: "",
              email,
              plan,
              customerId,
              subscriptionId,
              priceId,
              currentPeriodEnd: periodEndUnix
                ? new Date(periodEndUnix * 1000)
                : null,
            });

            console.log("invoice.payment_succeeded result:", result);
          }

          console.log("Billing marked active for subscription:", subscriptionId);
        }
      }

      if (eventType === "invoice.payment_failed") {
        const subscriptionId = data.subscription;

        if (subscriptionId) {
          await Organization.findOneAndUpdate(
            { "billing.stripeSubscriptionId": subscriptionId },
            {
              paymentStatus: "past_due",
              accessStatus: "suspended",
              "billing.status": "past_due",
            }
          );

          console.log("Billing marked past_due for subscription:", subscriptionId);
        }
      }

      if (eventType === "customer.subscription.deleted") {
        const subscriptionId = data.id;

        if (subscriptionId) {
          await Organization.findOneAndUpdate(
            { "billing.stripeSubscriptionId": subscriptionId },
            {
              paymentStatus: "canceled",
              accessStatus: "suspended",
              "billing.status": "canceled",
            }
          );

          console.log("Billing marked cancelled for subscription:", subscriptionId);
        }
      }

      if (eventType === "customer.subscription.updated") {
        const subscriptionId = data.id;
        const status = data.status;
        const priceId = data.items?.data?.[0]?.price?.id || null;
        const plan = normalizePlan(priceId ? PRICE_TO_PLAN[priceId] || "" : "");
        const currentPeriodEndUnix = data.current_period_end || null;

        if (subscriptionId) {
          const mappedPaymentStatus =
            status === "past_due"
              ? "past_due"
              : status === "canceled"
              ? "canceled"
              : "paid";

          const mappedAccessStatus =
            status === "past_due" || status === "canceled"
              ? "suspended"
              : "active";

          await Organization.findOneAndUpdate(
            { "billing.stripeSubscriptionId": subscriptionId },
            {
              plan,
              paymentStatus: mappedPaymentStatus,
              accessStatus: mappedAccessStatus,
              approvedForAccess: mappedAccessStatus === "active",
              "billing.stripePriceId": priceId || null,
              "billing.status": status,
              "billing.currentPeriodEnd": currentPeriodEndUnix
                ? new Date(currentPeriodEndUnix * 1000)
                : null,
            }
          );

          console.log(
            "Billing status synced from Stripe:",
            subscriptionId,
            "->",
            status
          );
        }
      }

      return res.json({ received: true });
    } catch (err) {
      console.error("Webhook processing error:", err);
      return res.status(500).json({
        error: "Webhook handler failed",
        message: err?.message || "Unknown webhook error",
      });
    }
  }
);

export default router;