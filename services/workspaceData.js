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

const REGION_CODES = {
  "North America": new Set([
    "US", "USA", "CA", "CAN", "MX", "MEX", "GL", "GRL",
  ]),
  "Latin America": new Set([
    "AR", "ARG", "BO", "BOL", "BR", "BRA", "BZ", "BLZ", "CL", "CHL",
    "CO", "COL", "CR", "CRI", "CU", "CUB", "DO", "DOM", "EC", "ECU",
    "GT", "GTM", "GY", "GUY", "HN", "HND", "HT", "HTI", "JM", "JAM",
    "NI", "NIC", "PA", "PAN", "PE", "PER", "PR", "PRI", "PY", "PRY",
    "SV", "SLV", "SR", "SUR", "TT", "TTO", "UY", "URY", "VE", "VEN",
  ]),
  Europe: new Set([
    "AD", "AL", "AT", "AUT", "BA", "BE", "BEL", "BG", "BGR", "BY", "CH",
    "CHE", "CY", "CZ", "CZE", "DE", "DEU", "DK", "DNK", "EE", "EST", "ES",
    "ESP", "FI", "FIN", "FR", "FRA", "GB", "GBR", "GR", "GRC", "HR", "HRV",
    "HU", "HUN", "IE", "IRL", "IS", "ISL", "IT", "ITA", "LI", "LT", "LTU",
    "LU", "LUX", "LV", "LVA", "MC", "MD", "ME", "MK", "MT", "MNE", "NL",
    "NLD", "NO", "NOR", "PL", "POL", "PT", "PRT", "RO", "ROU", "RS", "SRB",
    "SE", "SWE", "SI", "SVK", "SM", "UA", "UK",
  ]),
  Africa: new Set([
    "AO", "BDI", "BF", "BEN", "BW", "BWA", "CD", "COD", "CF", "CG", "CI",
    "CM", "CPV", "DJ", "DZA", "EG", "EGY", "ER", "ETH", "GA", "GAB", "GH",
    "GHA", "GM", "GMB", "GN", "GNB", "GQ", "KE", "KEN", "KM", "LS", "LSO",
    "LR", "LBR", "LY", "LBY", "MA", "MAR", "MG", "MDG", "ML", "MLI", "MR",
    "MRT", "MU", "MUS", "MW", "MWI", "MZ", "MOZ", "NA", "NAM", "NE", "NER",
    "NG", "NGA", "RW", "RWA", "SC", "SD", "SEN", "SL", "SLE", "SN", "SO",
    "SOM", "SS", "SZ", "TD", "TCD", "TG", "TGO", "TN", "TUN", "TZ", "TZA",
    "UG", "UGA", "ZA", "ZAF", "ZM", "ZMB", "ZW", "ZWE",
  ]),
  "Middle East": new Set([
    "AE", "ARE", "BH", "BHR", "IL", "ISR", "IQ", "IRQ", "IR", "IRN", "JO",
    "JOR", "KW", "KWT", "LB", "LBN", "OM", "OMN", "PS", "PSE", "QA", "QAT",
    "SA", "SAU", "SY", "SYR", "TR", "TUR", "YE", "YEM",
  ]),
  Asia: new Set([
    "AF", "AFG", "AM", "ARM", "AZ", "AZE", "BD", "BGD", "BN", "BRN", "BT",
    "BTN", "CN", "CHN", "GE", "GEO", "HK", "HKG", "ID", "IDN", "IN", "IND",
    "JP", "JPN", "KG", "KGZ", "KH", "KHM", "KP", "KR", "KOR", "KZ", "KAZ",
    "LA", "LAO", "LK", "LKA", "MM", "MMR", "MN", "MNG", "MO", "MAC", "MV",
    "MYS", "MY", "NP", "NPL", "PH", "PHL", "PK", "PAK", "SG", "SGP", "TH",
    "THA", "TJ", "TJK", "TL", "TM", "TKM", "TW", "TWN", "UZ", "UZB", "VN", "VNM",
  ]),
  Oceania: new Set([
    "AU", "AUS", "FJ", "FJI", "FM", "FSM", "KI", "KIR", "MH", "MHL", "NR",
    "NRU", "NZ", "NZL", "PG", "PNG", "PW", "PLW", "SB", "SLB", "TO", "TON",
    "TV", "TUV", "VU", "VUT", "WS", "WSM",
  ]),
};

