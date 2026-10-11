import IntegrationConnection from "../models/IntegrationConnection.js";
import SourceMetricDaily from "../models/SourceMetricDaily.js";
import Account from "../models/Account.js";
import Deal from "../models/Deal.js";
import { clientForAccount } from "./accountLinks.js";

export function reportingDates(now = new Date()) {
  const end = new Date(now); end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 29);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
  const data = await response.json();
  if (!response.ok || data?.error) {
    const error = new Error(data?.error?.message || data?.error_description || data?.message || `${response.status}: provider request failed`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function saveDailyMetrics(orgId, provider, accountId, records) {
  const { start, end } = reportingDates();
  const rows = new Map();
  for (const record of records) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.date) || record.date < start || record.date > end) continue;
    const row = rows.get(record.date) || { date: record.date, currency: String(record.currency || "USD").toUpperCase() };
    if (row.currency !== String(record.currency || "USD").toUpperCase()) throw new Error("Mixed currencies in one advertising account");
    for (const field of ["spend", "leads", "conversions", "sessions", "clicks", "impressions"]) {
      const value = Number(record[field] || 0);
      if (!Number.isFinite(value)) throw new Error(`Invalid ${field} from ${provider}`);
      row[field] = (row[field] || 0) + value;
    }
    rows.set(record.date, row);
  }
  // Explicit zero days overwrite previous imports when the provider removes a row.
  for (let date = new Date(`${start}T00:00:00Z`); date.toISOString().slice(0, 10) <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    const key = date.toISOString().slice(0, 10);
    if (!rows.has(key)) rows.set(key, { date: key, currency: records[0]?.currency || "USD", spend: 0, leads: 0, conversions: 0, sessions: 0, clicks: 0, impressions: 0 });
  }
  await SourceMetricDaily.bulkWrite([...rows.values()].map(row => ({ updateOne: {
    filter: { orgId, provider, accountId: String(accountId), date: row.date },
    update: { $set: { ...row, orgId, provider, accountId: String(accountId) } }, upsert: true,
  } })));
  return rows.size;
}

async function googleToken(connection) {
  if (!connection.refreshToken) {
    if (connection.tokenExpiresAt && new Date(connection.tokenExpiresAt) <= new Date()) throw new Error("Google authorization expired; reconnect");
    return connection.accessToken;
  }
  const tokens = await request("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: connection.refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID || "", client_secret: process.env.GOOGLE_CLIENT_SECRET || "" }),
  });
  connection.accessToken = tokens.access_token;
  connection.tokenExpiresAt = new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000);
  if (tokens.refresh_token) connection.refreshToken = tokens.refresh_token;
  await connection.save();
  return tokens.access_token;
}

async function googleAds(connection, orgId) {
  const accountId = String(connection.externalAccountId || "").replace(/\D/g, "");
  if (!accountId || connection.metadata?.needsSelection) throw new Error("Select a Google Ads client account first");
  if (!process.env.GOOGLE_ADS_DEVELOPER_TOKEN) throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN is missing");
  const token = await googleToken(connection);
  const { start, end } = reportingDates();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN };
  const manager = String(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "").replace(/\D/g, "");
  if (manager) headers["login-customer-id"] = manager;
  const data = await request(`https://googleads.googleapis.com/${process.env.GOOGLE_ADS_API_VERSION || "v25"}/customers/${accountId}/googleAds:searchStream`, {
    method: "POST", headers, body: JSON.stringify({ query: `SELECT segments.date, customer.currency_code, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM customer WHERE segments.date BETWEEN '${start}' AND '${end}'` }),
  });
  const records = (Array.isArray(data) ? data : [data]).flatMap(page => page.results || []).map(row => ({
    date: row.segments.date, currency: row.customer.currencyCode,
    spend: Number(row.metrics.costMicros || 0) / 1000000, conversions: Number(row.metrics.conversions || 0),
    clicks: Number(row.metrics.clicks || 0), impressions: Number(row.metrics.impressions || 0),
  }));
  return { days: await saveDailyMetrics(orgId, "google_ads", accountId, records) };
}

async function ga4(connection, orgId) {
  const propertyId = String(connection.externalAccountId || "").replace(/^properties\//, "");
  if (!/^\d+$/.test(propertyId) || connection.metadata?.needsSelection) throw new Error("Select a GA4 property first");
  const token = await googleToken(connection);
  const { start, end } = reportingDates();
  const report = async body => request(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ dimensions: [{ name: "date" }], dateRanges: [{ startDate: start, endDate: end }], limit: "1000", ...body }),
  });
  const [sessions, leads] = await Promise.all([
    report({ metrics: [{ name: "sessions" }] }),
    report({ metrics: [{ name: "eventCount" }], dimensionFilter: { filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: "generate_lead" } } } }),
  ]);
  const dateKey = row => String(row.dimensionValues[0].value).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  const records = [...(sessions.rows || []).map(row => ({ date: dateKey(row), sessions: Number(row.metricValues[0].value) })),
    ...(leads.rows || []).map(row => ({ date: dateKey(row), leads: Number(row.metricValues[0].value) }))];
  return { days: await saveDailyMetrics(orgId, "ga4", propertyId, records), leadEvent: "generate_lead" };
}

