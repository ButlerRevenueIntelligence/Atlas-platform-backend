import test from 'node:test';
import assert from 'node:assert/strict';
import router, { googleAdsCallbackErrorCode } from '../routes/integrations.js';
import Organization from '../models/Organization.js';
import IntegrationConnection from '../models/IntegrationConnection.js';
const orgId = '507f1f77bcf86cd799439011';
const auth = router.stack.find(layer => layer.route?.path === '/:provider/auth-url').route.stack.at(-1).handle;
const callback = router.stack.find(layer => layer.route?.path === '/google_ads/callback').route.stack.at(-1).handle;
const response = () => ({
  statusCode: 200,
  status(value) {
    this.statusCode = value;
    return this;
  },
  json(value) {
    this.body = value;
    return this;
  },
  send(value) {
    this.body = value;
    return this;
  },
  redirect(value) {
    this.redirectUrl = value;
    return this;
  }
});
async function fixture(t, options = {}) {
  t.mock.method(console, 'error', () => {});
  for (const [name, value] of Object.entries({
    OAUTH_STATE_SECRET: 'test-oauth-state-secret',
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_ADS_DEVELOPER_TOKEN: 'test-developer-token',
    BACKEND_PUBLIC_URL: 'https://backend.example.com',
    FRONTEND_URL: 'https://frontend.example.com'
  })) {
    const old = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (old === undefined) delete process.env[name];else process.env[name] = old;
    });
  }
  const saved = {
    metadata: {
      googleUserEmail: 'same@example.test'
    },
    refreshToken: options.oldRefresh || null,
    save: async () => {
      saved.didSave = true;
    }
  };
  t.mock.method(Organization, 'findById', async () => ({
    _id: orgId
  }));
  t.mock.method(Organization, 'findByIdAndUpdate', async () => ({}));
  t.mock.method(IntegrationConnection, 'findOne', query => {
    assert.equal(query.orgId, orgId);
    assert.equal(query.provider, 'google_ads');
    return {
      select: async () => saved
    };
  });
  const calls = [];
  // Every fetch is stubbed. Unknown URLs throw: this test never contacts Google.
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify(options.tokenError ? {
      error: options.tokenError
    } : {
      access_token: 'test-access',
      refresh_token: options.noRefresh ? undefined : 'test-refresh',
      scope: options.profile ? 'https://www.googleapis.com/auth/adwords openid email profile' : 'https://www.googleapis.com/auth/adwords',
      expires_in: 3600
    }), {
      status: options.tokenError ? 400 : 200
    });
    if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') return new Response(JSON.stringify(options.profileFailure ? {
      error: {
        message: 'Insufficient scope'
      }
    } : {
      email: options.email || 'same@example.test',
      name: 'Test User'
    }), {
      status: options.profileFailure ? 403 : 200
    });
    if (url === 'https://googleads.googleapis.com/v25/customers:listAccessibleCustomers') return new Response(JSON.stringify(options.adsError ? {
      error: {
        status: 'PERMISSION_DENIED',
        details: [{
          errors: [{
            errorCode: {
              authorizationError: options.adsError
            }
          }]
        }]
      }
    } : {
      resourceNames: options.customers || ['customers/1234567890']
    }), {
      status: options.adsError ? 403 : 200
    });
    const match = url.match(/customers\/(\d+)\/googleAds:searchStream$/);
    if (match) return new Response(JSON.stringify([{results:[{customer:{id:match[1],descriptiveName:`Advertiser ${match[1]}`,manager:false,status:'ENABLED'}}]}]),{status:200});
    throw new Error(`Unexpected mocked URL: ${url}`);
  });
  const authRes = response();
  await auth({
    user: {
      orgId
    },
    headers: {
      'x-org-id': orgId
    },
    query: {},
    params: {
      provider: 'google_ads'
    }
  }, authRes);
  assert.equal(authRes.body?.ok, true);
  const authUrl = new URL(authRes.body.authUrl);
  return {
    saved,
    calls,
    authUrl,
    async run(query = {}) {
      const res = response();
      await callback({
        query: {
          code: 'test-code',
          state: authUrl.searchParams.get('state'),
          ...query
        }
      }, res);
      return res;
    }
  };
}
test('Google Ads requests the identity scopes used for display-only profile lookup', async t => {
  const f = await fixture(t),
    scopes = f.authUrl.searchParams.get('scope').split(' ');
  for (const scope of ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/adwords']) assert.ok(scopes.includes(scope));
  assert.equal(f.authUrl.searchParams.get('access_type'), 'offline');
  assert.equal(f.authUrl.searchParams.get('include_granted_scopes'), 'false');
});
test('Ads-only grants connect without calling a profile API', async t => {
  const f = await fixture(t),
    r = await f.run();
  assert.match(r.redirectUrl, /connected=google_ads/);
  assert.equal(f.saved.status, 'connected');
  assert.equal(f.saved.externalAccountId, '1234567890');
  assert.equal(f.saved.didSave, true);
  assert.equal(f.calls.some(url => url.includes('userinfo')), false);
});
test('a failed optional profile lookup does not discard valid Ads access', async t => {
  const f = await fixture(t, {
      profile: true,
      profileFailure: true,
      customers: ['customers/123', 'customers/456']
    }),
    r = await f.run();
  assert.match(r.redirectUrl, /needsSelection=1/);
  assert.equal(f.saved.metadata.needsSelection, true);
  assert.equal(f.saved.metadata.googleUserEmail, null);
});
test('missing offline access fails before a connection is marked saved', async t => {
  const f = await fixture(t, {
      noRefresh: true
    }),
    r = await f.run();
  assert.match(r.redirectUrl, /google_ads_offline_access_required/);
  assert.notEqual(f.saved.didSave, true);
});
test('reconnect preserves an existing refresh token only for the same verified Google user', async t => {
  const f = await fixture(t, {
      noRefresh: true,
      oldRefresh: 'prior-token',
      profile: true
    }),
    r = await f.run();
  assert.match(r.redirectUrl, /connected=google_ads/);
  assert.equal(f.saved.refreshToken, 'prior-token');
});
test('reconnect does not reuse another Google user refresh token', async t => {
  const f = await fixture(t, {
      noRefresh: true,
      oldRefresh: 'prior-token',
      profile: true,
      email: 'other@example.test'
    }),
    r = await f.run();
  assert.match(r.redirectUrl, /google_ads_offline_access_required/);
  assert.notEqual(f.saved.didSave, true);
});
test('no Ads accounts, invalid grant and developer-token failures have distinct safe redirects', async t => {
  for (const [options, expected] of [[{
    customers: []
  }, 'google_ads_no_accessible_accounts'], [{
    tokenError: 'invalid_grant'
  }, 'google_ads_authorization_expired'], [{
    adsError: 'DEVELOPER_TOKEN_NOT_APPROVED'
  }, 'google_ads_developer_token_rejected']]) {
    await t.test(expected, async st => {
      const f = await fixture(st, options),
        r = await f.run();
      assert.match(r.redirectUrl, new RegExp(expected));
      assert.doesNotMatch(r.redirectUrl, /test-access|test-secret|test-refresh/);
      assert.notEqual(f.saved.didSave, true);
    });
  }
});
test('consent denial does not perform a token exchange', async t => {
  const f = await fixture(t),
    r = await f.run({
      error: 'access_denied'
    });
  assert.match(r.redirectUrl, /google_ads_access_denied/);
  assert.equal(f.calls.length, 0);
});
test('unknown error strings cannot be copied into callback URLs', () => {
  assert.equal(googleAdsCallbackErrorCode({
    callbackCode: 'secret-value',
    message: 'secret-value'
  }, 'save_connection'), 'google_ads_connection_save_failed');
  assert.equal(googleAdsCallbackErrorCode({
    status: 403
  }, 'account_discovery'), 'google_ads_account_access_denied');
});
