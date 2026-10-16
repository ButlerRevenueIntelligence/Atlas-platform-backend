import test from "node:test";
import assert from "node:assert/strict";
import { DEMO_DEALS, normalizeDeal, buildDealPriorityAnswer } from "../routes/ai.js";
import { buildRevenueRiskBriefing, isRevenueRiskQuestion } from "../services/operatorRiskBriefing.js";
const now = new Date("2026-10-11T20:00:00Z");
test("demo risk briefing shares ranking deal names, owners, amounts, and labels", () => {
  const result = buildRevenueRiskBriefing({ deals: DEMO_DEALS.map(normalizeDeal), isDemo: true, now });
  assert.match(result.summary, /\$1,155,000/);
  assert.match(result.summary, /\$762,650/);
  assert.match(result.summary, /74%/);
  assert.equal(result.risks.length, 3);
  assert.equal(result.risks[0].owner, "Maya Thompson");
  assert.ok(result.risks.some(risk => risk.name === "Atlas Manufacturing Modernization" && risk.owner === "Chris Morgan"));
  assert.ok(result.risks.every(risk => risk.deadline.startsWith("Recommended deadline:")));
  assert.equal(result.label,'Revenue priorities');
  assert.doesNotMatch(buildDealPriorityAnswer({ deals: DEMO_DEALS, isDemo: true }), /Owner not recorded/);
  assert.match(result.opportunities[0], /Summit Revenue Operations Program/);
  assert.match(result.caveats.join(' '), /not realized revenue/);
});
test("live briefing excludes closed deals and respects recorded actions and overdue dates", () => {
  const deals = [
    { name: "Real renewal", amount: 10000, probability: 0.6, stage: "Negotiation", ownerName: "Pat", daysToClose: -2, nextAction: "Confirm approval", nextActionDueAt: "2026-10-10" },
    { name: "Already won", amount: 900000, probability: 1, stage: "Closed Won" },
  ].map(normalizeDeal);
  const result = buildRevenueRiskBriefing({ deals, now, revenueSource: "stripe" });
  assert.match(result.summary, /\$10,000/);
  assert.match(result.summary, /\$6,000/);
  assert.doesNotMatch(result.text, /900,000|fictional/);
  assert.equal(result.risks[0].action, "Confirm approval");
  assert.match(result.risks[0].deadline, /Recorded due date: 2026-10-10 \(overdue\)/);
});
test("missing live dates and owners stay missing rather than implying near-term demand", () => {
  const result = buildRevenueRiskBriefing({ deals: [normalizeDeal({ name: "Undated", amount: 2500, stage: "Proposal" })], now });
  assert.equal(result.risks.length, 0);
  assert.match(result.summary, /No recorded close dates/);
  assert.match(result.text, /lack a recorded owner/);
  assert.match(result.text, /lack a close date/);
  assert.match(result.text, /No realized-revenue source/);
  assert.doesNotMatch(result.text, /Maya|Jordan|stronger engagement|high-performing channels/);
});
test("empty workspace identifies missing evidence instead of inventing a ranking", () => {
  const result = buildRevenueRiskBriefing({ orgName: "New company", now });
  assert.match(result.summary, /No open opportunities/);
  assert.equal(result.risks.length, 0);
  assert.equal(result.opportunities.length, 0);
});
test("risk intent handles executive questions and leaves discovery to GraphIQ", () => {
  assert.equal(isRevenueRiskQuestion("What's putting our revenue at risk, and what should leadership do this week?"), true);
  assert.equal(isRevenueRiskQuestion("What is the highest-risk forecast scenario right now?"), true);
  assert.equal(isRevenueRiskQuestion("Which deals should we focus on this week?"), false);
  assert.equal(isRevenueRiskQuestion("Search external companies with pipeline risk"), false);
});
