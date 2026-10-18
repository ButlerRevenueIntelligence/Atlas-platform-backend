import test from 'node:test';
import assert from 'node:assert/strict';
import router from '../routes/graphiqMcp.js';
import Membership from '../models/Membership.js';
import GraphIQResearch from '../models/GraphIQResearch.js';
import CompanyIntelligence from '../models/CompanyIntelligence.js';
import { loadNewsContext } from '../services/graphiqResearch.js';
const orgId = '507f1f77bcf86cd799439011',
  userId = '507f1f77bcf86cd799439012';
const request = () => ({
  orgId,
  user: {
    userId,
    permissions: ['market_signals.view']
  },
  query: {},
  body: {}
});
const response = () => ({
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
const q = value => ({
  sort() {
    return this;
  },
  lean: async () => value
});
async function invoke(path, method, req) {
  const res = response();
  await router.stack.find(l => l.route?.path === path && l.route.methods[method]).route.stack.at(-1).handle(req, res, e => {
    throw e;
  });
  return res;
}
const rpc = (id, result) => new Response(JSON.stringify({
  jsonrpc: '2.0',
  id,
  result
}), {
  headers: {
    'content-type': 'application/json'
  }
});
function network(t, {
  error = false,
  kind = 'news'
} = {}) {
  const old = process.env.GRAPHIQ_API_KEY;
  process.env.GRAPHIQ_API_KEY = 'test-key';
  t.after(() => {
    if (old === undefined) delete process.env.GRAPHIQ_API_KEY;else process.env.GRAPHIQ_API_KEY = old;
  });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    if (error) return new Response('sensitive provider diagnostic', {
      status: 403
    });
    const req = JSON.parse(options.body);
    if (req.method === 'initialize') return rpc(req.id, {
      protocolVersion: '2025-03-26',
      capabilities: {
        tools: {}
      }
    });
    if (req.method === 'notifications/initialized') return new Response(null, {
      status: 202
    });
    if (req.method === 'tools/list') return rpc(req.id, {
      tools: ['search_news', 'search_organizations'].map(name => ({
        name,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string'
            }
          },
          required: ['query']
        },
        annotations: {
          readOnlyHint: true
        }
      }))
    });
    if (req.method === 'tools/call') {
      assert.equal(req.params.name, kind === 'news' ? 'search_news' : 'search_organizations');
      assert.equal(req.params.arguments.query, 'Acme');
      return rpc(req.id, {
        structuredContent: kind === 'news' ? {
          articles: [{
            title: 'Acme launches',
            url: 'https://example.com/news'
          }]
        } : {
          organizations: [{
            name: 'Acme',
            website: 'https://acme.example'
          }]
        }
      });
    }
    assert.fail(req.method);
  });
  return () => calls;
}
test('MCP requires intelligence permissions and explicit active membership', async t => {
  const req = request();
  req.user.permissions = [];
  let res = response();
  await router.stack[0].handle(req, res, () => assert.fail());
  assert.equal(res.code, 403);
  req.user.permissions = ['market_signals.view'];
  t.mock.method(Membership, 'findOne', filter => {
    assert.deepEqual(filter, {
      orgId,
      userId,
      status: 'active'
    });
    return q(null);
  });
  res = response();
  await router.stack[0].handle(req, res, () => assert.fail());
  assert.equal(res.code, 403);
});
test('connection status never invokes the provider or exposes its key', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Status is a local check'));
  const res = await invoke('/status', 'get', request());
  assert.equal(res.body.automaticMonitoring, false);
  assert.equal(JSON.stringify(res.body).includes('X-API-Key'), false);
});
test('research history is workspace scoped and requires a fresh matching kind', async t => {
  t.mock.method(GraphIQResearch, 'findOne', filter => {
    assert.equal(filter.orgId, orgId);
    assert.equal(filter.kind, 'news');
    assert.ok(filter.expiresAt.$gt instanceof Date);
    return q(null);
  });
  const res = await invoke('/research', 'get', request());
  assert.equal(res.body.research, null);
});
test('invalid kinds and caller-controlled raw arguments are rejected before provider calls', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail());
  for (const body of [{
    kind: 'fetch_page',
    query: 'Acme'
  }, {
    kind: 'news',
    query: ''
  }, {
    kind: 'news',
    query: 'x'.repeat(501)
  }, {
    kind: 'news',
    arguments: {
      query: 'Acme'
    }
  }]) {
    const req = request();
    req.body = body;
    assert.equal((await invoke('/research', 'post', req)).code, 400);
  }
});
test('discovery reports actual available search tools without persisting or claiming automatic alerts', async t => {
  network(t);
  t.mock.method(GraphIQResearch, 'create', () => assert.fail());
  const res = await invoke('/check', 'post', request());
  assert.equal(res.code, 200);
  assert.equal(res.body.toolCount, 2);
  assert.equal(res.body.searches.length, 2);
  assert.ok(res.body.searches.every(s => s.available));
  assert.equal(res.body.automaticMonitoring, false);
});
test('news search stores normalized records in the authenticated workspace and ignores supplied org/source data', async t => {
  network(t);
  t.mock.method(GraphIQResearch, 'create', async value => {
    assert.equal(value.orgId, orgId);
    assert.equal(value.kind, 'news');
    assert.equal(value.tool, 'search_news');
    assert.equal(value.records[0].title, 'Acme launches');
    assert.equal(value.records[0].publishedAt, null);
    assert.ok(value.expiresAt > Date.now());
    assert.equal(value.text, '');
    return {
      ...value,
      _id: '507f1f77bcf86cd799439015',
      createdAt: new Date()
    };
  });
  t.mock.method(CompanyIntelligence, 'create', () => assert.fail('News is not a company-profile snapshot'));
  const req = request();
  req.body = {
    kind: 'news',
    query: 'Acme',
    orgId: 'foreign',
    records: [{
      title: 'fake'
    }],
    tool: 'fetch_page'
  };
  const res = await invoke('/research', 'post', req);
  assert.equal(res.body.research.source, 'GraphIQ MCP');
  assert.equal(res.body.companySnapshotId, null);
});
test('company research updates the shared profile contract for existing Atlas consumers', async t => {
  network(t, {
    kind: 'companies'
  });
  t.mock.method(GraphIQResearch, 'create', async value => ({
    ...value,
    _id: 'research',
    createdAt: new Date()
  }));
  t.mock.method(CompanyIntelligence, 'create', async value => {
    assert.equal(value.orgId, orgId);
    assert.equal(value.data.organizations[0].name, 'Acme');
    return {
      _id: 'shared-company'
    };
  });
  const req = request();
  req.body = {
    kind: 'companies',
    query: 'Acme'
  };
  const res = await invoke('/research', 'post', req);
  assert.equal(res.body.companySnapshotId, 'shared-company');
});
test('upstream access denial is safe, causes no writes and releases the workspace request lock', async t => {
  const calls = network(t, {
    error: true
  });
  t.mock.method(GraphIQResearch, 'create', () => assert.fail());
  for (let i = 0; i < 2; i++) {
    const req = request();
    req.body = {
      kind: 'news',
      query: 'Acme'
    };
    const res = await invoke('/research', 'post', req);
    assert.equal(res.code, 503);
    assert.equal(res.body.code, 'access_denied');
    assert.equal(JSON.stringify(res.body).includes('sensitive'), false);
  }
  assert.equal(calls(), 2);
});
test('AI news context reloads only a valid unexpired workspace-owned news snapshot', async t => {
  let calls = 0;
  t.mock.method(GraphIQResearch, 'findOne', filter => {
    calls++;
    assert.equal(filter.orgId, orgId);
    assert.equal(filter.kind, 'news');
    assert.ok(filter.expiresAt.$gt instanceof Date);
    return q(null);
  });
  assert.equal(await loadNewsContext(orgId, {
    snapshotId: 'forged'
  }), null);
  assert.equal(calls, 0);
  assert.equal(await loadNewsContext(orgId, '507f1f77bcf86cd799439099'), null);
  assert.equal(calls, 1);
});