async function linkedin(connection, orgId, override) {
  const accountId = override.accountId || connection.externalAccountId;
  if (!accountId) throw new Error("Select a LinkedIn Ads account first");
  if (connection.tokenExpiresAt && new Date(connection.tokenExpiresAt) <= new Date()) throw new Error("LinkedIn authorization expired; reconnect");
  const { start, end } = reportingDates();
  const restDate = date => { const [year, month, day] = date.split("-").map(Number); return `(year:${year},month:${month},day:${day})`; };
  const query = `q=analytics&pivot=ACCOUNT&timeGranularity=DAILY&dateRange=(start:${restDate(start)},end:${restDate(end)})&accounts=List(urn%3Ali%3AsponsoredAccount%3A${encodeURIComponent(accountId)})&fields=dateRange,costInLocalCurrency,impressions,clicks,externalWebsiteConversions,oneClickLeads`;
  const headers = { Authorization: `Bearer ${connection.accessToken}`, "LinkedIn-Version": "202608", "X-Restli-Protocol-Version": "2.0.0" };
  const [data, account] = await Promise.all([
    request(`https://api.linkedin.com/rest/adAnalytics?${query}`, { headers }),
    request(`https://api.linkedin.com/rest/adAccounts/${encodeURIComponent(accountId)}`, { headers }),
  ]);
  if (!account.currency) throw new Error("LinkedIn account currency is unavailable");
  const rows = (data.elements || []).map(row => ({
    date: `${row.dateRange.start.year}-${String(row.dateRange.start.month).padStart(2, "0")}-${String(row.dateRange.start.day).padStart(2, "0")}`,
    currency: account.currency, spend: Number(row.costInLocalCurrency || 0), clicks: Number(row.clicks || 0),
    impressions: Number(row.impressions || 0), leads: Number(row.oneClickLeads || 0), conversions: Number(row.externalWebsiteConversions || 0),
  }));
  return { days: await saveDailyMetrics(orgId, "linkedin_ads", accountId, rows) };
}

async function bitrix(connection, orgId) {
  const base = String(connection.webhookUrl || connection.metadata?.webhookUrl || connection.externalAccountId || "").replace(/\/+$/, "");
  if (!/^https:\/\/.+\/rest\/.+/i.test(base)) throw new Error("Invalid Bitrix24 webhook");
  const all = async method => {
    const rows = []; let start = 0;
    while (true) {
      const data = await request(`${base}/${method}.json`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ start, select: ["*"], order: { ID: "ASC" } }) });
      rows.push(...(data.result || []));
      if (data.next == null) break;
      if (Number(data.next) <= start) throw new Error("Bitrix24 pagination did not advance");
      start = Number(data.next);
    }
    return rows;
  };
  const [companies, deals] = await Promise.all([all("crm.company.list"), all("crm.deal.list")]);
  const clients = new Map();
  for (const company of companies) {
    const account = await Account.findOneAndUpdate({ orgId, externalSource: "bitrix24", externalId: String(company.ID) }, { $set: {
      orgId, workspaceId: orgId, name: company.TITLE || `Company ${company.ID}`, website: company.WEB?.[0]?.VALUE || "",
      phone: company.PHONE?.[0]?.VALUE || "", externalSource: "bitrix24", externalId: String(company.ID), sourcePayload: company,
    } }, { upsert: true, new: true });
    clients.set(String(company.ID), await clientForAccount(orgId, account));
  }
  for (const deal of deals) {
    let client = clients.get(String(deal.COMPANY_ID));
    if (!client) {
      const account = await Account.findOneAndUpdate({ orgId, externalSource: "bitrix24", externalId: `deal-account:${deal.ID}` }, { $set: {
        orgId, name: `Unassigned Bitrix24 account ${deal.ID}`, externalSource: "bitrix24", externalId: `deal-account:${deal.ID}`,
      } }, { upsert: true, new: true });
      client = await clientForAccount(orgId, account);
    }
    const stageId = String(deal.STAGE_ID || "").split(":").pop();
    const stage = deal.STAGE_SEMANTIC_ID === "S" || stageId === "WON" ? "Closed Won"
      : deal.STAGE_SEMANTIC_ID === "F" || stageId === "LOSE" ? "Closed Lost" : "Discovery";
    await Deal.findOneAndUpdate({ orgId, externalSource: "bitrix24", externalId: String(deal.ID) }, { $set: {
      orgId, workspaceId: orgId, clientId: client._id, name: deal.TITLE || `Deal ${deal.ID}`,
      amount: Number(deal.OPPORTUNITY || 0), stage, closeDate: deal.CLOSEDATE || null,
      externalSource: "bitrix24", externalId: String(deal.ID), sourcePayload: deal,
    } }, { upsert: true, new: true, runValidators: true });
  }
  return { accounts: companies.length, deals: deals.length };
}

export async function syncAdditionalProvider(provider, orgId, override = {}) {
  const connection = await IntegrationConnection.findOne({ orgId, provider, status: { $in: ["connected", "error"] } }).select("+accessToken +refreshToken +webhookUrl");
  if (!connection) throw new Error(`${provider} is not connected`);
  try {
    const worker = { google_ads: googleAds, ga4, linkedin_ads: linkedin, bitrix24: bitrix }[provider];
    if (!worker) throw new Error(`No importer for ${provider}`);
    const result = await worker(connection, orgId, override);
    connection.status = "connected"; connection.lastSyncAt = new Date(); connection.lastSyncStatus = "success"; connection.lastError = null;
    await connection.save();
    return result;
  } catch (error) {
    connection.lastSyncStatus = "failed"; connection.lastError = error.message;
    await connection.save();
    throw error;
  }
}
