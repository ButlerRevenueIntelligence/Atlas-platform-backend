import dotenv from "dotenv";
dotenv.config();

import express from "express";
import Stripe from "stripe";
import Organization from "../models/Organization.js";

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const STRIPE_PLANS = {
  SCALE: "price_1T9ElhKK5ZvMP3dusIFTijQg",
  GROWTH: "price_1T9EoiKK5ZvMP3du6LNA5PDk",
  ENTERPRISE: "price_1T9EpWKK5ZvMP3duGAsFkUyP",
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
        orgId,
        plan,
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res.status(500).json({
      error: "Checkout session failed",
      message: err?.message || "Unknown Stripe error",
    });
  }
});

   router.post("/webhook", async (req, res) => {
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
        const orgId = data.metadata?.orgId;
        const plan = data.metadata?.plan;

        if (!orgId) {
          console.log(
            "checkout.session.completed received without orgId metadata; likely Stripe dashboard test event"
          );
          return res.json({ received: true, skipped: true });
        }

        await Organization.findByIdAndUpdate(orgId, {
          "billing.status": "active",
          "billing.stripeCustomerId": data.customer,
          "billing.stripeSubscriptionId": data.subscription,
          "billing.plan": plan || "unknown",
        });

        console.log("Organization billing activated:", orgId);
      }

      if (eventType === "invoice.payment_succeeded") {
        const subscriptionId = data.subscription;

        if (subscriptionId) {
          await Organization.findOneAndUpdate(
            { "billing.stripeSubscriptionId": subscriptionId },
            { "billing.status": "active" }
          );

          console.log("Billing marked active for subscription:", subscriptionId);
        }
      }

      if (eventType === "invoice.payment_failed") {
        const subscriptionId = data.subscription;

        if (subscriptionId) {
          await Organization.findOneAndUpdate(
            { "billing.stripeSubscriptionId": subscriptionId },
            { "billing.status": "past_due" }
          );

          console.log("Billing marked past_due for subscription:", subscriptionId);
        }
      }

      if (eventType === "customer.subscription.deleted") {
        const subscriptionId = data.id;

        if (subscriptionId) {
          await Organization.findOneAndUpdate(
            { "billing.stripeSubscriptionId": subscriptionId },
            { "billing.status": "cancelled" }
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
            { "billing.status": status }
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