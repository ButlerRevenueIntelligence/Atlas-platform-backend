import test from 'node:test';
import assert from 'node:assert/strict';
import { accountIdentity, buildAccountCatalog, canManagePlan, validatePlanInput } from '../services/accountActionPlans.js';
import { buildDemoWorkspaceDeals } from '../services/demoWorkspace.js';
const clients = [{
  _id: 'client-1',
  name: 'Same company',
  externalSource: 'salesforce',
  externalId: 'A/1',
  primaryContactName: 'Buyer'
}, {
  _id: 'client-2',
  name: 'Same company'
}];
const accounts = [{
  _id: 'legacy',
  name: 'Former company name',
  externalSource: 'salesforce',
  externalId: 'A/1'
}, {
  _id: 'other',
  name: 'Same company',
  externalSource: 'hubspot',
  externalId: 'A/1'
}];
const deals = [{
  _id: 'first',
  clientId: 'legacy',
  name: 'Expansion',
  stage: 'Proposal',
  amount: 100,
  probability: .5
}, {
  _id: 'second',
  clientId: 'client-1',
  name: 'Rollout',
  stage: 'Negotiation',
  amount: 200,
  probability: .75
}, {
  _id: 'won',
  clientId: 'client-1',
  name: 'Previous win',
  stage: 'Closed Won',
  amount: 500,
  probability: 1
}, {
  _id: 'unlinked',
  clientName: 'Same company',
  name: 'No explicit link',
  stage: 'Proposal',
  amount: 99999
}];
test('exact provider identity unifies Client and legacy Account aliases without matching names/domains', () => {
  const c = buildAccountCatalog({
    clients,
    accounts,
    deals
  });
  assert.equal(c.accounts.length, 3);
  const key = accountIdentity(clients[0], 'client');
  assert.equal(c.resolve('client:client-1'), key);
  assert.equal(c.resolve('account:legacy'), key);
  assert.equal(c.dealKeys.get('first'), key);
  const account = c.accounts.find(a => a.key === key);
  assert.equal(account.name, 'Same company');
  assert.equal(account.pipeline, 300);
  assert.equal(account.weighted, 200);
  assert.equal(account.dealCount, 3);
  assert.equal(account.primaryContactName, 'Buyer');
  assert.equal(c.unlinkedDealCount, 1);
  assert.notEqual(c.resolve('client:client-2'), key);
  assert.notEqual(c.resolve('account:other'), key);
  assert.equal(c.dealKeys.has('unlinked'), false);
});
test('provider identities remain URL-safe and stable when names or document types change', () => {
  const a = {
    externalSource: 'Salesforce',
    externalId: 'id/with:%spaces and unicodeé'
  };
  const key = accountIdentity({
    ...a,
    _id: 'one',
    name: 'Old'
  }, 'client');
  assert.equal(key, accountIdentity({
    ...a,
    _id: 'two',
    name: 'New'
  }, 'account'));
  assert.match(key, /^provider:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
});
test('conflicting identical Mongo IDs do not attach an opportunity to an arbitrary account', () => {
  const c = buildAccountCatalog({
    clients: [{
      _id: 'collision',
      name: 'One'
    }],
    accounts: [{
      _id: 'collision',
      name: 'Two'
    }],
    deals: [{
      _id: 'deal',
      clientId: 'collision',
      amount: 100
    }]
  });
  assert.equal(c.dealKeys.has('deal'), false);
  assert.equal(c.unlinkedDealCount, 1);
});
test('archived accounts and archived deals do not inflate current plans', () => {
  const c = buildAccountCatalog({
    clients: [...clients, {
      _id: 'archived',
      name: 'Old',
      status: 'archived'
    }],
    accounts: [{
      _id: 'old',
      name: 'Old',
      archivedAt: new Date()
    }],
    deals: [...deals, {
      _id: 'archivedDeal',
      clientId: 'client-1',
      stage: 'Proposal',
      amount: 1000,
      archivedAt: new Date()
    }]
  });
  assert.equal(c.resolve('client:archived'), null);
  assert.equal(c.resolve('account:old'), null);
  assert.equal(c.accounts.find(a => a.name === 'Same company' && a.key.startsWith('provider:')).pipeline, 200);
});
test('demo catalog uses shared sample identities and never manufactures live CRM IDs', () => {
  const deals = buildDemoWorkspaceDeals({}, new Date('2026-10-15'));
  const c = buildAccountCatalog({
    demo: true,
    deals
  });
  assert.equal(c.accounts.length, 6);
  assert.equal(c.unlinkedDealCount, 0);
  assert.equal(c.dealKeys.get('demo-deal-1'), 'demo:demo-deal-1');
  assert.equal(c.accounts.find(a => a.key === 'demo:demo-deal-1').dealCount, 2);
  assert.equal(c.accounts.reduce((s, a) => s + a.pipeline, 0), 1665000);
  assert.equal(c.resolve('client:507f1f77bcf86cd799439011'), null);
});
test('plan edit rights belong to managers and the active non-viewer plan owner', () => {
  assert.equal(canManagePlan('owner', 'user', null), true);
  assert.equal(canManagePlan('manager', 'user', null), true);
  assert.equal(canManagePlan('member', 'user', {
    ownerId: 'user'
  }), true);
  assert.equal(canManagePlan('member', 'other', {
    ownerId: 'user'
  }), false);
  assert.equal(canManagePlan('viewer', 'user', {
    ownerId: 'user'
  }), false);
  assert.equal(canManagePlan('analyst', 'user', null), false);
  assert.equal(canManagePlan(undefined, undefined, undefined), false);
});
const members = [{
  id: 'user',
  name: 'Actual member',
  role: 'member'
}, {
  id: 'viewer',
  name: 'Reader',
  role: 'viewer'
}];
const body = () => ({
  objective: 'Confirm buying process',
  ownerId: 'user',
  reviewAt: '2026-10-30',
  stakeholders: [{
    name: 'Buyer',
    title: 'CFO',
    role: 'economic_buyer',
    engagement: 'unknown',
    notes: 'Role needs validation'
  }],
  blockers: [{
    text: 'Legal deadline unknown',
    ownerId: 'user',
    status: 'open'
  }]
});
test('input whitelisting derives real owner names and ignores caller history/identities', () => {
  const input = {
    ...body(),
    ownerName: 'Fictional owner',
    orgId: 'other',
    history: [{
      text: 'forged'
    }]
  };
  input.blockers[0].ownerName = 'Forged';
  input.stakeholders[0].sourcePayload = {
    token: 'secret'
  };
  const parsed = validatePlanInput(input, members);
  assert.equal(parsed.ownerName, 'Actual member');
  assert.equal(parsed.blockers[0].ownerName, 'Actual member');
  assert.equal(parsed.orgId, undefined);
  assert.equal(parsed.history, undefined);
  assert.equal(parsed.stakeholders[0].sourcePayload, undefined);
  assert.ok(parsed.reviewAt instanceof Date);
});
test('invalid owners, viewer owners, overlong arrays, and unsupported stakeholder assessments are rejected', () => {
  for (const change of [{
    ownerId: 'outside'
  }, {
    ownerId: 'viewer'
  }, {
    reviewAt: 'invalid'
  }, {
    objective: ''
  }, {
    stakeholders: Array(31).fill(body().stakeholders[0])
  }, {
    blockers: Array(51).fill(body().blockers[0])
  }, {
    stakeholders: [{
      ...body().stakeholders[0],
      engagement: 'AI verified intent'
    }]
  }, {
    blockers: [{
      ...body().blockers[0],
      ownerId: 'outside'
    }]
  }]) assert.throws(() => validatePlanInput({
    ...body(),
    ...change
  }, members));
});
