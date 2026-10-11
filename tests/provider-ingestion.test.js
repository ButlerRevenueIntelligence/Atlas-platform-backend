import test from "node:test";
import assert from "node:assert/strict";
import IntegrationConnection from "../models/IntegrationConnection.js";
import SourceMetricDaily from "../models/SourceMetricDaily.js";
import { syncAdditionalProvider, reportingDates } from "../services/providerMetrics.js";
import Account from "../models/Account.js";
import Client from "../models/Client.js";
import Deal from "../models/Deal.js";
import Organization from "../models/Organization.js";
import { runRegisteredSync } from "../services/providerSyncRegistry.js";
import "../routes/integrations.js";

function fixture(t, provider, extra = {}) {
  const connection = { provider, externalAccountId: "123", accessToken: "test-token", metadata: {}, async save() {}, ...extra };
  t.mock.method(IntegrationConnection, "findOne", filter => {
    assert.equal(filter.orgId, "workspace-a"); assert.equal(filter.provider, provider);
    return { select: async () => connection };
  });
  const writes = [];
  t.mock.method(SourceMetricDaily, "bulkWrite", async operations => writes.push(...operations));
  return { connection, writes };
}
const response = data => ({ ok: true, status: 200, json: async () => data });

test("Google Ads imports actual daily cost micros and keeps conversions separate from leads", async t => {
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "test-developer-token";
  const { writes } = fixture(t, "google_ads");
  const date = reportingDates().end;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.match(url, /customers\/123\/googleAds:searchStream/);
    assert.match(JSON.parse(options.body).query, /segments.date BETWEEN/);
    return response([{ results: [{ segments: { date }, customer: { currencyCode: "USD" }, metrics: { costMicros: "12500000", conversions: 4, clicks: 10, impressions: 20 } }] }]);
  });
  await syncAdditionalProvider("google_ads", "workspace-a");
  const row = writes.find(write => write.updateOne.filter.date === date).updateOne;
  assert.equal(row.filter.orgId, "workspace-a"); assert.equal(row.update.$set.spend, 12.5);
  assert.equal(row.update.$set.conversions, 4); assert.equal(row.update.$set.leads, 0);
  assert.equal(writes.length, 30);
});

test("GA4 reads generate_lead events, not every conversion as a lead", async t => {
  const { writes } = fixture(t, "ga4");
  const date = reportingDates().end;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    const leadReport = body.metrics[0].name === "eventCount";
    if (leadReport) assert.equal(body.dimensionFilter.filter.stringFilter.value, "generate_lead");
    return response({ rows: [{ dimensionValues: [{ value: date.replaceAll("-", "") }], metricValues: [{ value: leadReport ? "5" : "200" }] }] });
  });
  await syncAdditionalProvider("ga4", "workspace-a");
  const row = writes.find(write => write.updateOne.filter.date === date).updateOne.update.$set;
  assert.equal(row.leads, 5); assert.equal(row.sessions, 200); assert.equal(row.spend, 0);
});

test("Google refresh tokens rotate without losing the existing refresh token", async t => {
  const { connection } = fixture(t, "ga4", { refreshToken: "old-refresh" });
  t.mock.method(globalThis, "fetch", async url => url.includes("oauth2.googleapis.com")
    ? response({ access_token: "new-token", expires_in: 3600 }) : response({ rows: [] }));
  await syncAdditionalProvider("ga4", "workspace-a");
  assert.equal(connection.refreshToken, "old-refresh"); assert.equal(connection.accessToken, "new-token");
});

test("provider permission errors fail the sync and never write fake zero metrics", async t => {
  const { connection, writes } = fixture(t, "ga4");
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 403, json: async () => ({ error: { message: "Permission denied" } }) }));
  await assert.rejects(syncAdditionalProvider("ga4", "workspace-a"), /Permission denied/);
  assert.equal(connection.lastSyncStatus, "failed"); assert.equal(writes.length, 0);
});

