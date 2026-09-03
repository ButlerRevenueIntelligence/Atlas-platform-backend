// backend/routes/stripe.js
import express from "express";
import Stripe from "stripe";
import mongoose from "mongoose";

import Organization from "../models/Organization.js";
import Membership from "../models/Membership.js";
import User from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

const stripe = stripeSecretKey
  ? new Stripe(stripeSecretKey)
  : null;

const PLAN_CONFIG = {
  SCALE: {
    name: "Atlas Core",
    priceId: process.env.STRIPE_PRICE_CORE || "",
  },
  GROWTH: {
    name: "Atlas Growth",
    priceId: process.env.STRIPE_PRICE_GROWTH || "",
  },
  ENTERPRISE: {
    name: "Atlas Enterprise",
    priceId: process.env.STRIPE_PRICE_ENTERPRISE || "",
  },
};

function toObjectId(value) {
  if (!value) return null;

  const stringValue = String(value);

  return mongoose.Types.ObjectId.isValid(stringValue)
    ? new mongoose.Types.ObjectId(stringValue)
    : null;
}

function normalizePlan(value) {
  const plan = String(value || "")
    .trim()
    .toUpperCase();

  if (plan === "CORE") return "SCALE";
  if (plan === "SCALE") return "SCALE";
  if (plan === "GROWTH") return "GROWTH";
  if (plan === "ENTERPRISE") return "ENTERPRISE";

  return "";
}

function planFromPriceId(priceId) {
  const match = Object.entries(PLAN_CONFIG).find(
    ([, config]) =>
      config.priceId &&
      config.priceId === String(priceId || "")
  );

  return match?.[0] || "";
}

function getFrontendUrl() {
  return String(
    process.env.FRONTEND_URL ||
      process.env.APP_FRONTEND_URL ||
      "https://app.atlasrevenueai.com"
  ).replace(/\/+$/, "");
}

function stripeReady() {
  return Boolean(
    stripe &&
      stripeSecretKey &&
      stripeWebhookSecret
  );
}

function currentPeriodEnd(subscription) {
  const unixValue =
    subscription?.current_period_end ||
    subscription?.items?.data?.[0]?.current_period_end ||
    null;

  return unixValue
    ? new Date(unixValue * 1000)
    : null;
}

function subscriptionAccessState(status) {
  const normalized = String(status || "").toLowerCase();

  if (normalized === "active") {
    return {
      billingStatus: "active",
      paymentStatus: "paid",
      accessStatus: "active",
      approvedForAccess: true,
    };
  }

  if (normalized === "trialing") {
    return {
      billingStatus: "trialing",
      paymentStatus: "trialing",
      accessStatus: "active",
      approvedForAccess: true,
    };
  }

  if (normalized === "past_due") {
    return {
      billingStatus: "past_due",
      paymentStatus: "past_due",
      accessStatus: "suspended",
      approvedForAccess: false,
    };
  }

  if (
    [
      "canceled",
      "unpaid",
      "incomplete_expired",
      "paused",
    ].includes(normalized)
  ) {
    return {
      billingStatus: normalized,
      paymentStatus:
        normalized === "canceled"
          ? "canceled"
          : normalized,
      accessStatus: "suspended",
      approvedForAccess: false,
    };
  }

  return {
    billingStatus: normalized || "pending",
    paymentStatus: "pending",
    accessStatus: "pending",
    approvedForAccess: false,
  };
}

async function getAuthorizedWorkspace(req, options = {}) {
  const requireManager = Boolean(options.requireManager);

  const userId = toObjectId(
    req.user?.userId ||
      req.user?._id ||
      req.user?.id
  );

  const orgId = toObjectId(
    req.user?.orgId ||
      req.headers["x-org-id"] ||
      req.headers["x-workspace-id"]
  );

  if (!userId || !orgId) {
    return {
      error: {
        status: 400,
        message: "Missing workspace context.",
      },
    };
  }

  const membership = await Membership.findOne({
    userId,
    orgId,
    status: { $nin: ["disabled", "suspended"] },
  }).lean();

  if (!membership) {
    return {
      error: {
        status: 403,
        message:
          "You do not have access to this workspace.",
      },
    };
  }

  const role = String(
    membership.role || ""
  ).toLowerCase();

  if (
    requireManager &&
    !["owner", "admin"].includes(role)
  ) {
    return {
      error: {
        status: 403,
        message:
          "Only workspace owners and admins can manage billing.",
      },
    };
  }

  const organization = await Organization.findById(orgId);

  if (!organization) {
    return {
      error: {
        status: 404,
        message: "Workspace not found.",
      },
    };
  }

  return {
    userId,
    orgId,
    role,
    membership,
    organization,
  };
}

