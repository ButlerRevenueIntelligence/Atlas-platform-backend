import { googleAdsFailure } from './googleAdsErrors.js';
const id = value => String(value || '').replace(/^customers\//, '').replace(/-/g, '').trim();
const validId = value => /^\d+$/.test(value);
const supportedVersion = () => /^v\d+$/.test(process.env.GOOGLE_ADS_API_VERSION || '') ? process.env.GOOGLE_ADS_API_VERSION : 'v25';
async function queryAccount(accessToken, customerId, query) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };
  if (process.env.GOOGLE_ADS_DEVELOPER_TOKEN) headers['developer-token'] = process.env.GOOGLE_ADS_DEVELOPER_TOKEN.trim();
  // These roots came from listAccessibleCustomers; the user has direct access.
  const response = await fetch(`https://googleads.googleapis.com/${supportedVersion()}/customers/${customerId}/googleAds:searchStream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query
    }),
    signal: AbortSignal.timeout(60000)
  });
  const data = await response.json().catch(() => null);
  const envelope = Array.isArray(data) ? data.find(page => page?.error) : data;
  if (!response.ok || envelope?.error || data === null) {
    const error = new Error('Google Ads account discovery failed');
    error.status = response.ok ? 502 : response.status;
    error.providerDetails = envelope?.error?.details || [];
    error.providerStatus = envelope?.error?.status || null;
    error.requestId = response.headers?.get?.('request-id') || null;
    throw googleAdsFailure(error);
  }
  return (Array.isArray(data) ? data : [data]).flatMap(page => page.results || []);
}
export async function discoverGoogleAdsAdvertisers(accessToken, accessibleCustomers) {
  const roots = [...new Set(accessibleCustomers.map(id).filter(validId))];
  const warnings = [];
  const all = new Map();
  let successfulRoots = 0,
    firstError;
  // Bounded concurrency avoids a burst of quota-consuming hierarchy requests.
  for (let offset = 0; offset < roots.length; offset += 3) {
    const results = await Promise.allSettled(roots.slice(offset, offset + 3).map(async root => {
      const rows = await queryAccount(accessToken, root, 'SELECT customer.id, customer.descriptive_name, customer.manager, customer.status FROM customer');
      const customer = rows[0]?.customer;
      if (!customer || id(customer.id) !== root || customer.manager !== undefined && typeof customer.manager !== 'boolean') throw new Error(`Could not verify Google Ads account ${root}; refresh accounts to retry.`);
      if (!customer.manager) return customer.status === 'ENABLED' ? [{
        id: root,
        resourceName: `customers/${root}`,
        name: customer.descriptiveName || `Google Ads ${root}`,
        loginCustomerId: null,
        manager: false,
        status: customer.status
      }] : [];
      // customer_client includes transitive descendants; no recursive traversal is required.
      const clients = await queryAccount(accessToken, root, "SELECT customer_client.id, customer_client.client_customer, customer_client.descriptive_name, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.manager = FALSE AND customer_client.status = 'ENABLED'");
      return clients.map(row => row.customerClient).filter(client => client && client.manager !== true && client.status === 'ENABLED' && validId(id(client.id || client.clientCustomer))).map(client => {
        const clientId = id(client.id || client.clientCustomer);
        return {
          id: clientId,
          resourceName: `customers/${clientId}`,
          name: client.descriptiveName || `Google Ads ${clientId}`,
          loginCustomerId: root,
          manager: false,
          status: client.status
        };
      });
    }));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        firstError ||= result.reason;
        warnings.push(`Account ${roots[offset + index]}: ${result.reason.message}`);
        return;
      }
      successfulRoots++;
      for (const account of result.value) {
        const current = all.get(account.id);
        // Prefer a direct grant when an advertiser is reachable by multiple paths.
        if (!current || account.loginCustomerId === null) all.set(account.id, account);
      }
    });
  }
  if (roots.length && !successfulRoots) throw firstError;
  return {
    accounts: [...all.values()].sort((a, b) => a.name.localeCompare(b.name)),
    warnings
  };
}
export function applyGoogleAdsAdvertisers(connection, discovery, roots) {
  const previous = id(connection.externalAccountId);
  const selected = discovery.accounts.find(account => account.id === previous) || (discovery.accounts.length === 1 ? discovery.accounts[0] : null);
  connection.externalAccountId = selected?.id || null;
  connection.externalAccountName = selected?.name || null;
  connection.metadata = {
    ...(connection.metadata || {}),
    accessibleCustomers: roots,
    advertiserAccounts: discovery.accounts,
    accountDiscoveryWarnings: discovery.warnings,
    accountsDiscoveredAt: new Date(),
    selectedCustomer: selected?.resourceName || null,
    loginCustomerId: selected?.loginCustomerId || null,
    needsSelection: !selected
  };
  // Changing the source account must not retain a successful sync label for the previous source.
  if (previous !== (selected?.id || '')) {
    connection.lastSyncAt = null;
    connection.lastSyncStatus = 'never';
    connection.lastError = null;
  }
  return selected;
}
