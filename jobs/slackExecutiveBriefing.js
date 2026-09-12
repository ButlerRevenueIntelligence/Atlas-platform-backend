import cron from "node-cron";
import Deal from "../models/Deal.js";
import IntegrationConnection from "../models/IntegrationConnection.js";
import MetricDaily from "../models/MetricDaily.js";
import Organization from "../models/Organization.js";

const TIME_ZONE = "America/New_York";
const CLOSED_STAGES = new Set(["Closed Won", "Closed Lost"]);

const money = (value) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);

const percent = (value) => `${Math.round((Number(value) || 0) * 100)}%`;

function datePartsInEastern(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function easternWeekKey(date = new Date()) {
  const parts = datePartsInEastern(date);
  const localDate = new Date(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))
  );
  const weekday = localDate.getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  localDate.setUTCDate(localDate.getUTCDate() - daysSinceMonday);
  return localDate.toISOString().slice(0, 10);
}

function isMondayCatchUpWindow(date = new Date()) {
  const parts = datePartsInEastern(date);
  const hour = Number(parts.hour);
  return parts.weekday === "Mon" && hour >= 8 && hour < 12;
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + (Number(row?.[field]) || 0), 0);
}

function daysAgo(date, now) {
  const value = new Date(date || 0);
  if (Number.isNaN(value.getTime())) return 0;
  return Math.max(0, Math.floor((now.getTime() - value.getTime()) / 86400000));
}

function getDealRisks(deal, now) {
  if (!deal || CLOSED_STAGES.has(deal.stage) || deal.archivedAt) return [];

  const risks = [];
  const closeDate = deal.closeDate ? new Date(deal.closeDate) : null;
  const nextActionDueAt = deal.nextActionDueAt
    ? new Date(deal.nextActionDueAt)
    : null;
  const activityDate = deal.lastActivityAt || deal.updatedAt || deal.createdAt;

  if (closeDate && !Number.isNaN(closeDate.getTime()) && closeDate < now) {
    risks.push("close date overdue");
  }

  if (
    nextActionDueAt &&
    !Number.isNaN(nextActionDueAt.getTime()) &&
    nextActionDueAt < now
  ) {
    risks.push("next action overdue");
  }

  if (activityDate && daysAgo(activityDate, now) >= 14) {
    risks.push(`${daysAgo(activityDate, now)} days without activity`);
  }

  if (Number(deal.probability) <= 0.3) {
    risks.push(`${percent(deal.probability)} win probability`);
  }

  return risks;
}

function revenueTrend(currentRevenue, previousRevenue) {
  if (previousRevenue <= 0) return currentRevenue > 0 ? null : 0;
  return (currentRevenue - previousRevenue) / previousRevenue;
}

function buildPriorities({
  riskDeals,
  overdueNextActions,
  coverage,
  trend,
  failedIntegrations,
  topOpenDeals,
}) {
  const priorities = [];

  if (riskDeals.length) {
    priorities.push(
      `Review ${riskDeals.length} open deal${riskDeals.length === 1 ? "" : "s"} carrying active risk signals.`
    );
  }

  if (overdueNextActions > 0) {
    priorities.push(
      `Assign owners and next steps for ${overdueNextActions} overdue action${overdueNextActions === 1 ? "" : "s"}.`
    );
  }

  if (coverage !== null && coverage < 3) {
    priorities.push(
      `Build pipeline coverage from ${coverage.toFixed(1)}x toward at least 3.0x.`
    );
  }

  if (trend !== null && trend <= -0.1) {
    priorities.push(
      `Address the ${Math.abs(Math.round(trend * 100))}% revenue decline versus the prior 30 days.`
    );
  }

  if (failedIntegrations > 0) {
    priorities.push(
      `Restore ${failedIntegrations} failed data connection${failedIntegrations === 1 ? "" : "s"} before making forecast decisions.`
    );
  }

  if (!priorities.length && topOpenDeals.length) {
    priorities.push(
      `Focus leadership attention on ${topOpenDeals[0].name}, the largest active opportunity.`
    );
  }

  if (!priorities.length) {
    priorities.push("Confirm this week's revenue target and assign clear owners to the highest-impact actions.");
  }

  return priorities.slice(0, 3);
}