async function syncSubscriptionToWorkspace({
  subscription,
  organization = null,
}) {
  if (!subscription) return null;

  const subscriptionId = subscription.id || null;
  const customerId = subscription.customer || null;
  const priceId =
    subscription.items?.data?.[0]?.price?.id || null;

  const metadataOrgId = toObjectId(
    subscription.metadata?.orgId
  );

  let org = organization;

  if (!org && metadataOrgId) {
    org = await Organization.findById(metadataOrgId);
  }

  if (!org && subscriptionId) {
    org = await Organization.findOne({
      "billing.stripeSubscriptionId":
        subscriptionId,
    });
  }

  if (!org && customerId) {
    org = await Organization.findOne({
      "billing.stripeCustomerId": customerId,
    });
  }

  if (!org) return null;

  const mappedPlan = planFromPriceId(priceId);
  const state = subscriptionAccessState(
    subscription.status
  );

  if (mappedPlan) {
    org.plan = mappedPlan;
  }

  org.paymentStatus = state.paymentStatus;
  org.accessStatus = state.accessStatus;
  org.approvedForAccess =
    state.approvedForAccess;

  org.billing = {
    ...(org.billing?.toObject
      ? org.billing.toObject()
      : org.billing || {}),
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    stripePriceId: priceId,
    status: state.billingStatus,
    currentPeriodEnd:
      currentPeriodEnd(subscription),
  };

  if (
    ["active", "trialing"].includes(
      String(subscription.status).toLowerCase()
    )
  ) {
    org.demoCompleted = true;

    org.trial = {
      ...(org.trial?.toObject
        ? org.trial.toObject()
        : org.trial || {}),
      status: "converted",
    };
  }

  await org.save();

  return org;
}

/**
 * GET /api/stripe/summary
 * Returns billing information for the active workspace.
 */
router.get("/summary", requireAuth, async (req, res) => {
  try {
    const context =
      await getAuthorizedWorkspace(req);

    if (context.error) {
      return res
        .status(context.error.status)
        .json({
          ok: false,
          message: context.error.message,
        });
    }

    const { organization, role } = context;

    const billing =
      organization.billing?.toObject
        ? organization.billing.toObject()
        : organization.billing || {};

    return res.json({
      ok: true,
      billing: {
        orgId: String(organization._id),
        orgName: organization.name,
        plan: normalizePlan(
          organization.plan
        ) || "SCALE",
        accessStatus:
          organization.accessStatus || "pending",
        paymentStatus:
          organization.paymentStatus || "pending",
        billingStatus:
          billing.status ||
          organization.paymentStatus ||
          "inactive",
        currentPeriodEnd:
          billing.currentPeriodEnd || null,
        hasStripeCustomer: Boolean(
          billing.stripeCustomerId
        ),
        hasSubscription: Boolean(
          billing.stripeSubscriptionId
        ),
        trial: organization.trial || null,
        role,
        canManage: ["owner", "admin"].includes(
          role
        ),
      },
    });
  } catch (err) {
    console.error(
      "GET STRIPE SUMMARY ERROR:",
      err
    );

    return res.status(500).json({
      ok: false,
      message:
        "Unable to load billing information.",
    });
  }
});

/**
 * POST /api/stripe/create-checkout-session
 * Starts a new subscription for an owner/admin.
 */
router.post(
  "/create-checkout-session",
  express.json(),
  requireAuth,
  async (req, res) => {
    try {
      if (!stripe) {
        return res.status(503).json({
          ok: false,
          message:
            "Stripe is not configured.",
        });
      }

      const context =
        await getAuthorizedWorkspace(req, {
          requireManager: true,
        });

      if (context.error) {
        return res
          .status(context.error.status)
          .json({
            ok: false,
            message:
              context.error.message,
          });
      }

      const { organization, userId } = context;
      const requestedPlan = normalizePlan(
        req.body?.plan
      );

      if (
        !requestedPlan ||
        !PLAN_CONFIG[requestedPlan]
      ) {
        return res.status(400).json({
          ok: false,
          message:
            "Select a valid Atlas plan.",
        });
      }

      const priceId =
        PLAN_CONFIG[requestedPlan].priceId;

      if (!priceId) {
        return res.status(503).json({
          ok: false,
          message: `${PLAN_CONFIG[requestedPlan].name} is not configured in Stripe.`,
        });
      }

      const existingSubscriptionId =
        organization.billing
          ?.stripeSubscriptionId;

      const existingCustomerId =
        organization.billing
          ?.stripeCustomerId;

      if (
        existingSubscriptionId &&
        existingCustomerId
      ) {
        return res.status(409).json({
          ok: false,
          code: "USE_BILLING_PORTAL",
          message:
            "This workspace already has a subscription. Use Manage Billing to change its plan.",
        });
      }

      const user = await User.findById(userId)
        .select("email")
        .lean();

      const checkoutPayload = {
        mode: "subscription",
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        allow_promotion_codes: true,
        success_url: `${getFrontendUrl()}/billing?checkout=success`,
        cancel_url: `${getFrontendUrl()}/billing?checkout=cancelled`,
        metadata: {
          orgId: String(organization._id),
          targetPlan: requestedPlan,
        },
        subscription_data: {
          metadata: {
            orgId: String(
              organization._id
            ),
            targetPlan: requestedPlan,
          },
        },
      };

      if (existingCustomerId) {
        checkoutPayload.customer =
          existingCustomerId;
      } else if (user?.email) {
        checkoutPayload.customer_email =
          user.email;
      }

      const session =
        await stripe.checkout.sessions.create(
          checkoutPayload
        );

      return res.json({
        ok: true,
        url: session.url,
      });
    } catch (err) {
      console.error(
        "CREATE CHECKOUT SESSION ERROR:",
        err
      );

      return res.status(500).json({
        ok: false,
        message:
          "Unable to start secure checkout.",
      });
    }
  }
);

