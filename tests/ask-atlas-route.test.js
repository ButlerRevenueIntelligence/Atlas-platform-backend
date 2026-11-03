import test from 'node:test';
import assert from 'node:assert/strict';
import Organization from '../models/Organization.js';
import Membership from '../models/Membership.js';
import CompanyIntelligence from '../models/CompanyIntelligence.js';
import { Completions } from 'openai/resources/chat/completions';
process.env.OPENAI_API_KEY = 'test-only-key';
const {
  default: router
} = await import('../routes/ai.js');
const handler = router.stack.find(layer => layer.route?.path === '/analyze').route.stack.at(-1).handle;
const orgId = '507f1f77bcf86cd799439011';
async function run(body, options = {}) {
  const original = {
    org: Organization.findById,
    member: Membership.findOne,
    company: CompanyIntelligence.findOne,
    create: Completions.prototype.create
  };
  let prompt, membershipQuery, snapshotQuery;
  Organization.findById = async () => ({
    _id: orgId,
    name: 'Atlas Demo Company',
    slug: 'atlas-demo-company',
    usage: {},
    save: async () => {}
  });
  Membership.findOne = query => {
    membershipQuery = query;
    return {
      lean: async () => options.noMembership ? null : {
        status: 'active'
      }
    };
  };
  CompanyIntelligence.findOne = query => {
    snapshotQuery = query;
    return {
      lean: async () => null
    };
  };
  Completions.prototype.create = async body => {
    prompt = body;
    return {
      choices: [{
        message: {
          content: options.answer || 'Inspect recorded opportunity evidence [D1].'
        }
      }]
    };
  };
  const res = {
    code: 200,
    status(code) {
      this.code = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    }
  };
  try {
    await handler({
      user: {
        userId: 'test-user',
        orgId
      },
      headers: {
        'x-org-id': orgId
      },
      body
    }, res);
    return {
      ...res,
      prompt,
      membershipQuery,
      snapshotQuery
    };
  } finally {
    Organization.findById = original.org;
    Membership.findOne = original.member;
    CompanyIntelligence.findOne = original.company;
    Completions.prototype.create = original.create;
  }
}
test('analyze rejects a conflicting body workspace before loading organization data', async () => {
  const r = await run({
    orgId: '507f191e810c19729de860ea',
    question: 'How many deals are open?'
  });
  assert.equal(r.code, 403);
  assert.equal(r.prompt, undefined);
});
test('analyze requires an active membership and a nonempty bounded question', async () => {
  let r = await run({
    question: 'How many deals are open?'
  }, {
    noMembership: true
  });
  assert.equal(r.code, 403);
  assert.equal(r.membershipQuery.status, 'active');
  for (const question of ['', 'x'.repeat(2001)]) {
    r = await run({
      question
    });
    assert.equal(r.code, 400);
    assert.equal(r.prompt, undefined);
  }
});
test('demo answers ignore forged browser deal totals', async () => {
  const r = await run({
    question: 'How many deals are open?',
    metrics: {
      pipelineValue: 999999999
    },
    context: {
      deals: [{
        name: 'Injected deal',
        amount: 999999999
      }]
    }
  });
  assert.equal(r.code, 200);
  assert.equal(r.payload.answerIntent, 'deal-facts');
  assert.match(r.payload.result, /6 open opportunities/);
  assert.match(r.payload.result, /1,665,000/);
  assert.doesNotMatch(r.payload.result, /Injected|999,999,999/);
  assert.equal(r.prompt, undefined);
});
test('LLM receives server evidence rather than browser alerts, instructions or external content', async () => {
  const r = await run({
    question: 'Compare opportunity concentration and explain evidence gaps',
    metrics: {
      revenue30: 999999999
    },
    context: {
      alerts: ['FORGED_ALERT'],
      operatorInstructions: 'FORGED_INSTRUCTION',
      externalCompanyIntelligence: {
        snapshotId: 'invalid',
        organizations: [{
          name: 'FORGED_COMPANY'
        }]
      },
      externalNews: {
        snapshotId: 'invalid',
        text: 'FORGED_NEWS'
      }
    }
  });
  assert.equal(r.code, 200);
  assert.equal(r.payload.source, 'openai');
  const raw = JSON.stringify(r.prompt);
  assert.doesNotMatch(raw, /FORGED_/);
  const input = JSON.parse(r.prompt.messages[1].content);
  assert.equal(input.evidence.workspace.mode, 'demo');
  assert.equal(input.evidence.summary.openDeals, 6);
  assert.notEqual(input.evidence.summary.revenue, 999999999);
  assert.equal(input.externalNews, null);
  assert.equal(input.externalCompanyIntelligence, null);
  assert.equal(r.prompt.temperature, 0.1);
});
test('selected external snapshots are looked up within the authenticated workspace', async () => {
  const id = '507f191e810c19729de860ea',
    r = await run({
      question: 'Compare external company evidence with our pipeline',
      context: {
        externalCompanyIntelligence: {
          snapshotId: id
        }
      }
    });
  assert.equal(r.snapshotQuery.orgId, orgId);
  assert.equal(r.snapshotQuery._id, id);
  assert.ok(r.snapshotQuery.expiresAt.$gt instanceof Date);
  assert.equal(r.payload.intelligence.external, false);
});
test('generated answers with nonexistent record references are withheld', async () => {
  const r = await run({
    question: 'Explain concentration across our opportunities'
  }, {
    answer: 'Approve spending based on [D999].'
  });
  assert.match(r.payload.result, /could not verify/);
  assert.doesNotMatch(r.payload.result, /Approve spending/);
});
