import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphIQMcpClient, withGraphIQMcp, searchArguments, searchToolStatus, GRAPHIQ_MCP_URL, readMcpResponse } from '../services/graphiqMcp.js';
import { normalizeResearch, researchDto } from '../services/graphiqResearch.js';
const key = 'test-private-key';
const tool = {
  name: 'search_news',
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
};
const response = (id, result, extra = {}) => new Response(JSON.stringify({
  jsonrpc: '2.0',
  id,
  result
}), {
  status: 200,
  headers: {
    'content-type': 'application/json',
    ...extra
  }
});
function transport({
  sse = false,
  deny,
  callError = false
} = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      assert.equal(url, GRAPHIQ_MCP_URL);
      assert.equal(options.redirect, options.method === 'DELETE' ? 'error' : 'manual');
      assert.equal(options.headers['X-API-Key'], key);
      calls.push(options);
      if (options.method === 'DELETE') return new Response(null, {
        status: 204
      });
      const body = JSON.parse(options.body);
      if (deny) return new Response('SENSITIVE upstream error ' + key, {
        status: deny
      });
      if (body.method === 'initialize') return response(body.id, {
        protocolVersion: '2025-03-26',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'GraphIQ'
        }
      }, {
        'mcp-session-id': 'session-a'
      });
      assert.equal(options.headers['Mcp-Session-Id'], 'session-a');
      assert.equal(options.headers['MCP-Protocol-Version'], '2025-03-26');
      if (body.method === 'notifications/initialized') return new Response(null, {
        status: 202
      });
      if (body.method === 'tools/list') return response(body.id, {
        tools: [tool]
      });
      if (body.method === 'tools/call') {
        if (callError) return response(body.id, {
          isError: true,
          content: [{
            type: 'text',
            text: key
          }]
        });
        const result = {
          content: [{
            type: 'text',
            text: '{"articles":[{"title":"Company announces launch","url":"https://example.com/news"}]}'
          }]
        };
        if (sse) return new Response(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result
        })}\n\n`, {
          headers: {
            'content-type': 'text/event-stream'
          }
        });
        return response(body.id, result);
      }
      assert.fail(body.method);
    }
  };
}
test('MCP handshake, protocol headers, discovery, call and session closure use the fixed endpoint', async () => {
  const mock = transport();
  const result = await withGraphIQMcp(async (client, tools) => {
    assert.equal(tools[0].name, 'search_news');
    return client.call('search_news', searchArguments(tools[0], 'Acme news'));
  }, {
    apiKey: key,
    fetchImpl: mock.fetchImpl
  });
  assert.ok(result.content.length);
  assert.deepEqual(mock.calls.filter(c => c.body).map(c => JSON.parse(c.body).method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.equal(mock.calls.at(-1).method, 'DELETE');
});
test('MCP supports SSE response frames and ignores unrelated notifications', async () => {
  const mock = transport({
    sse: true
  });
  const result = await withGraphIQMcp(client => client.call('search_news', {
    query: 'Acme'
  }), {
    apiKey: key,
    fetchImpl: mock.fetchImpl
  });
  assert.match(result.content[0].text, /launch/);
});
test('SSE reads handle split multibyte text, CRLF, multiline data and close an otherwise open stream', async () => {
  const encoder = new TextEncoder(),
    text = 'data: ' + JSON.stringify({
      jsonrpc: '2.0',
      id: 'x',
      result: {
        text: 'café'
      }
    }) + '\r\n\r\n';
  const bytes = encoder.encode(text);
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    },
    cancel() {
      cancelled = true;
    }
  });
  const result = await readMcpResponse(new Response(stream, {
    headers: {
      'content-type': 'text/event-stream'
    }
  }), 'x');
  assert.equal(result.text, 'café');
  assert.equal(cancelled, true);
});
test('401, 403 and 429 stop after one request without leaking provider bodies or retrying', async () => {
  for (const status of [401, 403, 429]) {
    const mock = transport({
      deny: status
    });
    await assert.rejects(withGraphIQMcp(() => assert.fail(), {
      apiKey: key,
      fetchImpl: mock.fetchImpl
    }), e => {
      assert.ok(!e.message.includes(key));
      assert.ok(!e.message.includes('SENSITIVE'));
      assert.equal(e.status, status === 429 ? 429 : 503);
      return true;
    });
    assert.equal(mock.calls.length, 1);
  }
});
test('credentials are required before any network operation', async () => {
  assert.throws(() => new GraphIQMcpClient({
    apiKey: '',
    fetchImpl: () => assert.fail()
  }), e => e.code === 'not_configured');
});
test('a network/timeout failure is sanitized', async () => {
  await assert.rejects(withGraphIQMcp(() => assert.fail(), {
    apiKey: key,
    fetchImpl: async () => {
      throw Error(key);
    }
  }), e => e.code === 'network_error' && !e.message.includes(key));
});
test('MCP tool errors are sanitized and sessions still close', async () => {
  const mock = transport({
    callError: true
  });
  await assert.rejects(withGraphIQMcp(client => client.call('search_news', {
    query: 'Acme'
  }), {
    apiKey: key,
    fetchImpl: mock.fetchImpl
  }), e => e.code === 'tool_error' && !e.message.includes(key));
  assert.equal(mock.calls.at(-1).method, 'DELETE');
});
test('unknown protocol versions and invalid session IDs fail before discovery/calls', async () => {
  for (const [version, session] of [['2024-11-05', 'valid'], ['2025-03-26', 'bad session']]) {
    const client = new GraphIQMcpClient({
      apiKey: key,
      fetchImpl: async (_url, o) => response(JSON.parse(o.body).id, {
        protocolVersion: version,
        capabilities: {
          tools: {}
        }
      }, {
        'mcp-session-id': session
      })
    });
    await assert.rejects(client.initialize());
  }
});
test('tool pagination is bounded and rejects duplicate names/stalled cursors', async () => {
  const client = new GraphIQMcpClient({
    apiKey: key
  });
  client.send = async () => ({
    tools: [tool],
    nextCursor: 'same'
  });
  await assert.rejects(client.tools(), e => e.code === 'invalid_tools');
});
test('plain schema text binding uses only declared fields', () => {
  assert.deepEqual(searchArguments(tool, 'Acme'), {
    query: 'Acme'
  });
  assert.deepEqual(searchArguments({
    ...tool,
    inputSchema: {
      type: 'object',
      properties: {
        q: {
          type: 'string'
        }
      },
      required: ['q']
    }
  }, 'Acme'), {
    q: 'Acme'
  });
});
test('organization capability binding requires an explicitly declared schema', () => {
  const organization = {
    name: 'search_organizations',
    inputSchema: {
      type: 'object',
      properties: {
        organization: {
          type: 'object',
          properties: {
            capabilities: {
              type: 'array',
              items: {
                type: 'string'
              }
            }
          },
          required: ['capabilities']
        }
      },
      required: ['organization']
    }
  };
  assert.deepEqual(searchArguments(organization, 'precision machining'), {
    organization: {
      capabilities: ['precision machining']
    }
  });
  assert.throws(() => searchArguments({
    ...organization,
    inputSchema: {
      type: 'object',
      properties: {
        organization: {
          type: 'object'
        }
      }
    }
  }, 'Acme'), e => e.code === 'unsupported_schema');
});
test('unknown required fields, mutation hints and non-allowlisted tools never dispatch', async () => {
  for (const candidate of [{
    ...tool,
    annotations: {
      readOnlyHint: false
    }
  }, {
    ...tool,
    name: 'delete_organization'
  }, {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      required: ['query', 'required_unknown']
    }
  }, {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      oneOf: []
    }
  }, null]) assert.equal(searchToolStatus(candidate).available, false);
  const client = new GraphIQMcpClient({
    apiKey: key,
    fetchImpl: () => assert.fail()
  });
  await assert.rejects(client.call('fetch_page', {
    url: 'http://127.0.0.1'
  }), e => e.code === 'unsupported_tool');
});
test('missing, malformed, mismatched and oversized MCP bodies fail clearly', async () => {
  for (const body of ['not json', JSON.stringify({
    jsonrpc: '2.0',
    id: 'other',
    result: {}
  })]) await assert.rejects(readMcpResponse(new Response(body, {
    headers: {
      'content-type': 'application/json'
    }
  }), 'expected'));
  await assert.rejects(readMcpResponse(new Response('x'.repeat(2 * 1024 * 1024 + 1), {
    headers: {
      'content-type': 'application/json'
    }
  }), 'x'), e => e.code === 'response_too_large');
  await assert.rejects(readMcpResponse(new Response('<html>blocked</html>', {
    headers: {
      'content-type': 'text/html'
    }
  }), 'x'), e => e.code === 'invalid_response');
});
test('news normalization preserves source dates/URLs, strips unsafe links and does not invent dates', () => {
  const result = normalizeResearch({
    structuredContent: {
      articles: [{
        id: 'one',
        title: 'Acme expands',
        description: 'A reported event',
        url: 'https://example.com/acme',
        published_at: '2026-10-15',
        source: {
          name: 'Example News'
        }
      }, {
        title: 'Unknown date',
        url: 'javascript:alert(1)',
        date: 'bad'
      }]
    }
  }, 'news');
  assert.equal(result.records[0].publisher, 'Example News');
  assert.equal(result.records[0].publishedAt, '2026-10-15T00:00:00.000Z');
  assert.equal(result.records[1].url, '');
  assert.equal(result.records[1].publishedAt, null);
});
test('company results keep the existing shared-context name/website contract', () => {
  const result = normalizeResearch({
    content: [{
      type: 'text',
      text: JSON.stringify({
        entities: [{
          organization_name: 'Acme',
          website_url: 'https://acme.example',
          description: 'Manufacturer',
          secret: 'omit'
        }]
      })
    }]
  }, 'companies');
  assert.equal(result.records[0].name, 'Acme');
  assert.equal(result.records[0].secret, undefined);
});
test('unknown provider shapes remain inspectable rather than being interpreted as verified empty results', () => {
  const value = normalizeResearch({
    structuredContent: {
      unfamiliar_shape: {
        message: 'Inspect this'
      }
    }
  }, 'news');
  assert.equal(value.records.length, 0);
  assert.match(value.text, /Inspect this/);
  assert.equal(normalizeResearch({
    content: [{
      type: 'text',
      text: 'a'.repeat(25000)
    }]
  }, 'news').text.length, 20000);
});
test('research DTOs exclude workspace IDs and return explicit GraphIQ provenance', () => {
  const dto = researchDto({
    _id: 'snapshot',
    orgId: 'private-workspace',
    kind: 'news',
    query: 'Acme',
    records: [],
    tool: 'search_news',
    secret: 'omit'
  });
  assert.equal(dto.source, 'GraphIQ MCP');
  assert.equal(dto.orgId, undefined);
  assert.equal(dto.secret, undefined);
});
