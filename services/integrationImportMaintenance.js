import { linkedInPageUrl } from "./linkedinApi.js";
export async function fetchZohoPages(fetchPage, fields) {
  const records = [],
    seen = new Set();
  let page = 1,
    pageToken = null;
  for (;;) {
    const params = new URLSearchParams({
      per_page: '200',
      fields
    });
    if (pageToken) params.set('page_token', pageToken);else params.set('page', String(page));
    const data = await fetchPage(params);
    if (!Array.isArray(data?.data)) throw new Error('Zoho returned an invalid records page; import stopped.');
    records.push(...data.data);
    if (!data.info?.more_records) return records;
    const next = data.info.next_page_token;
    if (next) {
      if (typeof next !== 'string' || seen.has(next)) throw new Error('Zoho pagination did not advance; import stopped.');
      seen.add(next);
      pageToken = next;
    } else {
      if (pageToken || page >= 10) throw new Error('Zoho did not supply the page token required to finish this import.');
      page++;
    }
  }
}
export async function fetchLinkedInPages(fetchPage, initialUrl) {
  const rows = [],
    seen = new Set();
  let pageToken = null;
  for (;;) {
    const data = await fetchPage(linkedInPageUrl(initialUrl, pageToken));
    if (!Array.isArray(data?.elements)) throw new Error('LinkedIn returned an invalid search page; import stopped.');
    rows.push(...data.elements);
    const next = data.metadata?.nextPageToken;
    if (!next) return rows;
    if (typeof next !== 'string' || seen.has(next)) throw new Error('LinkedIn pagination did not advance; import stopped.');
    seen.add(next);
    pageToken = next;
  }
}
export function selectSavedLinkedInAccount(accounts, savedId) {
  const previous = String(savedId || '');
  const selected = accounts.find(account => String(account.id) === previous);
  if (selected) return selected;
  // Earlier OAuth callbacks stored the person's OpenID subject here, not an ad account.
  if (/^\d+$/.test(previous)) throw new Error('The previously selected LinkedIn ad account is no longer accessible. Reconnect with a user who can access it; Atlas did not switch accounts.');
  return accounts[0] || null;
}
export async function ensureLinkedInAccessToken(connection) {
  const expires = connection.tokenExpiresAt ? new Date(connection.tokenExpiresAt).getTime() : null;
  if (connection.accessToken && (expires === null || expires > Date.now() + 60000)) return connection.accessToken;
  if (!connection.refreshToken) throw Object.assign(new Error('LinkedIn authorization expired. Reconnect LinkedIn Ads.'), {
    status: 401
  });
  if (!process.env.LINKEDIN_CLIENT_ID || !process.env.LINKEDIN_CLIENT_SECRET) throw new Error('LinkedIn token renewal is not configured.');
  const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    signal: AbortSignal.timeout(30000),
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: connection.refreshToken,
      client_id: process.env.LINKEDIN_CLIENT_ID,
      client_secret: process.env.LINKEDIN_CLIENT_SECRET
    })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || typeof data?.access_token !== 'string' || !data.access_token || !(Number(data.expires_in) > 0)) throw Object.assign(new Error('LinkedIn token renewal failed. Reconnect LinkedIn Ads.'), {
    status: data?.error === 'invalid_grant' ? 401 : response.ok ? 502 : response.status,
    reconnectRequired: data?.error === 'invalid_grant'
  });
  connection.accessToken = data.access_token;
  if (data.refresh_token) connection.refreshToken = data.refresh_token;
  connection.tokenExpiresAt = new Date(Date.now() + Number(data.expires_in) * 1000);
  await connection.save();
  return connection.accessToken;
}
