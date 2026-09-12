import crypto from "crypto";
import IntegrationConnection from "../models/IntegrationConnection.js";
import Organization from "../models/Organization.js";

const FAILURE_REMINDER_MS = 24 * 60 * 60 * 1000;

const PROVIDER_NAMES = {
  hubspot: "HubSpot",
  salesforce: "Salesforce",
  google_ads: "Google Ads",
  meta_ads: "Meta Ads",
  linkedin_ads: "LinkedIn Ads",
  ga4: "Google Analytics 4",
  stripe: "Stripe",
  shopify: "Shopify",
  quickbooks: "QuickBooks Online",
  zoho_crm: "Zoho CRM",
  pipedrive: "Pipedrive",
  bitrix24: "Bitrix24",
};

function providerName(provider) {
  return PROVIDER_NAMES[provider] || String(provider || "Integration");
}

function cleanError(error) {
  const message = String(error?.message || error || "Unknown sync error")
    .replace(/https?:\/\/\S+/gi, "[URL removed]")
    .replace(/(token|secret|authorization|password)\s*[:=]\s*\S+/gi, "$1=[hidden]")
    .trim();

  return message.slice(0, 500) || "Unknown sync error";
}

function fingerprint(message) {
  return crypto.createHash("sha256").update(message).digest("hex").slice(0, 20);
}

function getAlertState(connection) {
  const value = connection?.metadata?.integrationFailureAlerts;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function shouldSendFailure(previous, nextFingerprint, now) {
  if (!previous) return true;
  if (previous.fingerprint !== nextFingerprint) return true;

  const lastAlertedAt = new Date(previous.lastAlertedAt || 0);
  return (
    Number.isNaN(lastAlertedAt.getTime()) ||
    now.getTime() - lastAlertedAt.getTime() >= FAILURE_REMINDER_MS
  );
}

async function getSlackConnection(orgId) {
  return IntegrationConnection.findOne({
    orgId,
    provider: "slack",
    status: "connected",
    mode: "live",
  }).select("+webhookUrl");
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

async function persistSlackState(connection, state) {
  connection.metadata = {
    ...(connection.metadata || {}),
    integrationFailureAlerts: state,
    lastAlertAt: new Date().toISOString(),
  };
  connection.lastSyncAt = new Date();
  connection.lastSyncStatus = "success";
  connection.lastError = null;
  connection.markModified("metadata");
  await connection.save();
}

export async function notifyIntegrationFailure({
  orgId,
  provider,
  error,
  source = "integration sync",
}) {
  if (!orgId || !provider || provider === "slack") return false;

  const connection = await getSlackConnection(orgId);
  const webhookUrl = String(connection?.webhookUrl || "").trim();
  if (!connection || !webhookUrl) return false;

  const now = new Date();
  const message = cleanError(error);
  const nextFingerprint = fingerprint(message);
  const state = { ...getAlertState(connection) };
  const previous = state[provider];

  if (!shouldSendFailure(previous, nextFingerprint, now)) return false;

  const org = await Organization.findById(orgId).select("name").lean();

  await postToSlack(webhookUrl, {
    text: `${providerName(provider)} failed to sync in Atlas Revenue AI.`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🚨 Atlas Integration Alert",
          emoji: true,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Integration*\n${providerName(provider)}`,
          },
          {
            type: "mrkdwn",
            text: `*Workspace*\n${org?.name || "Atlas workspace"}`,
          },
          {
            type: "mrkdwn",
            text: `*Status*\nSync failed`,
          },
          {
            type: "mrkdwn",
            text: `*Source*\n${source}`,
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*What happened*\n${message}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Check the connection in Atlas. If authorization expired, reconnect the integration.",
          },
        ],
      },
    ],
  });

  state[provider] = {
    fingerprint: nextFingerprint,
    firstAlertedAt: previous?.firstAlertedAt || now.toISOString(),
    lastAlertedAt: now.toISOString(),
    lastError: message,
  };

  await persistSlackState(connection, state);
  return true;
}

export async function notifyIntegrationRecovery({ orgId, provider }) {
  if (!orgId || !provider || provider === "slack") return false;

  const connection = await getSlackConnection(orgId);
  const webhookUrl = String(connection?.webhookUrl || "").trim();
  if (!connection || !webhookUrl) return false;

  const state = { ...getAlertState(connection) };
  if (!state[provider]) return false;

  const org = await Organization.findById(orgId).select("name").lean();

  await postToSlack(webhookUrl, {
    text: `${providerName(provider)} is syncing normally again in Atlas Revenue AI.`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "✅ Integration Recovered",
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${providerName(provider)}* is syncing normally again for *${org?.name || "Atlas workspace"}*.`,
        },
      },
    ],
  });

  delete state[provider];
  await persistSlackState(connection, state);
  return true;
}

export async function scanRecordedIntegrationFailures() {
  const failedConnections = await IntegrationConnection.find({
    provider: { $ne: "slack" },
    mode: "live",
    $or: [{ status: "error" }, { lastSyncStatus: "failed" }],
  }).lean();

  for (const failed of failedConnections) {
    try {
      await notifyIntegrationFailure({
        orgId: failed.orgId,
        provider: failed.provider,
        error: failed.lastError || "The integration reported a failed sync.",
        source: "recorded integration status",
      });
    } catch (error) {
      console.error("Slack integration-status alert failed:", error);
    }
  }
}

export async function scanRecordedIntegrationRecoveries() {
  const slackConnections = await IntegrationConnection.find({
    provider: "slack",
    status: "connected",
    mode: "live",
  }).lean();

  for (const slack of slackConnections) {
    const state = slack?.metadata?.integrationFailureAlerts;
    if (!state || typeof state !== "object" || Array.isArray(state)) continue;

    for (const provider of Object.keys(state)) {
      const providerConnection = await IntegrationConnection.findOne({
        orgId: slack.orgId,
        provider,
        status: "connected",
        lastSyncStatus: "success",
        mode: "live",
      })
        .select("_id")
        .lean();

      if (!providerConnection) continue;

      try {
        await notifyIntegrationRecovery({
          orgId: slack.orgId,
          provider,
        });
      } catch (error) {
        console.error("Slack integration-recovery alert failed:", error);
      }
    }
  }
}
