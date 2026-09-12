import cron from "node-cron";
import IntegrationConnection from "../models/IntegrationConnection.js";
import { syncStripeForOrg } from "../services/stripeSync.js";
import {
  notifyIntegrationFailure,
  notifyIntegrationRecovery,
  scanRecordedIntegrationFailures,
  scanRecordedIntegrationRecoveries,
} from "../services/slackIntegrationAlerts.js";

const AUTO_SYNC_PROVIDERS = new Set([
  "stripe",
  "zoho_crm",
  "hubspot",
  "pipedrive",
]);

async function runProviderSync(provider, orgId) {
  if (provider === "stripe") {
    return syncStripeForOrg(orgId);
  }

  if (provider === "zoho_crm") {
    const { autoSyncZohoForOrg } = await import("../services/zohoAutoSync.js");
    return autoSyncZohoForOrg(orgId);
  }

  if (provider === "hubspot") {
    const { autoSyncHubSpotForOrg } = await import(
      "../services/hubspotAutoSync.js"
    );
    return autoSyncHubSpotForOrg(orgId);
  }

  if (provider === "pipedrive") {
    const { autoSyncPipedriveForOrg } = await import(
      "../services/pipedriveAutoSync.js"
    );
    return autoSyncPipedriveForOrg(orgId);
  }

  return null;
}

async function prepareSyncAttempt(connection) {
  // Existing provider sync services look up status:"connected" themselves.
  // Keep that status during the attempt while recording the running state.
  connection.status = "connected";
  connection.lastSyncStatus = "running";
  connection.lastError = null;
  await connection.save();
}

async function markSyncSuccess(connection) {
  connection.status = "connected";
  connection.lastSyncStatus = "success";
  connection.lastSyncAt = new Date();
  connection.lastError = null;
  await connection.save();
}

async function markSyncFailed(connection, error) {
  connection.status = "error";
  connection.lastSyncStatus = "failed";
  connection.lastError = String(error?.message || "Unknown sync error");
  await connection.save();
}

export function startIntegrationAutoSync() {
  let running = false;

  cron.schedule("*/15 * * * *", async () => {
    if (running) {
      console.warn("Integration auto-sync skipped because the previous run is active");
      return;
    }

    running = true;
    console.log("⏱ Running integration auto-sync...");

    try {
      const connections = await IntegrationConnection.find({
        provider: { $in: Array.from(AUTO_SYNC_PROVIDERS) },
        status: { $in: ["connected", "error"] },
        mode: "live",
      }).select("+accessToken +refreshToken");

      for (const connection of connections) {
        const orgId = String(connection.orgId || "");
        const provider = String(connection.provider || "");

        if (!orgId || !provider) continue;

        try {
          await prepareSyncAttempt(connection);
          await runProviderSync(provider, orgId);
          await markSyncSuccess(connection);
          await notifyIntegrationRecovery({ orgId, provider });

          console.log(`✅ ${provider} auto-synced for org ${orgId}`);
        } catch (error) {
          console.error(
            `❌ ${provider} auto-sync failed for org ${orgId}:`,
            error?.message || error
          );

          await markSyncFailed(connection, error).catch((saveError) => {
            console.error("Failed to record integration error:", saveError);
          });

          await notifyIntegrationFailure({
            orgId,
            provider,
            error,
            source: "automatic sync",
          });
        }
      }

      // Also catches errors recorded by manual sync routes and providers that
      // do not currently have a scheduled sync handler in this job.
      await scanRecordedIntegrationFailures();
      await scanRecordedIntegrationRecoveries();
    } catch (error) {
      console.error(
        "❌ Integration auto-sync job failed:",
        error?.message || error
      );
    } finally {
      running = false;
    }
  });
}
