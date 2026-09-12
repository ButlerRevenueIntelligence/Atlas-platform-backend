import Deal from "../models/Deal.js";
import IntegrationConnection from "../models/IntegrationConnection.js";
import Organization from "../models/Organization.js";

const DEFAULT_SCAN_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_STALLED_DAYS = 14;
const MAX_DEALS_PER_DIGEST = 8;

const CLOSED_STAGES = new Set(["Closed Won", "Closed Lost"]);

function numberFromEnv(name, fallback, minimum = 1) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function escapeSlack(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

function formatDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function daysBetween(earlier, later) {
  return Math.max(
    0,
    Math.floor((later.getTime() - earlier.getTime()) / (24 * 60 * 60 * 1000))
  );
}

function getRiskReasons(deal, now = new Date()) {
  if (!deal || CLOSED_STAGES.has(deal.stage) || deal.archivedAt) return [];

  const reasons = [];
  const closeDate = deal.closeDate ? new Date(deal.closeDate) : null;
  const nextActionDueAt = deal.nextActionDueAt
    ? new Date(deal.nextActionDueAt)
    : null;
  const activityDate = new Date(
    deal.lastActivityAt || deal.updatedAt || deal.createdAt || now
  );
  const stalledDays = numberFromEnv(
    "SLACK_DEAL_STALLED_DAYS",
    DEFAULT_STALLED_DAYS
  );

  if (closeDate && !Number.isNaN(closeDate.getTime()) && closeDate < now) {
    reasons.push({
      code: "overdue_close",
      label: `Close date overdue since ${formatDate(closeDate)}`,
    });
  }

  if (
    nextActionDueAt &&
    !Number.isNaN(nextActionDueAt.getTime()) &&
    nextActionDueAt < now
  ) {
    reasons.push({
      code: "overdue_next_action",
      label: `Next action overdue since ${formatDate(nextActionDueAt)}`,
    });
  }

  if (
    !Number.isNaN(activityDate.getTime()) &&
    daysBetween(activityDate, now) >= stalledDays
  ) {
    reasons.push({
      code: "stalled",
      label: `No activity for ${daysBetween(activityDate, now)} days`,
    });
  }

  if (Number(deal.probability) <= 0.3) {
    reasons.push({
      code: "low_probability",
      label: `Win probability is ${Math.round(Number(deal.probability) * 100)}%`,
    });
  }

  return reasons;
}

function riskSignature(reasons) {
  return reasons
    .map((reason) => reason.code)
    .sort()
    .join("|");
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

function buildDealLine(deal, reasons) {
  const clientName = deal?.clientId?.name || "Unknown account";
  const probability = Math.round(Number(deal.probability || 0) * 100);
  const reasonText = reasons.map((reason) => `• ${reason.label}`).join("\n");
  const baseUrl = String(
    process.env.FRONTEND_URL || "https://app.atlasrevenueai.com"
  )
    .trim()
    .replace(/\/+$/, "");
  const dealUrl = `${baseUrl}/deals/${deal._id}`;

  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: [
        `*<${dealUrl}|${escapeSlack(deal.name || "Unnamed deal")}>* — ${escapeSlack(clientName)}`,
        `${formatMoney(deal.amount)} • ${escapeSlack(deal.stage)} • ${probability}% probability`,
        reasonText,
      ].join("\n"),
    },
  };
}

async function saveDeliverySuccess(connection, metadataPatch = {}) {
  connection.lastSyncAt = new Date();
  connection.lastSyncStatus = "success";
  connection.lastError = null;
  connection.metadata = {
    ...(connection.metadata || {}),
    lastAlertAt: new Date().toISOString(),
    ...metadataPatch,
  };
  connection.markModified("metadata");
  await connection.save();
}

async function saveDeliveryFailure(connection, error) {
  connection.lastSyncStatus = "failed";
  connection.lastError = String(error?.message || "Slack alert delivery failed");
  await connection.save().catch(() => null);
}

