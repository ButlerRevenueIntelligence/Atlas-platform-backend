import test from "node:test";
import assert from "node:assert/strict";
import { buildUnifiedMetrics } from "../services/workspaceMetrics.js";
import { aggregateCharges, amountToNumber } from "../services/stripeSync.js";
import { calculateDealMetrics } from "../services/dealMetrics.js";
import { buildDashboardResponse } from "../routes/dashboard.js";
import { calculateOperatorSignals } from "../services/operatorEngine.js";

const now = new Date("2026-10-11T19:00:00Z");
const date = "2026-10-10";
const total = result => result.metrics.reduce((sum, row) => sum + row.revenue, 0);

test("one sale appearing in Stripe, Shopify, and imported metrics is counted once", () => {
  const result = buildUnifiedMetrics({ now,
    stripeRows: [{ date, currency: "usd", netRevenue: 100 }],
    baseMetrics: [{ date, revenue: 100 }],
    deals: [{ externalSource: "shopify", stage: "Closed Won", closeDate: date, amount: 100 }],
  });
  assert.equal(total(result), 100);
  assert.equal(result.revenueSource, "stripe");
});

test("fully refunded Stripe revenue does not fall back to gross imported revenue", () => {
  assert.equal(total(buildUnifiedMetrics({ now, stripeRows: [{ date, currency: "usd", netRevenue: 0 }], baseMetrics: [{ date, revenue: 100 }] })), 0);
});

test("foreign currencies never enter USD revenue or spend", () => {
  const result = buildUnifiedMetrics({ now,
    stripeRows: [{ date, currency: "eur", netRevenue: 100 }, { date, currency: "usd", netRevenue: 50 }],
    sourceRows: [{ date, provider: "meta_ads", currency: "EUR", spend: 70 }],
  });
  assert.equal(total(result), 50);
  assert.equal(result.metrics.reduce((sum, row) => sum + row.spend, 0), 0);
  assert.deepEqual(result.excludedCurrencies, ["EUR"]);
});

test("GA4 leads are not added to advertising conversions or imported leads", () => {
  const result = buildUnifiedMetrics({ now, baseMetrics: [{ date, spend: 999, leads: 999 }], sourceRows: [
    { date, provider: "ga4", leads: 10, sessions: 100 },
    { date, provider: "google_ads", spend: 20, conversions: 8 },
    { date, provider: "meta_ads", spend: 30, leads: 10 },
  ] });
  const row = result.metrics.find(row => row.date === date);
  assert.equal(row.leads, 10); assert.equal(row.spend, 50); assert.equal(row.sessions, 100);
});

test("without GA4, advertising leads replace imported aggregate leads", () => {
  const result = buildUnifiedMetrics({ now, baseMetrics: [{ date, leads: 50 }], sourceRows: [{ date, provider: "meta_ads", leads: 5 }] });
  assert.equal(result.metrics.find(row => row.date === date).leads, 5);
});

test("a 30-day series includes zero days and excludes stale and future rows", () => {
  const result = buildUnifiedMetrics({ now, baseMetrics: [{ date: "2026-09-01", revenue: 100 }, { date: "2026-10-12", revenue: 100 }, { date, revenue: 60 }] });
  assert.equal(result.metrics.length, 30);
  assert.equal(result.metrics[0].date, "2026-09-12");
  assert.equal(total(result), 60);
});

test("old deals won this month appear on the close date, not import date", () => {
  const deal = { stage: "Closed Won", amount: 400, createdAt: "2026-01-01", closeDate: date, probability: 1 };
  const result = calculateDealMetrics([deal], 30, now);
  assert.equal(result.summary.wonRevenue, 400);
  assert.equal(result.days.find(row => row.date === date).wonRevenue, 400);
  assert.equal(result.summary.dealsCreated, 0);
  assert.equal(result.summary.raw, 0);
});

test("closed and archived deals do not inflate pipeline or Operator signals", () => {
  const deals = [{ stage: "Negotiation", amount: 100, probability: 0.5 }, { stage: "Closed Won", amount: 1000, probability: 1 }, { stage: "Closed Lost", amount: 900, probability: 1 }];
  const dashboard = buildDashboardResponse({ deals, membership: {}, metrics: [] });
  assert.equal(dashboard.summary.pipelineValue, 100);
  assert.equal(calculateOperatorSignals({ deals }).pipelineValue, 50);
  assert.equal(calculateDealMetrics([...deals, { stage: "Discovery", amount: 500, archivedAt: date }], 30, now).summary.raw, 100);
});

test("forecast uses all calendar days instead of exaggerating sparse activity", () => {
  const dashboard = buildDashboardResponse({ membership: {}, metrics: [{ dateISO: date, revenue: 100 }] });
  assert.equal(dashboard.summary.forecast90d, 300);
});

test("empty workspaces do not receive a fabricated health score", () => {
  assert.equal(buildDashboardResponse({ membership: {} }).summary.revenueHealth, 0);
});

test("Stripe excludes unpaid and failed charges, preserves refunds and currency buckets", () => {
  const created = Math.floor(now.getTime() / 1000);
  const result = aggregateCharges([
    { created, paid: true, status: "succeeded", currency: "usd", amount: 10000, amount_refunded: 2500 },
    { created, paid: false, status: "failed", currency: "usd", amount: 50000 },
    { created, paid: true, status: "succeeded", currency: "jpy", amount: 1000 },
  ]);
  assert.equal(result.size, 2);
  assert.equal(result.get("2026-10-11:usd").netRevenue, 75);
  assert.equal(result.get("2026-10-11:jpy").netRevenue, 1000);
  assert.equal(amountToNumber(1000, "jpy"), 1000);
});
