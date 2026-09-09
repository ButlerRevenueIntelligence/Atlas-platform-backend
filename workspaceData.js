import mongoose from "mongoose";
import Account from "../models/Account.js";
import Client from "../models/Client.js";
import Deal from "../models/Deal.js";
import IntegrationConnection from "../models/IntegrationConnection.js";
import MetricDaily from "../models/MetricDaily.js";
import StripeRevenueDaily from "../models/StripeRevenueDaily.js";

const safeNum = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const dayKey = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toISOString().slice(0, 10)
    : null;
};

const clean = (value) => String(value || "").trim();

function accountKey(record) {
  const source = clean(record.externalSource).toLowerCase();
  const externalId = clean(record.externalId).toLowerCase();
  const domain = clean(record.domain).toLowerCase().replace(/^www\./, "");
  const name = clean(record.name).toLowerCase();

  if (source && externalId) return `external:${source}:${externalId}`;
  if (domain) return `domain:${domain}`;
  return `name:${name}`;
}

function normalizeAccount(record, recordType) {
  return {
    _id: record._id,
    id: record._id,
    orgId: record.orgId,
    workspaceId: record.workspaceId || record.orgId,
    name: clean(record.name) || "Unnamed account",
    website: clean(record.website),
    domain: clean(record.domain),
    industry: clean(record.industry),
    phone: clean(record.primaryContactPhone || record.phone),
    primaryContactName: clean(record.primaryContactName),
    primaryContactEmail: clean(record.primaryContactEmail),
    status: clean(record.status),
    externalSource: clean(record.externalSource),
    externalId: clean(record.externalId),
    recordType,
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
  };
}

