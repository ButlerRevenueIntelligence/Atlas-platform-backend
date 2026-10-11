import LegacyStripeRevenueDaily from "../models/StripeRevenueDaily.js";
import StripeRevenueDaily from "../models/StripeRevenueDailyV2.js";
import IntegrationConnection from "../models/IntegrationConnection.js";
export async function stripeDailyRows(orgId, cutoff = null) {
  const connection = await IntegrationConnection.findOne({ orgId, provider: "stripe" }).select("metadata lastSyncStatus externalAccountId").lean();
  if (connection?.lastSyncStatus === "never") return [];
  if (connection?.metadata?.revenueSnapshotAccountId && String(connection.metadata.revenueSnapshotAccountId) !== String(connection.externalAccountId)) return [];
  const model = connection?.metadata?.revenueSnapshotComplete ? StripeRevenueDaily : LegacyStripeRevenueDaily;
  return model.find({ orgId, ...(cutoff ? { date: { $gte: cutoff } } : {}) }).sort({ date: 1 }).lean();
}