async function postToSlack(webhookUrl, payload) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const body = await response.text();
  if (!response.ok || body !== "ok") {
    throw new Error(body || `Slack webhook failed with status ${response.status}`);
  }
}

async function buildBriefing(orgId, now = new Date()) {
  const currentStart = new Date(now.getTime() - 30 * 86400000);
  const previousStart = new Date(now.getTime() - 60 * 86400000);

  const [org, metrics, deals, failedIntegrations] = await Promise.all([
    Organization.findById(orgId).select("name slug plan").lean(),
    MetricDaily.find({
      orgId,
      date: { $gte: previousStart, $lte: now },
    })
      .select("date revenue spend leads")
      .sort({ date: 1 })
      .lean(),
    Deal.find({ orgId, archivedAt: null })
      .select(
        "name stage amount probability closeDate nextActionDueAt lastActivityAt closedAt createdAt updatedAt clientId"
      )
      .populate({ path: "clientId", select: "name" })
      .lean(),
    IntegrationConnection.countDocuments({
      orgId,
      provider: { $ne: "slack" },
      mode: "live",
      $or: [{ status: "error" }, { lastSyncStatus: "failed" }],
    }),
  ]);

  if (!org) throw new Error("Workspace not found");

  const currentMetrics = metrics.filter(
    (row) => new Date(row.date).getTime() >= currentStart.getTime()
  );
  const previousMetrics = metrics.filter((row) => {
    const value = new Date(row.date).getTime();
    return value >= previousStart.getTime() && value < currentStart.getTime();
  });

  const revenue30 = sum(currentMetrics, "revenue");
  const previousRevenue30 = sum(previousMetrics, "revenue");
  const spend30 = sum(currentMetrics, "spend");
  const leads30 = sum(currentMetrics, "leads");
  const trend = revenueTrend(revenue30, previousRevenue30);

  const openDeals = deals.filter((deal) => !CLOSED_STAGES.has(deal.stage));
  const pipelineValue = sum(openDeals, "amount");
  const weightedPipeline = openDeals.reduce(
    (total, deal) =>
      total + (Number(deal.amount) || 0) * (Number(deal.probability) || 0),
    0
  );
  const coverage = revenue30 > 0 ? pipelineValue / revenue30 : null;
  const wonDeals = deals.filter(
    (deal) =>
      deal.stage === "Closed Won" &&
      new Date(deal.closedAt || deal.updatedAt).getTime() >= currentStart.getTime()
  );
  const lostDeals = deals.filter(
    (deal) =>
      deal.stage === "Closed Lost" &&
      new Date(deal.closedAt || deal.updatedAt).getTime() >= currentStart.getTime()
  );

  const riskDeals = openDeals
    .map((deal) => ({ deal, risks: getDealRisks(deal, now) }))
    .filter((item) => item.risks.length)
    .sort(
      (a, b) =>
        b.risks.length - a.risks.length ||
        (Number(b.deal.amount) || 0) - (Number(a.deal.amount) || 0)
    );

  const overdueNextActions = riskDeals.filter((item) =>
    item.risks.includes("next action overdue")
  ).length;
  const topOpenDeals = [...openDeals]
    .sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))
    .slice(0, 3);
  const priorities = buildPriorities({
    riskDeals,
    overdueNextActions,
    coverage,
    trend,
    failedIntegrations,
    topOpenDeals,
  });

  return {
    org,
    revenue30,
    spend30,
    leads30,
    trend,
    pipelineValue,
    weightedPipeline,
    coverage,
    openDeals,
    wonDeals,
    lostDeals,
    riskDeals,
    failedIntegrations,
    priorities,
  };
}

