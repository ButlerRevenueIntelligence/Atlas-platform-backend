import test from 'node:test';
import assert from 'node:assert/strict';
import { linkedInPageUrl, linkedInRequest } from '../services/linkedinApi.js';
import { fetchLinkedInPages } from '../services/integrationImportMaintenance.js';
import { runRegisteredSync } from '../services/providerSyncRegistry.js';
import IntegrationConnection from '../models/IntegrationConnection.js';
import Organization from '../models/Organization.js';
import SourceMetricDaily from '../models/SourceMetricDaily.js';
import '../routes/integrations.js';

const search = 'https://api.linkedin.com/rest/adAccounts?q=search&search=(status:(values:List(ACTIVE)))';
const response = (data, status = 200) => ({ok: status < 400, status, json: async () => data});

test('LinkedIn keeps literal Rest.li grouping syntax and encodes only the opaque page token', () => {
  const cursor = 'opaque&(x):+%=';
  const url = linkedInPageUrl(search, cursor);
  assert.ok(url.includes('search=(status:(values:List(ACTIVE)))&pageSize=100'));
  assert.ok(!url.includes('search=%28'));
  assert.equal(new URL(url).searchParams.get('pageToken'), cursor);
  assert.ok(url.includes('pageToken=opaque%26%28x%29%3A%2B%25%3D'));
  assert.ok(!linkedInPageUrl(`${search}&pageSize=5&pageToken=old`).includes('old'));
});
test('LinkedIn preserves already encoded scalar URNs across every discovery page', async () => {
  let calls = 0;
  await fetchLinkedInPages(async url => {
    calls++;
    assert.ok(url.includes('search=(reference:(values:List(urn%3Ali%3Aorganization%3A123)))'));
    assert.ok(!url.includes('%253A'));
    return {elements: [], ...(calls === 1 ? {metadata: {nextPageToken: 'next'}} : {})};
  }, 'https://api.linkedin.com/rest/adAccounts?q=search&search=(reference:(values:List(urn%3Ali%3Aorganization%3A123)))');
  assert.equal(calls, 2);
});
test('LinkedIn reports the failing stage and parameter without exposing raw provider input values', async t => {
  t.mock.method(globalThis, 'fetch', async () => response({message: 'private echoed input', errorDetails: {inputErrors: [{code: 'PARAM_INVALID', input: {inputPath: {fieldPath: 'search.status'}, value: 'secret-token'}}]}}, 400));
  await assert.rejects(linkedInRequest(search, {}), error => {
    assert.equal(error.status, 400);
    assert.match(error.message, /account discovery.*search.status: PARAM_INVALID/);
    assert.doesNotMatch(error.message, /private|secret-token/);
    return true;
  });
});
test('LinkedIn discovery through the registered sync rejects form-encoded structures and imports performance', async t => {
  const connection = {accessToken: 'test', externalAccountId: '123', status: 'connected', metadata: {}, async save() {}};
  t.mock.method(IntegrationConnection, 'findOne', () => ({select: async () => connection}));
  t.mock.method(Organization, 'findByIdAndUpdate', async () => ({}));
  const writes = [];
  t.mock.method(SourceMetricDaily, 'bulkWrite', async rows => writes.push(...rows));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    assert.equal(options.headers['X-Restli-Protocol-Version'], '2.0.0');
    if (url.includes('adAccounts?q=')) {
      assert.ok(url.includes('search=(status:(values:List(ACTIVE)))'));
      return response({elements: [{id: 123, name: 'Correct advertiser'}]});
    }
    if (url.includes('/adCampaigns?')) return response({elements: []});
    if (url.includes('/adAnalytics?')) return response({elements: []});
    return response({currency: 'USD'});
  });
  assert.equal((await runRegisteredSync('linkedin_ads', 'workspace-a')).ok, true);
  assert.equal(calls.length, 4);
  assert.equal(writes.length, 30);
  assert.equal(connection.lastSyncStatus, 'success');
});
test('LinkedIn discovery failures persist the actionable error without disconnecting authorization or writing zeros', async t => {
  const connection = {accessToken: 'test', status: 'connected', metadata: {}, async save() {}};
  t.mock.method(IntegrationConnection, 'findOne', () => ({select: async () => connection}));
  let writes = 0;
  t.mock.method(SourceMetricDaily, 'bulkWrite', async () => writes++);
  t.mock.method(globalThis, 'fetch', async () => response({errorDetails: {inputErrors: [{code: 'PARAM_INVALID', input: {inputPath: {fieldPath: 'search'}}}]}}, 400));
  t.mock.method(console, 'error', () => {});
  await assert.rejects(runRegisteredSync('linkedin_ads', 'workspace-a'), /account discovery.*search: PARAM_INVALID/);
  assert.match(connection.lastError, /search: PARAM_INVALID/);
  assert.equal(connection.status, 'connected');
  assert.equal(connection.lastSyncStatus, 'failed');
  assert.equal(writes, 0);
});
