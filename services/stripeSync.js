import {listStripeEvidence,normalizeStripe,saveCashSnapshot} from "./cashEvidence.js";
// backend/services/stripeSync.js
import Stripe from "stripe";
import IntegrationConnection from "../models/IntegrationConnection.js";
import StripeRevenueDaily from "../models/StripeRevenueDailyV2.js";

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

function dayKeyFromUnix(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return d.toISOString().slice(0, 10);
}

export function amountToNumber(amount, currency = "usd") {
  const zeroDecimal = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
  return Number(amount || 0) / (zeroDecimal.has(String(currency).toLowerCase()) ? 1 : 100);
}

export function aggregateCharges(charges) {
  const dailyMap = new Map();
  for (const charge of charges) {
    if (!charge?.created || charge.paid !== true || charge.status !== "succeeded") continue;
    const date = dayKeyFromUnix(charge.created);
    const currency = String(charge.currency || "usd").toLowerCase();
    const key = `${date}:${currency}`;
    const row = dailyMap.get(key) || { date, currency, grossRevenue: 0, refunds: 0, netRevenue: 0, transactionCount: 0 };
    const gross = amountToNumber(charge.amount, currency);
    const refunds = amountToNumber(charge.amount_refunded, currency);
    row.grossRevenue += gross; row.refunds += refunds; row.netRevenue += gross - refunds; row.transactionCount += 1;
    dailyMap.set(key, row);
  }
  return dailyMap;
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

    const dailyMap = aggregateCharges(charges);

    const customerDayMap = new Map();
    for (const customer of customers) {
      if (!customer?.created) continue;
      const key = dayKeyFromUnix(customer.created);
      customerDayMap.set(key, (customerDayMap.get(key) || 0) + 1);
    }

    let upserts = 0;

    for (const value of dailyMap.values()) {
      const date = value.date;
      const customerCount = customerDayMap.get(date) || 0;

      await StripeRevenueDaily.findOneAndUpdate(
        { orgId, provider: "stripe", date, currency: value.currency },
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

    const importedKeys = [...dailyMap.values()].map(row => ({ date: row.date, currency: row.currency }));
    await StripeRevenueDaily.deleteMany(importedKeys.length ? { orgId, provider: "stripe", $nor: importedKeys } : { orgId, provider: "stripe" });
    // Supplemental detail failures do not replace a good detail snapshot or fail daily revenue sync.
    let cashEvidence;
    try {
      const [invoices,invoicePayments]=await Promise.all([
        listStripeEvidence(stripe.invoices,stripeAccount),
        listStripeEvidence(stripe.invoicePayments,stripeAccount,{status:"paid"})
      ]);
      const saved=await saveCashSnapshot({orgId,provider:"stripe",accountId:stripeAccount,environment:"live",data:normalizeStripe({invoices,charges,invoicePayments})});
      cashEvidence={cashEvidenceStatus:"success",cashEvidenceAt:saved.capturedAt,cashEvidenceAccountId:String(stripeAccount),cashEvidenceEnvironment:"live"};
    } catch {
      cashEvidence={cashEvidenceStatus:"failed",cashEvidenceAttemptAt:new Date(),cashEvidenceAccountId:String(stripeAccount),cashEvidenceEnvironment:"live"};
    }
    connection.status = "connected";
    connection.lastSyncAt = new Date();
    connection.lastSyncStatus = "success";
    connection.lastError = null;
    connection.metadata = {
      ...(connection.metadata || {}),
      ...cashEvidence,
      syncedCharges: charges.length,
      syncedCustomers: customers.length,
      syncedDays: upserts,
      excludedCurrencies: [...new Set([...dailyMap.values()].map(row => row.currency).filter(currency => currency !== "usd"))],
      revenueSnapshotComplete: true,
      revenueSnapshotAccountId: String(stripeAccount),
    };
    await connection.save();

    return {
      ok: true,
      stripeAccount,
      cashEvidenceStatus: cashEvidence.cashEvidenceStatus,
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