const money = (value) => Number(value || 0).toLocaleString("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0,
});

export function isRevenueRiskQuestion(question) {
  const q = String(question || "").toLowerCase();
  return /\b(risk|risks|risky|threat|threats|jeopardy|slip|slipping|protect)\b/.test(q)
    && /\b(revenue|forecast|pipeline|leadership|business)\b/.test(q)
    && !/\b(graphiq|external|search|find companies)\b/.test(q);
}

// Input is normalized server-side workspace data, never client-provided live deals.
export function buildRevenueRiskBriefing({ deals = [], orgName, isDemo = false, revenueSource, now = new Date() }) {
  const open = deals.filter((deal) => !["Closed Won", "Closed Lost"].includes(deal.stage));
  const total = open.reduce((sum, deal) => sum + Math.max(0, deal.amount || 0), 0);
  const weighted = (deal) => Math.max(0, deal.amount || 0) * Math.max(0, Math.min(100, deal.probability || 0)) / 100;
  const nearTerm = open.filter((deal) => Number.isFinite(deal.daysToClose) && deal.daysToClose <= 30);
  const exposure = nearTerm.reduce((sum, deal) => sum + Math.max(0, deal.amount || 0), 0);
  const weightedExposure = nearTerm.reduce((sum, deal) => sum + weighted(deal), 0);
  const stale = open.filter((deal) => Number.isFinite(deal.daysSinceActivity) && deal.daysSinceActivity >= 7);
  const risks = [...open].filter((deal) => nearTerm.includes(deal) || stale.includes(deal))
    .sort((a, b) => (nearTerm.includes(b) - nearTerm.includes(a)) || weighted(b) - weighted(a))
    .slice(0, 3).map((deal) => {
      const due = deal.nextActionDueAt ? new Date(deal.nextActionDueAt) : null;
      const deadline = due && !Number.isNaN(due.getTime())
        ? `Recorded due date: ${due.toISOString().slice(0, 10)}${due < now ? " (overdue)" : ""}`
        : "Recommended deadline: within 48 hours";
      const timing = Number.isFinite(deal.daysToClose)
        ? deal.daysToClose < 0 ? `Close date is ${Math.abs(deal.daysToClose)} days overdue` : `Expected close in ${deal.daysToClose} days`
        : "Close date not recorded";
      return { name: deal.name, account: deal.accountName, amount: deal.amount,
        weightedValue: weighted(deal), owner: deal.owner, stage: deal.stage,
        evidence: `${timing}; ${Number.isFinite(deal.daysSinceActivity) ? `${deal.daysSinceActivity} days since recorded activity` : "activity date not recorded"}.`,
        risk: deal.risk, action: deal.nextStep, deadline };
    });
  const missingOwners = open.filter((deal) => !deal.owner || deal.owner === "Owner not recorded").length;
  const missingDates = open.filter((deal) => !Number.isFinite(deal.daysToClose)).length;
  const summary = nearTerm.length
    ? `Protect ${money(exposure)} across ${nearTerm.length} opportunities expected to close within 30 days or already overdue. That is ${total ? Math.round(exposure / total * 100) : 0}% of open pipeline, with ${money(weightedExposure)} in probability-weighted value. Resolve buyer and execution blockers before increasing the forecast.`
    : open.length ? `No recorded close dates place opportunities inside the next 30 days. Review ${money(total)} of open pipeline and confirm timing before treating it as near-term revenue.`
    : `No open opportunities are recorded for ${orgName || "this workspace"}. A revenue-risk assessment needs deal amounts, owners, activity, and close dates.`;
  const opportunities = open.filter((deal) => !nearTerm.includes(deal) && !stale.includes(deal))
    .sort((a, b) => weighted(b) - weighted(a)).slice(0, 1)
    .map((deal) => `${deal.owner}: validate the buying process for ${deal.name} (${money(deal.amount)}, ${money(weighted(deal))} weighted). ${deal.nextStep} Recommended deadline: this week. Its ${deal.stage.toLowerCase()} stage means it should not yet be treated as committed revenue.`);
  const caveats = [
    "Probability-weighted pipeline is potential deal value, not realized revenue or a committed forecast.",
    "Channel ROI and account expansion trends are not established by these deal records; validate attribution and account history before reallocating budget or claiming upsell momentum.",
    ...(missingOwners ? [`${missingOwners} open opportunities lack a recorded owner; assign accountability this week.`] : []),
    ...(missingDates ? [`${missingDates} open opportunities lack a close date; the near-term exposure may be incomplete.`] : []),
    ...(!isDemo && (!revenueSource || revenueSource === "none") ? ["No realized-revenue source is available; this briefing assesses pipeline execution only."] : []),
  ];
  const label = isDemo ? "Revenue priorities" : "Workspace analysis · recorded opportunity data";
  const text = `${label}\n\nExecutive decision:\n${summary}\n\nThis week's priorities:\n${risks.length ? risks.map((r, i) => `${i + 1}. ${r.name} — ${money(r.amount)} (${money(r.weightedValue)} weighted)\nOwner: ${r.owner}\nEvidence: ${r.evidence}\nRisk: ${r.risk}\nAction: ${r.action}\n${r.deadline}`).join("\n\n") : "Confirm owners, next buyer actions, and close dates before issuing a deal-specific risk ranking."}${opportunities.length ? `\n\nBuild the next wave:\n${opportunities.join("\n")}` : ""}\n\nEvidence limits:\n${caveats.join("\n")}`;
  return { type: "revenue-risk", label, summary, risks, opportunities, caveats, text };
}
