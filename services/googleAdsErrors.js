// Keep provider diagnostics useful without exposing request bodies or credentials.
export function googleAdsFailure(error) {
  const details = error.providerDetails || [];
  const failures = details.flatMap(detail => detail.errors || []);
  const codes = failures.flatMap(item => Object.values(item.errorCode || {}));
  const reasons = details.map(detail => detail.reason).filter(Boolean);
  const allCodes = [...codes, ...reasons];
  const hints = {
    USER_PERMISSION_DENIED: 'The connected Google user cannot access this ad account through the selected manager. Check Google Ads Access and security, then reconnect with the correct Google user or select an accessible client account.',
    DEVELOPER_TOKEN_NOT_APPROVED: 'The Google Ads developer token is not approved for this account. Check its access level in Google Ads API Center.',
    DEVELOPER_TOKEN_PROHIBITED: 'Google rejected the developer token for this Cloud project. Check the developer token and Google Cloud project configuration.',
    DEVELOPER_TOKEN_INVALID: 'The Google Ads developer token is invalid. The platform administrator needs to check the backend developer token.',
    DEVELOPER_TOKEN_NOT_ALLOWED: 'The developer token cannot access this Google Ads account. Check its approved access level and test-account restrictions.',
    CUSTOMER_NOT_ENABLED: 'The selected Google Ads account is not enabled. Complete its Google Ads setup or select an active advertiser account.',
    REQUESTED_METRICS_FOR_MANAGER: 'Google Ads cannot report campaign metrics for a manager account. Select the advertiser/client account that owns the campaigns.',
    PROJECT_DISABLED: 'Google Ads API access is disabled for the configured Cloud project. The platform administrator needs to review its API access.',
    SERVICE_DISABLED: 'The Google Ads API is disabled for the configured Cloud project. The platform administrator needs to enable it.',
    ACCESS_TOKEN_SCOPE_INSUFFICIENT: 'Google Ads authorization is missing the required permission. Reconnect Google Ads and approve Ads access.',
    ACCESS_TOKEN_EXPIRED: 'Google Ads authorization has expired. Reconnect Google Ads to restore access.',
    invalid_grant: 'Google revoked or expired the authorization. Reconnect Google Ads to grant background access again.'
  };
  const code = allCodes.find(value => hints[value]) || (typeof error.providerError === 'string' ? error.providerError : null) || allCodes[0] || error.providerStatus || null;
  const explanation = hints[code] || (error.status === 403 ? 'Google denied this sync request. Check the connected Google user, selected advertiser account and developer-token access. The platform administrator can use the request ID in Render logs to investigate.' : error.message);
  const requestId = String(error.requestId || details.find(detail => detail.requestId)?.requestId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100) || null;
  error.googleCode = code;
  error.requestId = requestId;
  error.message = `Google Ads sync failed${code ? ` (${code})` : ''}: ${explanation}${requestId ? ` Request ID: ${requestId}.` : ''}`;
  return error;
}
export function googleAdsLoginCustomerId(connection, configuredManager) {
  const normalize = value => String(value || '').replace(/^customers\//, '').replace(/-/g, '');
  const target = normalize(connection.externalAccountId);
  const directAccounts = connection.metadata?.accessibleCustomers || [];
  // OAuth discovery lists directly accessible accounts, not manager descendants.
  if (directAccounts.some(value => normalize(value) === target)) return null;
  const manager = normalize(connection.metadata?.loginCustomerId || configuredManager);
  return /^\d+$/.test(manager) ? manager : null;
}