function briefingBlocks(briefing, { preview = false } = {}) {
  const trendText =
    briefing.trend === null
      ? "No prior-period comparison"
      : `${briefing.trend >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(briefing.trend * 100))}% vs. prior 30 days`;
  const coverageText =
    briefing.coverage === null ? "—" : `${briefing.coverage.toFixed(1)}x`;
  const risks = briefing.riskDeals.slice(0, 3);
  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${preview ? "Preview: " : ""}Atlas Monday Executive Briefing`,
        emoji: true,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*${briefing.org.name}* • Leadership view • Last 30 days`,
        },
      ],
    },
    { type: "divider" },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Revenue*\n${money(briefing.revenue30)}` },
        { type: "mrkdwn", text: `*Revenue trend*\n${trendText}` },
        { type: "mrkdwn", text: `*Open pipeline*\n${money(briefing.pipelineValue)}` },
        { type: "mrkdwn", text: `*Weighted pipeline*\n${money(briefing.weightedPipeline)}` },
        { type: "mrkdwn", text: `*Pipeline coverage*\n${coverageText}` },
        { type: "mrkdwn", text: `*Open deals*\n${briefing.openDeals.length}` },
        { type: "mrkdwn", text: `*Won / lost*\n${briefing.wonDeals.length} / ${briefing.lostDeals.length}` },
        { type: "mrkdwn", text: `*Active deal risks*\n${briefing.riskDeals.length}` },
      ],
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Leadership priorities*\n${briefing.priorities.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
      },
    },
  ];

  if (risks.length) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Highest-risk deals*\n${risks
          .map(
            ({ deal, risks: reasons }) =>
              `• *${deal.name}* — ${money(deal.amount)} — ${reasons.join(", ")}`
          )
          .join("\n")}`,
      },
    });
  }

  if (briefing.failedIntegrations > 0) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `⚠️ ${briefing.failedIntegrations} live integration${briefing.failedIntegrations === 1 ? " is" : "s are"} reporting a failure.`,
        },
      ],
    });
  }

  return blocks;
}

async function sendBriefing(connection, { preview = false } = {}) {
  const webhookUrl = String(connection.webhookUrl || "").trim();
  if (!webhookUrl) return false;

  const weekKey = easternWeekKey();
  if (!preview && connection.metadata?.executiveBriefingLastWeekKey === weekKey) {
    return false;
  }

  const briefing = await buildBriefing(connection.orgId);
  await postToSlack(webhookUrl, {
    text: `Atlas Monday Executive Briefing for ${briefing.org.name}`,
    blocks: briefingBlocks(briefing, { preview }),
  });

  connection.metadata = {
    ...(connection.metadata || {}),
    ...(preview ? {} : { executiveBriefingLastWeekKey: weekKey }),
    lastExecutiveBriefingAt: new Date().toISOString(),
    lastAlertAt: new Date().toISOString(),
  };
  connection.lastSyncAt = new Date();
  connection.lastSyncStatus = "success";
  connection.lastError = null;
  connection.markModified("metadata");
  await connection.save();
  return true;
}

export async function sendMondayExecutiveBriefings({ preview = false } = {}) {
  const connections = await IntegrationConnection.find({
    provider: "slack",
    status: "connected",
    mode: "live",
  }).select("+webhookUrl");

  for (const connection of connections) {
    try {
      await sendBriefing(connection, { preview });
    } catch (error) {
      console.error("Slack executive briefing failed:", error);
      connection.lastSyncStatus = "failed";
      connection.lastError = String(
        error?.message || "Executive briefing delivery failed"
      );
      await connection.save().catch(() => null);
    }
  }
}

export function startSlackExecutiveBriefings() {
  const scheduledTask = cron.schedule(
    "0 8 * * 1",
    () => sendMondayExecutiveBriefings(),
    { timezone: TIME_ZONE }
  );

  const catchUpTimer = setTimeout(() => {
    if (isMondayCatchUpWindow()) {
      sendMondayExecutiveBriefings().catch((error) => {
        console.error("Slack Monday briefing catch-up failed:", error);
      });
    }

    if (String(process.env.SLACK_BRIEFING_PREVIEW_ON_START).toLowerCase() === "true") {
      sendMondayExecutiveBriefings({ preview: true }).catch((error) => {
        console.error("Slack briefing preview failed:", error);
      });
    }
  }, 20 * 1000);

  catchUpTimer.unref?.();

  return function stopSlackExecutiveBriefings() {
    clearTimeout(catchUpTimer);
    scheduledTask.stop();
  };
}
