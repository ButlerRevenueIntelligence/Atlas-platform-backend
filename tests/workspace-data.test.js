import test from "node:test";
import assert from "node:assert/strict";
import { getUnifiedWorkspaceData } from "../services/workspaceData.js";
import Account from "../models/Account.js";
import Client from "../models/Client.js";
import Deal from "../models/Deal.js";
import IntegrationConnection from "../models/IntegrationConnection.js";
import MetricDaily from "../models/MetricDaily.js";
import StripeRevenueDaily from "../models/StripeRevenueDaily.js";
import SourceMetricDaily from "../models/SourceMetricDaily.js";
import QuickBooksSnapshot from "../models/QuickBooksSnapshot.js";

const orgId = "507f1f77bcf86cd799439011";
function query(data) {
  return { select() { return this; }, sort() { return this; }, lean: async () => data };
}
test("all dashboard reads are scoped; legacy Account links resolve; old selected ad accounts are excluded", async t => {
  const date = new Date().toISOString().slice(0, 10);
  const fixtures = [
    [Account, [{ _id: "legacy-account", orgId, name: "Buyer", externalSource: "salesforce", externalId: "a", sourcePayload: { BillingCountry: "United States" } }]],
    [Client, []], [Deal, [{ _id: "deal", orgId, clientId: "legacy-account", stage: "Negotiation", amount: 200 }]],
    [IntegrationConnection, [{ orgId, provider: "google_ads", externalAccountId: "123", status: "connected" }]],
    [MetricDaily, [{date, revenue:0}]], [StripeRevenueDaily, [{ date, currency: "usd", netRevenue: 50 }]],
    [SourceMetricDaily, [{ date, provider: "google_ads", accountId: "old-account", currency: "USD", spend: 999 }, { date, provider: "google_ads", accountId: "123", currency: "USD", spend: 10 }]],
  ];
  for (const [model, data] of fixtures) t.mock.method(model, "find", filter => { assert.equal(String(filter.orgId), orgId); return query(data); });
  t.mock.method(IntegrationConnection, "findOne", filter => { assert.equal(String(filter.orgId), orgId); return query(null); });
  t.mock.method(QuickBooksSnapshot, "findOne", filter => { assert.equal(String(filter.orgId), orgId); return query({ metrics: { revenue: 2000 }, currency: "USD", periodStart: "2026-01-01", periodEnd: date }); });
  const data = await getUnifiedWorkspaceData(orgId);
  assert.equal(data.deals[0].clientName, "Buyer"); assert.equal(data.deals[0].region, "North America");
  assert.equal(data.metrics.reduce((sum, row) => sum + row.spend, 0), 10);
  assert.equal(data.metrics.reduce((sum, row) => sum + row.revenue, 0), 50);
  assert.deepEqual(data.revenueObservationDays.stripe, [date]);
  assert.deepEqual(data.revenueObservationDays.metrics_daily, [date]); // Original zero-value row is an observation.
  assert.equal(data.financials.revenue, 2000); // Accounting YTD is not added to payment revenue.
  assert.equal(data.channelMetrics.length, 1);
});

test("invalid workspace identifiers fail before any database read", async () => {
  await assert.rejects(getUnifiedWorkspaceData("not-a-workspace"), /Invalid workspace/);
});
