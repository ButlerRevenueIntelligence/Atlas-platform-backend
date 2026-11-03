import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { markSyncFailed } from '../jobs/integrationAutoSync.js';
import { googleToken } from '../services/providerMetrics.js';
import router from '../routes/integrations.js';
import Organization from '../models/Organization.js';
import IntegrationConnection from '../models/IntegrationConnection.js';

const json = (body, status = 200) => ({ok: status < 400, status, json: async () => body});
const conn = provider => ({provider, accessToken: 'existing-access', refreshToken: 'refresh', metadata: {accountId: '123'}, status: 'connected', async save() {this.saved = true;}});
for (const provider of ['google_ads', 'linkedin_ads']) {
  test(`${provider} keeps authorization connected after reporting, permission, rate-limit and network failures`, async () => {
    for (const status of [400, 403, 429, 500, undefined]) {
      const c = conn(provider);
      await markSyncFailed(c, Object.assign(new Error('Actual provider error'), {status}));
      assert.equal(c.status, 'connected');
      assert.equal(c.lastSyncStatus, 'failed');
      assert.equal(c.lastError, 'Actual provider error');
      assert.equal(c.refreshToken, 'refresh');
      assert.deepEqual(c.metadata, {accountId: '123'});
    }
  });
  test(`${provider} reports an authorization error when renewal requires reconnection`, async () => {
    const c = conn(provider);
    await markSyncFailed(c, Object.assign(new Error('Authorization expired'), {status: 401}));
    assert.equal(c.status, 'error');
    assert.equal(c.lastSyncStatus, 'failed');
    assert.equal(c.refreshToken, 'refresh');
  });
}
test('Google reuses a valid access token instead of renewing on every sync', async t => {
  const c = {...conn('google_ads'), tokenExpiresAt: new Date(Date.now() + 3600000)};
  t.mock.method(globalThis, 'fetch', () => {throw new Error('Unexpected renewal');});
  assert.equal(await googleToken(c), 'existing-access');
  assert.equal(c.saved, undefined);
});
test('Google renews an expiring token and classifies revoked grants separately from temporary failures', async t => {
  let payload = {access_token: 'new', expires_in: 3600}; let status = 200;
  t.mock.method(globalThis, 'fetch', async () => json(payload, status));
  const c = {...conn('google_ads'), tokenExpiresAt: new Date(0)};
  assert.equal(await googleToken(c), 'new');
  assert.equal(c.refreshToken, 'refresh');
  payload = {error: 'invalid_grant'}; status = 400;
  await assert.rejects(googleToken({...conn('google_ads'), tokenExpiresAt: new Date(0)}), error => error.status === 401 && error.reconnectRequired === true);
  payload = {error: 'temporarily_unavailable'}; status = 503;
  await assert.rejects(googleToken({...conn('google_ads'), tokenExpiresAt: new Date(0)}), error => error.status === 503 && !error.reconnectRequired);
});
test('Google expiration without a refresh token explicitly requires reconnection', async () => {
  await assert.rejects(googleToken({accessToken: 'expired', tokenExpiresAt: new Date(0)}), error => error.status === 401 && error.reconnectRequired);
});
test('the server mounts only the maintained LinkedIn OAuth handler', () => {
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(server, /import\s+linkedinAdsRoutes|\n\s*linkedinAdsRoutes\s*\n/);
  assert.match(server, /"\/api\/integrations",\s*integrationPlanGate,\s*integrationsRoute/);
});
test('LinkedIn maintained callback stores expiry and refresh credentials even without optional profile access', async t => {
  for (const [key, value] of Object.entries({OAUTH_STATE_SECRET: 'test-state', LINKEDIN_CLIENT_ID: 'test-client', LINKEDIN_CLIENT_SECRET: 'test-secret', BACKEND_PUBLIC_URL: 'https://backend.example.test', FRONTEND_URL: 'https://frontend.example.test'})) {
    const old = process.env[key]; process.env[key] = value;
    t.after(() => {if (old === undefined) delete process.env[key]; else process.env[key] = old;});
  }
  const c = conn('linkedin_ads'); c.externalAccountId = '123'; c.metadata = {selectedAdAccountId: '123'};
  t.mock.method(Organization, 'findById', async () => ({_id: 'workspace-a'}));
  t.mock.method(Organization, 'findByIdAndUpdate', async () => ({}));
  t.mock.method(IntegrationConnection, 'findOne', () => ({select: async () => c}));
  t.mock.method(globalThis, 'fetch', async url => url.includes('/accessToken') ? json({access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: 'r_ads r_ads_reporting'}) : json({}, 403));
  t.mock.method(console, 'log', () => {});
  const handler = path => router.stack.find(layer => layer.route?.path === path).route.stack.at(-1).handle;
  const result = () => ({status(code) {this.code = code; return this;}, json(body) {this.body = body; return this;}, redirect(url) {this.url = url; return this;}, send(body) {this.body = body; return this;}});
  const auth = result();
  await handler('/:provider/auth-url')({user: {orgId: 'workspace-a'}, params: {provider: 'linkedin_ads'}, headers: {'x-org-id': 'workspace-a'}, query: {}}, auth);
  const url = new URL(auth.body.authUrl);
  assert.equal(url.searchParams.get('scope'), 'r_ads r_ads_reporting');
  const callback = result();
  await handler('/linkedin_ads/callback')({query: {code: 'test-code', state: url.searchParams.get('state')}}, callback);
  assert.ok(callback.url.includes('connected=linkedin_ads'));
  assert.equal(c.accessToken, 'new-access');
  assert.equal(c.refreshToken, 'new-refresh');
  assert.ok(c.tokenExpiresAt > Date.now());
  assert.equal(c.externalAccountId, '123');
});

test('LinkedIn invalid_grant renewal failure requires reconnection rather than endless connected retries', async t => {
  const {ensureLinkedInAccessToken} = await import('../services/integrationImportMaintenance.js');
  for (const key of ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET']) {
    const old = process.env[key]; process.env[key] = 'test';
    t.after(() => {if (old === undefined) delete process.env[key]; else process.env[key] = old;});
  }
  t.mock.method(globalThis, 'fetch', async () => json({error: 'invalid_grant'}, 400));
  await assert.rejects(ensureLinkedInAccessToken({...conn('linkedin_ads'), tokenExpiresAt: new Date(0)}), error => error.status === 401 && error.reconnectRequired === true);
});
