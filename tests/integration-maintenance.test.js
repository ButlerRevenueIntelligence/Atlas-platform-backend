import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchZohoPages, fetchLinkedInPages, selectSavedLinkedInAccount, ensureLinkedInAccessToken } from '../services/integrationImportMaintenance.js';
import { ensureSlackAccessToken } from '../services/slackAuth.js';
import { qboRequest } from '../routes/quickbooks.js';
import router, { getGA4AccountSummaries, getPipedriveUserInfo } from '../routes/integrations.js';
import Organization from '../models/Organization.js';
import IntegrationConnection from '../models/IntegrationConnection.js';
const env = (t, name, value) => {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];else process.env[name] = previous;
  });
};
const json = (data, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => data
});
const expired = () => ({
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  tokenExpiresAt: new Date(0),
  async save() {
    this.saved = true;
  }
});
test('Zoho switches from numbered pages to page tokens beyond page ten', async () => {
  const rows = await fetchZohoPages(async params => {
    if (params.has('page_token')) {
      assert.equal(params.get('page_token'), 'cursor-11');
      assert.equal(params.has('page'), false);
      return {
        data: [{
          id: '11'
        }],
        info: {
          more_records: false
        }
      };
    }
    const page = Number(params.get('page'));
    return {
      data: [{
        id: String(page)
      }],
      info: {
        more_records: true,
        ...(page === 10 ? {
          next_page_token: 'cursor-11'
        } : {})
      }
    };
  }, 'id,Name');
  assert.equal(rows.length, 11);
});
test('Zoho repeated tokens and missing required tokens stop incomplete imports', async () => {
  await assert.rejects(fetchZohoPages(async () => ({
    data: [],
    info: {
      more_records: true,
      next_page_token: 'repeat'
    }
  }), 'id'), /did not advance/);
  await assert.rejects(fetchZohoPages(async () => ({
    data: [],
    info: {
      more_records: true
    }
  }), 'id'), /required to finish/);
  await assert.rejects(fetchZohoPages(async () => ({
    message: 'bad page'
  }), 'id'), /invalid records page/);
});
test('LinkedIn account search follows nextPageToken while preserving the original search', async () => {
  let n = 0;
  const rows = await fetchLinkedInPages(async url => {
    n++;
    const u = new URL(url);
    assert.equal(u.origin, 'https://api.linkedin.com');
    assert.equal(u.searchParams.get('q'), 'search');
    assert.equal(u.searchParams.get('pageSize'), '100');
    if (n === 1) return {
      elements: [{
        id: '1'
      }],
      metadata: {
        nextPageToken: 'token?&='
      }
    };
    assert.equal(u.searchParams.get('pageToken'), 'token?&=');
    return {
      elements: [{
        id: '2'
      }]
    };
  }, 'https://api.linkedin.com/rest/adAccounts?q=search&search=(status:(values:List(ACTIVE)))');
  assert.equal(rows.length, 2);
});
test('LinkedIn repeated cursors and invalid pages cannot silently truncate imports', async () => {
  await assert.rejects(fetchLinkedInPages(async () => ({
    elements: [],
    metadata: {
      nextPageToken: 'repeat'
    }
  }), 'https://api.linkedin.com/rest/adAccounts?q=search'), /did not advance/);
  await assert.rejects(fetchLinkedInPages(async () => ({}), 'https://api.linkedin.com/rest/adAccounts?q=search'), /invalid search page/);
});
test('LinkedIn keeps its saved ad account and fails instead of switching accounts when access disappears', () => {
  const rows = [{
    id: 2
  }, {
    id: 1
  }];
  assert.equal(selectSavedLinkedInAccount(rows, '1').id, 1);
  assert.throws(() => selectSavedLinkedInAccount(rows, '3'), /did not switch/);
  assert.equal(selectSavedLinkedInAccount(rows, null).id, 2);
  assert.equal(selectSavedLinkedInAccount([], null), null);
});
test('LinkedIn renews an expired token and persists returned credentials before API use', async t => {
  env(t, 'LINKEDIN_CLIENT_ID', 'test-id');
  env(t, 'LINKEDIN_CLIENT_SECRET', 'test-secret');
  const c = expired();
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.equal(url, 'https://www.linkedin.com/oauth/v2/accessToken');
    assert.equal(opts.body.get('grant_type'), 'refresh_token');
    assert.equal(opts.body.get('refresh_token'), 'old-refresh');
    return json({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600
    });
  });
  assert.equal(await ensureLinkedInAccessToken(c), 'new-access');
  assert.equal(c.refreshToken, 'new-refresh');
  assert.equal(c.saved, true);
  assert.ok(c.tokenExpiresAt > Date.now());
});
test('LinkedIn preserves a refresh token when it is not rotated and does not refresh a valid access token', async t => {
  env(t, 'LINKEDIN_CLIENT_ID', 'test-id');
  env(t, 'LINKEDIN_CLIENT_SECRET', 'test-secret');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return json({
      access_token: 'new-access',
      expires_in: 3600
    });
  });
  const c = expired();
  await ensureLinkedInAccessToken(c);
  assert.equal(c.refreshToken, 'old-refresh');
  await ensureLinkedInAccessToken(c);
  assert.equal(calls, 1);
});
test('LinkedIn refuses invalid renewal data without replacing the stored credentials', async t => {
  env(t, 'LINKEDIN_CLIENT_ID', 'test-id');
  env(t, 'LINKEDIN_CLIENT_SECRET', 'test-secret');
  t.mock.method(globalThis, 'fetch', async () => json({
    expires_in: 3600
  }));
  const c = expired();
  await assert.rejects(ensureLinkedInAccessToken(c), /renewal failed/);
  assert.equal(c.accessToken, 'old-access');
  assert.equal(c.saved, undefined);
});
test('QuickBooks detects a Fault in an HTTP 200 response instead of importing a zero report', async t => {
  t.mock.method(globalThis, 'fetch', async () => json({
    Fault: {
      Error: [{
        Detail: 'Authentication failed'
      }]
    }
  }));
  await assert.rejects(qboRequest({
    realmId: 'realm',
    accessToken: 'test',
    path: 'reports/ProfitAndLoss'
  }), error => error.status === 502 && /Authentication failed/.test(error.message));
});
test('QuickBooks rejects malformed or empty successful responses and accepts a valid report', async t => {
  const payloads = [null, {}, {
    Header: {
      ReportName: 'ProfitAndLoss'
    },
    Rows: {
      Row: []
    }
  }];
  t.mock.method(globalThis, 'fetch', async () => json(payloads.shift()));
  for (let i = 0; i < 2; i++) await assert.rejects(qboRequest({
    realmId: 'realm',
    accessToken: 'test',
    path: 'reports/ProfitAndLoss'
  }), /no report was imported/);
  assert.equal((await qboRequest({
    realmId: 'realm',
    accessToken: 'test',
    path: 'reports/ProfitAndLoss'
  })).Header.ReportName, 'ProfitAndLoss');
});
test('GA4 discovers properties from all account-summary pages', async t => {
  let n = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    const u = new URL(url);
    assert.equal(u.origin, 'https://analyticsadmin.googleapis.com');
    if (++n === 1) return json({
      accountSummaries: [{
        account: 'a'
      }],
      nextPageToken: 'next & page'
    });
    assert.equal(u.searchParams.get('pageToken'), 'next & page');
    return json({
      accountSummaries: [{
        account: 'b'
      }]
    });
  });
  assert.equal((await getGA4AccountSummaries('test')).length, 2);
});
test('GA4 pagination loops and malformed account lists fail explicitly', async t => {
  t.mock.method(globalThis, 'fetch', async () => json({
    nextPageToken: 'repeat'
  }));
  await assert.rejects(getGA4AccountSummaries('test'), /did not advance/);
});
test('Slack renews rotating bot tokens before revocation without sending any channel message', async t => {
  env(t, 'SLACK_CLIENT_ID', 'test-id');
  env(t, 'SLACK_CLIENT_SECRET', 'test-secret');
  const c = expired();
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.equal(url, 'https://slack.com/api/oauth.v2.access');
    assert.equal(opts.body.get('grant_type'), 'refresh_token');
    return json({
      ok: true,
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 43200
    });
  });
  assert.equal(await ensureSlackAccessToken(c), 'new-access');
  assert.equal(c.refreshToken, 'new-refresh');
  assert.equal(c.saved, true);
});
test('Slack leaves permanent tokens alone and does not save a failed rotation', async t => {
  env(t, 'SLACK_CLIENT_ID', 'test-id');
  env(t, 'SLACK_CLIENT_SECRET', 'test-secret');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return json({
      ok: false,
      error: 'invalid_refresh_token'
    });
  });
  assert.equal(await ensureSlackAccessToken({
    accessToken: 'permanent'
  }), 'permanent');
  const c = expired();
  await assert.rejects(ensureSlackAccessToken(c), /renewal failed/);
  assert.equal(c.accessToken, 'old-access');
  assert.equal(c.saved, undefined);
  assert.equal(calls, 1);
});
test('Slack OAuth callback saves the actual rotation expiry and refresh token', async t => {
  for (const [name, value] of Object.entries({
    OAUTH_STATE_SECRET: 'test-state',
    SLACK_CLIENT_ID: 'test-id',
    SLACK_CLIENT_SECRET: 'test-secret'
  })) env(t, name, value);
  const orgId = '507f1f77bcf86cd799439011',
    saved = {
      metadata: {},
      async save() {}
    };
  t.mock.method(Organization, 'findById', async () => ({
    _id: orgId
  }));
  t.mock.method(Organization, 'findByIdAndUpdate', async () => ({}));
  t.mock.method(IntegrationConnection, 'findOne', () => ({
    select: async () => saved
  }));
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'https://slack.com/api/oauth.v2.access');
    return json({
      ok: true,
      access_token: 'test-bot',
      refresh_token: 'test-refresh',
      expires_in: 43200,
      team: {
        id: 'team'
      },
      incoming_webhook: {
        url: 'https://hooks.slack.com/services/test/test/test',
        channel: '#test'
      }
    });
  });
  const res = () => ({
    json(value) {
      this.body = value;
      return this;
    },
    redirect(value) {
      this.url = value;
      return this;
    }
  });
  const authRes = res();
  await router.stack.find(x => x.route?.path === '/:provider/auth-url').route.stack.at(-1).handle({
    headers: {
      'x-org-id': orgId
    },
    user: {
      orgId
    },
    params: {
      provider: 'slack'
    }
  }, authRes);
  const state = new URL(authRes.body.authUrl).searchParams.get('state'),
    callbackRes = res();
  await router.stack.find(x => x.route?.path === '/slack/callback').route.stack.at(-1).handle({
    query: {
      code: 'test-code',
      state
    }
  }, callbackRes);
  assert.match(callbackRes.url, /connected=slack/);
  assert.equal(saved.refreshToken, 'test-refresh');
  assert.ok(saved.tokenExpiresAt > Date.now());
});
test('Pipedrive profile uses the company API path once for both domain formats', async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url);
    return json({
      success: true,
      data: {
        id: 1
      }
    });
  });
  for (const domain of ['https://example.pipedrive.com', 'https://example.pipedrive.com/api/']) assert.equal((await getPipedriveUserInfo('test', domain)).id, 1);
  assert.deepEqual(urls, ['https://example.pipedrive.com/api/v1/users/me', 'https://example.pipedrive.com/api/v1/users/me']);
});
test('Google rejects an incomplete token renewal without overwriting credentials', async t => {
  const {
    googleToken
  } = await import('../services/providerMetrics.js');
  const c = expired();
  t.mock.method(globalThis, 'fetch', async () => json({
    expires_in: 3600
  }));
  await assert.rejects(googleToken(c), /no access token/);
  assert.equal(c.accessToken, 'old-access');
  assert.equal(c.saved, undefined);
});
