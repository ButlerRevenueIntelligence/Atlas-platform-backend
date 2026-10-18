import test from 'node:test';
import assert from 'node:assert/strict';
import IntegrationConnection from '../models/IntegrationConnection.js';
import Organization from '../models/Organization.js';
import Delivery from '../models/GraphIQSlackDelivery.js';
import { notifyGraphIQResearch, getGraphIQSlackStatus, graphIQAlertItems, buildGraphIQSlackPayload, validSlackWebhook } from '../services/slackGraphIQAlerts.js';
const org = '507f1f77bcf86cd799439011',
  hook = 'https://hooks.slack.com/services/TEST/CHANNEL/test-secret';
const record = {
  title: 'Acme opens a facility',
  summary: 'Reported development',
  url: 'https://news.example/article',
  publisher: 'Example News',
  publishedAt: '2026-10-17'
};
const input = extra => ({
  orgId: org,
  kind: 'news',
  query: 'Acme',
  records: [record],
  sourcePage: 'market-signals',
  now: new Date('2026-10-18T00:00:00Z'),
  ...extra
});
const q = v => ({
  select() {
    return this;
  },
  lean: async () => v,
  then(resolve, reject) {
    return Promise.resolve(v).then(resolve, reject);
  }
});
function fixture(t, {
  connected = true,
  enabled = true,
  response = 200,
  throws = false,
  body = 'ok',
  url = hook
} = {}) {
  const ledger = new Map(),
    posts = [],
    status = [];
  let connection = {
    _id: 'connection',
    status: 'connected',
    mode: 'live',
    webhookUrl: url,
    settings: {
      graphiqAlertsEnabled: enabled
    },
    metadata: {
      incomingWebhookChannel: '#revenue'
    }
  };
  t.mock.method(IntegrationConnection, 'findOne', filter => {
    assert.ok(filter.orgId);
    assert.equal(filter.provider, 'slack');
    return q(connected ? connection : null);
  });
  t.mock.method(Organization, 'findById', id => {
    assert.ok(id);
    return q({
      name: 'Customer workspace'
    });
  });
  t.mock.method(IntegrationConnection, 'updateOne', async (filter, update) => {
    assert.ok(filter.orgId);
    assert.equal(filter._id, 'connection');
    assert.deepEqual(Object.keys(update.$set), ['metadata.graphiqAlerts']);
    status.push(update.$set['metadata.graphiqAlerts']);
    return {
      matchedCount: 1
    };
  });
  const key = r => [r.orgId, r.destination, r.fingerprint].join('|');
  t.mock.method(Delivery, 'create', async value => {
    if (ledger.has(key(value))) throw Object.assign(Error('duplicate'), {
      code: 11000
    });
    ledger.set(key(value), {
      ...value
    });
    return value;
  });
  t.mock.method(Delivery, 'findOneAndUpdate', (filter, update) => {
    const row = ledger.get(key(filter));
    if (!row || row.state !== filter.state || row.retryAt > filter.retryAt.$lte) return q(null);
    Object.assign(row, update.$set);
    return q(row);
  });
  t.mock.method(Delivery, 'updateMany', async (filter, update) => {
    let n = 0;
    for (const row of ledger.values()) if (row.orgId === filter.orgId && row.destination === filter.destination && row.claim === filter.claim && (!filter.state || row.state === filter.state) && (!filter.fingerprint || filter.fingerprint.$in.includes(row.fingerprint))) {
      Object.assign(row, update.$set);
      n++;
    }
    return {
      matchedCount: n
    };
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    posts.push({
      url,
      options,
      payload: JSON.parse(options.body)
    });
    assert.equal(options.redirect, 'error');
    if (throws) throw Error('secret URL ' + hook);
    return new Response(body, {
      status: response,
      headers: response === 429 ? {
        'retry-after': '120'
      } : {}
    });
  });
  return {
    ledger,
    posts,
    status,
    setHook(value) {
      connection.webhookUrl = value;
    }
  };
}
test('new structured news posts to the workspace-selected channel and records Slack acceptance', async t => {
  const f = fixture(t);
  const res = await notifyGraphIQResearch(input());
  assert.equal(res.state, 'sent');
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].url, hook);
  assert.equal(f.ledger.values().next().value.state, 'sent');
  assert.equal(f.status[0].count, 1);
  assert.equal(JSON.stringify(f.posts[0].payload).includes(hook), false);
  assert.equal(JSON.stringify(res).includes('test-secret'), false);
});
test('identical articles across pages/queries and tracking URLs do not create duplicate notifications', async t => {
  const f = fixture(t);
  await notifyGraphIQResearch(input());
  const res = await notifyGraphIQResearch(input({
    query: 'Different search',
    sourcePage: 'account-intelligence',
    records: [{
      ...record,
      url: record.url + '?utm_source=campaign#section'
    }]
  }));
  assert.equal(res.reason, 'already_notified_or_in_progress');
  assert.equal(f.posts.length, 1);
});
test('new results in a repeated search notify only the new items', async t => {
  const f = fixture(t);
  await notifyGraphIQResearch(input());
  const result = await notifyGraphIQResearch(input({
    records: [record, {
      ...record,
      title: 'Second report',
      url: 'https://news.example/second'
    }]
  }));
  assert.equal(result.count, 1);
  assert.match(JSON.stringify(f.posts[1].payload), /Second report/);
  assert.equal(JSON.stringify(f.posts[1].payload).includes('Acme opens a facility'), false);
});
test('atomic delivery claims suppress concurrent duplicate sends', async t => {
  const f = fixture(t);
  const results = await Promise.all([notifyGraphIQResearch(input()), notifyGraphIQResearch(input())]);
  assert.equal(f.posts.length, 1);
  assert.equal(results.filter(r => r.state === 'sent').length, 1);
});
test('notification identities are isolated by workspace and Slack destination', async t => {
  const f = fixture(t);
  await notifyGraphIQResearch(input());
  await notifyGraphIQResearch(input({
    orgId: 'other-workspace'
  }));
  f.setHook('https://hooks.slack.com/services/TEST/OTHER/new-secret');
  await notifyGraphIQResearch(input());
  assert.equal(f.posts.length, 3);
  assert.equal(f.ledger.size, 3);
});
test('disconnected, disabled, empty/unstructured and non-target-view research never posts', async t => {
  fixture(t, {
    connected: false
  });
  assert.equal((await notifyGraphIQResearch(input())).reason, 'slack_not_connected');
  t.mock.restoreAll();
  fixture(t, {
    enabled: false
  });
  assert.equal((await notifyGraphIQResearch(input())).reason, 'disabled');
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', () => assert.fail());
  assert.equal((await notifyGraphIQResearch(input({
    records: []
  }))).reason, 'no_structured_results');
  assert.equal((await notifyGraphIQResearch(input({
    sourcePage: 'operator'
  }))).reason, 'not_a_notifying_view');
});
test('unsafe webhook hosts and redirects cannot receive provider data', async t => {
  const f = fixture(t, {
    url: 'https://attacker.example/webhook'
  });
  assert.equal((await notifyGraphIQResearch(input())).reason, 'invalid_slack_destination');
  assert.equal(f.posts.length, 0);
  for (const url of ['http://hooks.slack.com/services/A/B/C', 'https://hooks.slack.com.evil.example/services/A/B/C', 'https://user:pass@hooks.slack.com/services/A/B/C', 'https://hooks.slack.com/services/A/B/C?extra=1']) assert.equal(validSlackWebhook(url), false);
  assert.equal(validSlackWebhook(hook), true);
});
test('definite Slack rate-limit rejections retry only after the recorded delay', async t => {
  const f = fixture(t, {
    response: 429,
    body: 'rate_limited'
  });
  const first = await notifyGraphIQResearch(input());
  assert.equal(first.reason, 'slack_rate_limited');
  await notifyGraphIQResearch(input({
    now: new Date('2026-10-18T00:01:00Z')
  }));
  assert.equal(f.posts.length, 1);
  await notifyGraphIQResearch(input({
    now: new Date('2026-10-18T00:03:00Z')
  }));
  assert.equal(f.posts.length, 2);
});
test('timeouts, server errors and unexpected 200 bodies remain uncertain and are not auto resent', async t => {
  for (const options of [{
    throws: true
  }, {
    response: 500,
    body: 'server_error'
  }, {
    response: 200,
    body: 'unexpected'
  }]) {
    const f = fixture(t, options);
    const first = await notifyGraphIQResearch(input());
    assert.equal(first.state, 'uncertain');
    assert.equal((await notifyGraphIQResearch(input({
      now: new Date('2026-10-19')
    }))).reason, 'already_notified_or_in_progress');
    assert.equal(f.posts.length, 1);
    assert.equal(JSON.stringify(first).includes('test-secret'), false);
    t.mock.restoreAll();
  }
});
test('database claim failures do not fail the research request or send an untracked notification', async t => {
  const f = fixture(t);
  t.mock.method(Delivery, 'create', async () => {
    throw Error('database failed');
  });
  const result = await notifyGraphIQResearch(input());
  assert.equal(result.state, 'failed');
  assert.equal(f.posts.length, 0);
});
test('Slack status persistence failure after acceptance does not make a send retryable', async t => {
  const f = fixture(t);
  t.mock.method(Delivery, 'updateMany', async () => {
    throw Error('database unavailable');
  });
  assert.equal((await notifyGraphIQResearch(input())).state, 'uncertain');
  await notifyGraphIQResearch(input());
  assert.equal(f.posts.length, 1);
});
test('Slack payload bounds research, includes both Atlas views, and cannot inject mentions or formatting', () => {
  const items = graphIQAlertItems('news', Array.from({
    length: 25
  }, (_, i) => ({
    ...record,
    title: 'Item ' + i,
    url: 'https://news.example/' + i
  })));
  assert.equal(items.length, 20);
  const payload = buildGraphIQSlackPayload({
    workspace: '<!channel>',
    kind: 'news',
    query: '<!here> & request',
    items,
    sourcePage: 'account-intelligence',
    now: new Date()
  });
  assert.equal(payload.blocks.filter(b => b.accessory).length, 5);
  assert.match(payload.text, /&lt;!here&gt;/);
  assert.equal(payload.blocks[1].text.type, 'plain_text');
  const links = payload.blocks.at(-1).elements.map(e => e.url);
  assert.ok(links.includes('https://app.atlasrevenueai.com/account-intelligence'));
  assert.ok(links.includes('https://app.atlasrevenueai.com/market-signals'));
  assert.equal(payload.unfurl_links, false);
});
test('profile changes notify as research, never imply a buying event, and deterministic repeats deduplicate', () => {
  const a = graphIQAlertItems('companies', [{
    name: 'Acme',
    website: 'https://acme.example',
    description: 'Manufacturer'
  }]);
  const b = graphIQAlertItems('companies', [{
    name: 'Acme',
    website: 'https://acme.example',
    description: 'Updated company description'
  }]);
  assert.notEqual(a[0].fingerprint, b[0].fingerprint);
  const payload = buildGraphIQSlackPayload({
    kind: 'companies',
    query: 'manufacturers',
    items: a
  });
  assert.match(payload.blocks[0].text.text, /company research/);
  assert.match(JSON.stringify(payload), /do not establish buying intent/);
});
test('notification status returns channel/settings but never tokens or webhook URLs', async t => {
  fixture(t);
  const result = await getGraphIQSlackStatus(org);
  assert.equal(result.connected, true);
  assert.equal(result.channel, '#revenue');
  assert.equal(JSON.stringify(result).includes(hook), false);
});
