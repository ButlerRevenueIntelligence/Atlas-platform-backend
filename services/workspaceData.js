import mongoose from "mongoose";
import { buildUnifiedMetrics } from "./workspaceMetrics.js";
import SourceMetricDaily from "../models/SourceMetricDaily.js";
import QuickBooksSnapshot from "../models/QuickBooksSnapshot.js";
import Account from "../models/Account.js";
import Client from "../models/Client.js";
import Deal from "../models/Deal.js";
import IntegrationConnection from "../models/IntegrationConnection.js";
import MetricDaily from "../models/MetricDaily.js";
import { stripeDailyRows } from "./stripeDailyReader.js";

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
    createdAt: deal.sourcePayload?.CreatedDate || deal.sourcePayload?.Created_Time || deal.sourcePayload?.DATE_CREATE || deal.sourcePayload?.created_at || deal.sourcePayload?.add_time || deal.sourcePayload?.properties?.createdate || deal.createdAt,
    updatedAt: deal.sourcePayload?.LastModifiedDate || deal.sourcePayload?.Modified_Time || deal.sourcePayload?.DATE_MODIFY || deal.sourcePayload?.updated_at || deal.sourcePayload?.update_time || deal.updatedAt,
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

export async function getUnifiedWorkspaceData(orgId, { days = 30 } = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(orgId || ""))) {
    throw new Error("Invalid workspace id");
  }

  const objectId = new mongoose.Types.ObjectId(String(orgId));
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - Math.max(1, days) + 1);
  cutoff.setUTCHours(0, 0, 0, 0);

  const [connections, rawDeals, clients, accounts, baseMetrics, stripeRows, sourceRows, financialSnapshot] =
    await Promise.all([
      IntegrationConnection.find({ orgId: objectId })
        .select("-accessToken -refreshToken")
        .sort({ provider: 1 })
        .lean(),
      Deal.find({ orgId: objectId, archivedAt: null }).sort({ updatedAt: -1 }).lean(),
      Client.find({ orgId: objectId, archivedAt: null }).lean(),
      Account.find({ orgId: objectId, archivedAt: null }).lean(),
      MetricDaily.find({ orgId: objectId, date: { $gte: cutoff } })
        .sort({ date: 1 })
        .lean(),
      stripeDailyRows(objectId, dayKey(cutoff)),
      SourceMetricDaily.find({ orgId: objectId, date: { $gte: dayKey(cutoff), $lte: dayKey(new Date()) } }).lean(),
      QuickBooksSnapshot.findOne({ orgId: objectId }).sort({ syncedAt: -1 }).lean(),
    ]);

  const linkedRecords = new Map([...accounts, ...clients].map(record => [String(record._id), record]));
  const excludedDealCurrencies = new Set();
  const deals = rawDeals.filter(deal => {
    const currency = String(deal.sourcePayload?.CurrencyIsoCode || deal.sourcePayload?.Currency || deal.sourcePayload?.CURRENCY_ID || deal.sourcePayload?.currency || "USD").toUpperCase();
    if (currency !== "USD") { excludedDealCurrencies.add(currency); return false; }
    return true;
  }).map(deal => normalizeDeal({ ...deal, clientId: linkedRecords.get(String(deal.clientId)) || deal.clientId }));
  const unifiedMetrics = buildUnifiedMetrics({
    baseMetrics,
    stripeRows,
    sourceRows: sourceRows.filter(row => {
      const connection = connections.find(item => item.provider === row.provider);
      return connection && !connection.metadata?.needsSelection && String(connection.externalAccountId || "").replace(/^properties\//, "").replace(/^act_/, "") === String(row.accountId).replace(/^act_/, "");
    }),
    deals,
    days,
  });

  const selectedSourceRows = sourceRows.filter(row => {
    const connection = connections.find(item => item.provider === row.provider);
    const normalizeId = id => String(id || "").replace(/^properties\//, "").replace(/^act_/, "");
    return connection && !connection.metadata?.needsSelection && normalizeId(connection.externalAccountId) === normalizeId(row.accountId);
  });
  const channelMetrics = Object.values(selectedSourceRows.reduce((channels, row) => {
    const channel = channels[row.provider] ||= { provider: row.provider, name: row.provider, spend: 0, leads: 0, conversions: 0, sessions: 0, clicks: 0, impressions: 0 };
    if (String(row.currency).toUpperCase() === "USD") channel.spend += safeNum(row.spend);
    for (const field of ["leads", "conversions", "sessions", "clicks", "impressions"]) channel[field] += safeNum(row[field]);
    return channels;
  }, {}));
  return {
    channelMetrics,
    // Original observation days distinguish genuine zero records from generated gap-fill rows.
    revenueObservationDays: {
      stripe: [...new Set(stripeRows.filter(row => String(row.currency || "USD").toUpperCase() === "USD").map(row => dayKey(row.date)).filter(Boolean))],
      shopify: [...new Set(deals.filter(deal => String(deal.externalSource).toLowerCase() === "shopify" && String(deal.stage).toLowerCase() === "closed won").map(deal => dayKey(deal.closedAt || deal.closeDate || deal.sourcePayload?.processed_at || deal.createdAt)).filter(Boolean))],
      metrics_daily: [...new Set(baseMetrics.map(row => dayKey(row.date)).filter(Boolean))],
    },
    dataAsOf: [...connections.filter(connection => connection.lastSyncAt).map(connection => new Date(connection.lastSyncAt).getTime()), ...baseMetrics.map(row => new Date(row.date).getTime())].filter(Number.isFinite).sort((a, b) => b - a).map(value => new Date(value).toISOString())[0] || null,
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
    financials: financialSnapshot ? {
      ...financialSnapshot.metrics, currency: financialSnapshot.currency,
      periodStart: financialSnapshot.periodStart, periodEnd: financialSnapshot.periodEnd, syncedAt: financialSnapshot.syncedAt,
    } : null,
    warnings: [...new Set([...unifiedMetrics.excludedCurrencies, ...excludedDealCurrencies])].map(currency => `${currency} records excluded from USD totals; currency conversion is not configured.`),
    dataSources: {
      revenue: unifiedMetrics.revenueSource,
      currency: unifiedMetrics.currency,
      leads: sourceRows.some(row => row.provider === "ga4") ? "ga4_generate_lead" : sourceRows.length ? "advertising_leads" : "metrics_daily",
      integrations: "integration_connections",
      deals: "deals",
      accounts: "clients_and_accounts",
    },
  };
}

export default getUnifiedWorkspaceData;
