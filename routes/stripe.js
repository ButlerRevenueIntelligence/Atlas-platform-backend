// backend/routes/stripe.js
import express from "express";
import Stripe from "stripe";
import mongoose from "mongoose";

import Organization from "../models/Organization.js";
import Membership from "../models/Membership.js";
import User from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";

import { additionalSeatQuantity, subscriptionPlanItem, seatQuantity, enterpriseMonthlyCents, validateMonthlyPrice, ENTERPRISE_SEAT_CENTS, ENTERPRISE_BASE_CENTS } from '../utils/enterpriseBilling.js';
import { seatCapacity, seatsUsed, withSeatLock } from '../services/workspaceSeats.js';

const router = express.Router();
const seatPriceId = process.env.STRIPE_PRICE_ENTERPRISE_SEAT || '';
async function validateEnterprisePrices() {
  validateMonthlyPrice(await stripe.prices.retrieve(PLAN_CONFIG.ENTERPRISE.priceId), ENTERPRISE_BASE_CENTS);
  if (!seatPriceId) throw Object.assign(new Error('Additional Enterprise seats are not configured. Contact Atlas support.'), { status: 503 });
  validateMonthlyPrice(await stripe.prices.retrieve(seatPriceId), ENTERPRISE_SEAT_CENTS);
}

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

export const stripe = stripeSecretKey
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
    req.headers["x-org-id"] ||
      req.headers["x-workspace-id"] ||
      req.user?.orgId
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
  lockHeld = false,
}) {
  if (!subscription) return null;

  const subscriptionId = subscription.id || null;
  const customerId = subscription.customer || null;

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

  const apply = async (org) => {
  // Read current state after acquiring the workspace lock, never the event's old quantity.
  subscription = await stripe.subscriptions.retrieve(subscription.id);
  const priceId = subscriptionPlanItem(subscription, PLAN_CONFIG)?.price?.id || null;
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
    enterpriseAdditionalSeats: mappedPlan === 'ENTERPRISE' && ['active', 'trialing'].includes(subscription.status)
      ? additionalSeatQuantity(subscription, seatPriceId) : 0,
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
  };
  return lockHeld ? apply(org) : withSeatLock(org._id, apply);
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
        seats: {
          included: 25,
          additional: organization.plan === 'ENTERPRISE' ? Math.max(0, billing.enterpriseAdditionalSeats || 0) : 0,
          capacity: organization.plan === 'ENTERPRISE' ? seatCapacity(organization) : null,
          used: await seatsUsed(organization._id),
          baseMonthlyCents: ENTERPRISE_BASE_CENTS,
          additionalMonthlyCents: ENTERPRISE_SEAT_CENTS,
          canManage: organization.plan === 'ENTERPRISE' && billing.status === 'active' && Boolean(seatPriceId && billing.stripeSubscriptionId),
        },
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

      const used = await seatsUsed(organization._id);
      const totalSeats = requestedPlan === 'ENTERPRISE' ? seatQuantity(req.body?.seats ?? 25) : 0;
      if (requestedPlan === 'ENTERPRISE' && totalSeats < used) return res.status(409).json({ ok: false, message: 'Choose enough seats for all current members.' });
      if (requestedPlan === 'ENTERPRISE' && totalSeats > 25) await validateEnterprisePrices();
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

      if (requestedPlan === 'ENTERPRISE' && totalSeats > 25) {
        checkoutPayload.line_items.push({ price: seatPriceId, quantity: totalSeats - 25 });
      }

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

      return res.status(err.status || 500).json({
        ok: false,
        message: err.status ? err.message : "Unable to start secure checkout.",
      });
    }
  }
);

// Purchased capacity changes only after Stripe successfully applies the subscription update.
router.post('/enterprise-seats', express.json(), requireAuth, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ ok: false, message: 'Stripe is not configured.' });
    const context = await getAuthorizedWorkspace(req, { requireManager: true });
    if (context.error) return res.status(context.error.status).json({ ok: false, message: context.error.message });
    const total = seatQuantity(req.body?.seats);
    if (req.body?.confirmed !== true) return res.status(400).json({ ok: false, message: 'Confirm the recurring price and prorated billing before changing seats.' });
    await validateEnterprisePrices();
    await withSeatLock(context.organization._id, async org => {
      if (org.plan !== 'ENTERPRISE' || org.billing?.status !== 'active' || !org.billing?.stripeSubscriptionId) {
        throw Object.assign(new Error('An active paid Enterprise subscription is required.'), { status: 409 });
      }
      if (total < await seatsUsed(org._id)) throw Object.assign(new Error('Disable or remove members before reducing purchased seats below current usage.'), { status: 409 });
      const subscription = await stripe.subscriptions.retrieve(org.billing.stripeSubscriptionId);
      const base = subscriptionPlanItem(subscription, PLAN_CONFIG);
      if (base?.price?.id !== PLAN_CONFIG.ENTERPRISE.priceId || base.quantity !== 1 || subscription.status !== 'active' || subscription.pending_update) {
        throw Object.assign(new Error('This subscription requires billing support before seats can be changed.'), { status: 409 });
      }
      const currentExtra = additionalSeatQuantity(subscription, seatPriceId);
      const extra = total - 25;
      if (currentExtra !== extra) {
        const item = subscription.items.data.find(i => i.price?.id === seatPriceId);
        const items = extra === 0 ? [{ id: item.id, deleted: true }] : [item ? { id: item.id, quantity: extra } : { price: seatPriceId, quantity: extra }];
        await stripe.subscriptions.update(subscription.id, {
          items,
          proration_behavior: extra > currentExtra ? 'always_invoice' : 'create_prorations',
          payment_behavior: 'error_if_incomplete',
        });
      }
      await syncSubscriptionToWorkspace({ subscription, organization: org, lockHeld: true });
    });
    return res.json({ ok: true, seats: total, monthlyCents: enterpriseMonthlyCents(total) });
  } catch (err) {
    console.error('ENTERPRISE SEATS ERROR:', err.message);
    return res.status(err.status || (err.type === 'StripeCardError' ? 402 : 500)).json({ ok: false, message: err.type === 'StripeCardError' ? 'Payment could not be completed. Update your payment method in Manage Billing and retry; additional seats have not been granted.' : err.status ? err.message : 'Unable to change seats. Refresh billing before retrying.' });
  }
});

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

      let enterprisePortalConfiguration;
      if (context.organization.plan === 'ENTERPRISE') {
        enterprisePortalConfiguration = process.env.STRIPE_ENTERPRISE_PORTAL_CONFIGURATION;
        if (!enterprisePortalConfiguration) return res.status(503).json({ ok: false, message: 'Enterprise billing management is being configured. Contact Atlas support.' });
        const configuration = await stripe.billingPortal.configurations.retrieve(enterprisePortalConfiguration);
        if (!configuration.active || configuration.features?.subscription_update?.enabled) {
          return res.status(503).json({ ok: false, message: 'Enterprise billing management requires configuration. Contact Atlas support.' });
        }
      }
      const session =
        await stripe.billingPortal.sessions.create(
          {
            ...(enterprisePortalConfiguration ? { configuration: enterprisePortalConfiguration } : {}),
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
