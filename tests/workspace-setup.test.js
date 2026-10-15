import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSetup, connectionReadiness, buildSetupReadiness, buildFirstBriefing, setupReviewSnapshot } from '../services/workspaceSetup.js';
import { buildAccountCatalog } from '../services/accountActionPlans.js';
const now = new Date('2026-10-15T12:00:00Z');
const opportunity = {
  _id: 'deal1',
  name: 'Expansion',
  amount: 1000,
  probability: 0,
  stage: 'Proposal',
  closeDate: '2026-10-30',
  ownerName: 'Actual owner',
  lastActivityAt: '2026-10-14',
  nextAction: 'Confirm buyer',
  clientId: 'client1'
};
const makeCtx = (deals = [opportunity], workspace = {}) => ({
  demo: false,
  now,
  warnings: [],
  workspace: {
    deals,
    ...workspace
  },
  catalog: buildAccountCatalog({
    deals,
    clients: [{
      _id: 'client1',
      name: 'Company'
    }]
  })
});
const facts = (ctx = makeCtx(), extra = {}) => buildSetupReadiness({
  ctx,
  permissions: ['*'],
  selectedPriorities: ['pipeline', 'accounts'],
  now,
  ...extra
});
const synced = {
  provider: 'salesforce',
  mode: 'live',
  status: 'connected',
  lastSyncStatus: 'success',
  lastSyncAt: '2026-10-15T11:00:00Z'
};
test('shared preferences accept only one to three known priorities and known distinct systems', () => {
  assert.deepEqual(validateSetup({
    version: null,
    priorities: ['pipeline'],
    expectedSystems: []
  }), {
    priorities: ['pipeline'],
    expectedSystems: []
  });
  for (const change of [{
    version: -1
  }, {
    version: '1'
  }, {
    priorities: []
  }, {
    priorities: ['pipeline', 'pipeline']
  }, {
    priorities: ['pipeline', 'forecast', 'accounts', 'cash']
  }, {
    priorities: ['unverified_intent']
  }, {
    expectedSystems: ['unknown']
  }, {
    expectedSystems: ['slack', 'slack']
  }]) assert.throws(() => validateSetup({
    version: 0,
    priorities: ['pipeline'],
    expectedSystems: [],
    ...change
  }));
});
test('connected status alone is not a successful sync and stale/failing/disconnected timestamps never turn green', () => {
  assert.equal(connectionReadiness({
    ...synced,
    lastSyncStatus: 'never'
  }, now).state, 'awaiting_sync');
  assert.equal(connectionReadiness({
    ...synced,
    lastSyncStatus: 'failed'
  }, now).state, 'needs_attention');
  assert.equal(connectionReadiness({
    ...synced,
    status: 'error'
  }, now).state, 'needs_attention');
  assert.equal(connectionReadiness({
    ...synced,
    status: 'disconnected'
  }, now).state, 'not_connected');
  assert.equal(connectionReadiness({
    ...synced,
    lastSyncAt: '2026-10-12'
  }, now).state, 'stale');
  assert.equal(connectionReadiness({
    ...synced,
    lastSyncAt: '2026-10-17'
  }, now).state, 'needs_attention');
  assert.equal(connectionReadiness({
    ...synced,
    lastSyncAt: 'bad'
  }, now).state, 'awaiting_sync');
  assert.equal(connectionReadiness(synced, now).state, 'synced');
});
test('selection-required, running, sample and Slack connections have distinct meanings', () => {
  assert.equal(connectionReadiness({
    ...synced,
    metadata: {
      needsSelection: true
    }
  }, now).state, 'needs_selection');
  assert.equal(connectionReadiness({
    ...synced,
    lastSyncStatus: 'running'
  }, now).state, 'syncing');
  assert.equal(connectionReadiness({
    ...synced,
    mode: 'demo'
  }, now).state, 'sample_connection');
  const slack = connectionReadiness({
    ...synced,
    provider: 'slack'
  }, now);
  assert.equal(slack.state, 'connected');
  assert.ok(slack.label.includes('not a data source'));
});
test('real zero probability and zero amount remain known values; missing/invalid fields are not covered', () => {
  const ready = facts(makeCtx([{
    ...opportunity,
    amount: 0,
    probability: 0
  }]));
  assert.equal(ready.cards[0].state, 'available');
  const partial = facts(makeCtx([{
    ...opportunity,
    amount: null,
    probability: '',
    ownerName: '',
    closeDate: null
  }]));
  assert.equal(partial.cards[0].state, 'partial');
  assert.deepEqual(partial.cards[0].counts, {
    open: 1,
    closeDate: 1,
    owner: 1,
    probability: 1,
    amount: 1,
    overdue: 0
  });
  assert.equal(facts(makeCtx([{
    ...opportunity,
    probability: 101
  }])).cards[0].counts.probability, 1);
});
test('explicit account links count; names alone and archived opportunities never fill coverage', () => {
  const readiness = facts(makeCtx([{
    ...opportunity,
    clientId: null,
    clientName: 'Company'
  }, {
    ...opportunity,
    _id: 'archived',
    archivedAt: now
  }]));
  const card = readiness.cards.find(c => c.id === 'accounts');
  assert.equal(card.state, 'partial');
  assert.deepEqual(card.counts, {
    linked: 0,
    total: 1
  });
});
test('empty live workspaces and a connected CRM never manufacture opportunities or briefing value', () => {
  const ctx = makeCtx([]);
  const readiness = facts(ctx, {
    connections: [synced],
    expectedSystems: ['salesforce']
  });
  assert.equal(readiness.cards[0].state, 'missing');
  assert.equal(readiness.pipelineAvailable, false);
  const briefing = buildFirstBriefing(ctx, readiness, now);
  assert.equal(briefing.kind, 'starter');
  assert.equal(briefing.summary.pipeline, 0);
  assert.deepEqual(briefing.priorities, []);
});
test('original zero-valued revenue days count while generated chart rows and future observation days do not', () => {
  const empty = facts(makeCtx([], {
    metrics: Array.from({
      length: 30
    }, () => ({
      date: '2026-10-14',
      revenue: 0
    }))
  }), {
    selectedPriorities: ['cash']
  });
  assert.equal(empty.cards.find(c => c.id === 'revenue').state, 'missing');
  const readiness = facts(makeCtx([], {
    revenueObservationDays: {
      stripe: ['2026-10-14', '2026-10-14', '2026-10-20', '2026-01-01'],
      metrics_daily: ['2026-10-15']
    }
  }), {
    selectedPriorities: ['cash']
  });
  const card = readiness.cards.find(c => c.id === 'revenue');
  assert.equal(card.state, 'available');
  assert.equal(card.observations.find(s => s.source === 'stripe').days, 1);
});
test('accounting readiness requires a usable USD snapshot; old snapshots remain partial', () => {
  const snapshot = {
    currency: 'USD',
    syncedAt: '2026-10-15T11:00:00Z'
  };
  const state = value => facts(makeCtx([], {
    financials: value
  }), {
    selectedPriorities: ['cash']
  }).cards.find(c => c.id === 'accounting').state;
  assert.equal(state(snapshot), 'available');
  assert.equal(state({
    ...snapshot,
    currency: 'EUR'
  }), 'missing');
  assert.equal(state({
    ...snapshot,
    syncedAt: '2026-10-12'
  }), 'partial');
  assert.equal(state({
    ...snapshot,
    syncedAt: '2026-10-20'
  }), 'missing');
});
test('sample deals in a live workspace do not satisfy live readiness and demo coverage stays explicitly sample', () => {
  assert.equal(facts(makeCtx([{
    ...opportunity,
    source: 'demo'
  }])).cards[0].state, 'missing');
  const ctx = {
    ...makeCtx(),
    demo: true
  };
  const readiness = facts(ctx);
  assert.equal(readiness.cards[0].state, 'sample');
  assert.equal(readiness.mode, 'demo');
  assert.ok(readiness.gaps.some(g => g.state === 'sample'));
  assert.equal(buildFirstBriefing(ctx, readiness, now).mode, 'demo');
});
test('account and dashboard permissions suppress protected coverage details and links', () => {
  const readiness = facts(makeCtx(), {
    permissions: ['command_center.view']
  });
  for (const id of ['accounts', 'revenue', 'accounting']) {
    const card = readiness.cards.find(c => c.id === id);
    assert.equal(card.state, 'restricted');
    assert.equal(card.href, null);
    assert.equal(card.counts, undefined);
    assert.equal(card.observations, undefined);
  }
  assert.equal(readiness.canOpenConnectors, false);
});
test('readiness DTOs omit credentials, external account identities, provider errors and raw payloads', () => {
  const readiness = facts(makeCtx(), {
    connections: [{
      ...synced,
      accessToken: 'secret-token',
      externalAccountId: 'private-account',
      lastError: 'secret-stack',
      metadata: {
        token: 'secret'
      }
    }],
    expectedSystems: ['salesforce']
  });
  const json = JSON.stringify(readiness);
  for (const text of ['secret-token', 'private-account', 'secret-stack', 'secret']) assert.ok(!json.includes(text));
  assert.equal(setupReviewSnapshot(readiness).expectedConnections[0].state, 'synced');
});
test('readiness acknowledgments remain stable across reads but change when relevant coverage changes', () => {
  const a = facts();
  const b = facts(makeCtx(), {
    now: new Date(now.getTime() + 1000)
  });
  assert.equal(a.reviewToken, b.reviewToken);
  const c = facts(makeCtx([{
    ...opportunity,
    ownerName: ''
  }]));
  assert.notEqual(a.reviewToken, c.reviewToken);
  const d = facts(makeCtx(), {
    selectedPriorities: ['cash']
  });
  assert.notEqual(a.reviewToken, d.reviewToken);
});
test('an existing relevant CRM sync failure remains a setup gap even when the expected-system checkbox was not selected', () => {
  const readiness = facts(makeCtx(), {
    connections: [{
      ...synced,
      status: 'error'
    }]
  });
  assert.ok(readiness.gaps.some(g => g.id === 'system:salesforce'));
});
test('cash-focused workspaces with accounting/revenue coverage receive a relevant briefing without needing CRM opportunities', () => {
  const ctx = makeCtx([], {
    revenueObservationDays: {
      stripe: ['2026-10-14']
    },
    financials: {
      currency: 'USD',
      syncedAt: '2026-10-15T11:00:00Z'
    }
  });
  const readiness = facts(ctx, {
    selectedPriorities: ['cash']
  });
  const brief = buildFirstBriefing(ctx, readiness, now);
  assert.equal(brief.kind, 'coverage');
  assert.deepEqual(brief.coverageHighlights.map(c => c.id), ['revenue', 'accounting']);
  assert.ok(!brief.message.includes('Connect and sync a CRM'));
});
