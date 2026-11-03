import test from 'node:test';
import assert from 'node:assert/strict';
import IntegrationConnection from '../models/IntegrationConnection.js';
import SourceMetricDaily from '../models/SourceMetricDaily.js';
import { syncAdditionalProvider, reportingDates } from '../services/providerMetrics.js';
import { googleAdsLoginCustomerId } from '../services/googleAdsErrors.js';
function fixture(t, metadata = {}) {
  const old = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'test-developer';
  t.after(() => {
    if (old === undefined) delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;else process.env.GOOGLE_ADS_DEVELOPER_TOKEN = old;
  });
  const connection = {
    externalAccountId: '1234567890',
    accessToken: 'test-access',
    metadata,
    async save() {}
  };
  t.mock.method(IntegrationConnection, 'findOne', filter => {
    assert.equal(filter.orgId, 'workspace-a');
    assert.equal(filter.provider, 'google_ads');
    return {
      select: async () => connection
    };
  });
  const writes = [],
    logs = [];
  t.mock.method(SourceMetricDaily, 'bulkWrite', async ops => writes.push(...ops));
  t.mock.method(console, 'error', (...args) => logs.push(args));
  return {
    connection,
    writes,
    logs
  };
}
function failure(code, array = true, status = 403) {
  const error = {
    error: {
      code: status,
      status: 'PERMISSION_DENIED',
      message: 'The caller does not have permission',
      details: [{
        requestId: 'request-123',
        errors: [{
          errorCode: {
            authorizationError: code
          }
        }]
      }]
    }
  };
  return {
    ok: status === 200,
    status,
    json: async () => array ? [error] : error,
    headers: new Headers()
  };
}
test('directly accessible accounts omit an unrelated global manager ID', async t => {
  const f = fixture(t, {
    accessibleCustomers: ['customers/1234567890']
  });
  const old = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = '999-999-9999';
  t.after(() => {
    if (old === undefined) delete process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;else process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = old;
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(url, /customers\/1234567890\/googleAds:searchStream$/);
    assert.equal(options.headers['login-customer-id'], undefined);
    return {
      ok: true,
      status: 200,
      json: async () => [{
        results: [{
          segments: {
            date: reportingDates().end
          },
          customer: {
            currencyCode: 'USD'
          },
          metrics: {
            costMicros: '2500000'
          }
        }]
      }]
    };
  });
  await syncAdditionalProvider('google_ads', 'workspace-a');
  assert.equal(f.connection.lastSyncStatus, 'success');
  assert.equal(f.writes.length, 30);
  assert.equal(f.writes.find(x => x.updateOne.filter.date === reportingDates().end).updateOne.update.$set.spend, 2.5);
});
test('manager access prefers a connection-specific manager and preserves legacy configuration', () => {
  assert.equal(googleAdsLoginCustomerId({
    externalAccountId: '123',
    metadata: {
      loginCustomerId: '444-555-6666'
    }
  }, '9999999999'), '4445556666');
  assert.equal(googleAdsLoginCustomerId({
    externalAccountId: '123',
    metadata: {}
  }, '999-999-9999'), '9999999999');
  assert.equal(googleAdsLoginCustomerId({
    externalAccountId: '123',
    metadata: {
      accessibleCustomers: ['customers/123']
    }
  }, '9999999999'), null);
  assert.equal(googleAdsLoginCustomerId({
    externalAccountId: '123',
    metadata: {}
  }, 'bad-id'), null);
});
test('streamed Google permission errors retain the real code and never overwrite prior metrics with zero', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => failure('USER_PERMISSION_DENIED'));
  await assert.rejects(syncAdditionalProvider('google_ads', 'workspace-a'), error => {
    assert.equal(error.status, 403);
    assert.equal(error.googleCode, 'USER_PERMISSION_DENIED');
    assert.equal(error.requestId, 'request-123');
    assert.match(error.message, /Check Google Ads Access and security/);
    return true;
  });
  assert.equal(f.writes.length, 0);
  assert.equal(f.connection.lastSyncStatus, 'failed');
  assert.match(f.connection.lastError, /USER_PERMISSION_DENIED/);
  assert.equal(f.logs[0][1].event, 'google_ads_sync_failed');
  assert.doesNotMatch(JSON.stringify(f.logs), /test-access|test-developer/);
});
test('developer-token rejection provides a specific setup action for an object response', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => failure('DEVELOPER_TOKEN_NOT_APPROVED', false));
  await assert.rejects(syncAdditionalProvider('google_ads', 'workspace-a'), /Check its access level in Google Ads API Center/);
  assert.equal(f.writes.length, 0);
});
test('manager metrics errors tell the user to choose the advertiser account', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => failure('REQUESTED_METRICS_FOR_MANAGER', true, 400));
  await assert.rejects(syncAdditionalProvider('google_ads', 'workspace-a'), /Select the advertiser\/client account/);
  assert.equal(f.writes.length, 0);
});
test('an error envelope in a successful HTTP stream is not treated as an empty report', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => failure('CUSTOMER_NOT_ENABLED', true, 200));
  await assert.rejects(syncAdditionalProvider('google_ads', 'workspace-a'), /Complete its Google Ads setup/);
  assert.equal(f.writes.length, 0);
});
test('invalid JSON fails safely without wiping metrics', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 403,
    json: async () => {
      throw new SyntaxError('Invalid response');
    }
  }));
  await assert.rejects(syncAdditionalProvider('google_ads', 'workspace-a'), /Google denied this sync request/);
  assert.equal(f.writes.length, 0);
});
test('revoked refresh-token grants ask for reconnect without logging credentials', async t => {
  const f = fixture(t);
  f.connection.refreshToken = 'test-refresh';
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    return {
      ok: false,
      status: 400,
      json: async () => ({
        error: 'invalid_grant',
        error_description: 'Token revoked'
      })
    };
  });
  await assert.rejects(syncAdditionalProvider('google_ads', 'workspace-a'), /Reconnect Google Ads to grant background access/);
  assert.equal(f.writes.length, 0);
  assert.doesNotMatch(JSON.stringify(f.logs), /test-refresh|test-access/);
});
