// Rest.li object/list delimiters must remain literal; only scalar values are encoded.
// https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/protocol-version
export function linkedInPageUrl(initialUrl, pageToken = null) {
  const root = new URL(initialUrl);
  const query = root.search.slice(1).split('&').filter(part => part && !/^(pageSize|pageToken)=/.test(part));
  query.push('pageSize=100');
  if (pageToken) query.push(`pageToken=${encodeURIComponent(pageToken).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`);
  return `${root.origin}${root.pathname}?${query.join('&')}`;
}

function requestStage(url) {
  const path = new URL(url).pathname;
  if (path.endsWith('/adAnalytics')) return 'performance report';
  if (path.endsWith('/adCampaigns')) return 'campaign discovery';
  if (path.endsWith('/adAccounts')) return 'account discovery';
  return 'account details';
}

export async function linkedInRequest(url, headers) {
  const response = await fetch(url, {method: 'GET', headers, signal: AbortSignal.timeout(60000)});
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error || Number(data?.status) >= 400) {
    const inputs = Array.isArray(data?.errorDetails?.inputErrors) ? data.errorDetails.inputErrors : [];
    // Never return raw provider payloads or input values; expose only parameter/code identifiers.
    const details = inputs.slice(0, 5).map(input => {
      const field = String(input?.input?.inputPath?.fieldPath || '').replace(/[^a-zA-Z0-9_.\[\]-]/g, '').slice(0, 100);
      const code = String(input?.code || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
      return [field, code].filter(Boolean).join(': ');
    }).filter(Boolean);
    const status = response.ok ? 502 : response.status;
    const reason = status === 400 ? 'LinkedIn rejected a request parameter'
      : status === 401 ? 'LinkedIn authorization expired or was revoked'
      : status === 403 ? 'LinkedIn denied permission for this request'
      : status === 429 ? 'LinkedIn rate limit reached; retry later' : 'LinkedIn API request failed';
    const error = new Error(`LinkedIn ${requestStage(url)} failed (${status})${details.length ? ` [${details.join('; ')}]` : ''}: ${reason}.`);
    error.status = status;
    error.linkedinStage = requestStage(url);
    throw error;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`LinkedIn ${requestStage(url)} returned an invalid response; no data was imported.`);
  return data;
}
