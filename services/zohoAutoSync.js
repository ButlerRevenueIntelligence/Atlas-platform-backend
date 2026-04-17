import IntegrationConnection from "../models/IntegrationConnection.js";
import Organization from "../models/Organization.js";
import Account from "../models/Account.js";
import Deal from "../models/Deal.js";

function normalizeAtlasStage(stageName) {
  const s = String(stageName || "").toLowerCase();
  if (s.includes("proposal")) return "Proposal";
  if (s.includes("negotiation")) return "Negotiation";
  if (s.includes("closed won")) return "Closed Won";
  if (s.includes("closed lost")) return "Closed Lost";
  if (s.includes("follow")) return "Follow-Up";
  return "Discovery";
}

async function zohoGetAll(moduleName, accessToken) {
  let page = 1;
  let more = true;
  const allRecords = [];

  while (more) {
    const response = await fetch(
      `https://www.zohoapis.com/crm/v8/${moduleName}?page=${page}&per_page=200`,
      {
        method: "GET",
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
        },
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data?.message || `Failed to fetch Zoho ${moduleName}`);
    }

    const rows = Array.isArray(data?.data) ? data.data : [];
    allRecords.push(...rows);

    const info = data?.info || {};
    more = !!info.more_records;
    page += 1;
  }

  return allRecords;
}

export async function autoSyncZohoForOrg(orgId) {
  const connection = await IntegrationConnection.findOne({
    orgId,
    provider: "zoho_crm",
    status: "connected",
  }).select("+accessToken +refreshToken");

  if (!connection?.accessToken) {
    throw new Error("Zoho CRM not connected");
  }

  const accessToken = connection.accessToken;

  const [zohoAccounts, zohoDeals] = await Promise.all([
    zohoGetAll("Accounts", accessToken),
    zohoGetAll("Deals", accessToken),
  ]);

  for (const acc of zohoAccounts) {
    const zohoAccountId = acc?.id ? String(acc.id) : null;
    const name = acc?.Account_Name || acc?.name || "Unnamed Account";
    if (!zohoAccountId || !name) continue;

    await Account.findOneAndUpdate(
      { orgId, externalSource: "zoho_crm", externalId: zohoAccountId },
      {
        $set: {
          orgId,
          name,
          website: acc?.Website || "",
          industry: acc?.Industry || "",
          phone: acc?.Phone || "",
          status: "Active",
          externalSource: "zoho_crm",
          externalId: zohoAccountId,
          sourcePayload: acc,
        },
      },
      { upsert: true, new: true }
    );
  }

  for (const deal of zohoDeals) {
    const zohoDealId = deal?.id ? String(deal.id) : null;
    const dealName = deal?.Deal_Name || deal?.name || "Unnamed Deal";
    if (!zohoDealId || !dealName) continue;

    const accountRef = deal?.Account_Name?.id ? String(deal.Account_Name.id) : null;

    let matchedAccount = null;
    if (accountRef) {
      matchedAccount = await Account.findOne({
        orgId,
        externalSource: "zoho_crm",
        externalId: accountRef,
      });
    }

    await Deal.findOneAndUpdate(
      { orgId, externalSource: "zoho_crm", externalId: zohoDealId },
      {
        $set: {
          orgId,
          name: dealName,
          clientId: matchedAccount?._id || null,
          amount: Number(deal?.Amount || 0),
          stage: normalizeAtlasStage(deal?.Stage),
          closeDate: deal?.Closing_Date || null,
          externalSource: "zoho_crm",
          externalId: zohoDealId,
          sourcePayload: deal,
        },
      },
      { upsert: true, new: true }
    );
  }

  connection.lastSyncAt = new Date();
  connection.lastSyncStatus = "success";
  connection.lastError = null;
  await connection.save();

  await Organization.findByIdAndUpdate(orgId, {
    $set: {
      "integrations.zoho_crm.connected": true,
      "integrations.zoho_crm.lastSync": new Date(),
      "integrations.zoho_crm.mode": "live",
    },
  });

  return {
    ok: true,
    accountsFetched: zohoAccounts.length,
    dealsFetched: zohoDeals.length,
  };
}