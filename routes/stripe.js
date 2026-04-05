import express from "express";
import Stripe from "stripe";
import Organization from "../models/Organization.js";

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRICE_TO_PLAN = {
  "price_1TC9EyKmVYjJJZfS0ung29G2": "SCALE",
  "price_1TC9FwKmVYjJJZfSAgSN5oK8": "GROWTH",
  "price_1TC9GUKmVYjJJZfS8E3rxQoG": "ENTERPRISE",
};

function normalizePlanFromPrice(priceId = "") {
  return PRICE_TO_PLAN[String(priceId)] || "SCALE";
}

function getFrontendUrl() {
  return (
    process.env.FRONTEND_URL ||
    "https://app.atlasrevenueai.com"
  );
}

function buildBillingState({
  stripeCustomerId = null,
  stripeSubscriptionId = null,
  stripePriceId = null,
  status = "inactive",
  currentPeriodEnd = null,
  existingBilling = {},
}) {
  return {
    ...(existingBilling || {}),
    stripeCustomerId:
      stripeCustomerId ?? existingBilling?.stripeCustomerId ?? null,
    stripeSubscriptionId:
      stripeSubscriptionId ?? existingBilling?.stripeSubscriptionId ?? null,
    stripePriceId: stripePriceId ?? existingBilling?.stripePriceId ?? null,
    status,
    currentPeriodEnd:
      currentPeriodEnd ?? existingBilling?.currentPeriodEnd ?? null,
  };
}

router.post("/create-checkout-session", async (req, res) => {
  try {
    const { priceId, email, orgId } = req.body || {};

    if (!priceId) {
      return res.status(400).json({ error: "priceId is required" });
    }

    if (!orgId) {
      return res.status(400).json({ error: "orgId is required" });
    }

    const org = await Organization.findById(orgId);

    if (!org) {
      return res.status(404).json({ error: "Organization not found" });
    }

    const targetPlan = normalizePlanFromPrice(priceId);
    const frontendUrl = getFrontendUrl();

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: email || undefined,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata: {
        orgId: String(org._id),
        targetPlan,
        priceId: String(priceId),
      },
      subscription_data: {
        metadata: {
          orgId: String(org._id),
          targetPlan,
          priceId: String(priceId),
        },
      },
      success_url: `${frontendUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/billing?checkout=cancelled`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout failed:", err);
    return res.status(500).json({ error: err?.message || "Stripe checkout failed" });
  }
});

router.post("/create-invoice", async (req, res) => {
  try {
    const { customerId, amount } = req.body || {};

    await stripe.invoiceItems.create({
      customer: customerId,
      amount,
      currency: "usd",
      description: "Atlas Revenue AI Invoice",
    });

    const invoice = await stripe.invoices.create({
      customer: customerId,
      auto_advance: true,
    });

    return res.json(invoice);
  } catch (err) {
    console.error("Invoice creation failed:", err);
    return res.status(500).json({ error: "Invoice creation failed" });
  }
});

