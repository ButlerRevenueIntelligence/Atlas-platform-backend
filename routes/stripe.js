import express from "express";
import Stripe from "stripe";

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

router.post("/create-checkout-session", async (req, res) => {
  try {
    const { priceId, email } = req.body;

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
      success_url: `${process.env.FRONTEND_URL}/command-center`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout failed:", err);
    res.status(500).json({ error: "Stripe checkout failed" });
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

    res.json(invoice);
  } catch (err) {
    console.error("Invoice creation failed:", err);
    res.status(500).json({ error: "Invoice creation failed" });
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

    switch (event.type) {
      case "checkout.session.completed":
        console.log("Subscription created");
        break;

      case "invoice.paid":
        console.log("Invoice paid");
        break;

      case "customer.subscription.deleted":
        console.log("Subscription canceled");
        break;

      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
  }
);

export default router;