/**
 * POST /api/stripe/create-portal-session
 * Opens Stripe’s hosted subscription manager.
 */
router.post(
  "/create-portal-session",
  express.json(),
  requireAuth,
  async (req, res) => {
    try {
      if (!stripe) {
        return res.status(503).json({
          ok: false,
          message:
            "Stripe is not configured.",
        });
      }

      const context =
        await getAuthorizedWorkspace(req, {
          requireManager: true,
        });

      if (context.error) {
        return res
          .status(context.error.status)
          .json({
            ok: false,
            message:
              context.error.message,
          });
      }

      const customerId =
        context.organization.billing
          ?.stripeCustomerId;

      if (!customerId) {
        return res.status(400).json({
          ok: false,
          code: "NO_STRIPE_CUSTOMER",
          message:
            "Choose a plan before opening the billing portal.",
        });
      }

      const session =
        await stripe.billingPortal.sessions.create(
          {
            customer: customerId,
            return_url: `${getFrontendUrl()}/billing`,
          }
        );

      return res.json({
        ok: true,
        url: session.url,
      });
    } catch (err) {
      console.error(
        "CREATE PORTAL SESSION ERROR:",
        err
      );

      return res.status(500).json({
        ok: false,
        message:
          "Unable to open the billing portal.",
      });
    }
  }
);

/**
 * POST /api/stripe/webhook
 *
 * This endpoint must receive the untouched raw body.
 */
router.post(
  "/webhook",
  express.raw({
    type: "application/json",
  }),
  async (req, res) => {
    if (!stripe || !stripeWebhookSecret) {
      return res.status(503).json({
        received: false,
        message:
          "Stripe webhook is not configured.",
      });
    }

    const signature =
      req.headers["stripe-signature"];

    let event;

    try {
      event =
        stripe.webhooks.constructEvent(
          req.body,
          signature,
          stripeWebhookSecret
        );
    } catch (err) {
      console.error(
        "STRIPE WEBHOOK SIGNATURE ERROR:",
        err?.message
      );

      return res
        .status(400)
        .send("Invalid Stripe signature.");
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const checkoutSession =
            event.data.object;

          const subscriptionId =
            checkoutSession.subscription;

          if (subscriptionId) {
            const subscription =
              await stripe.subscriptions.retrieve(
                subscriptionId
              );

            await syncSubscriptionToWorkspace({
              subscription,
            });
          }

          break;
        }

        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          await syncSubscriptionToWorkspace({
            subscription: event.data.object,
          });

          break;
        }

        case "invoice.paid": {
          const invoice = event.data.object;
          const subscriptionId =
            invoice.subscription;

          if (subscriptionId) {
            const subscription =
              await stripe.subscriptions.retrieve(
                subscriptionId
              );

            await syncSubscriptionToWorkspace({
              subscription,
            });
          }

          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object;

          const organization =
            await Organization.findOne({
              $or: [
                {
                  "billing.stripeSubscriptionId":
                    invoice.subscription,
                },
                {
                  "billing.stripeCustomerId":
                    invoice.customer,
                },
              ],
            });

          if (organization) {
            organization.paymentStatus =
              "past_due";
            organization.accessStatus =
              "suspended";
            organization.approvedForAccess =
              false;

            organization.billing = {
              ...(organization.billing
                ?.toObject
                ? organization.billing.toObject()
                : organization.billing ||
                  {}),
              status: "past_due",
            };

            await organization.save();
          }

          break;
        }

        default:
          break;
      }

      return res.json({
        received: true,
      });
    } catch (err) {
      console.error(
        "STRIPE WEBHOOK PROCESSING ERROR:",
        err
      );

      return res.status(500).json({
        received: false,
        message:
          "Stripe webhook processing failed.",
      });
    }
  }
);

export default router;
