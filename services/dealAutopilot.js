// backend/services/dealAutopilot.js
import Deal from "../models/Deal.js";

const STAGES = ["Discovery", "Proposal", "Follow-Up", "Negotiation", "Closed Won", "Closed Lost"];

const safeNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const daysBetween = (a, b) => {
  const da = a ? new Date(a) : null;
  const db = b ? new Date(b) : null;
  if (!da || !db || Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return null;
  const diff = db.getTime() - da.getTime();
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
};

const normalizeStage = (s) => {
  const val = (s || "").toString().trim().toLowerCase();
  if (!val) return "Discovery";
  if (val.includes("disc")) return "Discovery";
  if (val.includes("prop")) return "Proposal";
  if (val.includes("follow")) return "Follow-Up";
  if (val.includes("neg")) return "Negotiation";
  if (val.includes("won")) return "Closed Won";
  if (val.includes("lost")) return "Closed Lost";
  return "Discovery";
};

// stage aging thresholds (days)
const THRESH = {
  Discovery: { warn: 7, stale: 14 },
  Proposal: { warn: 5, stale: 10 },
  "Follow-Up": { warn: 4, stale: 8 },
  Negotiation: { warn: 3, stale: 7 },
  "Closed Won": { warn: 999, stale: 999 },
  "Closed Lost": { warn: 999, stale: 999 },
};

export function classifyDeal(deal) {
  const stage = STAGES.includes(deal?.stage) ? deal.stage : normalizeStage(deal?.stage);
  const now = new Date();

  const createdAge = daysBetween(deal?.createdAt, now) ?? 0;
  const lastTouchAge = daysBetween(deal?.lastActivityAt || deal?.updatedAt || deal?.createdAt, now) ?? createdAge;

  if (stage === "Closed Won" || stage === "Closed Lost") {
    return { stage, status: "CLOSED", tone: "neutral", createdAge, lastTouchAge };
  }

  const t = THRESH[stage] || THRESH.Discovery;

  if (lastTouchAge >= t.stale) return { stage, status: "STALE", tone: "bad", createdAge, lastTouchAge };
  if (lastTouchAge >= t.warn) return { stage, status: "AT_RISK", tone: "warn", createdAge, lastTouchAge };
  return { stage, status: "HOT", tone: "good", createdAge, lastTouchAge };
}

export function suggestedNextAction(deal) {
  if (deal?.nextAction && String(deal.nextAction).trim()) return String(deal.nextAction).trim();

  const stage = STAGES.includes(deal?.stage) ? deal.stage : normalizeStage(deal?.stage);
  const now = new Date();
  const lastTouchAge = daysBetween(deal?.lastActivityAt || deal?.updatedAt || deal?.createdAt, now) ?? 0;

  if (stage === "Discovery") return lastTouchAge > 7 ? "Book discovery follow-up" : "Confirm ICP + pain points";
  if (stage === "Proposal") return lastTouchAge > 5 ? "Nudge for proposal review" : "Send proposal + timeline";
  if (stage === "Follow-Up") return "Call + objection handling";
  if (stage === "Negotiation") return "Align terms + close plan";
  if (stage === "Closed Won") return "Kickoff + onboarding";
  if (stage === "Closed Lost") return "Log loss reason + reactivation date";

  return "Follow up";
}

export function nextActionDueDate(deal) {
  const { stage, status, lastTouchAge } = classifyDeal(deal);
  if (status === "CLOSED") return null;

  const now = new Date();
  const t = THRESH[stage] || THRESH.Discovery;

  const daysToDue = status === "STALE" ? 0 : status === "AT_RISK" ? 1 : 2;
  const urgencyBoost = lastTouchAge >= t.warn ? 0 : 1;
  const totalDays = Math.max(0, daysToDue + urgencyBoost);

  const due = new Date(now);
  due.setDate(due.getDate() + totalDays);
  return due;
}

export function priorityScore(deal) {
  const { stage, status, lastTouchAge } = classifyDeal(deal);

  if (status === "CLOSED") return { score: 0, reason: "Closed" };

  const amt = safeNum(deal?.amount ?? deal?.value ?? 0);
  const p = safeNum(deal?.probability ?? 0.5);
  const weighted = amt * p;

  const stageWeight =
    stage === "Negotiation" ? 1.35 :
    stage === "Follow-Up" ? 1.25 :
    stage === "Proposal" ? 1.15 :
    1.0;

  const riskWeight = status === "STALE" ? 1.45 : status === "AT_RISK" ? 1.25 : 1.0;

  const ageBoost = Math.min(30, safeNum(lastTouchAge)) / 30; // 0..1
  const urgencyWeight = 1 + (ageBoost * 0.35);

  const score = (weighted * stageWeight * riskWeight * urgencyWeight);

  const reason =
    status === "STALE" ? `Stale in ${stage} (${lastTouchAge}d no touch)` :
    status === "AT_RISK" ? `At risk in ${stage} (${lastTouchAge}d no touch)` :
    `Hot in ${stage}`;

  return { score, reason, stage, status, weighted };
}

// ✅ GET priority list (computed, no DB writes)
export async function computePriorities({ orgId, limit = 10, includeClosed = false }) {
  const deals = await Deal.find({ orgId })
    .sort({ updatedAt: -1 })
    .limit(1000)
    .populate({ path: "clientId", select: "name industry website status" })
    .lean();

  const items = (deals || [])
    .map((d) => {
      const id = d?._id?.toString?.() || d?.id;
      const clientName = d?.clientId?.name || "";
      const cls = classifyDeal(d);
      const nextAction = suggestedNextAction(d);
      const due = d?.nextActionDueAt ? new Date(d.nextActionDueAt) : nextActionDueDate(d);
      const pr = priorityScore(d);

      return {
        id,
        deal: d,
        clientName,
        status: cls.status,
        tone: cls.tone,
        stage: cls.stage,
        lastTouchAge: cls.lastTouchAge,
        weighted: Math.round(safeNum(pr.weighted || 0)),
        score: Math.round(safeNum(pr.score || 0)),
        reason: pr.reason,
        nextAction,
        nextActionDueAt: due ? due.toISOString() : null,
      };
    })
    .filter((x) => (includeClosed ? true : x.status !== "CLOSED"))
    .sort((a, b) => b.score - a.score);

  const top = items.slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));

  const summary = {
    total: items.length,
    stale: items.filter((x) => x.status === "STALE").length,
    atRisk: items.filter((x) => x.status === "AT_RISK").length,
    hot: items.filter((x) => x.status === "HOT").length,
  };

  return { top, summary };
}

