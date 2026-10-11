const amount = deal => Number(deal.amount || 0);
const open = deal => !["Closed Won", "Closed Lost"].includes(deal.stage);
const wonDate = deal => deal.closedAt || deal.closeDate || deal.updatedAt || deal.createdAt;
const dayKey = value => new Date(value).toISOString().slice(0, 10);
export function calculateDealMetrics(deals, days = 30, now = new Date()) {
  const end = new Date(now); end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - days + 1);
  const nextDay = new Date(end); nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const inPeriod = value => value && new Date(value) >= start && new Date(value) < nextDay;
  const active = deals.filter(deal => !deal.archivedAt);
  const created = active.filter(deal => inPeriod(deal.createdAt));
  const closed = active.filter(deal => !open(deal) && inPeriod(wonDate(deal)));
  const won = closed.filter(deal => deal.stage === "Closed Won");
  const pipeline = active.filter(open);
  const cycles = closed.map(deal => Math.max(0, (new Date(wonDate(deal)) - new Date(deal.createdAt)) / 86400000)).filter(Number.isFinite);
  const buckets = new Map();
  for (let date = new Date(start); date < nextDay; date.setUTCDate(date.getUTCDate() + 1)) {
    const key = dayKey(date); buckets.set(key, { date: key, dealsCreated: 0, weightedCreated: 0, wonRevenue: 0, wonCount: 0 });
  }
  for (const deal of created) {
    const row = buckets.get(dayKey(deal.createdAt)); row.dealsCreated += 1;
    row.weightedCreated += amount(deal) * Number(deal.probability ?? 0.5);
  }
  for (const deal of won) {
    const row = buckets.get(dayKey(wonDate(deal))); row.wonRevenue += amount(deal); row.wonCount += 1;
  }
  return { summary: {
    days, totalDeals: active.length, dealsCreated: created.length,
    raw: pipeline.reduce((sum, deal) => sum + amount(deal), 0),
    weighted: pipeline.reduce((sum, deal) => sum + amount(deal) * Number(deal.probability ?? 0.5), 0),
    wonRevenue: won.reduce((sum, deal) => sum + amount(deal), 0), wonCount: won.length,
    winRate: closed.length ? won.length / closed.length : 0,
    avgDeal: active.length ? active.reduce((sum, deal) => sum + amount(deal), 0) / active.length : 0,
    avgCycleDays: cycles.length ? cycles.reduce((sum, value) => sum + value, 0) / cycles.length : 0,
    staleCount: pipeline.filter(deal => new Date(deal.lastActivityAt || deal.createdAt) < new Date(now.getTime() - 14 * 86400000)).length,
  }, days: [...buckets.values()] };
}
