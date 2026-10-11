const safeNum = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const clean = value => String(value || "").trim();
const dayKey = value => { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null; };
export function buildUnifiedMetrics({ baseMetrics = [], stripeRows = [], deals = [], sourceRows = [], days = 30, now = new Date() }) {
  const cutoff = new Date(now);
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

  const endKey = dayKey(now);
  for (let day = new Date(cutoff); dayKey(day) <= endKey; day.setUTCDate(day.getUTCDate() + 1)) ensureRow(dayKey(day));
  const moneyCurrency = value => clean(value || "USD").toUpperCase();
  const excludedCurrencies = new Set();
  for (const metric of stripeRows) if (moneyCurrency(metric.currency) !== "USD") excludedCurrencies.add(moneyCurrency(metric.currency));
  const activeProviders = new Set(sourceRows.map(row => row.provider));
  const hasAdSpend = sourceRows.some(row => row.provider !== "ga4");
  for (const metric of baseMetrics) {
    const date = dayKey(metric.date);
    if (!date || date > endKey || new Date(`${date}T00:00:00.000Z`) < cutoff) continue;
    const row = ensureRow(date);
    row.baseRevenue += safeNum(metric.revenue);
    if (!hasAdSpend) row.spend += safeNum(metric.spend);
    if (!sourceRows.length) row.leads += safeNum(metric.leads);
  }

  for (const metric of stripeRows) {
    if (moneyCurrency(metric.currency) !== "USD") continue;
    const date = dayKey(metric.date);
    if (!date || date > endKey || new Date(`${date}T00:00:00.000Z`) < cutoff) continue;
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

    const currency = moneyCurrency(deal.sourcePayload?.currency || deal.sourcePayload?.presentment_currency);
    if (currency !== "USD") { excludedCurrencies.add(currency); continue; }
    const date = dayKey(deal.closedAt || deal.closeDate || deal.sourcePayload?.processed_at || deal.createdAt);
    if (!date || date > endKey || new Date(`${date}T00:00:00.000Z`) < cutoff) continue;
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

  // Transactional revenue is a separate measure from CRM bookings and GA4 attribution.
  const revenueSource = stripeRows.some(row => moneyCurrency(row.currency) === "USD")
    ? "stripe" : totals.shopify !== 0 ? "shopify" : totals.base !== 0 ? "metrics_daily" : "none";
  for (const metric of sourceRows) {
    const date = dayKey(metric.date);
    if (!date || date > endKey || date < dayKey(cutoff)) continue;
    const row = ensureRow(date);
    const currency = moneyCurrency(metric.currency);
    if (currency === "USD") row.spend += safeNum(metric.spend);
    else if (safeNum(metric.spend)) excludedCurrencies.add(currency);
    row.sessions = (row.sessions || 0) + safeNum(metric.sessions);
    row.clicks = (row.clicks || 0) + safeNum(metric.clicks);
    row.impressions = (row.impressions || 0) + safeNum(metric.impressions);
    row.conversions = (row.conversions || 0) + safeNum(metric.conversions);
    if (activeProviders.has("ga4") ? metric.provider === "ga4" : true) row.leads += safeNum(metric.leads);
  }

  return {
    revenueSource,
    excludedCurrencies: [...excludedCurrencies],
    currency: "USD",
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