function mergeAccounts(clients, accounts) {
  const merged = new Map();

  for (const item of [
    ...clients.map((record) => normalizeAccount(record, "client")),
    ...accounts.map((record) => normalizeAccount(record, "account")),
  ]) {
    const key = accountKey(item);
    const current = merged.get(key);

    if (!current) {
      merged.set(key, item);
      continue;
    }

    merged.set(key, {
      ...item,
      ...current,
      website: current.website || item.website,
      domain: current.domain || item.domain,
      industry: current.industry || item.industry,
      phone: current.phone || item.phone,
      primaryContactName:
        current.primaryContactName || item.primaryContactName,
      primaryContactEmail:
        current.primaryContactEmail || item.primaryContactEmail,
      recordType: current.recordType === item.recordType
        ? current.recordType
        : "unified",
    });
  }

  return [...merged.values()].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

function normalizeDeal(deal) {
  const sourceCustomer = deal?.sourcePayload?.customer || {};
  const fallbackClientName =
    clean(sourceCustomer.first_name || sourceCustomer.firstName) +
    (sourceCustomer.last_name || sourceCustomer.lastName
      ? ` ${clean(sourceCustomer.last_name || sourceCustomer.lastName)}`
      : "");

  return {
    ...deal,
    clientName:
      clean(deal?.clientId?.name) ||
      clean(deal?.clientName) ||
      fallbackClientName.trim() ||
      clean(deal?.accountName) ||
      "Unassigned account",
    clientId: deal?.clientId?._id || deal?.clientId || null,
  };
}

function buildUnifiedMetrics({ baseMetrics, stripeRows, deals, days }) {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - Math.max(1, days) + 1);
  cutoff.setUTCHours(0, 0, 0, 0);

  const rows = new Map();
  const ensureRow = (date) => {
    if (!rows.has(date)) {
      rows.set(date, {
        date,
        dateISO: `${date}T00:00:00.000Z`,
        revenue: 0,
        baseRevenue: 0,
        stripeRevenue: 0,
        shopifyRevenue: 0,
        spend: 0,
        leads: 0,
      });
    }
    return rows.get(date);
  };

  for (const metric of baseMetrics) {
    const date = dayKey(metric.date);
    if (!date || new Date(`${date}T00:00:00.000Z`) < cutoff) continue;
    const row = ensureRow(date);
    row.baseRevenue += safeNum(metric.revenue);
    row.spend += safeNum(metric.spend);
    row.leads += safeNum(metric.leads);
  }

  for (const metric of stripeRows) {
    const date = dayKey(metric.date);
    if (!date || new Date(`${date}T00:00:00.000Z`) < cutoff) continue;
    const row = ensureRow(date);
    row.stripeRevenue = (row.stripeRevenue || 0) + safeNum(metric.netRevenue);
    row.transactions = (row.transactions || 0) + safeNum(metric.transactionCount);
    row.customers = (row.customers || 0) + safeNum(metric.customerCount);
  }

  for (const deal of deals) {
    if (
      clean(deal.externalSource).toLowerCase() !== "shopify" ||
      clean(deal.stage).toLowerCase() !== "closed won"
    ) {
      continue;
    }

    const date = dayKey(deal.closeDate || deal.closedAt || deal.createdAt);
    if (!date || new Date(`${date}T00:00:00.000Z`) < cutoff) continue;
    const row = ensureRow(date);
    row.shopifyRevenue = (row.shopifyRevenue || 0) + safeNum(deal.amount);
    row.shopifyOrders = (row.shopifyOrders || 0) + 1;
  }

  const values = [...rows.values()];
  const totals = values.reduce(
    (sum, row) => ({
      base: sum.base + safeNum(row.baseRevenue),
      stripe: sum.stripe + safeNum(row.stripeRevenue),
      shopify: sum.shopify + safeNum(row.shopifyRevenue),
    }),
    { base: 0, stripe: 0, shopify: 0 }
  );

  // Prefer a single transactional source to prevent counting the same sale
  // once in Shopify and again in Stripe. Existing imported daily revenue stays
  // authoritative when present.
  const revenueSource =
    totals.base > 0
      ? "metrics_daily"
      : totals.stripe > 0
      ? "stripe"
      : totals.shopify > 0
      ? "shopify"
      : "none";

  return {
    revenueSource,
    metrics: values
      .map((row) => ({
        ...row,
        revenue:
          revenueSource === "metrics_daily"
            ? safeNum(row.baseRevenue)
            : revenueSource === "stripe"
            ? safeNum(row.stripeRevenue)
            : revenueSource === "shopify"
            ? safeNum(row.shopifyRevenue)
            : 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export async function getUnifiedWorkspaceData(orgId, { days = 30 } = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(orgId || ""))) {
    throw new Error("Invalid workspace id");
  }

  const objectId = new mongoose.Types.ObjectId(String(orgId));
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - Math.max(1, days) + 1);
  cutoff.setUTCHours(0, 0, 0, 0);

  const [connections, rawDeals, clients, accounts, baseMetrics, stripeRows] =
    await Promise.all([
      IntegrationConnection.find({ orgId: objectId })
        .select("-accessToken -refreshToken")
        .sort({ provider: 1 })
        .lean(),
      Deal.find({ orgId: objectId, archivedAt: null })
        .populate("clientId", "name website domain industry status")
        .sort({ updatedAt: -1 })
        .limit(1000)
        .lean(),
      Client.find({ orgId: objectId, archivedAt: null }).lean(),
      Account.find({ orgId: objectId, archivedAt: null }).lean(),
      MetricDaily.find({ orgId: objectId, date: { $gte: cutoff } })
        .sort({ date: 1 })
        .lean(),
      StripeRevenueDaily.find({
        orgId: objectId,
        date: { $gte: dayKey(cutoff) },
      })
        .sort({ date: 1 })
        .lean(),
    ]);

  const deals = rawDeals.map(normalizeDeal);
  const unifiedMetrics = buildUnifiedMetrics({
    baseMetrics,
    stripeRows,
    deals,
    days,
  });

  return {
    orgId: String(objectId),
    integrations: connections.map((connection) => ({
      id: connection.provider,
      provider: connection.provider,
      name: connection.externalAccountName || connection.provider,
      status: connection.status,
      connected: connection.status === "connected",
      mode: connection.mode,
      lastSync: connection.lastSyncAt,
      lastSyncAt: connection.lastSyncAt,
      lastSyncStatus: connection.lastSyncStatus,
      externalAccountId: connection.externalAccountId,
      externalAccountName: connection.externalAccountName,
      metadata: connection.metadata || {},
    })),
    deals,
    accounts: mergeAccounts(clients, accounts),
    metrics: unifiedMetrics.metrics,
    dataSources: {
      revenue: unifiedMetrics.revenueSource,
      integrations: "integration_connections",
      deals: "deals",
      accounts: "clients_and_accounts",
    },
  };
}

export default getUnifiedWorkspaceData;
