import test from 'node:test';
import assert from 'node:assert/strict';
import { searchArguments, searchToolStatus } from '../services/graphiqMcp.js';
import { retrieveGraphIQResearch } from '../services/retrieveGraphIQResearch.js';
import GraphIQResearch from '../models/GraphIQResearch.js';
import CompanyIntelligence from '../models/CompanyIntelligence.js';
const nullable = {
  anyOf: [{
    type: 'string'
  }, {
    type: 'array',
    items: {
      type: 'string'
    }
  }, {
    type: 'null'
  }]
};
// Structural fixtures from the deployed schemas supplied by the workspace owner.
function tool(name) {
  const criteriaProperties = name === 'search_news' ? {
    organization_id: nullable,
    person_id: nullable,
    text: nullable,
    summary: nullable,
    tags: nullable,
    from_date: {
      anyOf: [{
        type: 'string'
      }, {
        type: 'null'
      }]
    }
  } : {
    id: nullable,
    name: nullable,
    all_names: nullable,
    capabilities: {
      anyOf: [...nullable.anyOf, {
        type: 'object',
        properties: {
          any: {
            type: 'array',
            items: {
              type: 'string'
            }
          }
        }
      }]
    },
    min_employees: {
      anyOf: [{
        type: 'integer'
      }, {
        type: 'null'
      }]
    }
  };
  const properties = {
    criteria: {
      type: 'object',
      additionalProperties: false,
      properties: criteriaProperties
    },
    limit: {
      type: 'integer'
    },
    offset: {
      type: 'integer'
    },
    sort_by: {
      type: 'string',
      enum: name === 'search_news' ? ['date', 'relevance', 'sentiment'] : ['relevance', 'importance', 'revenue', 'employees', 'founded']
    }
  };
  if (name === 'search_news') properties.cluster = {
    type: 'string',
    enum: ['dedupe', 'best', 'all']
  };else properties.fields = {
    anyOf: [{
      type: 'string'
    }, {
      type: 'array',
      items: {
        type: 'string'
      }
    }]
  };
  return {
    name,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['criteria'],
      properties
    }
  };
}
test('deployed criteria adapters bind only declared name/text and bounded options', () => {
  assert.deepEqual(searchArguments(tool('search_organizations'), 'Acme'), {
    criteria: {
      name: 'Acme'
    },
    limit: 20,
    offset: 0,
    sort_by: 'relevance'
  });
  assert.deepEqual(searchArguments(tool('search_news'), 'Acme expansion'), {
    criteria: {
      text: 'Acme expansion'
    },
    limit: 20,
    offset: 0,
    sort_by: 'date',
    cluster: 'dedupe'
  });
  assert.equal(searchToolStatus(tool('search_news')).available, true);
  assert.equal(searchToolStatus(tool('search_organizations')).available, true);
});
test('optional unsupported criteria are not invented and simple declared text fields remain compatible', () => {
  const candidate = tool('search_news');
  candidate.inputSchema.properties.criteria.properties.text = {
    type: 'string'
  };
  delete candidate.inputSchema.properties.limit;
  delete candidate.inputSchema.properties.offset;
  delete candidate.inputSchema.properties.sort_by;
  delete candidate.inputSchema.properties.cluster;
  assert.deepEqual(searchArguments(candidate, 'topic'), {
    criteria: {
      text: 'topic'
    }
  });
});
test('criteria cannot bypass unknown required fields, constraints, references or mutation guards', () => {
  const changes = [t => t.inputSchema.required.push('tenant'), t => t.inputSchema.properties.criteria.required = ['organization_id'], t => delete t.inputSchema.properties.criteria.properties.text, t => t.inputSchema.properties.criteria.properties.text = {
    type: 'array',
    items: {
      type: 'string'
    }
  }, t => t.inputSchema.properties.criteria.properties.text = {
    anyOf: [{
      type: 'string',
      pattern: 'x'
    }]
  }, t => t.inputSchema.properties.criteria.properties.text = {
    type: 'string',
    maxLength: 2
  }, t => t.inputSchema.properties.criteria.$ref = '#/evil', t => t.inputSchema.properties.criteria.anyOf = [], t => t.inputSchema.properties.criteria.properties.text = {
    anyOf: [{
      type: 'string',
      enum: ['other']
    }]
  }, t => t.inputSchema.properties.limit.maximum = 10, t => t.inputSchema.properties.offset.minimum = 1, t => t.annotations = {
    readOnlyHint: false
  }];
  for (const change of changes) {
    const t = structuredClone(tool('search_news'));
    change(t);
    assert.equal(searchToolStatus(t).available, false);
  }
});
const rpc = (id, result) => new Response(JSON.stringify({
  jsonrpc: '2.0',
  id,
  result
}), {
  headers: {
    'content-type': 'application/json'
  }
});
for (const kind of ['companies', 'news']) test(`shared ${kind} retrieval dispatches deployed criteria and persists workspace-owned results`, async t => {
  const prior = process.env.GRAPHIQ_API_KEY;
  process.env.GRAPHIQ_API_KEY = 'test-key';
  t.after(() => {
    if (prior === undefined) delete process.env.GRAPHIQ_API_KEY;else process.env.GRAPHIQ_API_KEY = prior;
  });
  const orgId = '507f1f77bcf86cd799439011';
  let dispatched = false;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === 'initialize') return rpc(body.id, {
      protocolVersion: '2025-03-26',
      capabilities: {
        tools: {}
      }
    });
    if (body.method === 'notifications/initialized') return new Response(null, {
      status: 202
    });
    if (body.method === 'tools/list') return rpc(body.id, {
      tools: [tool('search_news'), tool('search_organizations')]
    });
    assert.equal(body.method, 'tools/call');
    dispatched = true;
    assert.equal(body.params.name, kind === 'news' ? 'search_news' : 'search_organizations');
    assert.deepEqual(body.params.arguments, searchArguments(tool(body.params.name), 'Acme'));
    return rpc(body.id, {
      structuredContent: kind === 'news' ? {
        articles: [{
          title: 'Acme expands',
          url: 'https://example.com/news'
        }]
      } : {
        organizations: [{
          id: 'provider-id',
          name: 'Acme',
          website_url: 'https://acme.example'
        }]
      }
    });
  });
  t.mock.method(GraphIQResearch, 'create', async value => {
    assert.equal(value.orgId, orgId);
    assert.equal(value.kind, kind);
    assert.equal(value.records.length, 1);
    return {
      ...value,
      _id: 'research'
    };
  });
  t.mock.method(CompanyIntelligence, 'create', async value => {
    assert.equal(kind, 'companies');
    assert.equal(value.orgId, orgId);
    assert.equal(value.data.organizations[0].name, 'Acme');
    return {
      _id: 'shared-profile'
    };
  });
  const result = await retrieveGraphIQResearch({
    orgId,
    kind,
    query: 'Acme'
  });
  assert.ok(dispatched);
  assert.equal(result.records.length, 1);
  assert.equal(result.companySnapshotId, kind === 'companies' ? 'shared-profile' : null);
});