const REGION_PATTERNS = [
  ["North America", /\b(?:united states|usa|u\.s\.a?|canada|mexico|north america)\b/i],
  ["Latin America", /latin america|south america|central america|caribbean|brazil|argentina|chile|colombia|peru|costa rica|panama|puerto rico|dominican republic|jamaica/i],
  ["Europe", /europe|united kingdom|england|scotland|wales|ireland|france|germany|spain|italy|netherlands|belgium|switzerland|austria|portugal|poland|sweden|norway|denmark|finland|greece|ukraine/i],
  ["Africa", /africa|south africa|nigeria|kenya|egypt|morocco|ghana|ethiopia|tanzania|uganda|algeria|tunisia/i],
  ["Middle East", /middle east|united arab emirates|saudi arabia|israel|qatar|kuwait|bahrain|oman|jordan|lebanon|turkey|türkiye/i],
  ["Asia", /asia|china|japan|india|singapore|hong kong|south korea|korea|indonesia|malaysia|thailand|philippines|vietnam|pakistan|bangladesh|taiwan/i],
  ["Oceania", /oceania|australia|new zealand|fiji|papua new guinea/i],
];

function normalizeRegion(value) {
  const text = clean(value);
  if (!text) return "";
  const direct = Object.keys(REGION_CODES).find(
    (region) => region.toLowerCase() === text.toLowerCase()
  );
  if (direct) return direct;
  const code = text.toUpperCase().replace(/[^A-Z]/g, "");
  for (const [region, codes] of Object.entries(REGION_CODES)) {
    if (codes.has(code)) return region;
  }
  return REGION_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] || "";
}

function firstValue(objects, keys) {
  for (const object of objects) {
    if (!object || typeof object !== "object") continue;
    for (const key of keys) {
      const value = object[key];
      if (value !== undefined && value !== null && clean(value)) return clean(value);
    }
  }
  return "";
}

function extractGeo(record, source = "record") {
  if (!record || typeof record !== "object") return null;
  const payload = record.sourcePayload && typeof record.sourcePayload === "object"
    ? record.sourcePayload
    : {};
  const properties = payload.properties && typeof payload.properties === "object"
    ? payload.properties
    : {};
  const nested = [
    payload.default_address,
    payload.defaultAddress,
    payload.billing_address,
    payload.billingAddress,
    payload.shipping_address,
    payload.shippingAddress,
    payload.address,
    payload.organization,
    payload.company,
    payload.account,
    payload.customer,
  ].filter(Boolean);
  const sources = [record, payload, properties, ...nested];
  const explicitRegion = firstValue(sources, [
    "region", "Region", "territory", "Territory", "continent", "Continent",
  ]);
  const countryCode = firstValue(sources, [
    "countryCode", "country_code", "country_code_v2", "Country_Code", "BillingCountryCode",
  ]).toUpperCase();
  const country = firstValue(sources, [
    "country", "Country", "country_name", "countryName", "BillingCountry", "Billing_Country",
    "ShippingCountry", "Shipping_Country", "address_country", "org_address_country",
  ]);
  const state = firstValue(sources, [
    "state", "State", "province", "Province", "state_code", "province_code",
    "BillingState", "Billing_State", "ShippingState", "Shipping_State", "address_admin_area_level_1",
  ]);
  const city = firstValue(sources, [
    "city", "City", "locality", "BillingCity", "Billing_City", "ShippingCity",
    "Shipping_City", "address_locality", "org_address_locality",
  ]);
  const location = [city, state, country].filter(Boolean).join(", ");
  const region =
    normalizeRegion(explicitRegion) ||
    normalizeRegion(countryCode) ||
    normalizeRegion(country) ||
    normalizeRegion(location);

  if (!region) return null;
  return { region, country, countryCode, state, city, location, source };
}

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
  const geo = extractGeo(record, recordType);
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
    geo,
    region: geo?.region || "",
    country: geo?.country || "",
    location: geo?.location || "",
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

  const linkedClient =
    deal?.clientId && typeof deal.clientId === "object" ? deal.clientId : null;
  const geo =
    extractGeo(deal, "deal") ||
    extractGeo(linkedClient, "linked_account");

  return {
    ...deal,
    clientName:
      clean(deal?.clientId?.name) ||
      clean(deal?.clientName) ||
      fallbackClientName.trim() ||
      clean(deal?.accountName) ||
      "Unassigned account",
    clientId: deal?.clientId?._id || deal?.clientId || null,
    geo,
    region: geo?.region || "",
    country: geo?.country || "",
    location: geo?.location || "",
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
        .populate(
          "clientId",
          "name website domain industry status externalSource externalId sourcePayload region country city state stateProvince"
        )
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
