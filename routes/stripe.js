import express from "express";
import Stripe from "stripe";
import Organization from "../models/Organization.js";

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function normalizePlanFromPrice(priceId = "") {
  const id = String(priceId).toLowerCase();

  if (id.includes("enterprise")) return "ENTERPRISE";
  if (id.includes("growth")) return "GROWTH";
  return "CORE";
}

router.post("/create-checkout-session", async (req, res) => {
  try {
    const { priceId, email, orgId } = req.body;

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
      metadata: {
        orgId: String(org._id),
        targetPlan,
      },
      subscription_data: {
        metadata: {
          orgId: String(org._id),
          targetPlan,
        },
      },
      success_url: `${process.env.FRONTEND_URL}/command-center`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout failed:", err);
    return res.status(500).json({ error: "Stripe checkout failed" });
  }
});

router.post("/create-invoice", async (req, res) => {
  try {
    const { customerId, amount } = req.body;

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
      console.error("Webhook signature failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;

          const orgId = session?.metadata?.orgId;
          const targetPlan = session?.metadata?.targetPlan || "CORE";
          const stripeCustomerId = session?.customer || null;
          const stripeSubscriptionId = session?.subscription || null;

          if (orgId) {
            await Organization.findByIdAndUpdate(orgId, {
              plan: targetPlan,
              paymentStatus: "paid",
              accessStatus: "active",
              approvedForAccess: true,
              billing: {
                stripeCustomerId,
                stripeSubscriptionId,
                stripePriceId: null,
                status: "active",
                currentPeriodEnd: null,
              },
            });
          }

          console.log(`Subscription created for org ${orgId} with plan ${targetPlan}`);
          break;
        }

        case "invoice.paid": {
          const invoice = event.data.object;
          const stripeCustomerId = invoice?.customer || null;
          const stripeSubscriptionId = invoice?.subscription || null;

          const org = await Organization.findOne({
            "billing.stripeCustomerId": stripeCustomerId,
          });

          if (org) {
            org.paymentStatus = "paid";
            org.accessStatus = "active";
            org.approvedForAccess = true;
            org.billing.status = "active";
            org.billing.stripeSubscriptionId =
              stripeSubscriptionId || org.billing.stripeSubscriptionId;
            if (invoice?.lines?.data?.[0]?.price?.id) {
              org.billing.stripePriceId = invoice.lines.data[0].price.id;
            }
            if (invoice?.period_end) {
              org.billing.currentPeriodEnd = new Date(invoice.period_end * 1000);
            }
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
            org.billing.status = "past_due";
            await org.save();
          }

          console.log("Invoice payment failed");
          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object;
          const stripeSubscriptionId = subscription?.id || null;

          const org = await Organization.findOne({
            "billing.stripeSubscriptionId": stripeSubscriptionId,
          });

          if (org) {
            org.plan = "CORE";
            org.paymentStatus = "canceled";
            org.accessStatus = "suspended";
            org.billing.status = "canceled";
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
  }
);

export default router;