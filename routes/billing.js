import express from "express";
import Stripe from "stripe";
import { requireAuth } from "../middleware/authMiddleware.js";
import Organization from "../models/Organization.js";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

router.post("/checkout", requireAuth, async (req, res) => {
  const { priceId } = req.body; // Stripe Price ID
  if (!priceId) return res.status(400).json({ error: "Missing priceId" });

  const org = await Organization.findById(req.orgId);
  if (!org) return res.status(404).json({ error: "Org not found" });

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.FRONTEND_URL}/billing/success`,
    cancel_url: `${process.env.FRONTEND_URL}/billing/cancel`,
    metadata: { orgId: org._id.toString() },
  });

  res.json({ url: session.url });
});

export default router;
