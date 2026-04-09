// backend/services/stripeSync.js
import Stripe from "stripe";
import IntegrationConnection from "../models/IntegrationConnection.js";
import StripeRevenueDaily from "../models/StripeRevenueDaily.js";

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

function dayKeyFromUnix(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return d.toISOString().slice(0, 10);
}

function amountToNumber(amount) {
  return Number(amount || 0) / 100;
}

async function listAllCustomers(stripeAccount) {
  const customers = [];
  let starting_after = undefined;

  while (true) {
    const page = await stripe.customers.list(
      { limit: 100, starting_after },
      { stripeAccount }
    );

    customers.push(...(page.data || []));

    if (!page.has_more || !page.data?.length) break;
    starting_after = page.data[page.data.length - 1].id;
  }

  return customers;
}

async function listAllCharges(stripeAccount) {
  const charges = [];
  let starting_after = undefined;

  while (true) {
    const page = await stripe.charges.list(
      { limit: 100, starting_after },
      { stripeAccount }
    );

    charges.push(...(page.data || []));

    if (!page.has_more || !page.data?.length) break;
    starting_after = page.data[page.data.length - 1].id;
  }

  return charges;
}

export async function syncStripeForOrg(orgId) {
  if (!stripe) {
    throw new Error("Stripe is not configured");
  }

  const connection = await IntegrationConnection.findOne({
    orgId,
    provider: "stripe",
    status: "connected",
  }).select("+accessToken +refreshToken");

  if (!connection) {
    throw new Error("Stripe integration is not connected for this workspace");
  }

  const stripeAccount = connection.externalAccountId;
  if (!stripeAccount) {
    throw new Error("Missing connected Stripe account id");
  }

  connection.status = "syncing";
  connection.lastSyncStatus = "running";
  connection.lastError = null;
  await connection.save();

  try {
    const [customers, charges] = await Promise.all([
      listAllCustomers(stripeAccount),
      listAllCharges(stripeAccount),
    ]);

    const dailyMap = new Map();

    for (const charge of charges) {
      if (!charge?.created) continue;

      const key = dayKeyFromUnix(charge.created);
      const existing = dailyMap.get(key) || {
        grossRevenue: 0,
        netRevenue: 0,
        refunds: 0,
        transactionCount: 0,
        currency: String(charge.currency || "usd").toLowerCase(),
      };

      const gross = amountToNumber(charge.amount);
      const refunded = amountToNumber(charge.amount_refunded);
      const net = gross - refunded;

      existing.grossRevenue += gross;
      existing.netRevenue += net;
      existing.refunds += refunded;
      existing.transactionCount += 1;

      dailyMap.set(key, existing);
    }

    const customerDayMap = new Map();
    for (const customer of customers) {
      if (!customer?.created) continue;
      const key = dayKeyFromUnix(customer.created);
      customerDayMap.set(key, (customerDayMap.get(key) || 0) + 1);
    }

    let upserts = 0;

    for (const [date, value] of dailyMap.entries()) {
      const customerCount = customerDayMap.get(date) || 0;

      await StripeRevenueDaily.findOneAndUpdate(
        { orgId, provider: "stripe", date },
        {
          $set: {
            currency: value.currency,
            grossRevenue: Number(value.grossRevenue.toFixed(2)),
            netRevenue: Number(value.netRevenue.toFixed(2)),
            refunds: Number(value.refunds.toFixed(2)),
            transactionCount: value.transactionCount,
            customerCount,
            source: "stripe_sync",
          },
        },
        { upsert: true, new: true }
      );

      upserts += 1;
    }

    connection.status = "connected";
    connection.lastSyncAt = new Date();
    connection.lastSyncStatus = "success";
    connection.lastError = null;
    connection.metadata = {
      ...(connection.metadata || {}),
      syncedCharges: charges.length,
      syncedCustomers: customers.length,
      syncedDays: upserts,
    };
    await connection.save();

    return {
      ok: true,
      stripeAccount,
      chargesSynced: charges.length,
      customersSynced: customers.length,
      dailyRowsUpserted: upserts,
    };
  } catch (err) {
    connection.status = "error";
    connection.lastSyncStatus = "failed";
    connection.lastError = err.message || "Stripe sync failed";
    await connection.save();
    throw err;
  }
}