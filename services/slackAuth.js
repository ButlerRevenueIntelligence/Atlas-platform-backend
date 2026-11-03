export async function ensureSlackAccessToken(connection) {
  const expires = connection.tokenExpiresAt ? new Date(connection.tokenExpiresAt).getTime() : null;
  if (connection.accessToken && (expires === null || expires > Date.now() + 60000)) return connection.accessToken;
  if (!connection.refreshToken) throw new Error('Slack authorization expired. Reconnect Slack before changing its installation.');
  const clientId = process.env.SLACK_CLIENT_ID,
    clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Slack token renewal is not configured.');
  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: connection.refreshToken
    })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok || typeof data.access_token !== 'string' || !data.access_token || !data.refresh_token || !(Number(data.expires_in) > 0)) throw new Error('Slack token renewal failed. Reconnect Slack.');
  connection.accessToken = data.access_token;
  connection.refreshToken = data.refresh_token;
  connection.tokenExpiresAt = new Date(Date.now() + Number(data.expires_in) * 1000);
  await connection.save();
  return connection.accessToken;
}