test('Market Signals MCP results include Slack delivery status without making delivery a search requirement',async t=>{
 network(t);
 const {default:IntegrationConnection}=await import('../models/IntegrationConnection.js');
 t.mock.method(IntegrationConnection,'findOne',filter=>{assert.equal(filter.orgId,orgId);assert.equal(filter.provider,'slack');assert.equal(filter.status,'connected');return {select:async()=>null};});
 t.mock.method(GraphIQResearch,'create',async value=>({...value,_id:'research',createdAt:new Date()}));
 const req=request();req.body={kind:'news',query:'Acme',sourcePage:'market-signals'};
 const res=await invoke('/research','post',req);assert.equal(res.code,200);assert.equal(res.body.research.records[0].title,'Acme launches');assert.equal(res.body.slackNotification.reason,'slack_not_connected');
});
test('only active workspace managers may change GraphIQ Slack settings',async t=>{
 const {default:IntegrationConnection}=await import('../models/IntegrationConnection.js');
 t.mock.method(IntegrationConnection,'updateOne',async(filter,update)=>{assert.deepEqual(filter,{orgId,provider:'slack'});assert.deepEqual(update,{$set:{'settings.graphiqAlertsEnabled':false}});return {matchedCount:1};});
 t.mock.method(IntegrationConnection,'findOne',()=>({select(){return this;},lean:async()=>({status:'connected',mode:'live',settings:{graphiqAlertsEnabled:false},metadata:{incomingWebhookChannel:'#leadership'}})}));
 const req=request();req.graphiqMember={role:'viewer'};req.body={enabled:false};assert.equal((await invoke('/notifications','put',req)).code,403);
 req.graphiqMember={role:'manager'};req.body={enabled:'false'};assert.equal((await invoke('/notifications','put',req)).code,400);
 req.body={enabled:false};const res=await invoke('/notifications','put',req);assert.equal(res.body.enabled,false);assert.equal(res.body.channel,'#leadership');assert.equal(res.body.canManage,true);
});
test('legacy Account Intelligence company search reports its workspace Slack notification result',async t=>{
 const {default:legacy}=await import('../routes/graphiq.js'),{default:IntegrationConnection}=await import('../models/IntegrationConnection.js');
 const previous=process.env.GRAPHIQ_API_KEY;process.env.GRAPHIQ_API_KEY='test-key';t.after(()=>{if(previous===undefined)delete process.env.GRAPHIQ_API_KEY;else process.env.GRAPHIQ_API_KEY=previous;});
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({entities:[{name:'Acme',website:'https://acme.example',description:'Manufacturer'}]}),{headers:{'content-type':'application/json'}}));
 t.mock.method(CompanyIntelligence,'create',async value=>{assert.equal(value.orgId,orgId);return {_id:'snapshot'};});
 t.mock.method(IntegrationConnection,'findOne',filter=>{assert.equal(filter.orgId,orgId);return {select:async()=>null};});
 const req=request();req.body={organization:{capabilities:['machining']},sourcePage:'account-intelligence'};const res=response();await legacy.stack.find(l=>l.route?.path==='/organizations/search').route.stack[0].handle(req,res);
 assert.equal(res.body.ok,true);assert.equal(res.body.slackNotification.reason,'slack_not_connected');
});
