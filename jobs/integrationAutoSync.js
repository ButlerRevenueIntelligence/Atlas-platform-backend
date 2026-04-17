import cron from "node-cron";
import IntegrationConnection from "../models/IntegrationConnection.js";
import { syncStripeForOrg } from "../services/stripeSync.js";

async function runZohoSyncForOrg(orgId) {
  const mod = await import("../routes/integrations.js");
  return mod;
}

export function startIntegrationAutoSync() {
  cron.schedule("*/15 * * * *", async () => {
    console.log("⏱ Running integration auto-sync...");

    try {
      const liveConnections = await IntegrationConnection.find({
        status: "connected",
        mode: "live",
      }).lean();

      const grouped = new Map();

      for (const conn of liveConnections) {
        if (!conn.orgId || !conn.provider) continue;
        const key = String(conn.orgId);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(conn.provider);
      }

      for (const [orgId, providers] of grouped.entries()) {
        try {
          if (providers.includes("stripe")) {
            try {
              await syncStripeForOrg(orgId);
              console.log(`✅ Stripe auto-synced for org ${orgId}`);
            } catch (err) {
              console.error(`❌ Stripe auto-sync failed for org ${orgId}:`, err.message);
            }
          }

          // Zoho
          if (providers.includes("zoho_crm")) {
            try {
              const { autoSyncZohoForOrg } = await import("../services/zohoAutoSync.js");
              await autoSyncZohoForOrg(orgId);
              console.log(`✅ Zoho auto-synced for org ${orgId}`);
            } catch (err) {
              console.error(`❌ Zoho auto-sync failed for org ${orgId}:`, err.message);
            }
          }

          // HubSpot
          if (providers.includes("hubspot")) {
            try {
              const { autoSyncHubSpotForOrg } = await import("../services/hubspotAutoSync.js");
              await autoSyncHubSpotForOrg(orgId);
              console.log(`✅ HubSpot auto-synced for org ${orgId}`);
            } catch (err) {
              console.error(`❌ HubSpot auto-sync failed for org ${orgId}:`, err.message);
            }
          }

          // Pipedrive
          if (providers.includes("pipedrive")) {
            try {
              const { autoSyncPipedriveForOrg } = await import("../services/pipedriveAutoSync.js");
              await autoSyncPipedriveForOrg(orgId);
              console.log(`✅ Pipedrive auto-synced for org ${orgId}`);
            } catch (err) {
              console.error(`❌ Pipedrive auto-sync failed for org ${orgId}:`, err.message);
            }
          }
        } catch (err) {
          console.error(`❌ Auto-sync failed for org ${orgId}:`, err.message);
        }
      }
    } catch (err) {
      console.error("❌ Integration auto-sync job failed:", err.message);
    }
  });
}