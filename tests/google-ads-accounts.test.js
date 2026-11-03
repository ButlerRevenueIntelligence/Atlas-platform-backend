import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverGoogleAdsAdvertisers, applyGoogleAdsAdvertisers } from '../services/googleAdsAccounts.js';
import { googleAdsLoginCustomerId } from '../services/googleAdsErrors.js';
import router from '../routes/integrations.js';
import { integrationWorkspace } from '../middleware/integrationWorkspace.js';
import IntegrationConnection from '../models/IntegrationConnection.js';
import Organization from '../models/Organization.js';
const response = rows => ({
  ok: true,
  status: 200,
  json: async () => [{
    results: rows
  }]
});
const advertiser = (id, name = id) => ({
  id,
  descriptiveName: name,
  manager: false,
  status: 'ENABLED'
});
const managed = (id, name = id) => ({
  customerClient: advertiser(id, name)
});
test('manager discovery includes enabled nested advertisers, excludes manager IDs, and records the access root', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({
      url,
      options
    });
    assert.equal(options.headers['login-customer-id'], undefined);
    const q = JSON.parse(options.body).query;
    if (q.includes('FROM customer_client')) {
      assert.match(q, /manager = FALSE/);
      assert.match(q, /status = 'ENABLED'/);
      return response([managed('2', 'Client Two'), managed('3', 'Nested Client'), {
        customerClient: {
          id: '4',
          manager: true,
          status: 'ENABLED'
        }
      }, {
        customerClient: {
          id: '5',
          manager: false,
          status: 'CANCELED'
        }
      }]);
    }
    return response([{
      customer: {
        id: '1',
        manager: true,
        status: 'ENABLED'
      }
    }]);
  });
  const result = await discoverGoogleAdsAdvertisers('test-access', ['customers/1']);
  assert.deepEqual(result.accounts.map(a => a.id), ['2', '3']);
  assert.equal(result.accounts[1].loginCustomerId, '1');
  assert.equal(result.accounts.some(a => a.id === '1'), false);
  assert.equal(calls.length, 2);
});
test('direct advertiser access wins over duplicate manager paths and supports omitted false protobuf fields', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => url.includes('/1/') ? response(JSON.parse(options.body).query.includes('FROM customer_client') ? [managed('2')] : [{
    customer: {
      id: '1',
      manager: true,
      status: 'ENABLED'
    }
  }]) : response([{
    customer: {
      id: '2',
      status: 'ENABLED',
      descriptiveName: 'Direct Advertiser'
    }
  }]));
  const result = await discoverGoogleAdsAdvertisers('test-access', ['customers/1', 'customers/2']);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].loginCustomerId, null);
  assert.equal(result.accounts[0].name, 'Direct Advertiser');
});
test('discovery handles an empty manager and cannot auto-select it as a reporting account', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => response(JSON.parse(options.body).query.includes('FROM customer_client') ? [] : [{
    customer: {
      id: '1',
      manager: true,
      status: 'ENABLED'
    }
  }]));
  const result = await discoverGoogleAdsAdvertisers('test-access', ['customers/1']);
  const connection = {
    externalAccountId: '1',
    metadata: {},
    lastSyncStatus: 'success'
  };
  applyGoogleAdsAdvertisers(connection, result, ['customers/1']);
  assert.equal(connection.externalAccountId, null);
  assert.equal(connection.metadata.needsSelection, true);
  assert.equal(connection.lastSyncStatus, 'never');
});
test('failed hierarchy queries retain actionable provider errors and do not mark discovery complete', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 403,
    headers: new Headers(),
    json: async () => [{
      error: {
        details: [{
          errors: [{
            errorCode: {
              authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION'
            }
          }]
        }]
      }
    }]
  }));
  await assert.rejects(discoverGoogleAdsAdvertisers('test-access', ['customers/1']), /Apply for Explorer or higher access/);
});
test('partial discovery surfaces root warnings while preserving valid advertisers', async t => {
  t.mock.method(globalThis, 'fetch', async url => url.includes('/1/') ? {
    ok: false,
    status: 403,
    json: async () => ({
      error: {
        status: 'PERMISSION_DENIED'
      }
    })
  } : response([{
    customer: advertiser('2')
  }]));
  const result = await discoverGoogleAdsAdvertisers('test-access', ['customers/1', 'customers/2']);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Account 1/);
});
test('selected advertiser stores its verified root and does not inherit a global manager', () => {
  const account = {
      id: '2',
      name: 'Client',
      resourceName: 'customers/2',
      loginCustomerId: '1',
      manager: false,
      status: 'ENABLED'
    },
    c = {
      externalAccountId: '1',
      metadata: {},
      lastSyncStatus: 'success'
    };
  applyGoogleAdsAdvertisers(c, {
    accounts: [account],
    warnings: []
  }, ['customers/1']);
  assert.equal(c.externalAccountId, '2');
  assert.equal(c.metadata.loginCustomerId, '1');
  assert.equal(c.metadata.needsSelection, false);
  assert.equal(googleAdsLoginCustomerId(c, '999'), '1');
});
const layer = path => router.stack.find(item => item.route?.path === path).route.stack;
const res = () => ({
  code: 200,
  status(code) {
    this.code = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});
test('selection only accepts a server-discovered enabled advertiser within the active workspace', async t => {
  assert.equal(layer('/google_ads/select-account')[0].handle, integrationWorkspace);
  const account = {
      id: '2',
      name: 'Client',
      resourceName: 'customers/2',
      loginCustomerId: '1',
      manager: false,
      status: 'ENABLED'
    },
    connection = {
      metadata: {
        advertiserAccounts: [account]
      },
      async save() {
        this.saved = true;
      }
    };
  t.mock.method(IntegrationConnection, 'findOne', filter => {
    assert.equal(filter.orgId, 'workspace-a');
    return {
      select: async () => connection
    };
  });
  t.mock.method(IntegrationConnection, 'find', () => ({
    lean: async () => []
  }));
  t.mock.method(Organization, 'findById', () => ({
    lean: async () => ({})
  }));
  t.mock.method(Organization, 'findByIdAndUpdate', async () => ({}));
  const handler = layer('/google_ads/select-account').at(-1).handle;
  for (const customerId of ['1', 'foreign-account', '3']) {
    const r = res();
    await handler({
      headers: {
        'x-org-id': 'workspace-a'
      },
      body: {
        customerId
      }
    }, r);
    assert.equal(r.code, 400);
    assert.notEqual(connection.saved, true);
  }
  const r = res();
  await handler({
    headers: {
      'x-org-id': 'workspace-a'
    },
    body: {
      customerId: '2',
      loginCustomerId: '999'
    }
  }, r);
  assert.equal(r.code, 200);
  assert.equal(connection.externalAccountId, '2');
  assert.equal(connection.metadata.loginCustomerId, '1');
  assert.equal(connection.saved, true);
});
test('existing grants refresh the advertiser inventory without requiring a reconnect', async t => {
  const old = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'test-developer';
  t.after(() => {
    if (old === undefined) delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;else process.env.GOOGLE_ADS_DEVELOPER_TOKEN = old;
  });
  assert.equal(layer('/google_ads/refresh-accounts')[0].handle, integrationWorkspace);
  const connection = {
    externalAccountId: '1',
    accessToken: 'test-access',
    metadata: {},
    async save() {
      this.saved = true;
    }
  };
  t.mock.method(IntegrationConnection, 'findOne', filter => {
    assert.equal(filter.orgId, 'workspace-a');
    return {
      select: async () => connection
    };
  });
  t.mock.method(IntegrationConnection, 'find', () => ({
    lean: async () => []
  }));
  t.mock.method(Organization, 'findById', () => ({
    lean: async () => ({})
  }));
  t.mock.method(globalThis, 'fetch', async (url, options) => url.endsWith('customers:listAccessibleCustomers') ? {
    ok: true,
    status: 200,
    json: async () => ({
      resourceNames: ['customers/1']
    })
  } : response(JSON.parse(options.body).query.includes('FROM customer_client') ? [managed('2')] : [{
    customer: {
      id: '1',
      manager: true,
      status: 'ENABLED'
    }
  }]));
  const r = res();
  await layer('/google_ads/refresh-accounts').at(-1).handle({
    headers: {
      'x-org-id': 'workspace-a'
    }
  }, r);
  assert.equal(r.code, 200);
  assert.equal(r.body.accounts[0].id, '2');
  assert.equal(connection.metadata.loginCustomerId, '1');
  assert.equal(connection.saved, true);
});