// ✅ Autopilot: supports dryRun preview + force + changes[]
export async function runAutopilot({ orgId, maxUpdates = 200, dryRun = false, force = false }) {
  const deals = await Deal.find({ orgId }).sort({ updatedAt: -1 }).limit(1000);

  let updatedCount = 0;
  const changes = [];

  for (const d of deals) {
    if (updatedCount >= maxUpdates) break;

    const cls = classifyDeal(d);
    if (cls.status === "CLOSED") continue;

    const beforeNext = String(d.nextAction || "").trim();
    const beforeDue = d.nextActionDueAt ? new Date(d.nextActionDueAt).toISOString() : null;

    const needsNext = !beforeNext;
    const needsDue = !d.nextActionDueAt;

    const shouldUpdate = force || cls.status === "STALE" || needsNext || needsDue;
    if (!shouldUpdate) continue;

    const nextAction = suggestedNextAction(d);
    const due = nextActionDueDate(d);
    const afterDue = due ? due.toISOString() : null;

    // Determine if anything will actually change
    const nextChanged = force ? (nextAction !== beforeNext) : (needsNext && nextAction !== beforeNext);
    const dueChanged = force ? (afterDue !== beforeDue) : (needsDue && afterDue !== beforeDue);

    if (!nextChanged && !dueChanged) continue;

    const reason =
      force ? "FORCE_REFRESH" :
      cls.status === "STALE" ? "STALE" :
      needsNext ? "MISSING_NEXT_ACTION" :
      "MISSING_DUE_DATE";

    changes.push({
      id: d._id?.toString?.(),
      name: d.name,
      stage: d.stage,
      reason,
      before: { nextAction: beforeNext, nextActionDueAt: beforeDue },
      after: { nextAction, nextActionDueAt: afterDue },
    });

    updatedCount += 1;

    if (dryRun) continue;

    d.nextAction = nextAction;
    d.nextActionDueAt = due || null;

    if (!d.lastActivityAt) d.lastActivityAt = d.createdAt || new Date();

    d.activities = Array.isArray(d.activities) ? d.activities : [];
    d.activities.push({
      type: "system",
      note: `Autopilot refreshed: nextAction="${nextAction}"`,
      nextAction,
      nextActionDueAt: due || null,
      createdAt: new Date(),
      createdBy: null,
    });

    await d.save();
  }

  return { updatedCount, changes };
}