router.post("/create-portal-session", async (req, res) => {
  try {
    const { orgId } = req.body || {};

    if (!orgId) {
      return res.status(400).json({ error: "orgId is required" });
    }

    const org = await Organization.findById(orgId).lean();

    if (!org) {
      return res.status(404).json({ error: "Organization not found" });
    }

    const customerId = org?.billing?.stripeCustomerId;

    if (!customerId) {
      return res.status(400).json({
        error: "No Stripe customer found for this workspace",
      });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${getFrontendUrl()}/billing`,
    });

    return res.json({ url: portalSession.url });
  } catch (err) {
    console.error("Stripe portal failed:", err);
    return res.status(500).json({ error: err?.message || "Stripe portal failed" });
  }
});

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
    console.error("Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;

        const orgId = session?.metadata?.orgId;
        const targetPlan = session?.metadata?.targetPlan || "SCALE";
        const stripeCustomerId = session?.customer || null;
        const stripeSubscriptionId = session?.subscription || null;
        const stripePriceId = session?.metadata?.priceId || null;

        if (orgId) {
          const org = await Organization.findById(orgId);

          if (org) {
            org.plan = targetPlan;
            org.paymentStatus = "paid";
            org.accessStatus = "active";
            org.approvedForAccess = true;
            org.demoCompleted = true;

            org.trial = {
              ...(org.trial || {}),
              status: "converted",
            };

            org.billing = buildBillingState({
              stripeCustomerId,
              stripeSubscriptionId,
              stripePriceId,
              status: "active",
              currentPeriodEnd: org.billing?.currentPeriodEnd || null,
              existingBilling: org.billing,
            });

            await org.save();
          }
        }

        console.log(`Checkout completed for org ${orgId} with plan ${targetPlan}`);
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = event.data.object;
        const stripeSubscriptionId = subscription?.id || null;
        const stripeCustomerId = subscription?.customer || null;
        const stripePriceId =
          subscription?.items?.data?.[0]?.price?.id || null;
        const targetPlan = normalizePlanFromPrice(stripePriceId);
        const currentPeriodEnd = subscription?.current_period_end
          ? new Date(subscription.current_period_end * 1000)
          : null;

        const org =
          (subscription?.metadata?.orgId
            ? await Organization.findById(subscription.metadata.orgId)
            : null) ||
          (stripeCustomerId
            ? await Organization.findOne({
                "billing.stripeCustomerId": stripeCustomerId,
              })
            : null);

        if (org) {
          const subStatus = String(subscription?.status || "").toLowerCase();
          const paidLike =
            subStatus === "active" || subStatus === "trialing";

          org.plan = targetPlan || org.plan;
          org.paymentStatus = paidLike ? "paid" : "past_due";
          org.accessStatus = paidLike ? "active" : "suspended";
          org.approvedForAccess = paidLike;
          org.demoCompleted = true;

          if (paidLike) {
            org.trial = {
              ...(org.trial || {}),
              status: "converted",
            };
          }

          org.billing = buildBillingState({
            stripeCustomerId,
            stripeSubscriptionId,
            stripePriceId,
            status: paidLike ? "active" : "past_due",
            currentPeriodEnd,
            existingBilling: org.billing,
          });

          await org.save();
        }

        console.log(`Subscription synced: ${stripeSubscriptionId}`);
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object;
        const stripeCustomerId = invoice?.customer || null;
        const stripeSubscriptionId = invoice?.subscription || null;
        const stripePriceId = invoice?.lines?.data?.[0]?.price?.id || null;
        const targetPlan = normalizePlanFromPrice(stripePriceId);

        const org = await Organization.findOne({
          "billing.stripeCustomerId": stripeCustomerId,
        });

        if (org) {
          org.plan = targetPlan || org.plan;
          org.paymentStatus = "paid";
          org.accessStatus = "active";
          org.approvedForAccess = true;
          org.demoCompleted = true;
          org.trial = {
            ...(org.trial || {}),
            status: "converted",
          };

          org.billing = buildBillingState({
            stripeCustomerId,
            stripeSubscriptionId,
            stripePriceId,
            status: "active",
            currentPeriodEnd: invoice?.lines?.data?.[0]?.period?.end
              ? new Date(invoice.lines.data[0].period.end * 1000)
              : org.billing?.currentPeriodEnd || null,
            existingBilling: org.billing,
          });

          await org.save();
        }

        console.log("Invoice paid");
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const stripeCustomerId = invoice?.customer || null;

        const org = await Organization.findOne({
          "billing.stripeCustomerId": stripeCustomerId,
        });

        if (org) {
          org.paymentStatus = "past_due";
          org.accessStatus = "suspended";
          org.approvedForAccess = false;

          org.billing = buildBillingState({
            stripeCustomerId,
            stripeSubscriptionId: org.billing?.stripeSubscriptionId || null,
            stripePriceId: org.billing?.stripePriceId || null,
            status: "past_due",
            currentPeriodEnd: org.billing?.currentPeriodEnd || null,
            existingBilling: org.billing,
          });

          await org.save();
        }

        console.log("Invoice payment failed");
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const stripeSubscriptionId = subscription?.id || null;
        const stripeCustomerId = subscription?.customer || null;

        const org =
          (stripeSubscriptionId
            ? await Organization.findOne({
                "billing.stripeSubscriptionId": stripeSubscriptionId,
              })
            : null) ||
          (stripeCustomerId
            ? await Organization.findOne({
                "billing.stripeCustomerId": stripeCustomerId,
              })
            : null);

        if (org) {
          org.paymentStatus = "canceled";
          org.accessStatus = "suspended";
          org.approvedForAccess = false;

          org.billing = buildBillingState({
            stripeCustomerId,
            stripeSubscriptionId,
            stripePriceId: org.billing?.stripePriceId || null,
            status: "canceled",
            currentPeriodEnd: org.billing?.currentPeriodEnd || null,
            existingBilling: org.billing,
          });

          await org.save();
        }

        console.log("Subscription canceled");
        break;
      }

      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("Webhook handling failed:", err);
    return res.status(500).json({ error: "Webhook handling failed" });
  }
});

export default router;