async function scanConnection(connection, now = new Date()) {
  const webhookUrl = String(connection.webhookUrl || "").trim();
  if (!webhookUrl) return { sent: 0, skipped: true };

  const deals = await Deal.find({
    orgId: connection.orgId,
    archivedAt: null,
    stage: { $nin: ["Closed Won", "Closed Lost"] },
  })
    .select(
      "name amount probability stage closeDate nextAction nextActionDueAt lastActivityAt archivedAt createdAt updatedAt clientId"
    )
    .populate({ path: "clientId", select: "name" })
    .lean();

  const previousState = connection.metadata?.dealRiskAlertState || {};
  const nextState = {};
  const newlyAtRisk = [];

  for (const deal of deals) {
    const reasons = getRiskReasons(deal, now);
    if (!reasons.length) continue;

    const dealId = String(deal._id);
    const signature = riskSignature(reasons);
    nextState[dealId] = {
      signature,
      lastSeenAt: now.toISOString(),
      lastAlertedAt: previousState[dealId]?.lastAlertedAt || null,
    };

    if (previousState[dealId]?.signature !== signature) {
      newlyAtRisk.push({ deal, reasons, dealId, signature });
    }
  }

  const selected = newlyAtRisk.slice(0, MAX_DEALS_PER_DIGEST);

  if (selected.length) {
    const org = await Organization.findById(connection.orgId).select("name").lean();
    const remaining = Math.max(0, newlyAtRisk.length - selected.length);
    const blocks = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "⚠️ Atlas Deal Risk Alert",
          emoji: true,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `${escapeSlack(org?.name || "Atlas workspace")} • ${selected.length}${remaining ? ` of ${newlyAtRisk.length}` : ""} new or changed risk signal${newlyAtRisk.length === 1 ? "" : "s"}`,
          },
        ],
      },
      { type: "divider" },
    ];

    for (const item of selected) {
      blocks.push(buildDealLine(item.deal, item.reasons));
      blocks.push({ type: "divider" });
    }

    if (remaining) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `${remaining} additional risk signal${remaining === 1 ? "" : "s"} remain in Atlas.`,
          },
        ],
      });
    }

    await postToSlack(webhookUrl, {
      text: `Atlas found ${newlyAtRisk.length} new or changed deal risk signal${newlyAtRisk.length === 1 ? "" : "s"}.`,
      blocks,
    });

    for (const item of selected) {
      nextState[item.dealId].lastAlertedAt = now.toISOString();
    }

    for (const item of newlyAtRisk.slice(MAX_DEALS_PER_DIGEST)) {
      if (previousState[item.dealId]) {
        nextState[item.dealId] = previousState[item.dealId];
      } else {
        delete nextState[item.dealId];
      }
    }

    await saveDeliverySuccess(connection, { dealRiskAlertState: nextState });
  } else {
    connection.metadata = {
      ...(connection.metadata || {}),
      dealRiskAlertState: nextState,
    };
    connection.markModified("metadata");
    await connection.save();
  }

  return { sent: selected.length, detected: newlyAtRisk.length };
}

export async function runSlackDealRiskAlertScan() {
  const connections = await IntegrationConnection.find({
    provider: "slack",
    status: "connected",
    mode: "live",
  }).select("+webhookUrl");

  const results = [];

  for (const connection of connections) {
    try {
      results.push({
        orgId: String(connection.orgId),
        ...(await scanConnection(connection)),
      });
    } catch (error) {
      console.error("Slack deal-risk scan failed:", error);
      await saveDeliveryFailure(connection, error);
      results.push({
        orgId: String(connection.orgId),
        sent: 0,
        error: String(error?.message || error),
      });
    }
  }

  return results;
}

export async function notifyMajorProbabilityDrop({ orgId, beforeDeal, afterDeal }) {
  const before = Number(beforeDeal?.probability);
  const after = Number(afterDeal?.probability);

  if (
    !orgId ||
    !Number.isFinite(before) ||
    !Number.isFinite(after) ||
    before - after < 0.2 ||
    CLOSED_STAGES.has(afterDeal?.stage)
  ) {
    return false;
  }

  const connection = await IntegrationConnection.findOne({
    orgId,
    provider: "slack",
    status: "connected",
    mode: "live",
  }).select("+webhookUrl");

  const webhookUrl = String(connection?.webhookUrl || "").trim();
  if (!connection || !webhookUrl) return false;

  try {
    const reasons = [
      {
        code: "probability_drop",
        label: `Win probability dropped from ${Math.round(before * 100)}% to ${Math.round(after * 100)}%`,
      },
    ];

    await postToSlack(webhookUrl, {
      text: `Deal risk increased for ${afterDeal?.name || "a deal"}.`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "⚠️ Deal Risk Increased",
            emoji: true,
          },
        },
        buildDealLine(afterDeal, reasons),
      ],
    });

    await saveDeliverySuccess(connection);
    return true;
  } catch (error) {
    console.error("Slack probability-drop alert failed:", error);
    await saveDeliveryFailure(connection, error);
    return false;
  }
}

export function startSlackDealRiskAlerts() {
  const intervalMs = numberFromEnv(
    "SLACK_DEAL_ALERT_INTERVAL_MS",
    DEFAULT_SCAN_INTERVAL_MS,
    60 * 1000
  );

  let stopped = false;
  let running = false;

  const runSafely = async () => {
    if (stopped || running) return;
    running = true;

    try {
      await runSlackDealRiskAlertScan();
    } catch (error) {
      console.error("Slack deal-risk alert job failed:", error);
    } finally {
      running = false;
    }
  };

  const initialTimer = setTimeout(runSafely, 20 * 1000);
  const interval = setInterval(runSafely, intervalMs);

  initialTimer.unref?.();
  interval.unref?.();

  return function stopSlackDealRiskAlerts() {
    stopped = true;
    clearTimeout(initialTimer);
    clearInterval(interval);
  };
}
