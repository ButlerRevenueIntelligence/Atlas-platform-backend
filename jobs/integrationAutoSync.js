import { requireDataAccess } from "../services/dataAccess.js";
import cron from "node-cron";
import IntegrationConnection from "../models/IntegrationConnection.js";
import { runRegisteredSync } from "../services/providerSyncRegistry.js";
import "../routes/integrations.js";
import "../routes/quickbooks.js";
import {
  notifyIntegrationFailure,
  notifyIntegrationRecovery,
  scanRecordedIntegrationFailures,
  scanRecordedIntegrationRecoveries,
} from "../services/slackIntegrationAlerts.js";

const AUTO_SYNC_PROVIDERS = new Set([
  "stripe", "zoho_crm", "hubspot", "pipedrive", "salesforce", "shopify", "quickbooks",
  "bitrix24", "google_ads", "ga4", "meta_ads", "linkedin_ads",
]);

export async function runProviderSync(provider, orgId) {
  return runRegisteredSync(provider, orgId);
}

export async function prepareSyncAttempt(connection) {
  // A hydrated document may be stale; save() omits fields it considers unchanged.
  // Force the complete retry state, but never revive an explicit disconnection.
  const attemptedAt = new Date();
  const result = await IntegrationConnection.updateOne(
    {_id: connection._id, orgId: connection.orgId, provider: connection.provider, status: {$in: ["connected", "error"]}},
    {$set: {status: "connected", lastSyncStatus: "running", lastSyncAttemptAt: attemptedAt, lastError: null}}
  );
  if (result.matchedCount === 0) return false;
  connection.status = "connected";
  connection.lastSyncStatus = "running";
  connection.lastSyncAttemptAt = attemptedAt;
  connection.lastError = null;
  return true;
}

export async function markSyncSuccess(connection) {
  connection.status = "connected";
  connection.lastSyncStatus = "success";
  connection.lastSyncAt = new Date();
  connection.lastError = null;
  // The provider handler saves a different document instance. Fields that are
  // unchanged on this job's snapshot may still be stale in MongoDB, so always
  // write the complete successful outcome instead of relying on dirty tracking.
  const result = await IntegrationConnection.updateOne(
    { _id: connection._id, orgId: connection.orgId, provider: connection.provider, status: {$in: ["connected", "error"]} },
    { $set: {
      status: "connected",
      lastSyncStatus: "success",
      lastSyncAt: connection.lastSyncAt,
      lastError: null,
    } }
  );
  return result.matchedCount !== 0;
}

export async function markSyncFailed(connection, error) {
  const preservesAuthorization = ["google_ads", "linkedin_ads", "salesforce"].includes(connection.provider);
  const authorizationFailed = error?.status === 401 || error?.reconnectRequired === true;
  // A reporting, permission, quota or network failure does not revoke OAuth.
  connection.status = preservesAuthorization && !authorizationFailed ? "connected" : "error";
  connection.lastSyncStatus = "failed";
  connection.lastError = String(error?.message || "Unknown sync error");
  const result = await IntegrationConnection.updateOne(
    {_id: connection._id, orgId: connection.orgId, provider: connection.provider, status: {$in: ["connected", "error"]}},
    {$set: {status: connection.status, lastSyncStatus: "failed", lastError: connection.lastError}}
  );
  return result.matchedCount !== 0;
}

export async function syncScheduledConnection(connection, {sync = runProviderSync, recovery = notifyIntegrationRecovery, failure = notifyIntegrationFailure} = {}) {
  const orgId = String(connection.orgId || "");
  const provider = String(connection.provider || "");
  if (!orgId || !provider) return {skipped: true};
  const started = Date.now();
  try {
    await requireDataAccess(orgId, provider);
    if (!await prepareSyncAttempt(connection)) return {skipped: true};
    await sync(provider, orgId);
    if (!await markSyncSuccess(connection)) return {skipped: true};
  } catch (error) {
    if (["SYNC_IN_PROGRESS", "SYNC_CANCELLED", "DATA_ACCESS_REQUIRED", "DATA_ACCESS_NOT_PUBLISHED"].includes(error?.code)) {
      console.log({event: "integration_sync_skipped", orgId, provider, reason: error.code, at: new Date().toISOString()});
      return {skipped: true};
    }
    console.error({event: "integration_sync_failed", orgId, provider, at: new Date().toISOString(), durationMs: Date.now() - started, status: error?.status, message: error?.message});
    try {if (!await markSyncFailed(connection, error)) return {skipped: true};}
    catch (persistenceError) {console.error("Failed to record integration error:", persistenceError?.message);}
    try {await failure({orgId, provider, error, source: "automatic sync"});}
    catch (notificationError) {console.error("Integration failure notification failed:", notificationError?.message);}
    return {ok: false};
  }
  // Slack delivery is not a provider sync. Its failure must never change CRM state.
  try {await recovery({orgId, provider});}
  catch (notificationError) {console.error("Integration recovery notification failed:", notificationError?.message);}
  console.log({event: "integration_sync_succeeded", orgId, provider, at: new Date().toISOString(), durationMs: Date.now() - started});
  return {ok: true};
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
        await syncScheduledConnection(connection);
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