test("LinkedIn imports performance with the account currency", async t => {
  const { writes } = fixture(t, "linkedin_ads");
  const [year, month, day] = reportingDates().end.split("-").map(Number);
  t.mock.method(globalThis, "fetch", async url => url.includes("adAnalytics")
    ? response({ elements: [{ dateRange: { start: { year, month, day } }, costInLocalCurrency: "20.50", clicks: 12, oneClickLeads: 2 }] })
    : response({ currency: "EUR" }));
  await syncAdditionalProvider("linkedin_ads", "workspace-a");
  const row = writes.find(write => write.updateOne.filter.date === reportingDates().end).updateOne.update.$set;
  assert.equal(row.currency, "EUR"); assert.equal(row.spend, 20.5); assert.equal(row.leads, 2);
});

test("Bitrix24 imports every deal page and links actual Client IDs", async t => {
  fixture(t, "bitrix24", { externalAccountId: "https://example.bitrix24.com/rest/1/test" });
  const calls = []; const deals = [];
  t.mock.method(Account, "findOneAndUpdate", async (_filter, update) => ({ _id: "account-id", ...update.$set }));
  t.mock.method(Client, "findOneAndUpdate", async filter => { assert.equal(filter.orgId, "workspace-a"); return { _id: "client-id" }; });
  t.mock.method(Deal, "findOneAndUpdate", async (filter, update) => deals.push({ filter, ...update.$set }));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const start = JSON.parse(options.body).start; calls.push({ url, start });
    if (url.includes("crm.company.list")) return response({ result: [{ ID: "1", TITLE: "Company" }] });
    return response({ result: [{ ID: start ? "2" : "1", COMPANY_ID: "1", TITLE: "Deal", OPPORTUNITY: "500", STAGE_SEMANTIC_ID: "S" }], ...(start ? {} : { next: 50 }) });
  });
  const result = await syncAdditionalProvider("bitrix24", "workspace-a");
  assert.equal(result.deals, 2); assert.equal(deals.length, 2);
  assert.equal(deals[0].clientId, "client-id"); assert.equal(deals[1].stage, "Closed Won");
  assert.ok(calls.some(call => call.start === 50));
});

test("Shopify follows next-page links and never counts unpaid fulfillment as revenue", async t => {
  fixture(t, "shopify", { externalAccountName: "fixture.myshopify.com", tokenExpiresAt: new Date(Date.now() + 3600000), metadata: { shopDomain: "fixture.myshopify.com" } });
  const writes = [];
  const account = { _id: "account-id", name: "Customer", externalSource: "shopify", externalId: "1" };
  t.mock.method(Account, "findOneAndUpdate", async () => account);
  t.mock.method(Account, "findOne", async () => account);
  t.mock.method(Client, "findOneAndUpdate", async () => ({ _id: "client-id" }));
  t.mock.method(Deal, "findOneAndUpdate", async (_filter, update) => writes.push(update.$set));
  t.mock.method(Organization, "findByIdAndUpdate", async () => ({}));
  t.mock.method(globalThis, "fetch", async url => {
    let data; let link = null;
    if (url.includes("orders.json")) {
      const second = url.includes("page_info=next");
      data = { orders: [{ id: second ? 2 : 1, customer: { id: 1 }, total_price: "100", financial_status: second ? "pending" : "paid", fulfillment_status: "fulfilled" }] };
      if (!second) link = '<https://fixture.myshopify.com/admin/api/2026-07/orders.json?page_info=next>; rel="next"';
    } else if (url.includes("customers.json")) data = { customers: [{ id: 1, first_name: "Customer" }] };
    else data = { products: [] };
    return { ...response(data), headers: { get: () => link } };
  });
  await runRegisteredSync("shopify", "workspace-a");
  assert.equal(writes.length, 2); assert.equal(writes[0].clientId, "client-id");
  assert.equal(writes[0].stage, "Closed Won"); assert.equal(writes[1].stage, "Negotiation");
});
