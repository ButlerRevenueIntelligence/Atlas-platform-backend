import dotenv from "dotenv";
dotenv.config();

import express from "express";
import Stripe from "stripe";
import mongoose from "mongoose";
import Organization from "../models/Organization.js";
import User from "../models/User.js";

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const STRIPE_PLANS = {
  SCALE: "price_1T9ElhKK5ZvMP3dusIFTijQg",
  GROWTH: "price_1T9EoiKK5ZvMP3du6LNA5PDk",
  ENTERPRISE: "price_1T9EpWKK5ZvMP3duGAsFkUyP",
};

const PRICE_TO_PLAN = {
  price_1T9ElhKK5ZvMP3dusIFTijQg: "SCALE",
  price_1T9EoiKK5ZvMP3du6LNA5PDk: "GROWTH",
  price_1T9EpWKK5ZvMP3duGAsFkUyP: "ENTERPRISE",
};

router.post("/checkout", async (req, res) => {
  try {
    const { email, orgId, plan } = req.body;

    const priceId = STRIPE_PLANS[plan];

    if (!priceId) {
      return res.status(400).json({ error: "Invalid plan selected" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${process.env.APP_BASE_URL}/login?payment=success`,
      cancel_url: `${process.env.APP_BASE_URL}/login?payment=cancelled`,
      metadata: {
        orgId: orgId || "",
        plan: plan || "",
        email: email || "",
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

async function activateOrganization({
  orgId,
  email,
  plan,
  customerId,
  subscriptionId,
}) {
  let targetOrgId = null;

  if (orgId && mongoose.isValidObjectId(orgId)) {
    targetOrgId = orgId;
  }

  // Fallback: match org from user email when payment link doesn't send metadata
  if (!targetOrgId && email) {
    const user = await User.findOne({ email: String(email).toLowerCase().trim() }).lean();
    if (user?.orgId && mongoose.isValidObjectId(user.orgId)) {
      targetOrgId = String(user.orgId);
    }
  }

  if (!targetOrgId) {
    console.log("No valid org found for Stripe activation", {
      orgId,
      email,
      plan,
    });
    return false;
  }

  await Organization.findByIdAndUpdate(targetOrgId, {
    status: "active",
    isActive: true,
    billingStatus: "active",
    plan: plan || "GROWTH",
    "billing.status": "active",
    "billing.plan": plan || "GROWTH",
    "billing.stripeCustomerId": customerId || null,
    "billing.stripeSubscriptionId": subscriptionId || null,
  });

  console.log("Organization billing activated:", targetOrgId);
  return true;
}

router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
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
      const metadataPlan = data.metadata?.plan || "";
      const metadataEmail = data.metadata?.email || "";

      const email =
        metadataEmail ||
        data.customer_details?.email ||
        data.customer_email ||
        "";

      let plan = metadataPlan;

      if (!plan && Array.isArray(data.line_items?.data) && data.line_items.data[0]?.price?.id) {
        plan = PRICE_TO_PLAN[data.line_items.data[0].price.id] || "";
      }

      // If line items are not present on the event object, fetch the session with line items
      if (!plan) {
        const fullSession = await stripe.checkout.sessions.retrieve(data.id, {
          expand: ["line_items.data.price"],
        });

        const priceId = fullSession?.line_items?.data?.[0]?.price?.id;
        if (priceId) {
          plan = PRICE_TO_PLAN[priceId] || "";
        }
      }

      await activateOrganization({
        orgId: metadataOrgId,
        email,
        plan,
        customerId: data.customer || null,
        subscriptionId: data.subscription || null,
      });
    }

    if (eventType === "invoice.payment_succeeded") {
      const subscriptionId = data.subscription;
      const customerId = data.customer;
      const email = data.customer_email || data.customer_details?.email || "";

      if (subscriptionId) {
        const existingOrg = await Organization.findOneAndUpdate(
          { "billing.stripeSubscriptionId": subscriptionId },
          {
            "billing.status": "active",
            billingStatus: "active",
            status: "active",
            isActive: true,
          }
        );

        if (!existingOrg) {
          await activateOrganization({
            orgId: "",
            email,
            plan: "",
            customerId,
            subscriptionId,
          });
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
            "billing.status": "past_due",
            billingStatus: "past_due",
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
            "billing.status": "cancelled",
            billingStatus: "cancelled",
          }
        );

        console.log("Billing marked cancelled for subscription:", subscriptionId);
      }
    }

    if (eventType === "customer.subscription.updated") {
      const subscriptionId = data.id;
      const status = data.status;

      if (subscriptionId) {
        await Organization.findOneAndUpdate(
          { "billing.stripeSubscriptionId": subscriptionId },
          {
            "billing.status": status,
            billingStatus: status,
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
});

export default router;