import Client from "../models/Client.js";

// Deals reference Clients. Provider Account IDs must never be written as clientId.
export async function clientForAccount(orgId, account) {
  if (!account) return null;
  const filter = account.externalSource && account.externalId
    ? { orgId, externalSource: account.externalSource, externalId: account.externalId }
    : { orgId, _id: account._id };
  return Client.findOneAndUpdate(filter, {
    $set: {
      orgId, workspaceId: orgId, name: account.name,
      website: account.website || "", domain: account.domain || "",
      industry: account.industry || "", primaryContactPhone: account.phone || "",
      status: account.archivedAt ? "archived" : "active",
      archivedAt: account.archivedAt || null,
      externalSource: account.externalSource || "", externalId: account.externalId || "",
      sourcePayload: account.sourcePayload || null,
    },
  }, { upsert: true, new: true });
}
