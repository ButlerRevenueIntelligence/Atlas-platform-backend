import crypto from "node:crypto";
import fs from "node:fs";

const defaults = {
  hubspot: [
    "HubSpot CRM",
    "Contact, company, and deal records used by the CRM importer.",
    "The code requests contact, company, deal, and deal-schema read scopes.",
  ],
  salesforce: [
    "Salesforce",
    "Accounts and opportunities used by the Salesforce importer.",
    "The code requests API and refresh-token access; API permission is broader than read-only.",
  ],
  zoho_crm: [
    "Zoho CRM",
    "CRM account, contact, and deal records used by the importer.",
    "Read scopes are requested by the connector; production grants require review.",
  ],
  pipedrive: [
    "Pipedrive",
    "CRM organization, person, and deal information used by the importer.",
    "OAuth access depends on the application configuration and provider grant; do not assume read-only.",
  ],
  bitrix24: [
    "Bitrix24",
    "CRM records available through the supplied webhook.",
    "Webhook permissions are determined in Bitrix24 and may allow more than reading. Treat the webhook URL as a credential.",
  ],
  google_ads: [
    "Google Ads",
    "Accessible advertiser accounts and daily advertising performance.",
    "The adwords scope permits broader Ads access than reporting alone, plus Google sign-in profile scopes.",
  ],
  meta_ads: [
    "Meta Ads",
    "Ad accounts and daily advertising performance.",
    "The code requests ads_read, ads_management, and business_management; these are broader than read-only.",
  ],
  linkedin_ads: [
    "LinkedIn Ads",
    "Ad accounts and reporting information.",
    "The code requests r_ads and r_ads_reporting.",
  ],
  ga4: [
    "Google Analytics 4",
    "Analytics properties and daily traffic and lead metrics.",
    "The code requests analytics.readonly plus sign-in profile scopes.",
  ],
  stripe: [
    "Stripe",
    "Payment and refund information used for revenue reporting.",
    "The OAuth flow requests read_write. Do not describe this connection as read-only.",
  ],
  quickbooks: [
    "QuickBooks Online",
    "Accounting reports and financial evidence used by the QuickBooks importer.",
    "The accounting scope is broader than read-only.",
  ],
  shopify: [
    "Shopify",
    "Store, customer, and order information used by the importer.",
    "Requested scopes are deployment-configurable; the actual configured scope list must be reviewed.",
  ],
  slack: [
    "Slack",
    "Workspace and channel connection information; outgoing Atlas alerts and briefings.",
    "The code requests chat:write and incoming-webhook and can post information to Slack.",
  ],
  excel_csv: [
    "Excel / CSV Import",
    "Selected rows mapped to client, deal, and daily metric records. The filename is also sent.",
    "Creates imported records in Atlas; no source-system OAuth access.",
  ],
  ghl: [
    "GoHighLevel",
    "Contact and opportunity information.",
    "The code requests contacts.readonly and opportunities.readonly.",
  ],
};
export const CHECKBOXES = Object.freeze({
  authority:
    "I confirm I am authorized to connect or upload this information for my organization.",
  processing:
    "I have reviewed the data access, AI processing, service-provider, and retention disclosures and authorize this processing for the purposes described.",
  agreement:
    "I am authorized to accept the Data Processing Agreement and Terms on behalf of my organization, and I accept them.",
});
export function dataAccessMode() {
  const mode = process.env.DATA_ACCESS_MODE || "off";
  // Invalid values must never silently disable enforcement.
  if (!["off", "preview", "enforce"].includes(mode))
    throw new Error("Invalid DATA_ACCESS_MODE");
  return mode;
}
export function loadPolicy() {
  return JSON.parse(
    fs.readFileSync(
      process.env.DATA_ACCESS_POLICY_FILE ||
        new URL("../config/dataAccessPolicy.json", import.meta.url),
      "utf8",
    ),
  );
}
export function policySnapshot(provider, policy = loadPolicy()) {
  if (!Object.hasOwn(defaults, provider))
    throw Object.assign(new Error("Unknown data source"), { status: 400 });
  const [name, imports, access] = defaults[provider];
  const connector = policy.connectors?.[provider] || {};
  const documents = policy.documents || {};
  const common = policy.common || {};
  const snapshot = {
    version: policy.version,
    legalEntity: policy.legalEntity || "",
    provider,
    name,
    disclosureVersion: connector.version || policy.version,
    imports: connector.imports || imports,
    access: connector.access || access,
    ...Object.fromEntries(
      [
        "purpose",
        "aiProcessing",
        "otherProviders",
        "saleAndTraining",
        "storageAndAccess",
        "retentionAndDeletion",
        "contact",
      ].map((k) => [k, common[k] || ""]),
    ),
    documents: Object.fromEntries(
      ["agreement", "terms", "privacy", "providers"].map((k) => [
        k,
        { title: documents[k]?.title || k, text: documents[k]?.text || "" },
      ]),
    ),
    checkboxes: CHECKBOXES,
  };
  const complete = (value) =>
    typeof value === "string" &&
    value.trim().length > 0 &&
    !/\[.*?\]|awaiting|must be verified|before release|TODO/i.test(value);
  const ready =
    policy.approved === true &&
    connector.approved === true &&
    complete(connector.imports) &&
    complete(connector.access) &&
    complete(connector.version) &&
    complete(policy.reviewedAt) &&
    !Number.isNaN(Date.parse(policy.reviewedAt)) &&
    [
      snapshot.version,
      snapshot.disclosureVersion,
      snapshot.legalEntity,
      snapshot.imports,
      snapshot.access,
      ...Object.keys(common).map((k) => common[k]),
    ].every(complete) &&
    [
      "purpose",
      "aiProcessing",
      "otherProviders",
      "saleAndTraining",
      "storageAndAccess",
      "retentionAndDeletion",
      "contact",
    ].every((k) => complete(snapshot[k])) &&
    Object.values(snapshot.documents).every((d) => complete(d.text));
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
  return { snapshot, digest, ready };
}
export function dataAccessError(code, message, status = 428) {
  return Object.assign(new Error(message), { code, status });
}
